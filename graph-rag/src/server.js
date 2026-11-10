/**
 * graph-rag MCP sidecar — facet-indexed vector retrieval over ArcadeDB.
 *
 * Each node facet (identity, location, state, temporal, relations, + any
 * custom name) gets an LSM_VECTOR index over `n.embed_<facet>`; facet texts
 * are authored by the calling model via upsert_entities. search_graph embeds
 * the query and fans out over facet indexes, merging nearest-per-node.
 * A periodic sweep backfills the deterministic identity facet for nodes that
 * were written via raw queries (model-authored facets are never synthesized).
 *
 * Storage: ArcadeDB (HTTP JSON API, basic auth). Also exposes query_graph /
 * execute_graph / schema_graph pass-throughs so agents keep raw read/write
 * access without needing credentials (ArcadeDB's own MCP requires auth,
 * which pi-mcp-adapter cannot send).
 */
import { watchFile } from "node:fs";
import { parseValidUntil } from "./extent.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DOC_STORE, GRADER_MODEL, log, loops, PORT, POSITION_MAP_PATH, PRUNE_SINK, SWEEP_INTERVAL_MS, TOKEN_MAP_PATH } from "./context.js";
import { adbCommand, ensureIndex, ENTITY_LABEL, FACETS, knownIndexes } from "./db.js";
import { loadPositionMap, loadTokenMap, positionMap, requireCap, resolveWriteHome, SCOPED, scopeOf, writerOf } from "./scope.js";
import { aboutThing, queryGraph, schemaGraph, searchGraph } from "./search.js";
import { derivedFloor, ensureReadMarkSchema, entryAudience, recordReads, regradeTick } from "./floor.js";
import { approvePending, backfillIdentity, decideWrite, ensurePendingSchema, executeGraph, listPending, queueWrite, rejectPending, setHome, upsertEntities } from "./write.js";
import { ensureGrantSchema, findShareable, grantAccess, listGrants, refreshGrants, revokeGrant } from "./sharing.js";
import { ensureNeedSchema, expireRequests, requestAccess } from "./requests.js";
import { docStore, ensureDocumentSchema, readDocument, requestIngest, sweepOrphanDocuments } from "./ingest.js";
import { ensureWorkerSchema, expireLeases, PROPOSED_NOTE, wakeIdleWaiting, worker, workerModel, workerTick } from "./worker-pool.js";
import { registerWorkerTools, workerUpsert } from "./worker-tools.js";
import { registerRecordTools } from "./record-tools.js";
import { gateOffRecordTools, isOffRecord, loadThreadRecords, OFF_RECORD_REFUSAL, registerThreadRecordRoute } from "./record-state.js";
import { statements as modelStatements } from "./model/schema.js";
import { batchTick, ensureMasterSchema, registerHandlerTools, registerLiaisonTools, registerMasterTools } from "./master-tools.js";
import { ensurePruneSchema, pruneExpired, pruneSink } from "./pruning.js";
import { ensurePolicySchema, loadPolicy, policy } from "./org-policy.js";
import { settleTightening } from "./tightening.js";
import { app } from "./routes.js";
import { registerClassTools } from "./routes-classes.js";
import { gateDiscoveryTools } from "./discovery.js";
import { discoveryRunOf } from "./classes.js";

/** ---- MCP server (fresh instance per request: stateless) ---- */
const facetDoc = Object.entries(FACETS)
  .map(([f, d]) => `- ${f}: ${d}`)
  .join("\n");

