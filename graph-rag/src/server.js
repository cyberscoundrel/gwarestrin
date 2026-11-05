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
import express from "express";
import { watchFile } from "node:fs";
import { EVERYONE, heldPositions, homeName, visibleHomes } from "./positions.js";
import { liveClause, parseValidUntil } from "./extent.js";
import { firstJob, handlerBrief, signalsMessage, poolSettings, surveyBrief } from "./pool.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { DOC_STORE, EMBED_MODEL, GRADER_MODEL, LITELLM_API_KEY, LITELLM_BASE_URL, log, loops, PORT, POSITION_MAP_PATH, PRUNE_SINK, SWEEP_INTERVAL_MS, TOKEN_MAP_PATH } from "./context.js";
import { adbCommand, adbQuery, ensureIndex, ENTITY_LABEL, FACETS, knownIndexes, likeTerm, RID_RE } from "./db.js";
import { homeFilter, homeLabel, loadPositionMap, loadTokenMap, peopleView, personOf, positionMap, requireCap, resolveIdentity, resolveWriteHome, SCOPED, scopeOf, writerOf } from "./scope.js";
import { aboutThing, queryGraph, schemaGraph, searchGraph } from "./search.js";
import { derivedFloor, ensureReadMarkSchema, entryAudience, recordReads, regradeTick } from "./floor.js";
import { approvePending, backfillIdentity, ensurePendingSchema, executeGraph, listPending, queueWrite, rejectPending, setHome, upsertEntities } from "./write.js";
import { confirmProposal, declineProposal, ensureGrantSchema, findShareable, grantAccess, listGrants, proposalStatus, refreshGrants, revokeGrant } from "./sharing.js";
import { answerRequest, askerRequest, ASSERTIONS, confirmRequest, dismissRequest, ensureNeedSchema, expireRequests, incomingRequests, requestAccess, withdrawRequest } from "./requests.js";
import { docStore, ensureDocumentSchema, readDocument, requestIngest, sweepOrphanDocuments } from "./ingest.js";
import { answerQuestions, claimThreads, createTask, enqueue, ensureWorkerSchema, expireLeases, finishThread, JOB_ID_RE, listProposals, listQuestions, PROPOSED_NOTE, setWorker, threadAgent, wakeIdleWaiting, worker, workerModel, workerStatus, workerTick } from "./worker-pool.js";
import { registerWorkerTools, workerUpsert } from "./worker-tools.js";
import { ensureTriageSchema } from "./triage.js";
import { batchTick, decideProposal, ensureMasterSchema, masterStatus, registerHandlerTools, registerLiaisonTools, registerMasterTools } from "./master-tools.js";
import { ensurePruneSchema, pruneExpired, prunePreview, pruneSink } from "./pruning.js";
import { canEditPolicy, ensurePolicySchema, loadPolicy, policy, policyDefaults, policyMeta, savePolicy } from "./org-policy.js";

/** ---- MCP server (fresh instance per request: stateless) ---- */
const facetDoc = Object.entries(FACETS)
  .map(([f, d]) => `- ${f}: ${d}`)
  .join("\n");

