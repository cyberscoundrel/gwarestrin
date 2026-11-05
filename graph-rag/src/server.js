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
import { randomUUID } from "node:crypto";
import { EVERYONE, heldPositions, homeName, moveKind, visibleHomes } from "./positions.js";
import { liveClause, parseValidUntil } from "./extent.js";
import { createSink, ledgerLine, preview as prunePreviewDays, pruneCutoff, pruneRecord } from "./prune.js";
import { firstJob, handlerBrief, signalsMessage, poolSettings, surveyBrief } from "./pool.js";
import { applyPolicyUpdate, defaultPolicy, normalizeStored } from "./policy.js";
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
import { answerQuestions, claimThreads, createTask, enqueue, ensureWorkerSchema, expireLeases, finishThread, JOB_ID_RE, listProposals, listQuestions, proposalLands, PROPOSED_NOTE, resumeThread, setWorker, threadAgent, wakeIdleWaiting, worker, workerModel, workerStatus, workerTick } from "./worker-pool.js";
import { registerWorkerTools, workerUpsert } from "./worker-tools.js";
import { ensureTriageSchema } from "./triage.js";

/**
 * ---- the master (pool.master): a long-running thread plans batches of saved
 * entries and starts workers; graph-rag keeps its inbox (Signal), the batches
 * (Batch) and the handlers (Job kind "handler": one stopped worker each, which
 * the operator settles). Workers started by the master have parent MASTER.
 */
export const MASTER = "master";

async function ensureMasterSchema() {
  // (BATCH is a reserved word in ArcadeDB SQL: the type is WorkBatch)
  for (const type of ["Signal", "WorkBatch"]) await adbCommand(`CREATE DOCUMENT TYPE ${type} IF NOT EXISTS`).catch(() => {});
  for (const prop of ["id", "kind", "job_id", "batch_id", "data", "status", "created_at"]) await adbCommand(`CREATE PROPERTY Signal.${prop} IF NOT EXISTS STRING`).catch(() => {});
  for (const prop of ["id", "entries", "status", "created_at"]) await adbCommand(`CREATE PROPERTY WorkBatch.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON Signal (status) NOTUNIQUE").catch(() => {});
}

export async function emitSignal(kind, { job_id = null, batch_id = null, data = {} } = {}) {
  await adbCommand("INSERT INTO Signal SET id = :id, kind = :k, job_id = :j, batch_id = :b, data = :d, status = 'new', created_at = :now", "sql", {
    id: randomUUID(),
    k: kind,
    j: job_id,
    b: batch_id,
    d: JSON.stringify(data),
    now: new Date().toISOString(),
  });
}

/** a stopped worker's open questions and undecided proposals */
export async function openItems(jobId) {
  const questions = await adbQuery("SELECT id, question, options FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: jobId }).catch(() => []);
  const proposals = await adbQuery("SELECT id, kind, note, payload FROM PendingWrite WHERE job_id = :id AND status = 'pending'", { id: jobId }).catch(() => []);
  return {
    questions: questions.map((q) => ({ id: q.id, question: q.question, options: JSON.parse(q.options || "[]") })),
    proposals: await Promise.all(proposals.map(async (p) => ({ id: p.id, kind: p.kind, lands: await proposalLands(p.kind, p.payload), reason: p.note ?? "" }))),
  };
}

const openHandlers = async () => Number((await adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'handler' AND status IN ['pending', 'running', 'waiting']").catch(() => []))[0]?.n ?? 0);

/** the master's status: halted when too many stopped workers wait on the operator */
export async function masterStatus() {
  const handlers = await openHandlers();
  const intake = Number((await adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'intake' AND status = 'pending'").catch(() => []))[0]?.n ?? 0);
  const signals = Number((await adbQuery("SELECT count(*) AS n FROM Signal WHERE status = 'new'").catch(() => []))[0]?.n ?? 0);
  return { on: !!worker.pool.master && worker.pool.poolSize > 0, handlers, maxHandlers: worker.pool.maxHandlers, halted: handlers >= worker.pool.maxHandlers, intake, signals };
}

/** a batch closes at batchSize entries or when its oldest has waited batchMinutes; not while halted */
async function batchTick() {
  const st = await masterStatus();
  if (!st.on || st.halted || !st.intake) return;
  const rows = await adbQuery("SELECT id, payload, created_at FROM Job WHERE kind = 'intake' AND status = 'pending' ORDER BY created_at ASC LIMIT " + Math.floor(worker.pool.batchSize));
  const oldest = Date.parse(rows[0]?.created_at ?? "");
  if (rows.length < worker.pool.batchSize && !(Date.now() - oldest >= worker.pool.batchMinutes * 60_000)) return;
  const batch = randomUUID();
  const entries = [];
  const taken = [];
  for (const r of rows) {
    const p = JSON.parse(r.payload || "{}");
    const row = RID_RE.test(String(p.rid)) ? (await adbQuery(`SELECT name, _home FROM ${p.rid}`).catch(() => []))[0] : null;
    taken.push(r.id);
    if (!row?.name) continue; // gone since it was saved
    const edges = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${p.rid})`).catch(() => []);
    const dsts = edges.map((e) => String(e.dst)).filter((x) => RID_RE.test(x));
    const things = dsts.length ? await adbQuery(`SELECT label, _thing_type FROM [${dsts.join(",")}]`).catch(() => []) : [];
    entries.push({ name: row.name, home: homeName(positionMap, row._home), links: things.map((t) => `${t.label} (${t._thing_type})`), unsure: p.unsure ?? [], fresh: p.fresh ?? [], ...(p.triage ? { triage: p.triage } : {}) });
  }
  // the batch and its signal first: entries leave the intake only once the master will hear of them
  if (entries.length) {
    await adbCommand("INSERT INTO WorkBatch SET id = :id, entries = :e, status = 'open', created_at = :now", "sql", { id: batch, e: JSON.stringify(entries.map((e) => e.name)), now: new Date().toISOString() });
    await emitSignal("batch", { batch_id: batch, data: { entries } });
  }
  for (const id of taken) await adbCommand("UPDATE Job SET status = 'done', summary = :b, updated_at = :now WHERE id = :id AND status = 'pending'", "sql", { b: `batch ${batch}`, now: new Date().toISOString(), id });
  if (!entries.length) return;
  log.info(`batch ${batch.slice(0, 8)}: ${entries.length} entries for the master`);
}