export function createServer(identity) {
  const caps = identity.caps;
  const scope = scopeOf(identity);
  // the graph worker's agents (see delegation.js): their own tools, not the sharing and review ones
  const role = identity.role?.kind;
  // a worker reads what its entry's people see, resolved once per request; beyond: true reads
  // everything, and only then can what it read hold its write for an admin
  let audience;
  const readScope = async (args) => {
    if (role !== "worker" || args?.beyond) return scope;
    audience ??= entryAudience(identity.role);
    return (await audience) ?? scope;
  };
  // listed whether or not the thread is on record: the agent's client keeps the list it fetched when it connected.
  // An off-record chat agent is refused at the call (gateOffRecordTools, record-state.js), and again by need("write").
  const writable = caps.write !== "deny";
  const need = (cap) => {
    requireCap(caps, cap);
    if (cap === "write" && isOffRecord(identity)) throw new Error(OFF_RECORD_REFUSAL);
    // raw queries bypass the home filter: only for the root of the tree
    if (cap === "raw" && !scope.root) throw new Error("raw graph queries require the root position");
  };
  const homeNote = SCOPED
    ? `\nEach entity has a home position; you only see entities homed at your positions or below them.`
    : "";
  // a discovery run is held to read tools, the class tree and instances (discovery.js, R11)
  const server = gateDiscoveryTools(gateOffRecordTools(new McpServer({ name: "graph-rag", version: "0.3.0" }), identity), identity, { isDiscoveryEntry: async (rid) => Boolean(await discoveryRunOf(rid)) });
  // each identity is only shown the tools its capabilities allow (the
  // handlers check again: listing is not the boundary)

  // raw Cypher/SQL bypasses every read filter: only listed for raw identities
  if (caps.raw === true && scope.root) server.tool(
    "query_graph",
    `Run a READ-ONLY query against the knowledge graph (openCypher or SQL). Use for exact identifiers, structure, and schema exploration. Returns JSON rows.`,
    {
      query: z.string().min(1),
      language: z.enum(["cypher", "sql"]).optional(),
    },
    async (args) => {
      need("read");
      need("raw");
      return { content: [{ type: "text", text: JSON.stringify(await queryGraph(args)) }] };
    },
  );

  server.tool(
    "search_graph",
    `Semantic (embedding) search over per-facet vector indexes of the knowledge graph. Facets:
${facetDoc}
Custom facets created via upsert_entities are also searchable. Use for conceptual or
paraphrased questions; temporal_filter (property + after/before ISO datetimes) narrows by
a datetime property. Entries past their end date (valid_until) are left out; include_expired
shows them too, marked expired (for history: "who was on shift last Friday?"). Falls back to
lexical matching if embeddings are unavailable.${homeNote}${
      role === "worker"
        ? `
It searches what the people who see your entry see. beyond: true searches everything, but then what you
write may be held for an admin (you read what they can't see): use it only when the entry needs it.`
        : ""
    }`,
    {
      query: z.string().min(1),
      ...(role === "worker" ? { beyond: z.boolean().optional() } : {}),
      include_expired: z.boolean().optional(),
      facets: z.array(z.string()).optional(),
      k: z.number().int().min(1).max(32).optional(),
      temporal_filter: z
        .object({
          property: z.string(),
          after: z.string().optional(),
          before: z.string().optional(),
        })
        .optional(),
    },
    async (args) => {
      need("read");
      const read = [];
      const result = await searchGraph(args, await readScope(args), read, { ownEntry: identity.role?.entry ?? null });
      recordReads(identity, read);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "schema_graph",
    "List the knowledge-graph types and indexes.",
    {},
    async () => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await schemaGraph()) }] };
    },
  );

  if (writable) server.tool(
    "upsert_entities",
    `Create or update graph entities with per-facet semantic indexes. For each entity provide
facet texts — a concise natural-language sentence per facet capturing that aspect (facet
list below). Provide only facets you have information for. Unknown facet names are allowed
and indexed lazily. Include datetime facts BOTH as properties (for temporal_filter) and
inside facet texts. Facets say what the entry is about, never where it lives or who can see
it (a position, "admins only", "an Operations note"): that is its home, kept apart, and it can change.
Things that stop mattering on a date (a visit, an event, this week's schedule, a temporary state)
get valid_until: an ISO date or e.g. "7d"; after it they drop out of searches and are later
removed. Leave it out for what lasts (where things are, how things are done, decisions); grading
fills it in when the content clearly ends, and "lasting" keeps an entry from ever expiring. To
change an existing entry's end date, upsert it again with valid_until.${SCOPED ? `
Entities land at your position by default; \`home\` may name one of your positions or one above it
(restricting who sees them), never one below or beside yours.${role === "worker" ? ` An entry that already exists is
updated where it lives: leave \`home\` out for it (set_home moves an entry).` : ""}` : ""}
${facetDoc}`,
    {
      ...(SCOPED ? { home: z.string().optional() } : {}),
      entities: z
        .array(
          z.object({
            name: z.string().min(1),
            labels: z.array(z.string()).optional(),
            properties: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
            facets: z.record(z.string()).optional(),
            valid_until: z.string().optional(),
          }),
        )
        .max(64),
      ...(role === "worker" ? { reason: z.string().max(600).optional(), propose: z.boolean().optional() } : {}),
    },
    async (args) => {
      need("write");
      if (role === "worker") return { content: [{ type: "text", text: JSON.stringify(await workerUpsert(args, identity, scope)) }] };
      const home = resolveWriteHome(scope, args.home);
      // end dates resolve now ("7d" from today), not when a queued write is approved
      const now = Date.now();
      const entities = args.entities.map((e) => {
        const v = parseValidUntil(e.valid_until, now);
        return v === undefined ? e : { ...e, valid_until: v.valid_until ?? "lasting" };
      });
      // fixed at request time: what the requester read, not the approver
      // the one write-or-propose rule for graph writes (write.js decideWrite): the derived floor and the identity's queuing
      const d = decideWrite(identity, { kind: "upsert" }, { origin: home });
      const write = { entities, home, floor: d.floor ?? derivedFloor(identity, home), written_at: new Date(now).toISOString(), ...writerOf(identity) };
      if (d.action !== "direct") {
        const pending = await queueWrite({ kind: "upsert", payload: JSON.stringify(write), user: identity.user, home: d.home ?? home });
        return { content: [{ type: "text", text: JSON.stringify({ ...pending, ...(d.reason ? { reason: d.reason } : {}) }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(await upsertEntities(write)) }] };
    },
  );

  if (caps.raw === true && scope.root) server.tool(
    "execute_graph",
    "Execute a WRITE command against the knowledge graph (openCypher or SQL): ONE statement per call (no ';'-separated statements). Depending on your identity capabilities this executes immediately or is queued for review.",
    {
      command: z.string().min(1),
      language: z.enum(["cypher", "sql"]).optional(),
      ...(role === "worker" ? { reason: z.string().max(600).optional(), propose: z.boolean().optional() } : {}),
    },
    async (args) => {
      need("write");
      need("raw");
      return { content: [{ type: "text", text: JSON.stringify(await executeGraph(args, identity)) }] };
    },
  );

  if (writable && !role) server.tool(
    "embed_backfill",
    "Embed the identity facet for graph nodes written without embeddings. Requires write capability; queued-mode identities store it for approval.",
    { limit: z.number().int().min(1).max(256).optional() },
    async (args) => {
      need("write");
      if (decideWrite(identity, { kind: "backfill" }).action !== "direct") {
        const pending = await queueWrite({ kind: "backfill", payload: JSON.stringify({ limit: args?.limit ?? 64 }), user: identity.user });
        return { content: [{ type: "text", text: JSON.stringify(pending) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(await backfillIdentity(args?.limit ?? 64)) }] };
    },
  );

  if (SCOPED && writable) server.tool(
    "set_home",
    `Move entities to another home position. Moving one up (to a position above its home) restricts
who sees it and applies directly; moving it anywhere else widens who sees it and is queued for a
person to approve. Identify each entity by name (and its current home if the name exists at several
homes you can see).`,
    {
      entities: z.array(z.object({ name: z.string().min(1), home: z.string().optional() })).min(1).max(32),
      to: z.string().min(1),
      ...(role === "worker" ? { reason: z.string().max(600).optional(), propose: z.boolean().optional() } : {}),
    },
    async (args) => {
      need("write");
      const r = await setHome(args, identity, scope);
      if (role === "worker" && r.results.some((x) => x.queued)) r.note = PROPOSED_NOTE;
      return { content: [{ type: "text", text: JSON.stringify(r) }] };
    },
  );

  if (SCOPED && writable && !role) server.tool(
    "ingest_document",
    `Add a long document (a manual, a meeting transcript, a report) to the knowledge graph. Give
its full text, a short title and a one-sentence description. The text is kept in the document
store; the graph gets the document's entry and one searchable section per page or so, each filed
where it belongs (a sensitive part may be filed higher than the rest). valid_until works as in
upsert_entities. Re-ingesting the same title replaces the document.`,
    {
      title: z.string().min(3).max(200),
      description: z.string().min(3).max(500),
      text: z.string().min(20),
      ...(SCOPED ? { home: z.string().optional() } : {}),
      valid_until: z.string().optional(),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await requestIngest(args, identity, scope)) }] };
    },
  );

  if (SCOPED) server.tool(
    "about_thing",
    `Everything you can see about one instance (a person, a customer, a machine, a building), by name
(aliases work: "Toro Co." finds Toro): the sections about it. Use it for "what do we know about X"
questions, and to find related entries after a search.${role === "worker" ? " Like search_graph, it shows what your entry's people see; beyond: true shows everything, and then what you write may be held for an admin." : ""}`,
    { name: z.string().min(2), ...(role === "worker" ? { beyond: z.boolean().optional() } : {}) },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await aboutThing(args, identity, await readScope(args))) }] };
    },
  );


  // ---- a graph worker thread's own tools (one queue entry: its entry) ----
  if (SCOPED && role === "worker") registerWorkerTools(server, { identity, scope, need });

  // ---- a person's chat agent puts a condensed section of an on-record thread on record (record-tools.js) ----
  if (SCOPED && writable && !role) registerRecordTools(server, { identity, scope, need });

  // ---- the class tree, instances and dependency, by role (routes-classes.js) ----
  if (SCOPED) registerClassTools(server, { identity, scope, need, readScope });

  // ---- the master's tools: start workers, settle stops, hand the rest to the operator ----
  if (SCOPED && role === "master") registerMasterTools(server, { identity });

  // ---- a handler's tools: one stopped worker, settled with the operator ----
  if (SCOPED && role === "handler") registerHandlerTools(server, { identity });

  // ---- the liaison's tools: workers' questions and proposals, for the admin ----
  if (SCOPED && role === "liaison") registerLiaisonTools(server, { identity });

  if (SCOPED) server.tool(
    "read_document",
    `Read a document from the knowledge graph. Search results with kind "section" are parts of a
document (document, document_id, section): pass document_id (or the document's title) and the
section to read it in full, with up to count sections from there (default 3, at most 6). Without
a section you get its contents (the sections you can see) and the first sections.${role === "worker" ? " Like search_graph, it shows what your entry's people see; beyond: true shows everything, and then what you write may be held for an admin." : ""}`,
    {
      document: z.string().min(1),
      section: z.number().int().min(1).optional(),
      count: z.number().int().min(1).max(6).optional(),
      ...(role === "worker" ? { beyond: z.boolean().optional() } : {}),
    },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await readDocument(args, identity, await readScope(args))) }] };
    },
  );

  if (SCOPED && !role) server.tool(
    "find_shareable",
    `Find knowledge-graph entries you own (and so may share) by describing them; also lists the
positions and the people things can be shared with.

When the person asks you to let a position or a person know about something ("let Sales know what
this email said", "share the line 2 plan with the floor", "show bob the Toro schedule"):
1. Work out what "this" is from the conversation. If it isn't in the knowledge graph yet (e.g. text
   pasted into the chat), it gets there only through the record: on record, record it and use its title;
   off record nothing can be written, so say so and offer the person the switch.
2. Otherwise call find_shareable with a short description and pick the matching entries; mention
   related entries only if the person seems to want them too.
3. Match who they named: a team or role to one of the returned positions ("to"), one named person
   to one of the returned people ("person"). Only that person (and their agents) will see it.
4. Propose with grant_access: the entries, that position or person and a one-sentence reason in
   the person's words; leave "until" out unless they said how long (the organization's default
   applies).
5. Tell them the share is waiting for their confirmation in the chat (and, if the entry's save was
   queued, for that approval too). Nothing is shared until they confirm.`,
    { query: z.string().min(1), k: z.number().int().min(1).max(32).optional() },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await findShareable(args, identity, scope)) }] };
    },
  );

  if (SCOPED && writable && !role) server.tool(
    "grant_access",
    `Show data you own to another position, or to one person, for a while: either named entities or
a whole subtree (a position and everything below it). Name the recipient with "to" (a position:
its holders and those above it see the data) or "person" (one person and their agents only). Give a
reason; "until" ("14d" or an ISO date) is optional,
the organization's default length applies without it, and its maximum always does. People share what they own at once; agents propose and
the person confirms (a card in their chat). Data you only see through a grant can't be granted
onward. To find what to share, use find_shareable.`,
    {
      entities: z.array(z.object({ name: z.string().min(1), home: z.string().optional() })).min(1).max(32).optional(),
      subtree: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      person: z.string().min(1).optional(),
      reason: z.string().min(3).max(500),
      until: z.string().optional(),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await grantAccess(args, identity, scope)) }] };
    },
  );

  if (SCOPED && !role) server.tool(
    "request_access",
    `Ask for information the person can't see. When the knowledge graph doesn't answer their
question (search_graph finds nothing that answers it), offer to ask; if they agree, call this
with their question in their own words. graph-rag checks the whole graph, including parts the
person can't see, and quietly asks the people who own anything that matches; an owner may then
share it with them. If nothing matches yet, the question is posted for the people most likely to
know, and anything saved later that answers it is offered to them. The person confirms the request
on a card in the chat first, since it carries their question and name to others. Off record it is
refused, like every write: say so and offer the person the switch.

You never learn whether anything matched, who was asked, or whether anyone said no: never say
that the information exists or that someone has it. Say the request is waiting for their
confirmation; once confirmed, if someone shares an answer it shows up in their searches (and on
the card), and you can search again.`,
    { question: z.string().min(3).max(500) },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await requestAccess(args, identity, scope)) }] };
    },
  );

  if (SCOPED && !role) server.tool(
    "list_grants",
    "List active grants on data you own (outgoing) and grants that show you data (incoming).",
    {},
    async () => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(listGrants(scope)) }] };
    },
  );

  if (SCOPED && writable && !role) server.tool(
    "revoke_grant",
    "Revoke a grant (takes effect at once). The person who granted it or any owner of the data may revoke.",
    { id: z.string().min(1) },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await revokeGrant(args, identity, scope)) }] };
    },
  );

  if (caps.approve === true && !role) server.tool(
    "list_pending_writes",
    "List queued graph writes awaiting approval (requires approve capability).",
    {},
    async () => {
      need("approve");
      return { content: [{ type: "text", text: JSON.stringify({ pending: await listPending(identity) }) }] };
    },
  );

  if (caps.approve === true && !role) server.tool(
    "approve_write",
    "Approve and execute a queued graph write.",
    { id: z.string().min(1) },
    async (args) => {
      need("approve");
      return { content: [{ type: "text", text: JSON.stringify(await approvePending(args.id, identity)) }] };
    },
  );

  if (caps.approve === true && !role) server.tool(
    "reject_write",
    "Reject a queued graph write without executing it.",
    { id: z.string().min(1) },
    async (args) => {
      need("approve");
      return { content: [{ type: "text", text: JSON.stringify(await rejectPending(args.id, identity)) }] };
    },
  );

  return server;
}