function createServer(identity) {
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
  const need = (cap) => {
    requireCap(caps, cap);
    // raw queries bypass the home filter: only for the root of the tree
    if (cap === "raw" && !scope.root) throw new Error("raw graph queries require the root position");
  };
  const homeNote = SCOPED
    ? `\nEach entity has a home position; you only see entities homed at your positions or below them.`
    : "";
  const server = new McpServer({ name: "graph-rag", version: "0.3.0" });
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
      const result = await searchGraph(args, await readScope(args), read, { demand: !role, ownEntry: identity.role?.entry ?? null });
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

  if (caps.write !== "deny") server.tool(
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
      const write = { entities, home, floor: derivedFloor(identity, home), written_at: new Date(now).toISOString(), ...writerOf(identity) };
      if (caps.write === "queued") {
        const pending = await queueWrite({ kind: "upsert", payload: JSON.stringify(write), user: identity.user, home });
        return { content: [{ type: "text", text: JSON.stringify(pending) }] };
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

  if (caps.write !== "deny" && !role) server.tool(
    "embed_backfill",
    "Embed the identity facet for graph nodes written without embeddings. Requires write capability; queued-mode identities store it for approval.",
    { limit: z.number().int().min(1).max(256).optional() },
    async (args) => {
      need("write");
      if (caps.write === "queued") {
        const pending = await queueWrite({ kind: "backfill", payload: JSON.stringify({ limit: args?.limit ?? 64 }), user: identity.user });
        return { content: [{ type: "text", text: JSON.stringify(pending) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(await backfillIdentity(args?.limit ?? 64)) }] };
    },
  );

  if (SCOPED && caps.write !== "deny") server.tool(
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

  if (SCOPED && caps.write !== "deny" && !role) server.tool(
    "ingest_document",
    `Add a long document (a manual, a meeting transcript, a report) to the knowledge graph. Give
its full text, a short title and a one-sentence description. The text is kept in the document
store; the graph gets the document's entry and one searchable section per page or so, each filed
where it belongs (a sensitive part may be filed higher than the rest).
extract is required, true or false: true also pulls focused facts (specifications, decisions,
action items with dates) out of the text into the graph, each linked to its section; false keeps
only the document and its sections. It's the person's decision: if they haven't said, ask them
("Should I also pull the individual facts out of it?") before calling this. valid_until works as
in upsert_entities. Re-ingesting the same title replaces the document.`,
    {
      title: z.string().min(3).max(200),
      description: z.string().min(3).max(500),
      text: z.string().min(20),
      extract: z.boolean(),
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
    `Everything you can see about one thing: a person, customer, supplier, machine, part, order,
place, project or team, by name (aliases work: "Toro Co." finds Toro). The graph worker links
statements to the things they mention in the background, so newly saved entries appear here after
a minute or so. Use it for "what do we know about X" questions, and to find related entries after
a search.${role === "worker" ? " Like search_graph, it shows what your entry's people see; beyond: true shows everything, and then what you write may be held for an admin." : ""}`,
    { name: z.string().min(2), ...(role === "worker" ? { beyond: z.boolean().optional() } : {}) },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await aboutThing(args, identity, await readScope(args))) }] };
    },
  );

  // ---- a graph worker thread's own tools (one queue entry: its entry) ----
  if (SCOPED && role === "worker") registerWorkerTools(server, { identity, scope, need });

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
   pasted into the chat), save it first with upsert_entities, then use the name you saved.
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

  if (SCOPED && caps.write !== "deny" && !role) server.tool(
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
on a card in the chat first, since it carries their question and name to others.

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

  if (SCOPED && caps.write !== "deny" && !role) server.tool(
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

/** ---- http ---- */
const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/mcp", async (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthenticated" }, id: null });
    return;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: each POST is self-contained
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  try {
    await createServer(identity).connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null });
    }
  }
});

app.get("/mcp", (_req, res) => res.status(405).json({ error: "POST only (stateless)" }));
app.get("/health", (_req, res) => res.json({ ok: true, facets_indexed: [...knownIndexes] }));

/** write-approval queue HTTP (for review UIs); approve-capability required */
function queueIdentity(req) {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity || identity.caps.approve !== true) return null;
  return identity;
}
app.get("/api/queue", (req, res) => {
  const identity = queueIdentity(req);
  if (!identity) return res.status(403).json({ error: "requires approve capability" });
  void listPending(identity).then(
    (pending) => res.json({ pending }),
    (err) => res.status(500).json({ error: String(err).slice(0, 200) }),
  );
});
app.post("/api/queue/:id/approve", (req, res) => {
  const identity = queueIdentity(req);
  if (!identity) return res.status(403).json({ error: "requires approve capability" });
  void approvePending(req.params.id, identity).then(
    (result) => res.json({ result }),
    (err) => res.status(400).json({ error: String(err).slice(0, 200) }),
  );
});
app.post("/api/queue/:id/reject", (req, res) => {
  const identity = queueIdentity(req);
  if (!identity) return res.status(403).json({ error: "requires approve capability" });
  void rejectPending(req.params.id, identity).then(
    (result) => res.json({ result }),
    (err) => res.status(400).json({ error: String(err).slice(0, 200) }),
  );
});

/**
 * The part of the position tree the caller can reach (its positions and
 * everything below): what a tenant may place its agents at.
 */