/** the master starts a worker: a task (a brief, the entries it's about), run by the pool */
async function masterStartWorker(args, identity) {
  const names = (args.entries ?? []).slice(0, 25);
  const brief = [String(args.brief), ...(names.length ? ["", `The entries this is about: ${names.map((n) => `"${n}"`).join(", ")} (read them in the graph).`] : [])].join("\n");
  // its level of work (which model runs it): the master's call, else the highest triage level among its entries, else an investigation
  let level = Number(args.level) || 0;
  if (!level && names.length) {
    for (const n of names) {
      const t = (await adbQuery("SELECT level FROM Triage WHERE name = :n ORDER BY created_at DESC LIMIT 1", { n }).catch(() => []))[0];
      level = Math.max(level, Number(t?.level ?? 0));
    }
  }
  const r = await createTask({ title: args.title, brief, minutes: args.minutes, parent: MASTER, by: identity.user, audience: args.audience === "everyone" ? EVERYONE : undefined, entries: names, level: level || 2 });
  return { ...r, note: "Started: you'll get a signal when it's done or stopped." };
}

/** one worker's situation, for the master or its handler */
async function workerSituation(jobId) {
  if (!JOB_ID_RE.test(String(jobId))) throw new Error("which worker (its job id)");
  const job = (await adbQuery("SELECT status, payload, summary, changes, agent_id, updated_at FROM Job WHERE id = :id AND kind = 'review'", { id: jobId }))[0];
  if (!job) throw new Error(`no worker ${jobId}`);
  const p = JSON.parse(job.payload || "{}");
  return {
    job: jobId,
    title: p.task?.title ?? null,
    status: job.status,
    brief: String(p.task?.brief ?? "").slice(0, 3000),
    report: String(job.summary ?? "").slice(0, 3000),
    changes: JSON.parse(job.changes || "[]").slice(-30),
    ...(await openItems(jobId)),
  };
}

