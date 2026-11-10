/**
 * The orchestrator (docs/ORGANIZATION-MODEL.md, "The orchestrator, workers and briefs"): the most privileged agent.
 * It reads batches in full, makes the broad class decisions (the classes stream's class tools), and starts workers
 * (R7). Every record gets a worker (R4), one per home of its sections, each seeing only its audience (R11). It
 * answers workers' requests, structured (R10), re-files Kept pieces when a fitting class or source appears (R11),
 * and checks each worker's account against the source itself (R10, R11). It never approves a Proposed piece: a
 * person with authority for the class does (R11).
 *
 * It writes no brief: a worker's brief is composed in code from the graph as its audience sees it
 * (worker-pool.js composeFilingBrief), so nothing the orchestrator reads reaches a worker through one.
 *
 * The filing stream owns this module. master-tools.js keeps the batch inbox, handlers and liaison and calls in here.
 */
import { z } from "zod";
import { log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { effectiveHome, homeName } from "./positions.js";
import { positionMap } from "./scope.js";
import { accountEvidence, answerRequest, filingLog, keptPieces, liveEnv, recordVerdict, refileRefusal, REFILE_LIMIT } from "./filing.js";
import { ANSWERS, VERDICTS } from "./model/filing.js";
import { splitByHome } from "./model/brief.js";

export const ORCHESTRATOR = "master"; // the role kind stays `master` (NEEDS A RULING F13): the shared GraphRole type is unchanged

const db0 = { adbQuery, adbCommand };

/** a record's sections, each with its home (effective) */
async function sectionsOf(record, db = db0, positions = positionMap) {
  const rows = await db.adbQuery(`SELECT @rid AS rid, _home, heading, text_identity FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :d ORDER BY _section`, { d: record });
  return rows.map((r) => ({ rid: String(r.rid), home: effectiveHome(positions, r._home), heading: r.heading ?? null, text: r.text_identity ?? "" }));
}

/** the jobs filing a record at a home, any status */
const jobsFor = (record, home, db = db0) => db.adbQuery("SELECT id, status FROM Job WHERE kind = 'review' AND job_key = :k", { k: `file:${record}:${home}` }).catch(() => []);

/**
 * Start a record's workers: one per home of its sections (R11). A home that already has its filing job keeps it
 * (a record is filed once; re-filing is `refile`). Returns the jobs, by home.
 */
export async function startRecordWorkers(record, { by, level, minutes, refile = null, why = null } = {}, { db = db0, enqueue, positions = positionMap, pool } = {}) {
  const doc = (await db.adbQuery(`SELECT _on_record FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: record }).catch(() => []))[0];
  if (!doc) throw new Error(`no record ${record}`);
  // nothing from an off-record thread reaches the graph or any source (R11)
  if (doc._on_record !== true) throw new Error(`record ${record} isn't on record: it gets no worker`);
  const groups = splitByHome(await sectionsOf(record, db, positions));
  const q = enqueue ?? (await import("./worker-pool.js")).enqueue;
  const settings = pool ?? (await import("./worker-pool.js")).worker.pool;
  const out = [];
  for (const g of groups) {
    const key = refile ? `refile:${record}:${g.audience}:${refile.join(",")}` : `file:${record}:${g.audience}`;
    if (!refile) {
      const had = await jobsFor(record, g.audience, db);
      if (had.length) {
        out.push({ home: g.audience, job: had[0].id, already: true });
        continue;
      }
    }
    const label = `${refile ? "re-file" : "file"} ${g.sections.length} section${g.sections.length === 1 ? "" : "s"} at ${positions ? homeName(positions, g.audience) : g.audience}`;
    const lvl = Math.max(1, Math.min(3, Number(level) || 2));
    const job = await q(
      "review",
      { rid: g.sections[0].rid, sections: g.sections.map((s) => s.rid), record, home: g.audience, parent: ORCHESTRATOR, by, label, minutes: Math.max(5, Math.min(180, Number(minutes) || settings.threadMinutes)), level: lvl, ...(refile ? { refile } : {}), ...(why ? { why } : {}) },
      { key, priority: 3 },
    );
    out.push({ home: g.audience, job });
  }
  return out;
}

/** what a batch tells the orchestrator of each record: in full, it being the most privileged agent (R7) */
export async function recordsForBatch(rids, db = db0, positions = positionMap) {
  const byRecord = new Map();
  for (const rid of rids) {
    if (!RID_RE.test(String(rid))) continue;
    const row = (await db.adbQuery(`SELECT _doc_id, _kind FROM ${rid}`).catch(() => []))[0];
    if (row?._kind !== "section" || !row._doc_id) continue;
    byRecord.set(row._doc_id, true);
  }
  const out = [];
  for (const record of byRecord.keys()) {
    const doc = (await db.adbQuery(`SELECT name, _recorded_by, _on_record FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: record }).catch(() => []))[0];
    if (doc?._on_record !== true) continue;
    const sections = (await sectionsOf(record, db, positions)).map((s) => ({ rid: s.rid, home: positions ? homeName(positions, s.home) : s.home, heading: s.heading, text: String(s.text).slice(0, 1200) }));
    out.push({ record, title: doc.name ?? null, recorded_by: doc._recorded_by ?? null, sections });
  }
  return out;
}

/**
 * Every record gets a worker (R4): a batch's record the orchestrator left without one is started here once the
 * batch has waited `minutes` (NEEDS A RULING F9). Returns how many it started.
 */
export async function startUnstarted({ minutes, db = db0, start = startRecordWorkers } = {}) {
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
  const open = await db.adbQuery("SELECT id, entries FROM WorkBatch WHERE status = 'open' AND created_at < :c LIMIT 50", { c: cutoff }).catch(() => []);
  let started = 0;
  for (const b of open) {
    let records = [];
    try {
      records = JSON.parse(b.entries || "[]");
    } catch {
      /* none */
    }
    for (const record of records) {
      const had = await db.adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'review' AND job_key LIKE :k", { k: `file:${record}:%` }).catch(() => []);
      if (Number(had[0]?.n ?? 0) > 0) continue;
      try {
        started += (await start(record, { by: "graph-rag (every record gets a worker)" })).filter((j) => !j.already).length;
      } catch (e) {
        log.warn(`record ${record}: no worker started: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    }
    await db.adbCommand("UPDATE WorkBatch SET status = 'closed' WHERE id = :id", "sql", { id: b.id });
  }
  return started;
}

/**
 * re-file Kept pieces (by entry id) in a later batch: one worker per record and home, pointing back at them (R11).
 * R14: an entry is refused, with its reason, when it was re-filed REFILE_LIMIT times already or when no class was
 * created and no source table declared since it was Kept; the others go ahead.
 */
export async function refileKept(ids, by, env) {
  const groups = new Map();
  const refused = [];
  for (const id of ids) {
    const e = (await env.store.entries({ id: String(id) }))[0];
    if (!e || e.outcome !== "kept") throw new Error(`entry ${id} isn't a Kept piece`);
    const why = await refileRefusal(env, e);
    if (why) {
      refused.push({ entry: e.id, reason: why });
      continue;
    }
    const k = `${e.record}\u0000${e.home}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const out = [];
  for (const list of groups.values()) {
    const jobs = await (env.startRecordWorkers ?? startRecordWorkers)(list[0].record, { by, refile: list.map((e) => e.id), why: "a fitting class or source may exist now for pieces that were Kept" });
    out.push(...jobs.filter((j) => j.home === list[0].home));
  }
  return { started: out, ...(refused.length ? { refused } : {}) };
}

const reply = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });

/** the orchestrator's own filing tools (registered with its other tools: master-tools.js registerMasterTools) */
export function registerOrchestratorTools(server, { identity }) {
  server.tool(
    "start_worker",
    `Start a record's workers (by its record id, as the batch names it): one per home of its sections,
each seeing only what people at that home see. Every record gets a worker; a record already being filed
keeps its workers. level picks the model: 1 quick, 2 the default, 3 a broad matter. Its brief is composed
for it from the graph: you write none.`,
    { record: z.string().min(3).max(120), level: z.number().int().min(1).max(3).optional(), minutes: z.number().int().min(5).max(180).optional() },
    async (args) => reply({ started: await startRecordWorkers(args.record, { by: identity.user, level: args.level, minutes: args.minutes }), note: "You'll get a signal when each is done or stopped." }),
  );
  server.tool(
    "answer_request",
    `Answer a worker's request, structured: ${ANSWERS.join(", ")}. use_class and class_created name the
class, one the worker's audience can see; update says a conflict with the source is really a change the
record states. No free text reaches the worker.`,
    { request: z.string().min(8).max(80), decision: z.enum(ANSWERS), class: z.string().max(80).optional() },
    async (args) => reply(await answerRequest(args.request, { decision: args.decision, ...(args.class ? { class: args.class } : {}) }, identity.user, await liveEnv())),
  );
  server.tool(
    "open_requests",
    "Workers' requests not yet answered: kind, record, home, question.",
    {},
    async () => reply({ requests: await (await liveEnv()).store.requests({ status: "open" }) }),
  );
  server.tool(
    "filing_log",
    "The filing log: every outcome, Filed, Proposed, Held or Kept, with its row, class, account and verdict. Filter by record, outcome or worker (its job id).",
    { record: z.string().max(120).optional(), outcome: z.enum(["filed", "proposed", "held", "kept"]).optional(), worker: z.string().max(80).optional() },
    async (args) => reply(await filingLog(args, await liveEnv())),
  );
  server.tool(
    "kept_pieces",
    `Kept pieces that may be re-filed now: nothing has re-filed them yet, a class was created or a source table declared
since each was Kept, and none has been re-filed ${REFILE_LIMIT} times already (R14). Re-file those a new class or
source fits (graph-rag_refile); leave the rest. Recurring Kept pieces are a signal for a class.`,
    {},
    async () => reply({ kept: await keptPieces(await liveEnv()) }),
  );
  server.tool(
    "refile",
    `Re-file Kept pieces (by entry id, from graph-rag_kept_pieces) that a class created or a source table declared since
they were Kept now fits: a worker per record and home files them again, and the Kept entries stay. Refused, with the
reason, for a piece with nothing new since it was Kept or re-filed ${REFILE_LIMIT} times already (R14).`,
    { entries: z.array(z.string().min(8).max(80)).min(1).max(50) },
    async (args) => reply(await refileKept(args.entries, identity.user, await liveEnv())),
  );
  server.tool(
    "check_account",
    "A worker's account against the source itself: each entry it wrote, what it said it did, the row as the source holds it now, and a suggested verdict.",
    { job: z.string().min(8).max(80) },
    async (args) => reply(await accountEvidence(args.job, await liveEnv())),
  );
  server.tool(
    "record_verdict",
    `Your verdict on one entry's account, after checking it against the source: ${VERDICTS.join(", ")}. A
"differs" flags the entry for a person; nothing is undone.`,
    { entry: z.string().min(8).max(80), result: z.enum(VERDICTS), note: z.string().max(1000).optional() },
    async (args) => reply(await recordVerdict(args.entry, { result: args.result, note: args.note }, identity.user, await liveEnv())),
  );
}

/** for tests: the orchestrator's filing tools, and the master tools that went (R11: it never approves) */
export const ORCHESTRATOR_TOOLS = ["start_worker", "answer_request", "open_requests", "filing_log", "kept_pieces", "refile", "check_account", "record_verdict"];
export const REMOVED_ORCHESTRATOR_TOOLS = ["decide_proposal", "answer_worker"];