app.get("/api/positions", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!SCOPED) return res.json({ scoped: false, held: [], positions: [] });
  if (!positionMap) return res.status(503).json({ error: "position map not loaded" });
  const held = heldPositions(positionMap, identity.positions);
  const reach = visibleHomes(positionMap, held);
  const positions = Object.entries(positionMap.positions)
    .filter(([id]) => reach === null || reach.has(id))
    .map(([id, p]) => ({ id, name: homeName(positionMap, id), parent: p.parent, ...(p.description ? { description: p.description } : {}) }));
  // the whole tree's names: grants may go to positions outside the caller's
  // reach (that is their point); this says nothing about anyone's data
  const tree = Object.entries(positionMap.positions).map(([id, p]) => ({ id, name: homeName(positionMap, id), parent: p.parent }));
  res.json({ scoped: true, root: positionMap.root, everyone: { id: EVERYONE, name: "Everyone" }, held, positions, tree, people: peopleView(personOf(identity.user)), canGrantStanding: reach === null && !identity.agent && policy.standingGrants === "root" });
});

app.get("/api/policy", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  const scope = scopeOf(identity);
  void Promise.all([
    adbQuery("SELECT changed_at, changed_by, prev_json, next_json FROM PolicyChange ORDER BY changed_at DESC LIMIT 10").catch(() => []),
    canEditPolicy(identity, scope) ? prunePreview() : null,
  ])
    .then(([history, pruning]) =>
      res.json({
        policy,
        defaults: policyDefaults,
        ...policyMeta,
        canEdit: canEditPolicy(identity, scope),
        history: canEditPolicy(identity, scope) ? history : [],
        ...(canEditPolicy(identity, scope) ? { pruning } : {}),
        // set at deploy, not here
        infra: {
          scoped: SCOPED,
          positions: positionMap ? Object.keys(positionMap.positions).length : 0,
          graderModel: GRADER_MODEL || null,
          embedModel: EMBED_MODEL,
        },
      }),
    );
});