/** the master (or a handler, on the operator's word) answers a stopped worker: it resumes with the message */
async function answerWorker(jobId, answer, by) {
  const items = await openItems(jobId);
  if (items.questions.length) await answerQuestions(items.questions.map((q) => q.id), { answer, quiet: true }, by);
  await resumeThread(jobId, { message: String(answer).slice(0, 3000), answered_by: by });
  return { resumed: true, answered: items.questions.length };
}

/** raw commands and widening who sees something are the operator's, whatever the master thinks */
async function needsOperator(id) {
  const rec = (await adbQuery("SELECT kind, payload FROM PendingWrite WHERE id = :id", { id }))[0];
  if (!rec) return null;
  if (rec.kind === "command") return "a raw command";
  if (rec.kind === "rehome") {
    const m = JSON.parse(rec.payload);
    if (moveKind(positionMap, m.from, m.to) === "widen") return "widening who sees something";
  }
  return null;
}

/** the master closes a worker it won't pursue: questions dismissed, proposals rejected, no resume */
async function closeWorker(jobId, summary, identity) {
  await adbCommand("UPDATE Job SET status = 'closed', summary = :s, updated_at = :now WHERE id = :id AND kind = 'review'", "sql", { s: String(summary ?? "closed by the master").slice(0, 2000), now: new Date().toISOString(), id: jobId });
  const items = await openItems(jobId);
  if (items.questions.length) await answerQuestions(items.questions.map((q) => q.id), { answer: "", dismiss: true }, identity.user);
  for (const p of items.proposals) await rejectPending(p.id, identity, "closed by the master").catch(() => {});
  return { closed: true };
}

/** the master hands a stop it can't decide to a handler, who settles it with the operator */
async function startHandler(jobId, description, identity) {
  const sit = await workerSituation(jobId);
  if (sit.status !== "waiting") throw new Error(`worker ${jobId} isn't waiting (${sit.status})`);
  const st = await masterStatus();
  if (st.halted) throw new Error(`${st.handlers} handlers already wait on the operator (at most ${st.maxHandlers}): settle what you can, the rest waits`);
  const id = randomUUID();
  const now = new Date().toISOString();
  await adbCommand(
    "INSERT INTO Job SET id = :id, kind = 'handler', job_key = :k, payload = :p, status = 'pending', attempts = 0, priority = 9, run_after = :now, created_at = :now, updated_at = :now",
    "sql",
    { id, k: `handler:${jobId}:${id.slice(0, 8)}`, p: JSON.stringify({ for_job: jobId, title: sit.title, description: String(description).slice(0, 3000), by: identity.user }), now },
  );
  return { handler: id, note: "Handed to the operator: you'll get a signal when it's resolved." };
}