/** boot: ensure advertised indexes + periodic identity sweep */
async function boot() {
  loadTokenMap();
  loadPositionMap();
  if (SCOPED) {
    watchFile(POSITION_MAP_PATH, { interval: 5000 }, () => {
      console.log("[graph-rag] position map changed; reloading");
      loadPositionMap();
    });
  }
  if (TOKEN_MAP_PATH) {
    watchFile(TOKEN_MAP_PATH, { interval: 5000 }, () => {
      console.log("[graph-rag] token map changed; reloading");
      loadTokenMap();
    });
  }
  for (const facet of Object.keys(FACETS)) await ensureIndex(facet);
  // declared, or SQL WHERE can't see it (see upsertEntities)
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._home IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (_home) NOTUNIQUE`).catch(() => {});
  for (const prop of ["_origin", "_grade", "_valid_until", "_valid_by", "_ungraded", "_placed_by", "_placed_at", "_written_by"]) await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (name, _origin) NOTUNIQUE`).catch(() => {});
  // the organization model's types (model/schema.js): classes on Entity, SUBCLASS_OF, INSTANCE_OF, DEPENDS_ON,
  // ABOUT, the filing log and workers' requests, and the on-record marker; idempotent DDL, run at every start
  for (const sql of modelStatements()) await adbCommand(sql).catch((e) => log.warn(`model schema: ${sql}: ${String(e).slice(0, 120)}`));
  if (SCOPED && positionMap) {
    // entities from before origins: their origin is where they are (legacy, unhomed ones: the root)
    await adbCommand(`UPDATE ${ENTITY_LABEL} SET _origin = _home WHERE _origin IS NULL AND _home IS NOT NULL`).catch((e) => log.warn(`origin migration: ${e}`));
    await adbCommand(`UPDATE ${ENTITY_LABEL} SET _origin = :root WHERE _origin IS NULL`, "sql", { root: positionMap.root }).catch((e) => log.warn(`origin migration: ${e}`));
  }
  await ensurePolicySchema();
  await loadPolicy();
  setInterval(() => void loadPolicy(), 60_000);
  await ensurePruneSchema();
  if (!pruneSink) log.warn(`PRUNE_SINK=${PRUNE_SINK} isn't a known sink: pruning is off (nothing is deleted)`);
  // every 10 minutes, a batch at a time; the first a minute after boot
  const prune = () => void loops.run("pruning", () => pruneExpired().then(() => sweepOrphanDocuments()));
  setTimeout(prune, 60_000);
  setInterval(prune, 600_000);
  if (SCOPED) log.info(`semantic grading: ${GRADER_MODEL && policy.gradingEnabled ? `on (${GRADER_MODEL}, confidence ${policy.gradingConfidence})` : "off"}`);
  if (SCOPED) await ensureReadMarkSchema();
  if (SCOPED) {
    await ensureGrantSchema();
    await refreshGrants();
    await ensureNeedSchema();
    await ensureDocumentSchema();
    await ensureWorkerSchema();
    setInterval(() => void loops.run("worker jobs", workerTick), 5_000);
    setInterval(() => void loops.run("worker leases", () => expireLeases().then(wakeIdleWaiting)), 60_000);
    // entries written while the grader was out: graded once it's back
    setInterval(() => void loops.run("regrading", regradeTick), 60_000);
    // a rule change still being worked through: at boot it is what a restart left
    void loops.run("re-homing", settleTightening);
    setInterval(() => void loops.run("re-homing", settleTightening), 10_000);
    await ensureMasterSchema();
    setInterval(() => void loops.run("batches", batchTick), 30_000);
    log.info(`graph worker: ${worker.enabled && workerModel() ? `on (${workerModel()}${worker.profile ? `, from profile ${worker.profile}` : ""})` : "off"}`);
    if (!docStore) log.warn(`DOC_STORE=${DOC_STORE} isn't a known store: documents can't be ingested`);
    await expireRequests();
    setInterval(() => void refreshGrants().then(expireRequests), 60_000);
  }
  await ensurePendingSchema();
  // the on/off-record gate (record-state.js): before the first request, so a restart can't open a thread that was off
  await loadThreadRecords();
  registerThreadRecordRoute(app);
  console.log(`[graph-rag] indexes ready: ${[...knownIndexes].join(", ")}`);
  const sweep = () =>
    loops.run("sweep", async () => {
      const r = await backfillIdentity(64);
      if (r.backfilled > 0) console.log(`[graph-rag] sweep backfilled ${r.backfilled} identity embeddings`);
    });
  setInterval(sweep, Number(SWEEP_INTERVAL_MS));
  app.listen(Number(PORT), () => console.log(`[graph-rag] listening on :${PORT}`));
}

boot().catch((e) => {
  console.error("[graph-rag] boot failed:", e);
  process.exit(1);
});