app.get("/api/worker", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sees the graph worker" });
  void workerStatus().then((r) => res.json(r), (e) => httpError(res, e));
});
app.put("/api/worker", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sets the graph worker" });
  const b = req.body ?? {};
  const next = {
    enabled: typeof b.enabled === "boolean" ? b.enabled : worker.enabled,
    model: typeof b.model === "string" ? b.model.slice(0, 300) : worker.model,
    instructions: typeof b.instructions === "string" ? b.instructions.slice(0, 4000) : worker.instructions,
    profile: typeof b.profile === "string" ? b.profile.slice(0, 120) : b.profile === null ? null : worker.profile,
    pool: worker.pool,
  };
  try {
    if (b.pool !== undefined) next.pool = poolSettings(b.pool, worker.pool);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const now = new Date().toISOString();
  void (async () => {
    const json = JSON.stringify(next);
    const done = await adbCommand("UPDATE OrgPolicy SET json = :json, updated_by = :u, updated_at = :now WHERE scope = 'worker'", "sql", { json, u: identity.user, now });
    if (Number(done?.[0]?.count ?? 0) === 0) await adbCommand("INSERT INTO OrgPolicy SET scope = 'worker', json = :json, updated_by = :u, updated_at = :now", "sql", { json, u: identity.user, now });
    setWorker({ ...next, updated_by: identity.user, updated_at: now });
    log.info(`graph worker set by ${identity.user}: ${next.enabled ? `on, ${workerModel() || "no model"}` : "off"}${next.profile ? ` (profile ${next.profile})` : ""}`);
    return workerStatus();
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
/** the models graph-rag reaches through litellm (what a Graph worker profile can pick) */
app.get("/api/worker/models", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sets the graph worker" });
  void fetch(`${LITELLM_BASE_URL.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${LITELLM_API_KEY}` }, signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json())
    .then((j) => res.json({ models: (j.data ?? []).map((m) => m.id).filter((id) => typeof id === "string" && !/embed/i.test(id)).sort() }))
    .catch((e) => httpError(res, e));
});
/** the worker pool's endpoints: the admin's workspace runs the threads; root only */
const rootOnly = (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return void res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return void res.status(403).json({ error: "only the organization's root runs graph worker threads" });
  return identity;
};
app.post("/api/worker/threads/claim", (req, res) => {
  if (!rootOnly(req, res)) return;
  void claimThreads(req.body?.limit, req.body?.groups).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/worker/threads/:id/agent", (req, res) => {
  if (!rootOnly(req, res)) return;
  void threadAgent(req.params.id, req.body?.agent_id).then((r) => res.json(r), (e) => httpError(res, e));
});
/** a claimed thread the workspace couldn't start yet (its model is at its limit): pending again in a minute, its tries kept */
app.post("/api/worker/threads/:id/release", (req, res) => {
  if (!rootOnly(req, res)) return;
  if (!JOB_ID_RE.test(String(req.params.id))) return res.status(400).json({ error: "invalid job" });
  const now = new Date();
  void adbCommand("UPDATE Job SET status = 'pending', lease_until = null, run_after = :ra, updated_at = :now WHERE id = :id AND kind = 'review' AND status = 'running'", "sql", {
    ra: new Date(now.getTime() + 60_000).toISOString(),
    now: now.toISOString(),
    id: req.params.id,
  }).then((r) => res.json({ released: Number(r?.[0]?.count ?? 0) === 1 }), (e) => httpError(res, e));
});
app.post("/api/worker/threads/:id/finish", (req, res) => {
  if (!rootOnly(req, res)) return;
  void finishThread(req.params.id, req.body ?? {}).then((r) => res.json(r), (e) => httpError(res, e));
});
/** the master's inbox: new signals (the workspace delivers them to the master thread) */
app.get("/api/worker/signals", (req, res) => {
  if (!rootOnly(req, res)) return;
  void (async () => {
    const rows = await adbQuery("SELECT id, kind, job_id, batch_id, data, created_at FROM Signal WHERE status = 'new' ORDER BY created_at ASC LIMIT 50");
    const signals = rows.map((r) => ({ ...r, data: JSON.parse(r.data || "{}") }));
    const status = await masterStatus();
    return { signals, status, message: signals.length ? signalsMessage(signals, status) : "" };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/worker/signals/ack", (req, res) => {
  if (!rootOnly(req, res)) return;
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((i) => JOB_ID_RE.test(String(i))).slice(0, 100);
  void (async () => {
    for (const id of ids) await adbCommand("UPDATE Signal SET status = 'delivered' WHERE id = :id", "sql", { id });
    return { acked: ids.length };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
/** handlers to start (not limited by the pool: they wait on the operator) */
app.post("/api/worker/handlers/claim", (req, res) => {
  if (!rootOnly(req, res)) return;
  void (async () => {
    const rows = await adbQuery("SELECT id, payload FROM Job WHERE kind = 'handler' AND status = 'pending' ORDER BY created_at ASC LIMIT 10");
    const out = [];
    for (const r of rows) {
      const ok = await adbCommand("UPDATE Job SET status = 'running', updated_at = :now WHERE id = :id AND status = 'pending'", "sql", { now: new Date().toISOString(), id: r.id });
      if (Number(ok?.[0]?.count ?? 0) !== 1) continue;
      const p = JSON.parse(r.payload || "{}");
      out.push({ job: r.id, worker: p.for_job, title: p.title ?? "a stopped worker", message: handlerBrief({ worker: { job: p.for_job, title: p.title ?? "" }, description: p.description }) });
    }
    return { handlers: out };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
/** a handler's thread asked the operator: it waits (it stays in the rail) */
app.post("/api/worker/handlers/:id/waiting", (req, res) => {
  if (!rootOnly(req, res)) return;
  void adbCommand("UPDATE Job SET status = 'waiting', agent_id = :a, updated_at = :now WHERE id = :id AND kind = 'handler' AND status IN ['running', 'pending']", "sql", {
    a: typeof req.body?.agent_id === "string" ? req.body.agent_id.slice(0, 80) : null,
    now: new Date().toISOString(),
    id: req.params.id,
  }).then(() => res.json({ ok: true }), (e) => httpError(res, e));
});
app.get("/api/worker/handlers", (req, res) => {
  if (!rootOnly(req, res)) return;
  void (async () => {
    const rows = await adbQuery("SELECT id, payload, status, agent_id, summary, created_at, updated_at FROM Job WHERE kind = 'handler' ORDER BY created_at DESC LIMIT 100");
    return { handlers: rows.map((r) => ({ id: r.id, ...JSON.parse(r.payload || "{}"), status: r.status, agent_id: r.agent_id ?? null, decision: r.summary ?? "", created_at: r.created_at, updated_at: r.updated_at })) };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});

/** recent threads: which entry, how it went, its agent (for the audit view and clean-up) */
app.get("/api/worker/threads", (req, res) => {
  if (!rootOnly(req, res)) return;
  void (async () => {
    const rows = await adbQuery("SELECT id, payload, status, agent_id, summary, error, attempts, changes, created_at, updated_at, claimed_at FROM Job WHERE kind = 'review' ORDER BY updated_at DESC LIMIT 200");
    const out = [];
    for (const r of rows) {
      const p = JSON.parse(r.payload || "{}");
      const name = RID_RE.test(String(p.rid)) ? (await adbQuery(`SELECT name FROM ${p.rid}`).catch(() => []))[0]?.name : null;
      out.push({
        id: r.id,
        entry: name ?? null,
        why: p.why ?? "",
        ...(p.level ? { level: p.level } : {}),
        status: r.status,
        agent_id: r.agent_id ?? null,
        summary: r.summary ?? "",
        // what it changed without asking (the audit trail for the small things)
        changes: JSON.parse(r.changes || "[]"),
        error: r.error ?? null,
        attempts: Number(r.attempts ?? 0),
        created_at: r.created_at,
        updated_at: r.updated_at,
      });
    }
    return { threads: out };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
/** the admin starts a survey of a connection: a task thread maps it, seeds its records, relates them */
app.post("/api/worker/survey", (req, res) => {
  const identity = rootOnly(req, res);
  if (!identity) return;
  const connection = String(req.body?.connection ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(connection)) return res.status(400).json({ error: "which connection (its name)" });
  const focus = typeof req.body?.focus === "string" ? req.body.focus.slice(0, 1000) : "";
  // who sees what the survey builds: everyone (the default: it's the organization's map) or the admin only
  const audience = req.body?.audience === "admin" ? "admin" : EVERYONE;
  void createTask({ title: `Survey: ${connection}`, brief: surveyBrief(connection, focus, audience), minutes: Number(req.body?.minutes) || 60, by: identity.user, audience, level: 3 }).then(
    (r) => res.json(r),
    (e) => httpError(res, e),
  );
});
app.get("/api/worker/questions", (req, res) => {
  if (!rootOnly(req, res)) return;
  const status = ["open", "answered", "dismissed"].includes(String(req.query.status)) ? String(req.query.status) : "open";
  void listQuestions(status).then((questions) => res.json({ questions }), (e) => httpError(res, e));
});
app.post("/api/worker/questions/answer", (req, res) => {
  const identity = rootOnly(req, res);
  if (!identity) return;
  const b = req.body ?? {};
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 100) : [];
  if (!b.dismiss && !(typeof b.answer === "string" && b.answer.trim())) return res.status(400).json({ error: "an answer, or dismiss" });
  void answerQuestions(ids, { answer: b.answer ?? "", dismiss: b.dismiss === true }, identity.user).then((r) => res.json(r), (e) => httpError(res, e));
});
app.get("/api/worker/proposals", (req, res) => {
  if (!rootOnly(req, res)) return;
  void listProposals().then((proposals) => res.json({ proposals }), (e) => httpError(res, e));
});
app.post("/api/worker/proposals/:id", (req, res) => {
  const identity = rootOnly(req, res);
  if (!identity) return;
  void decideProposal(req.params.id, req.body?.approve === true, typeof req.body?.reason === "string" ? req.body.reason.slice(0, 1000) : "", identity).then((r) => res.json(r), (e) => httpError(res, e));
});

/** queue the entries saved before the worker existed (newest first; demand still goes first) */
app.post("/api/worker/backfill", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root runs a backfill" });
  void (async () => {
    const kind = firstJob(worker.pool);
    const rows = await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE ${kind === "mentions" ? "_mentions_at" : "_reviewed_at"} IS NULL AND embed_identity IS NOT NULL${ASSERTIONS}${liveClause()} ORDER BY updated_at DESC LIMIT 500`);
    for (const r of rows) await enqueue(kind, { rid: String(r.rid) }, { key: `${kind}:${r.rid}` });
    return { queued: rows.length };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});

/** the pruning record: what was removed, when (names only, never content; the root only) */
app.get("/api/pruned", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sees what was pruned" });
  void adbQuery("SELECT name, home, kind, valid_until, pruned_at, sink, kept FROM PruneRecord ORDER BY pruned_at DESC LIMIT 100")
    .catch(() => [])
    .then((rows) => res.json({ pruned: rows.map((r) => ({ ...r, home: r.home ? homeLabel(r.home)?.name ?? r.home : null })) }));
});
/** prune what's due now instead of at the next sweep (the root only) */
app.post("/api/pruned/run", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root prunes" });
  void pruneExpired(500).then(async (r) => res.json({ ...r, preview: await prunePreview() }), (e) => httpError(res, e));
});
app.put("/api/policy", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root can change these settings" });
  void savePolicy(req.body, identity).then(
    (p) => res.json({ policy: p, ...policyMeta }),
    (e) => res.status(400).json({ error: String(e instanceof Error ? e.message : e).slice(0, 300) }),
  );
});

/** ---- grants + owned-entity search over HTTP (the people-facing UI) ---- */
function httpScope(req, res) {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  if (!SCOPED || !positionMap) {
    res.status(409).json({ error: "the knowledge graph isn't divided into positions" });
    return null;
  }
  return { identity, scope: scopeOf(identity) };
}
const httpError = (res, err) => res.status(400).json({ error: String(err instanceof Error ? err.message : err).slice(0, 300) });

app.get("/api/grants", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) res.json({ ...listGrants(ctx.scope), canGrantStanding: ctx.scope.root && !ctx.identity.agent && policy.standingGrants === "root" });
});
app.post("/api/grants", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  if (ctx.identity.caps.write === "deny") return res.status(403).json({ error: "graph writes are denied for this identity" });
  const b = req.body ?? {};
  const args = {
    ...(Array.isArray(b.entities) ? { entities: b.entities.slice(0, 32).map((e) => ({ name: String(e?.name ?? ""), ...(e?.home ? { home: String(e.home) } : {}) })) } : {}),
    ...(typeof b.subtree === "string" ? { subtree: b.subtree } : {}),
    ...(typeof b.to === "string" && b.to ? { to: b.to } : {}),
    ...(typeof b.person === "string" && b.person ? { person: b.person } : {}),
    reason: String(b.reason ?? ""),
    ...(typeof b.until === "string" && b.until ? { until: b.until } : {}),
  };
  if (args.reason.trim().length < 3) return httpError(res, "give a reason");
  void grantAccess(args, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/grants/:id/revoke", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void revokeGrant({ id: req.params.id }, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
/** shares proposed by this person's agents: status, confirm, decline (the chat card) */
app.get("/api/grants/proposals/:id", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void proposalStatus(req.params.id, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/grants/proposals/:id/confirm", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  const b = req.body ?? {};
  const changes = {
    ...(typeof b.until === "string" && b.until ? { until: b.until } : {}),
    ...(typeof b.to === "string" && b.to ? { to: b.to } : {}),
    ...(typeof b.person === "string" && b.person ? { person: b.person } : {}),
  };
  void confirmProposal(req.params.id, changes, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/grants/proposals/:id/decline", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void declineProposal(req.params.id, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});

/** access requests: the asker's card (their own) and the owners' side (routed to them) */
app.get("/api/requests", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void incomingRequests(ctx.identity).then((r) => res.json(r), (e) => httpError(res, e));
});
app.get("/api/requests/:id", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void askerRequest(req.params.id, ctx.identity).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/requests/:id/confirm", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void confirmRequest(req.params.id, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/requests/:id/withdraw", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void withdrawRequest(req.params.id, ctx.identity).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/requests/:id/answer", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  if (ctx.identity.caps.write === "deny") return res.status(403).json({ error: "graph writes are denied for this identity" });
  const b = req.body ?? {};
  const args = {
    entries: Array.isArray(b.entries) ? b.entries.slice(0, 32).map(String) : [],
    ...(typeof b.until === "string" && b.until ? { until: b.until } : {}),
  };
  void answerRequest(req.params.id, args, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/requests/:id/dismiss", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void dismissRequest(req.params.id, ctx.identity).then((r) => res.json(r), (e) => httpError(res, e));
});

/** entities the caller owns (by home), for picking what to grant */
app.get("/api/entities", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  // case-insensitive: people type "thinkcentre" for "ThinkCentre"
  const match = q ? ` AND (name ILIKE '%${likeTerm(q)}%' OR text_identity ILIKE '%${likeTerm(q)}%')` : "";
  void adbQuery(`SELECT name, _home FROM ${ENTITY_LABEL} WHERE name IS NOT NULL${match}${homeFilter(ctx.scope, { own: true })}${liveClause()}${ASSERTIONS} ORDER BY name LIMIT 25`).then(
    (rows) => res.json({ entities: rows.map((r) => ({ name: r.name, home: homeLabel(r._home) })) }),
    (e) => httpError(res, e),
  );
});

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
    await ensureMasterSchema();
    await ensureTriageSchema();
    setInterval(() => void loops.run("batches", batchTick), 30_000);
    log.info(`graph worker: ${worker.enabled && workerModel() ? `on (${workerModel()}${worker.profile ? `, from profile ${worker.profile}` : ""})` : "off"}`);
    if (!docStore) log.warn(`DOC_STORE=${DOC_STORE} isn't a known store: documents can't be ingested`);
    await expireRequests();
    setInterval(() => void refreshGrants().then(expireRequests), 60_000);
  }
  await ensurePendingSchema();
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