/** the handler records the operator's decision: answers, applies or rejects proposals; the worker resumes; the master hears */
async function handlerDecide(args, identity) {
  const h = (await adbQuery("SELECT payload, status FROM Job WHERE id = :id AND kind = 'handler'", { id: identity.role.job }))[0];
  if (!h) throw new Error("no such handler");
  if (h.status === "done") throw new Error("already decided");
  const { for_job } = JSON.parse(h.payload || "{}");
  const items = await openItems(for_job);
  // checked before anything is applied: an empty call or an id that isn't open was taken as
  // "carry on", closing the handler with the operator's decision unrecorded
  const open = items.proposals.map((p) => p.id);
  // the worker's own first; else any pending proposal the operator named (the grader's moves, say):
  // otherwise their decision on one the worker didn't raise came back as yet another handler
  const pending = (await adbQuery("SELECT id FROM PendingWrite WHERE status = 'pending'").catch(() => [])).map((p) => String(p.id));
  const match = (list, id) => list.filter((p) => p === id || (String(id).length >= 8 && p.startsWith(String(id))));
  const resolve = (id) => {
    const own = match(open, id);
    const hits = own.length ? own : match(pending, id);
    if (hits.length !== 1) throw new Error(`${id} is not one pending proposal (this worker's open ones: ${open.join(", ") || "none"}): nothing was recorded`);
    return hits[0];
  };
  const approve = (args.approve ?? []).map(resolve);
  const reject = (args.reject ?? []).map((r) => ({ ...r, id: resolve(r.id) }));
  if (!args.answer?.trim() && !approve.length && !reject.length) throw new Error("Nothing to record: give the operator's answer, or the proposals to apply or reject. Nothing was recorded.");
  const by = `${identity.user} (on the operator's word)`;
  const done = [];
  for (const id of approve) {
    await approvePending(id, { ...identity, user: by }, "", { quiet: true }).then(() => done.push(`applied ${id.slice(0, 8)}`), (e) => done.push(`couldn't apply ${id.slice(0, 8)}: ${String(e.message ?? e).slice(0, 120)}`));
  }
  for (const r of reject) {
    await rejectPending(r.id, { ...identity, user: by }, r.reason ?? "", { quiet: true }).then(() => done.push(`rejected ${r.id.slice(0, 8)}`));
  }
  if (items.questions.length && args.answer) await answerQuestions(items.questions.map((q) => q.id), { answer: args.answer, quiet: true }, by);
  const decision = [args.answer ? `The operator: ${args.answer}` : "", ...done].filter(Boolean).join("; ");
  await resumeThread(for_job, { message: decision || "The operator looked at it: carry on.", answered_by: by });
  await adbCommand("UPDATE Job SET status = 'done', summary = :s, updated_at = :now WHERE id = :id", "sql", { s: decision.slice(0, 2000), now: new Date().toISOString(), id: identity.role.job });
  await emitSignal("resolved", { job_id: for_job, data: { decision } });
  return { decided: true, worker_resumes: for_job, note: "Recorded: the worker resumes and the master knows. Tell the operator what you recorded." };
}

/** the admin's decision on a worker's proposal (through the liaison or Approvals); rejected = the thread decides again */
async function decideProposal(id, approve, reason, identity) {
  const rec = (await adbQuery("SELECT id FROM PendingWrite WHERE id = :id AND status = 'pending' AND job_id IS NOT NULL", { id }))[0];
  if (!rec) throw new Error(`no pending proposal ${id}`);
  // either way the waiting thread resumes with the decision (see approvePending, rejectPending)
  return approve ? approvePending(id, identity, reason) : rejectPending(id, identity, reason);
}

/** ---- pruning (see prune.js): expired entries leave for good after a window ---- */

const pruneSink = createSink(PRUNE_SINK);
let pruneRunning = false;

async function ensurePruneSchema() {
  await adbCommand("CREATE DOCUMENT TYPE PruneRecord IF NOT EXISTS").catch(() => {});
  for (const prop of ["name", "home", "kind", "valid_until", "pruned_at", "sink"]) {
    await adbCommand(`CREATE PROPERTY PruneRecord.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
}

/** one batch: hand expired entries to the sink, delete what it accepted, leave a line each */
async function pruneExpired(limit = 100) {
  const cutoff = pruneCutoff(policy.pruneAfterDays);
  if (!cutoff || !pruneSink || pruneRunning) return { pruned: 0 };
  pruneRunning = true;
  try {
    // only entries with a definite end date; lasting ones never come here
    const rows = await adbQuery(`SELECT FROM ${ENTITY_LABEL} WHERE _valid_until IS NOT NULL AND _valid_until < :cutoff LIMIT ${Math.max(1, Math.min(500, limit))}`, { cutoff });
    if (rows.length === 0) return { pruned: 0 };
    const records = [];
    for (const row of rows) {
      const rid = String(row["@rid"]);
      if (!RID_RE.test(rid)) continue;
      const raw = await adbQuery(`SELECT @type AS type, @out AS src, @in AS dst FROM (SELECT expand(bothE()) FROM ${rid}) LIMIT 200`).catch(() => []);
      const others = [...new Set(raw.map((e) => String(String(e.src) === rid ? e.dst : e.src)).filter((r) => RID_RE.test(r)))];
      const names = new Map(others.length ? (await adbQuery(`SELECT @rid AS rid, name FROM [${others.join(",")}]`).catch(() => [])).map((n) => [String(n.rid), n.name]) : []);
      const edges = raw.map((e) => {
        const out = String(e.src) === rid;
        const other = String(out ? e.dst : e.src);
        return { type: e.type, direction: out ? "out" : "in", other: names.get(other) ?? other };
      });
      const grants = await adbQuery("SELECT id, to_pos, to_user, expires_at FROM AccessGrant WHERE target = :rid AND status = 'active'", { rid }).catch(() => []);
      records.push(pruneRecord(row, edges, grants));
    }
    const accepted = new Set(await pruneSink.archive(records));
    let pruned = 0;
    const now = new Date().toISOString();
    for (const rec of records) {
      if (!accepted.has(rec.rid)) continue;
      // still expired? (an owner may have extended it since the batch was read)
      const gone = await adbCommand(`DELETE FROM ${ENTITY_LABEL} WHERE @rid = ${rec.rid} AND _valid_until < :cutoff`, "sql", { cutoff });
      if (Number(gone?.[0]?.count ?? 0) !== 1) continue;
      pruned++;
      if (rec.properties?._kind === "document" && rec.properties._doc_id && docStore) await docStore.remove(rec.properties._doc_id).catch(() => {});
      await adbCommand("UPDATE AccessGrant SET status = 'revoked', revoked_at = :now, revoked_by = 'graph-rag: entry pruned' WHERE target = :rid AND status = 'active'", "sql", { now, rid: rec.rid }).catch(() => {});
      const line = ledgerLine(rec, pruneSink);
      await adbCommand(
        "INSERT INTO PruneRecord SET name = :name, home = :home, kind = :kind, valid_until = :valid_until, pruned_at = :pruned_at, sink = :sink, kept = :kept",
        "sql",
        line,
      ).catch((e) => log.warn(`prune record for ${rec.name}: ${String(e).slice(0, 120)}`));
    }
    if (pruned) {
      await refreshGrants();
      log.info(`pruned ${pruned} expired entr${pruned === 1 ? "y" : "ies"} (ended before ${cutoff.slice(0, 10)}; sink ${pruneSink.name}${pruneSink.keeps ? "" : ": nothing kept"})`);
    }
    return { pruned };
  } finally {
    pruneRunning = false;
  }
}

/** for Organization settings: what's waiting to be pruned, and when */
async function prunePreview() {
  const rows = await adbQuery(`SELECT _valid_until AS valid_until FROM ${ENTITY_LABEL} WHERE _valid_until IS NOT NULL AND _valid_until <= :now LIMIT 100000`, { now: new Date().toISOString() }).catch(() => []);
  return { ...prunePreviewDays(rows, policy.pruneAfterDays), sink: pruneSink ? { name: pruneSink.name, keeps: pruneSink.keeps } : { name: PRUNE_SINK, unknown: true } };
}

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
  if (SCOPED && role === "master") {
    server.tool(
      "start_worker",
      `Start a worker on a piece of work: a title, a precise brief (what to do, which entries, what a good
result is) and the entries it's about (by name: the worker reads them). Group entries that belong
together into one worker. audience "everyone" lets it write for Everyone (only for organization-wide
knowledge). level picks the model it runs on: 1 a quick check, 2 an investigation, 3 a broad or
structural matter (default: the highest triage level among its entries). You get a signal when it's
done or stopped. The brief names no entry its entries' people can't see: the worker writes for them.`,
      {
        title: z.string().min(4).max(120),
        brief: z.string().min(20).max(6000),
        entries: z.array(z.string().max(200)).max(25).optional(),
        minutes: z.number().int().min(5).max(180).optional(),
        audience: z.enum(["everyone", "default"]).optional(),
        level: z.number().int().min(1).max(3).optional(),
      },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await masterStartWorker(args, identity)) }] }),
    );
    server.tool(
      "worker_status",
      "A worker's situation: its status, brief, report, changes, and the questions and proposals it's waiting on.",
      { job: z.string() },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await workerSituation(args.job)) }] }),
    );
    server.tool(
      "answer_worker",
      `Settle a stopped worker yourself when you can: your answer to its questions, or what to do next. It
resumes in its own conversation.`,
      { job: z.string(), answer: z.string().min(2).max(3000) },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await answerWorker(args.job, args.answer, identity.user)) }] }),
    );
    server.tool(
      "decide_proposal",
      `Apply or reject a worker's proposal yourself (its worker resumes with your decision). Raw commands and
widening who sees something are the operator's: hand those to a handler, once they're queued (the
handler applies them on the operator's word; asking first means a second handler to apply them).`,
      { id: z.string(), approve: z.boolean(), reason: z.string().max(1000).optional() },
      async (args) => {
        const why = await needsOperator(args.id);
        if (why) throw new Error(`${why} is the operator's decision: start a handler for this worker`);
        return { content: [{ type: "text", text: JSON.stringify(await decideProposal(args.id, args.approve, args.reason ?? "", identity)) }] };
      },
    );
    server.tool(
      "close_worker",
      "Close a worker you won't pursue (its questions dismissed, its proposals rejected). Say why.",
      { job: z.string(), summary: z.string().min(3).max(2000) },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await closeWorker(args.job, args.summary, identity)) }] }),
    );
    server.tool(
      "start_handler",
      `Hand a stopped worker you can't decide for to the operator: a handler thread explains it to them and
records their decision. Describe what's going on and what needs deciding, plainly.`,
      { job: z.string(), description: z.string().min(10).max(3000) },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await startHandler(args.job, args.description, identity)) }] }),
    );
    server.tool(
      "pool_status",
      "How the pool stands: workers by status, handlers waiting on the operator (and whether that halts new batches), entries waiting for the next batch.",
      {},
      async () => {
        const counts = await adbQuery("SELECT status, count(*) AS n FROM Job WHERE kind = 'review' GROUP BY status").catch(() => []);
        return { content: [{ type: "text", text: JSON.stringify({ workers: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])), ...(await masterStatus()) }) }] };
      },
    );
  }

  // ---- a handler's tools: one stopped worker, settled with the operator ----
  if (SCOPED && role === "handler") {
    server.tool(
      "worker_status",
      "The stopped worker you handle: its brief, report, changes, and the questions and proposals it waits on.",
      {},
      async () => {
        const h = (await adbQuery("SELECT payload FROM Job WHERE id = :id AND kind = 'handler'", { id: identity.role.job }))[0];
        return { content: [{ type: "text", text: JSON.stringify(await workerSituation(JSON.parse(h?.payload || "{}").for_job)) }] };
      },
    );
    server.tool(
      "decide_for_worker",
      `Record the operator's decision, only on their word: their answer to the worker's questions, which
proposals to apply, which to reject (with their reason). Proposals are this worker's, or any other pending
one the operator's decision covers (by id: the grader's moves, another worker's duplicate), so one decision
settles it. The worker resumes and the master is told.`,
      {
        answer: z.string().max(3000).optional(),
        approve: z.array(z.string()).max(20).optional(),
        reject: z.array(z.object({ id: z.string(), reason: z.string().max(600).optional() })).max(20).optional(),
      },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlerDecide(args, identity)) }] }),
    );
  }

  // ---- the liaison's tools: workers' questions and proposals, for the admin ----
  if (SCOPED && role === "liaison") {
    server.tool(
      "list_worker_questions",
      "The questions graph worker threads are waiting on, oldest first: which entry, the question, its options, and why the thread asks.",
      {},
      async () => ({ content: [{ type: "text", text: JSON.stringify({ questions: await listQuestions("open") }) }] }),
    );
    server.tool(
      "answer_worker_questions",
      `Record the admin's answer to one or more questions (several threads asking the same thing can share one
answer). Each thread resumes with it. Only answer with what the admin said: never decide for them.
dismiss: true closes the questions without an answer (the threads finish as they are).`,
      { ids: z.array(z.string()).min(1).max(100), answer: z.string().max(2000).optional(), dismiss: z.boolean().optional() },
      async (args) => {
        if (!args.dismiss && !args.answer?.trim()) throw new Error("an answer, or dismiss: true");
        return { content: [{ type: "text", text: JSON.stringify(await answerQuestions(args.ids, { answer: args.answer ?? "", dismiss: args.dismiss === true }, `${identity.user} (for the admin)`)) }] };
      },
    );
    server.tool(
      "list_worker_proposals",
      "Changes graph worker threads proposed (to entries that aren't theirs, merges, raw commands), with each thread's reason.",
      {},
      async () => ({ content: [{ type: "text", text: JSON.stringify({ proposals: await listProposals() }) }] }),
    );
    server.tool(
      "decide_worker_proposal",
      `Apply or reject a worker's proposal, as the admin decided. Only on the admin's say-so. A rejection (and
an approval with a reason) resumes the thread with the reason.`,
      { id: z.string(), approve: z.boolean(), reason: z.string().max(1000).optional() },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await decideProposal(args.id, args.approve, args.reason ?? "", identity)) }] }),
    );
  }

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

/** ---- organization policy (Organization settings; see policy.js) ---- */

const policyDefaults = defaultPolicy();
export let policy = policyDefaults;
let policyMeta = { updated_by: null, updated_at: null };

export const expiryRules = (identity, scope) => ({
  root: scope.root,
  agent: Boolean(identity.agent),
  maxDays: policy.maxGrantDays,
  defaultDays: policy.defaultShareDays,
  standing: policy.standingGrants,
});

async function ensurePolicySchema() {
  await adbCommand("CREATE DOCUMENT TYPE OrgPolicy IF NOT EXISTS").catch(() => {});
  await adbCommand("CREATE DOCUMENT TYPE PolicyChange IF NOT EXISTS").catch(() => {});
  for (const prop of ["scope", "json", "updated_by", "updated_at"]) await adbCommand(`CREATE PROPERTY OrgPolicy.${prop} IF NOT EXISTS STRING`).catch(() => {});
  // (no "by"/"before"/"after": reserved words in ArcadeDB SQL)
  for (const prop of ["changed_at", "changed_by", "prev_json", "next_json"]) await adbCommand(`CREATE PROPERTY PolicyChange.${prop} IF NOT EXISTS STRING`).catch(() => {});
}

async function loadPolicy() {
  try {
    const row = (await adbQuery("SELECT FROM OrgPolicy WHERE scope = 'org' LIMIT 1"))[0];
    policy = row ? normalizeStored(JSON.parse(row.json), policyDefaults) : policyDefaults;
    policyMeta = { updated_by: row?.updated_by ?? null, updated_at: row?.updated_at ?? null };
  } catch (e) {
    log.warn(`policy load failed (keeping the current one): ${String(e).slice(0, 120)}`);
  }
}

/** a root person changes the policy; every change is recorded */
async function savePolicy(input, identity) {
  const next = applyPolicyUpdate(policy, input);
  const now = new Date().toISOString();
  const updated = await adbCommand("UPDATE OrgPolicy SET json = :json, updated_by = :by_user, updated_at = :now WHERE scope = 'org'", "sql", {
    json: JSON.stringify(next),
    by_user: identity.user,
    now,
  });
  if (Number(updated?.[0]?.count ?? 0) === 0) {
    await adbCommand("INSERT INTO OrgPolicy SET scope = 'org', json = :json, updated_by = :by_user, updated_at = :now", "sql", {
      json: JSON.stringify(next),
      by_user: identity.user,
      now,
    });
  }
  await adbCommand("INSERT INTO PolicyChange SET changed_at = :now, changed_by = :by_user, prev_json = :prev, next_json = :next", "sql", {
    now,
    by_user: identity.user,
    prev: JSON.stringify(policy),
    next: JSON.stringify(next),
  }).catch((e) => log.warn(`policy change not logged: ${String(e).slice(0, 120)}`));
  log.info(`organization policy changed by ${identity.user}: ${JSON.stringify(input)}`);
  policy = next;
  policyMeta = { updated_by: identity.user, updated_at: now };
  return policy;
}

const canEditPolicy = (identity, scope) => !identity.agent && !identity.open && scope.root && SCOPED;

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
