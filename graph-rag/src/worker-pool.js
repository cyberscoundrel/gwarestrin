/**
 * The graph worker's job queue and the pool of threads (see pool.js): claiming, finishing and resuming threads,
 * their questions and proposals, the change log, and the worker's settings and status.
 *
 * A thread's unit of work is a record's sections at one home (R11: a record whose sections have different homes
 * is split by home, one worker per home). Its brief holds nothing its sections' people can't see (R7), and is a
 * read recorded like any other (floor.js `recordReads`), so it bounds the worker's writes. The filing stream
 * owns this module and builds filing on it (model/filing.js, model/brief.js).
 */
import { randomUUID } from "node:crypto";
import { canSee, effectiveHome, EVERYONE, homeName, moveKind } from "./positions.js";
import { checkBriefFloor, POOL_DEFAULTS, poolSettings, resumeBrief, taskBrief, taskThreadBrief } from "./pool.js";
import { EMBED_MODEL, health, log, loops, WORKER_DAILY_CALLS, WORKER_MODEL, WORKER_TIMEOUT_MS } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, PENDING_ID_RE, RID_RE } from "./db.js";
import { chat } from "./models.js";
import { recordReads } from "./floor.js";
import { assertBrief, scopeBrief } from "./model/brief.js";
import { briefSource } from "./model/sources.js";
import { accountGiven, ensureFilingSchema, liveEnv, settleProposals } from "./filing.js";
import { entriesByUser, positionMap, SCOPED } from "./scope.js";
import { emitSignal, MASTER, masterStatus, openItems } from "./master-tools.js";
import { describeEntry } from "./data-entry.js";

/** ---- the graph worker: a job queue and loop ---- */

// the worker's settings come from the admin's "Graph worker" profile (PUT /api/worker)
export let worker = { enabled: true, model: "", instructions: "", profile: null, pool: { ...POOL_DEFAULTS }, updated_by: null, updated_at: null };
// only a model someone chose: falling back to the grader's would spend its quota on every write
export const workerModel = () => worker.model || WORKER_MODEL;
const workerUsage = { day: "", calls: 0 }; // model calls today (WORKER_DAILY_CALLS caps them)
let workerTicking = false;

/** the worker's settings, replaced as a whole (PUT /api/worker) */
export function setWorker(next) {
  worker = next;
}

export async function ensureWorkerSchema() {
  await adbCommand("CREATE DOCUMENT TYPE Job IF NOT EXISTS").catch(() => {});
  for (const prop of ["id", "kind", "job_key", "payload", "status", "run_after", "created_at", "updated_at", "error"]) {
    await adbCommand(`CREATE PROPERTY Job.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
  for (const prop of ["attempts", "priority"]) await adbCommand(`CREATE PROPERTY Job.${prop} IF NOT EXISTS INTEGER`).catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON Job (job_key) NOTUNIQUE").catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON Job (status) NOTUNIQUE").catch(() => {});
  for (const prop of ["_norm"]) await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS STRING`).catch(() => {});
  for (const prop of ["_homes", "_alias_norms", "_keys"]) await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS LIST`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (_norm) NOTUNIQUE`).catch(() => {});
  for (const prop of ["agent_id", "summary", "lease_until", "claimed_at", "changes"]) await adbCommand(`CREATE PROPERTY Job.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._reviewed_at IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand("CREATE DOCUMENT TYPE WorkerQuestion IF NOT EXISTS").catch(() => {});
  for (const prop of ["id", "job_id", "entry", "entry_name", "question", "options", "why", "asked_by", "status", "answer", "answered_by", "created_at", "answered_at"]) {
    await adbCommand(`CREATE PROPERTY WorkerQuestion.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
  await adbCommand("CREATE INDEX IF NOT EXISTS ON WorkerQuestion (job_id) NOTUNIQUE").catch(() => {});
  await adbCommand("CREATE EDGE TYPE RELATES IF NOT EXISTS").catch(() => {});
  for (const prop of ["rel", "evidence", "job", "at"]) await adbCommand(`CREATE PROPERTY RELATES.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._task_by IF NOT EXISTS STRING`).catch(() => {});
  // a Held piece's question names whoever put the record on record, and its entry (filing.js)
  await ensureFilingSchema();
  // a crash mid-job leaves it running: it runs again (threads keep their lease: their workspace may still run them)
  await adbCommand("UPDATE Job SET status = 'pending' WHERE status = 'running' AND kind <> 'review'").catch(() => {});
  try {
    const row = (await adbQuery("SELECT FROM OrgPolicy WHERE scope = 'worker' LIMIT 1"))[0];
    if (row) {
      const saved = JSON.parse(row.json);
      worker = { ...worker, ...saved, pool: poolSettings(saved.pool ?? {}, POOL_DEFAULTS), updated_by: row.updated_by ?? null, updated_at: row.updated_at ?? null };
    }
  } catch {
    /* defaults */
  }
}

/** queue a job once: a pending one with the same key is reused (and raised in priority) */
export async function enqueue(kind, payload, { key, priority = 0 } = {}) {
  const job_key = key ?? `${kind}:${JSON.stringify(payload)}`;
  const open = (await adbQuery("SELECT id, priority FROM Job WHERE job_key = :k AND status IN ['pending', 'running'] LIMIT 1", { k: job_key }).catch(() => []))[0];
  if (open) {
    if (priority > Number(open.priority ?? 0)) await adbCommand("UPDATE Job SET priority = :p WHERE id = :id AND status = 'pending'", "sql", { p: priority, id: open.id });
    return open.id;
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  await adbCommand(
    "INSERT INTO Job SET id = :id, kind = :kind, job_key = :k, payload = :payload, status = 'pending', attempts = 0, priority = :p, run_after = :now, created_at = :now, updated_at = :now",
    "sql",
    { id, kind, k: job_key, payload: JSON.stringify(payload), p: priority, now },
  );
  return id;
}

/** one model call for the worker, counted against the daily budget */
export async function workerCall(messages) {
  const day = new Date().toISOString().slice(0, 10);
  if (workerUsage.day !== day) Object.assign(workerUsage, { day, calls: 0 });
  if (workerUsage.calls >= Number(WORKER_DAILY_CALLS)) throw Object.assign(new Error("the worker's daily budget is used up"), { later: true });
  workerUsage.calls++;
  return chat(workerModel(), messages, Number(WORKER_TIMEOUT_MS));
}

/** ---- the worker pool (see pool.js): one agent thread per section, run by the admin's workspace ---- */

export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);

/** threads started today (first starts and resumes) */
async function threadsToday() {
  const rows = await adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'review' AND claimed_at >= :day", { day: today() }).catch(() => []);
  return Number(rows[0]?.n ?? 0);
}

/** the root tenant's user (the admin whose workspace runs the threads), or null when it can't be told */
export function rootTenantUser() {
  if (!positionMap) return null;
  const roots = [...entriesByUser.values()].filter((e) => Array.isArray(e.positions) && e.positions.includes(positionMap.root) && e.caps?.write === "direct" && e.caps?.read === true && typeof e.delegationKey === "string");
  return roots.length === 1 ? roots[0].user : null;
}

/** the brief was shown to the thread's agent: recorded as that agent's read, so it bounds what it writes */
function recordBriefRead(agentId, homes) {
  const root = rootTenantUser();
  if (!root || !agentId || !homes?.length) return;
  recordReads({ key: `${root}/agent:${agentId}`, user: `${root}/worker:${String(agentId).slice(0, 8)}` }, homes);
}

/**
 * A level's share of a model with a limit: [{levels, room}] from the
 * workspace (levels on one model share it; 0 = a thread with no level). A
 * thread of a full group stays pending, keeping its tries, for the next claim.
 */
function levelRoom(groups) {
  const room = new Map(); // level -> its group's counter
  for (const g of Array.isArray(groups) ? groups.slice(0, 8) : []) {
    const counter = { left: Math.max(0, Math.floor(Number(g?.room) || 0)) };
    for (const l of Array.isArray(g?.levels) ? g.levels : []) if ([0, 1, 2, 3].includes(Number(l))) room.set(Number(l), counter);
  }
  return room;
}

/**
 * The admin's workspace claims up to `limit` threads to run: due review jobs, highest priority first,
 * within the day's budget. Each comes with its brief (a first start: its sections and their record,
 * checked against the floor) or its resume message (an answered question, a decided
 * proposal) and the thread's agent if it has one. A brief that would carry anything above the worker's
 * floor is refused here, and the job fails with the reason: no worker ever sees it.
 */
export async function claimThreads(limit, groups) {
  // a thread on a model that's out would only fail: none start until it's back
  const paused = health.outage(`model:${workerModel()}`);
  if (paused) return { threads: [], paused: paused.message };
  const room = Math.max(0, Math.min(Number(limit) || 0, worker.pool.poolSize, worker.pool.dailyThreads - (await threadsToday())));
  if (!room) return { threads: [] };
  const now = new Date();
  const limited = levelRoom(groups);
  // with a full model, look past its threads for ones that can run
  const due = await adbQuery(`SELECT id, payload, agent_id, attempts FROM Job WHERE kind = 'review' AND status = 'pending' AND run_after <= :now ORDER BY priority DESC, created_at ASC LIMIT ${limited.size ? Math.min(200, Math.floor(room) * 10) : Math.floor(room)}`, {
    now: now.toISOString(),
  });
  const out = [];
  for (const job of due) {
    if (out.length >= room) break;
    const counter = limited.get(Number(JSON.parse(job.payload || "{}").level) || 0);
    if (counter && counter.left <= 0) continue;
    const minutes = Number(JSON.parse(job.payload || "{}").minutes) || worker.pool.threadMinutes;
    const lease = new Date(now.getTime() + (minutes + 5) * 60_000).toISOString();
    const claimed = await adbCommand("UPDATE Job SET status = 'running', claimed_at = :now, lease_until = :lease, updated_at = :now WHERE id = :id AND status = 'pending'", "sql", {
      now: now.toISOString(),
      lease,
      id: job.id,
    });
    if (Number(claimed?.[0]?.count ?? 0) !== 1) continue;
    if (counter) counter.left--;
    const payload = JSON.parse(job.payload || "{}");
    if (!RID_RE.test(String(payload.rid))) {
      await adbCommand("UPDATE Job SET status = 'done', summary = 'the entry is gone', updated_at = :now WHERE id = :id", "sql", { now: now.toISOString(), id: job.id });
      continue;
    }
    let message;
    let name;
    let homes = [];
    if (payload.resume) {
      message = resumeBrief(payload.resume);
      name = payload.label ?? (await adbQuery(`SELECT name FROM ${payload.rid}`).catch(() => []))[0]?.name ?? "a thread";
    } else if (payload.task) {
      message = taskThreadBrief(payload.task);
      name = payload.task.title;
    } else {
      // a record's sections at one home: the job is set up as a filing job (one per record and home, R11), gated, then briefed
      const setup = await filingJob(job.id, payload);
      if (setup.skip) {
        const later = setup.skip === "later";
        await adbCommand(`UPDATE Job SET status = :s, summary = :sum, run_after = :ra, claimed_at = null, updated_at = :now WHERE id = :id`, "sql", { s: later ? "pending" : "done", sum: setup.why, ra: new Date(now.getTime() + (later ? 60_000 : 0)).toISOString(), now: now.toISOString(), id: job.id });
        continue;
      }
      let composed;
      try {
        composed = await composeFilingBrief(setup.payload);
        homes = checkBriefFloor(positionMap, composed.brief.sections);
        // every brief is logged before it goes out (the integrator's leak gate scans BriefLog); one that can't be logged isn't sent
        // the message is computed here so the log holds exactly what the worker receives, `why` included
        message = taskBrief({ ...composed, why: payload.why });
        await logBrief({ record: setup.payload.record, worker: job.id, composed, why: payload.why ?? null, message });
      } catch (e) {
        // the brief would show the worker something its sections' people can't see: refused here, never sent
        await adbCommand("UPDATE Job SET status = 'failed', summary = :s, error = :s, updated_at = :now WHERE id = :id", "sql", { s: `brief refused: ${String(e.message).slice(0, 600)}`, now: now.toISOString(), id: job.id });
        if (payload.parent === MASTER) await emitSignal("stopped", { job_id: job.id, data: { title: payload.label ?? "a worker", reason: "its brief was refused", error: String(e.message).slice(0, 600) } });
        log.warn(`thread ${String(job.id).slice(0, 8)}: brief refused: ${String(e.message).slice(0, 160)}`);
        continue;
      }
      Object.assign(payload, setup.payload);
      name = payload.label ?? labelFor(composed.brief.sections);
      // the brief is a read: recorded for the thread's agent now when it has one, else when the workspace names it
      if (job.agent_id) recordBriefRead(job.agent_id, homes);
      else payload.brief_homes = homes;
      // the job now says which record, home and sections it files: its tools read them from here, never from the model
      await adbCommand("UPDATE Job SET payload = :p WHERE id = :id", "sql", { p: JSON.stringify(payload), id: job.id });
    }
    out.push({
      job: job.id,
      entry: payload.rid,
      name,
      agent_id: job.agent_id ?? null,
      ...(payload.level ? { level: payload.level } : {}),
      minutes: Number(payload.minutes) || worker.pool.threadMinutes,
      message,
    });
  }
  return { threads: out };
}

/**
 * A review job becomes a filing job: one record, its sections at one home (R11: split by home, one worker per home).
 * A job queued for one section (no orchestrator: write.js queues one per section) takes in the record's other
 * sections at that home that no filing job holds yet, and one whose section another job already holds is done.
 * Gates: nothing off record reaches a worker (R11), and a section the check hasn't answered waits (NEEDS A RULING
 * F11: its home may still drop, and the worker would have read above it). Returns { payload } or { skip, why }.
 */
export async function filingJob(jobId, payload, db = { adbQuery, adbCommand }, positions = positionMap) {
  const first = RID_RE.test(String(payload.rid)) ? (await db.adbQuery(`SELECT _doc_id, _home, _kind FROM ${payload.rid}`).catch(() => []))[0] : null;
  const record = payload.record ?? first?._doc_id ?? null;
  if (!record) return { skip: "done", why: "the section is gone, or belongs to no record" };
  const doc = (await db.adbQuery(`SELECT _on_record FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: record }).catch(() => []))[0];
  if (doc?._on_record !== true) return { skip: "done", why: "not on record: nothing from an off-record thread reaches the graph or a source (R11)" };
  const home = payload.home ?? effectiveHome(positions, first?._home);
  const all = await db.adbQuery(`SELECT @rid AS rid, _home, _ungraded FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :d ORDER BY _section`, { d: record });
  const atHome = all.filter((s) => effectiveHome(positions, s._home) === home);
  if (atHome.some((s) => s._ungraded !== null && s._ungraded !== undefined)) return { skip: "later", why: "waiting for the check on a section (its home may still change)" };
  let sections = Array.isArray(payload.sections) && payload.record ? payload.sections.filter((r) => atHome.some((s) => String(s.rid) === r)) : atHome.map((s) => String(s.rid));
  if (!payload.record) {
    // the per-section path: what another filing job of this record and home already holds isn't filed twice
    const others = await db.adbQuery("SELECT id, payload FROM Job WHERE kind = 'review' AND id <> :id AND job_key = :k", { id: jobId, k: `file:${record}:${home}` }).catch(() => []);
    const held = new Set(others.flatMap((o) => JSON.parse(o.payload || "{}").sections ?? []));
    if (held.has(String(payload.rid))) return { skip: "done", why: "filed with its record's other sections" };
    sections = sections.filter((r) => !held.has(r));
    await db.adbCommand("UPDATE Job SET job_key = :k WHERE id = :id", "sql", { k: `file:${record}:${home}`, id: jobId }).catch(() => {});
  }
  if (!sections.length) return { skip: "done", why: "no section of the record is left at this home" };
  return { payload: { ...payload, rid: sections[0], record, home, sections } };
}

/**
 * The brief a filing worker starts with (R7): the record's sections at its home, the record (its title only if its
 * audience sees it: R11), the class tree, the instances its sections relate to with the dependencies between them,
 * how each source is committed to, and any Kept or Held pieces it re-files. Gathered here, then scoped to the
 * audience and checked (model/brief.js scopeBrief, assertBrief): a brief holding anything above it is refused.
 */
export async function composeFilingBrief(payload, { db = { adbQuery }, positions = positionMap, sources, entries } = {}) {
  const home = payload.home;
  const rids = payload.sections;
  const rows = await db.adbQuery(`SELECT @rid AS rid, name, heading, text_identity, _home, _doc_id FROM [${rids.join(",")}] WHERE _kind = 'section'`);
  const sections = rows.filter((r) => r._doc_id === payload.record).map((r) => ({ rid: String(r.rid), heading: r.heading ?? null, text: String(r.text_identity ?? "").slice(0, 4000), home: effectiveHome(positions, r._home) }));
  if (!sections.length) throw new Error("the record's sections are gone");
  const doc = (await db.adbQuery(`SELECT name, _home, description FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: payload.record }))[0];
  // the title takes the strictest home among the sections (R11): the document's own home
  const record = doc ? { id: payload.record, title: doc.name ?? null, description: doc.description ?? null, home: effectiveHome(positions, doc._home) } : null;
  const classRows = await db.adbQuery(`SELECT @rid AS rid, _class_key, _class_name, _home, _rows_are_nodes, _record_table, _status, _description FROM ${ENTITY_LABEL} WHERE _kind = 'class' AND (_status IS NULL OR _status <> 'retired') LIMIT 1000`).catch(() => []);
  const keyOf = new Map(classRows.map((c) => [String(c.rid), c._class_key]));
  const sub = classRows.length ? await db.adbQuery("SELECT @out AS o, @in AS i FROM SUBCLASS_OF").catch(() => []) : [];
  const parents = new Map();
  for (const e of sub) if (keyOf.has(String(e.o)) && keyOf.has(String(e.i))) parents.set(keyOf.get(String(e.o)), [...(parents.get(keyOf.get(String(e.o))) ?? []), keyOf.get(String(e.i))]);
  const classes = classRows.map((c) => ({ key: c._class_key, name: c._class_name ?? c._class_key, parents: parents.get(c._class_key) ?? [], home: c._home ?? null, description: c._description ?? null, rows_are_nodes: c._rows_are_nodes === true, record_table: c._record_table ?? null }));
  // a link (INSTANCE_OF, DEPENDS_ON) is seen where its home is seen; one with no home counts as the root's
  const linkSeen = (h) => canSee(positions, [home], h ?? positions.root);
  const related = await db.adbQuery(`SELECT @rid AS rid, label, _homes, _keys FROM (SELECT expand(out('ABOUT')) FROM [${rids.join(",")}]) WHERE _kind = 'thing'`).catch(() => []);
  const instances = [];
  const seen = new Set();
  for (const r of related) {
    if (seen.has(String(r.rid))) continue;
    seen.add(String(r.rid));
    // its classes by links the audience sees: an INSTANCE_OF edge carries its own home, none meaning the root (R11.8, R11.9)
    const of = await db.adbQuery(`SELECT @in AS cls, home FROM (SELECT expand(outE('INSTANCE_OF')) FROM ${r.rid})`).catch(() => []);
    const classesOf = of.filter((e) => linkSeen(e.home)).map((e) => keyOf.get(String(e.cls))).filter(Boolean);
    instances.push({ rid: String(r.rid), label: r.label ?? null, homes: Array.isArray(r._homes) ? r._homes : [], keys: Array.isArray(r._keys) ? r._keys : [], classes: [...new Set(classesOf)] });
  }
  // how each source is committed to (R7), from its declaration: its tables and actions as declared, and only the
  // sources whose read home the audience sees (R11.6, R11.9; no home: the root). Never a URL (briefSource).
  const decls = sources ?? (await (await import("./sources.js")).loadSources(undefined, { ttlMs: 0 }).catch(() => ({})));
  const srcs = Object.values(decls)
    .filter((d) => d && canSee(positions, [home], d.read?.home ?? positions.root))
    .map(briefSource);
  const { brief, dropped } = scopeBrief({ audience: home, record, sections, classes, instances, sources: srcs }, positions);
  // a dependency is seen only by someone who sees both ends (R11): only between instances the brief keeps
  const kept = new Set(brief.instances.map((i) => i.rid));
  const deps = kept.size ? await db.adbQuery(`SELECT @out AS src, @in AS dst, stated_as, note, home FROM (SELECT expand(outE('DEPENDS_ON')) FROM [${[...kept].join(",")}])`).catch(() => []) : [];
  // both ends seen, and the link's own home seen (none: the root)
  const dependencies = deps.filter((d) => kept.has(String(d.src)) && kept.has(String(d.dst)) && linkSeen(d.home)).map((d) => ({ from: String(d.src), to: String(d.dst), stated_as: d.stated_as ?? null, note: d.note ?? null }));
  assertBrief(brief, positions);
  // the Kept or Held pieces it re-files (R11): only this record's, at this home
  const byId = entries ?? (async (id) => (await import("./filing.js")).arcadeStore().entries({ id }));
  const toRefile = [];
  for (const id of Array.isArray(payload.refile) ? payload.refile : []) for (const e of await byId(id)) if (e.record === payload.record && e.home === home) toRefile.push({ entry: e.id, outcome: e.outcome, piece: e.piece, section: e.section });
  return { brief, dropped, dependencies, refile: toRefile };
}

/**
 * One BriefLog row per brief sent (model/schema.js BriefLog, the integrator's: a document, outside the graph):
 * { id, record, audience, worker (the job), brief (JSON: the scoped brief, the dependencies and pieces to re-file that
 * go out with it, the `why` it carries, and the message as sent), dropped (JSON: what scopeBrief left out, counted),
 * at }. Throws when the row can't be written: the caller refuses the brief.
 */
export async function logBrief({ record, worker: job, composed, why = null, message = null }, db = { adbCommand }) {
  const row = {
    id: randomUUID(),
    record: String(record),
    audience: String(composed.brief.audience),
    worker: String(job),
    brief: JSON.stringify({ ...composed.brief, dependencies: composed.dependencies ?? [], refile: composed.refile ?? [], why, message }),
    dropped: JSON.stringify(composed.dropped ?? {}),
    at: new Date().toISOString(),
  };
  try {
    await db.adbCommand("INSERT INTO BriefLog SET id = :id, record = :record, audience = :audience, worker = :worker, brief = :brief, dropped = :dropped, at = :at", "sql", row);
  } catch (e) {
    throw new Error(`the brief couldn't be logged, so it isn't sent: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  return row;
}

/** a thread's label for the rail: how many sections and where, never a title or text */
export function labelFor(sections) {
  const homes = [...new Set(sections.map((s) => s.home_name ?? s.home).filter(Boolean))];
  return `${sections.length} section${sections.length === 1 ? "" : "s"}${homes.length ? ` at ${homes.join(", ")}` : ""}`;
}

/** a thread's agent (recorded when the workspace makes it); the brief it was sent counts as its read */
export async function threadAgent(jobId, agentId) {
  if (!JOB_ID_RE.test(String(jobId)) || typeof agentId !== "string" || !/^[\w-]{1,80}$/.test(agentId)) throw Object.assign(new Error("invalid job or agent"), { status: 400 });
  await adbCommand("UPDATE Job SET agent_id = :a, updated_at = :now WHERE id = :id AND kind = 'review'", "sql", { a: agentId, now: new Date().toISOString(), id: jobId });
  const job = (await adbQuery("SELECT payload FROM Job WHERE id = :id AND kind = 'review'", { id: jobId }).catch(() => []))[0];
  const payload = JSON.parse(job?.payload || "{}");
  if (Array.isArray(payload.brief_homes) && payload.brief_homes.length) {
    recordBriefRead(agentId, payload.brief_homes);
    delete payload.brief_homes;
    await adbCommand("UPDATE Job SET payload = :p WHERE id = :id", "sql", { p: JSON.stringify(payload), id: jobId }).catch(() => {});
  }
  return { ok: true };
}

/** the thread ended its turn: done, or waiting on its open questions */
/** a thread whose turn died on the model connection waits it out this many times before it counts as a failure */
const MAX_OUTAGE_DEFERRALS = 6;

export async function finishThread(jobId, { status, summary, outage }) {
  if (!JOB_ID_RE.test(String(jobId))) throw Object.assign(new Error("invalid job"), { status: 400 });
  const job = (await adbQuery("SELECT payload, attempts FROM Job WHERE id = :id AND kind = 'review'", { id: jobId }))[0];
  if (!job) throw Object.assign(new Error("no such thread"), { status: 404 });
  // open questions to the admin, undecided proposals, and requests the orchestrator hasn't answered: it waits.
  // (A Held piece's question to the recorder is an outcome on record, not a wait: R2.)
  const open =
    Number((await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open' AND asked_of IS NULL", { id: jobId }).catch(() => []))[0]?.n ?? 0) +
    Number((await adbQuery("SELECT count(*) AS n FROM PendingWrite WHERE job_id = :id AND status = 'pending'", { id: jobId }).catch(() => []))[0]?.n ?? 0) +
    Number((await adbQuery("SELECT count(*) AS n FROM WorkerRequest WHERE worker = :id AND status = 'open'", { id: jobId }).catch(() => []))[0]?.n ?? 0);
  const now = new Date().toISOString();
  const payload = JSON.parse(job.payload || "{}");
  const model = `model:${workerModel()}`;
  // the model was out, not the work wrong: the model pauses (no thread starts until it's back) and this one
  // goes again after the pause, keeping its tries; one that keeps dying this way counts as failing after a while
  if (status === "failed" && outage && Number(payload.outages ?? 0) < MAX_OUTAGE_DEFERRALS) {
    const out = health.fail(model, { outage: true, message: String(outage).slice(0, 120) });
    payload.outages = Number(payload.outages ?? 0) + 1;
    const now = new Date().toISOString();
    await adbCommand("UPDATE Job SET status = 'pending', summary = :sum, payload = :p, run_after = :ra, updated_at = :now WHERE id = :id", "sql", {
      sum: String(summary ?? "").slice(0, 4000),
      p: JSON.stringify(payload),
      ra: new Date(out?.until ?? Date.now() + 60_000).toISOString(),
      now,
      id: jobId,
    });
    log.warn(`thread ${String(jobId).slice(0, 8)} put off: ${model} out (${String(outage).slice(0, 80)})`);
    return { status: "pending", outage: true };
  }
  const failed = status === "failed";
  const attempts = Number(job.attempts ?? 0) + (failed ? 1 : 0);
  // a turn that ended normally: the model answered
  if (!failed) {
    health.ok(model);
    delete payload.outages;
  }
  delete payload.resume;
  // answers or decisions that came while it ran: it goes again with the first
  const queued = !failed && Array.isArray(payload.next_resume) && payload.next_resume.length ? payload.next_resume.shift() : null;
  if (queued) payload.resume = queued;
  if (Array.isArray(payload.next_resume) && !payload.next_resume.length) delete payload.next_resume;
  // a filing worker is done only once it has given its account of every entry it wrote (R10): asked for it once,
  // and a thread that still gives none fails (what it filed stays in the log)
  let account = null;
  if (!failed && !queued && !open && payload.record && !(await accountGiven(jobId, payload, await liveEnv()))) {
    account = payload.account_asked ? "missing" : "ask";
    if (account === "ask") {
      payload.account_asked = true;
      payload.resume = { account: true };
    }
  }
  if (account === "missing") summary = `${summary ?? ""}\n\n(no account given: the thread ends without one)`.trim();
  const next = failed ? (attempts >= 3 ? "failed" : "pending") : queued || account === "ask" ? "pending" : account === "missing" ? "failed" : open ? "waiting" : "done";
  await adbCommand("UPDATE Job SET status = :s, attempts = :a, summary = :sum, payload = :p, run_after = :ra, updated_at = :now WHERE id = :id", "sql", {
    s: next,
    a: attempts,
    sum: String(summary ?? "").slice(0, 4000),
    p: JSON.stringify(payload),
    ra: new Date(Date.now() + (failed ? 120_000 * attempts : 0)).toISOString(),
    now,
    id: jobId,
  });
  const sections = [...new Set([payload.rid, ...(Array.isArray(payload.sections) ? payload.sections : [])].filter((r) => RID_RE.test(String(r))))];
  if (next === "done") for (const r of sections) await adbCommand(`UPDATE ${r} SET _reviewed_at = :now`, "sql", { now }).catch(() => {});
  // the master hears how its worker ended: done, or stopped (waiting on a decision, or failed for good)
  if (payload.parent === MASTER && (next === "done" || next === "waiting" || next === "failed")) {
    const title = payload.label ?? payload.task?.title ?? "a worker";
    // a filing worker's outcomes, counted: the orchestrator checks its account against the source (R10)
    const outcomes = payload.record ? await outcomeCounts(jobId) : null;
    if (next === "done") await emitSignal("done", { job_id: jobId, data: { title, summary: String(summary ?? "").slice(0, 2000), ...(outcomes ? { outcomes, check: true } : {}) } });
    else await emitSignal("stopped", { job_id: jobId, data: { title, reason: next === "failed" ? (account === "missing" ? "it gave no account of what it did" : "it failed three times") : "it's waiting on a decision", ...(outcomes ? { outcomes } : {}), ...(next === "failed" ? { error: String(summary ?? "").slice(0, 600) } : { ...(await openItems(jobId)), summary: String(summary ?? "").slice(0, 1200) }) } });
  }
  // a task's report stays on its task entry (what the survey found, for the admin and later tasks)
  if (payload.task && RID_RE.test(String(payload.rid)) && summary) await adbCommand(`UPDATE ${payload.rid} SET text_state = :sum`, "sql", { sum: String(summary).slice(0, 6000) }).catch(() => {});
  return { status: next };
}

/** wake a thread that waited: it resumes with this message */
export async function resumeThread(jobId, resume) {
  const job = (await adbQuery("SELECT payload, status FROM Job WHERE id = :id AND kind = 'review'", { id: jobId }))[0];
  if (!job) return;
  if (job.status === "running" || job.status === "pending") {
    // still working (or about to): it resumes with this once its turn ends
    const p = JSON.parse(job.payload || "{}");
    p.next_resume = [...(p.next_resume ?? []), resume].slice(-5);
    await adbCommand("UPDATE Job SET payload = :p WHERE id = :id", "sql", { p: JSON.stringify(p), id: jobId });
    return;
  }
  const payload = { ...JSON.parse(job.payload || "{}"), resume };
  await adbCommand("UPDATE Job SET status = 'pending', payload = :p, priority = 8, run_after = :now, updated_at = :now WHERE id = :id AND status IN ['waiting', 'done']", "sql", {
    p: JSON.stringify(payload),
    now: new Date().toISOString(),
    id: jobId,
  });
}

export async function listQuestions(status = "open") {
  const rows = await adbQuery("SELECT id, job_id, entry_name, question, options, why, status, answer, answered_by, created_at, answered_at FROM WorkerQuestion WHERE status = :s AND asked_of IS NULL ORDER BY created_at ASC LIMIT 200", { s: status }).catch(() => []);
  const agents = new Map();
  for (const r of rows) {
    if (!agents.has(r.job_id)) agents.set(r.job_id, (await adbQuery("SELECT agent_id FROM Job WHERE id = :id", { id: r.job_id }).catch(() => []))[0]?.agent_id ?? null);
  }
  return rows.map((r) => ({ ...r, options: JSON.parse(r.options || "[]"), agent_id: agents.get(r.job_id) }));
}

/** answer (or dismiss) questions; each one's thread resumes with the answer */
export async function answerQuestions(ids, { answer, dismiss = false, quiet = false }, by) {
  const done = [];
  for (const id of ids) {
    if (!PENDING_ID_RE.test(String(id))) continue;
    const q = (await adbQuery("SELECT FROM WorkerQuestion WHERE id = :id AND status = 'open' AND asked_of IS NULL", { id }))[0];
    if (!q) continue;
    const now = new Date().toISOString();
    await adbCommand("UPDATE WorkerQuestion SET status = :s, answer = :a, answered_by = :u, answered_at = :now WHERE id = :id", "sql", {
      s: dismiss ? "dismissed" : "answered",
      a: String(answer ?? "").slice(0, 2000),
      u: by,
      now,
      id,
    });
    const left = Number((await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open' AND asked_of IS NULL", { id: q.job_id }))[0]?.n ?? 0);
    if (dismiss) {
      // nothing to resume with: the thread is done once nothing else waits
      if (!left) await adbCommand("UPDATE Job SET status = 'done', updated_at = :now WHERE id = :id AND status = 'waiting'", "sql", { now, id: q.job_id });
    } else if (!quiet) {
      await resumeThread(q.job_id, { question: q.question, answer, answered_by: by });
    }
    done.push(id);
  }
  return { answered: done.length, ids: done };
}

/**
 * Where a proposal lands, in plain words. An upsert payload's `home` is the
 * origin an entry is keyed by (where it was first written), not who sees it:
 * read raw, an update to an entry grading moved up looked like a widening.
 */
export async function proposalLands(kind, payload) {
  if (kind === "command") return ["a raw command: it can change anything"];
  if (kind === "data_entry") return describeEntry(payload);
  try {
    const p = JSON.parse(payload);
    if (kind === "rehome") return [`moves "${p.name}" from ${homeName(positionMap, p.from)} to ${homeName(positionMap, p.to)} (${moveKind(positionMap, p.from, p.to) === "widen" ? "more people see it" : "fewer people see it"})`];
    if (kind !== "upsert" || !positionMap || p.home === undefined) return [];
    const out = [];
    for (const e of p.entities ?? []) {
      const row = (await adbQuery(`SELECT _home FROM ${ENTITY_LABEL} WHERE name = :n AND _origin = :o LIMIT 1`, { n: e.name, o: p.home }).catch(() => []))[0];
      out.push(
        row
          ? `"${e.name}": updated where it's seen from now, ${homeName(positionMap, effectiveHome(positionMap, row._home))}; who sees it doesn't change`
          : `"${e.name}": a new entry from ${homeName(positionMap, p.home)}, placed by grading${p.floor && p.floor !== p.home ? `, held at least at ${homeName(positionMap, p.floor)}` : ""}`,
      );
    }
    return out;
  } catch {
    return [];
  }
}

/** workers' proposals: queued writes from a thread, with its reason */
export async function listProposals() {
  const rows = await adbQuery("SELECT id, kind, payload, requested_by, created_at, note, job_id, home FROM PendingWrite WHERE status = 'pending' AND job_id IS NOT NULL ORDER BY created_at ASC LIMIT 100").catch(() => []);
  const out = [];
  for (const r of rows) {
    const job = (await adbQuery("SELECT agent_id, payload FROM Job WHERE id = :id", { id: r.job_id }).catch(() => []))[0];
    const rid = JSON.parse(job?.payload || "{}").rid;
    const entry = RID_RE.test(String(rid)) ? (await adbQuery(`SELECT name FROM ${rid}`).catch(() => []))[0]?.name : null;
    out.push({ id: r.id, kind: r.kind, lands: await proposalLands(r.kind, r.payload), change: String(r.payload).slice(0, 2000), reason: r.note ?? "", proposed_by: r.requested_by, created_at: r.created_at, entry, agent_id: job?.agent_id ?? null });
  }
  return out;
}

/**
 * A thread with a question or proposal waiting is stopped until the admin
 * decides: graph-rag refuses its further changes (the model may not stop by
 * itself). Reading still works; the turn should end.
 */
export async function assertNotWaiting(identity) {
  const job = identity.role?.kind === "worker" ? identity.role.job : null;
  if (!job) return;
  const q = Number((await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open' AND asked_of IS NULL", { id: job }).catch(() => []))[0]?.n ?? 0);
  const p = Number((await adbQuery("SELECT count(*) AS n FROM PendingWrite WHERE job_id = :id AND status = 'pending'", { id: job }).catch(() => []))[0]?.n ?? 0);
  if (q || p) throw new Error(`You're waiting on the admin (${q ? "your question" : "your proposal"}): nothing more changes until they decide. End your turn now with a short report; you're resumed in this conversation with their answer.`);
}

/** what a proposal tells the thread: it stops here */
export const PROPOSED_NOTE = "Proposed: nothing changes until the admin decides. End your turn now with a short report; you're resumed in this conversation with the decision.";

/** a worker's direct changes, kept on its thread (the audit view lists them) */
export async function logChange(identity, change) {
  const job = identity.role?.job;
  if (!job) return;
  const row = (await adbQuery("SELECT changes FROM Job WHERE id = :id", { id: job }).catch(() => []))[0];
  const list = JSON.parse(row?.changes || "[]");
  list.push({ ...change, at: new Date().toISOString() });
  await adbCommand("UPDATE Job SET changes = :c WHERE id = :id", "sql", { c: JSON.stringify(list.slice(-100)), id: job }).catch(() => {});
}

/**
 * A task thread: not a section but a piece of work (a survey of a connection: the Discovery stream's
 * pass; see pool.js surveyBrief). Its "entry" is a task entry (_kind 'task', at the root: only the
 * admin sees it) that holds its brief and, once done, what it found.
 */
export async function createTask({ title, brief, minutes, parent, from, by, audience, entries, level }) {
  const name = String(title).replace(/\s+/g, " ").trim().slice(0, 120);
  if (name.length < 4) throw Object.assign(new Error("a task needs a title"), { status: 400 });
  const now = new Date().toISOString();
  await adbCommand(
    `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, _kind = 'task', _home = :root, _origin = :root, text_identity = :brief, _task_by = :taskby, updated_at = :now`,
    "sql",
    { name, root: positionMap.root, brief: String(brief).slice(0, 6000), taskby: by ?? "", now },
  );
  const rid = String((await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE name = :name AND _kind = 'task' ORDER BY @rid DESC LIMIT 1`, { name }))[0]?.rid);
  const job = await enqueue(
    "review",
    { rid, task: { title: name, brief: String(brief).slice(0, 6000) }, minutes: Math.max(5, Math.min(180, Number(minutes) || 60)), ...(parent ? { parent } : {}), ...(from ? { from } : {}), ...(audience === EVERYONE ? { audience } : {}), ...(entries?.length ? { entries } : {}), ...(level ? { level: Math.max(1, Math.min(3, Number(level))) } : {}) },
    { key: `task:${rid}`, priority: 3 },
  );
  return { task: name, job };
}

// the jobs graph-rag runs itself (review jobs are threads: the admin's workspace runs them); none since the linker went (R4)
const JOBS = {};

/** a thread whose workspace went quiet past its lease runs again (three times at most) */
export async function expireLeases() {
  const now = new Date().toISOString();
  await adbCommand("UPDATE Job SET status = 'failed', error = 'the thread stopped reporting', updated_at = :now WHERE kind = 'review' AND status = 'running' AND lease_until < :now AND attempts >= 2", "sql", { now });
  await adbCommand("UPDATE Job SET status = 'pending', attempts = attempts + 1, error = 'the thread stopped reporting', updated_at = :now WHERE kind = 'review' AND status = 'running' AND lease_until < :now", "sql", { now });
}

/** a thread left waiting with nothing open (its proposals were handled some other way) carries on */
export async function wakeIdleWaiting() {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const rows = await adbQuery("SELECT id FROM Job WHERE kind = 'review' AND status = 'waiting' AND updated_at < :c LIMIT 50", { c: cutoff });
  for (const r of rows) {
    const q = Number((await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open' AND asked_of IS NULL", { id: r.id }))[0]?.n ?? 0);
    const p = Number((await adbQuery("SELECT count(*) AS n FROM PendingWrite WHERE job_id = :id AND status = 'pending'", { id: r.id }))[0]?.n ?? 0);
    const w = Number((await adbQuery("SELECT count(*) AS n FROM WorkerRequest WHERE worker = :id AND status = 'open'", { id: r.id }).catch(() => []))[0]?.n ?? 0);
    if (!q && !p && !w) await resumeThread(r.id, { proposal: "your last proposal", decision: "handled", reason: "nothing of yours is waiting any more: check what's in place now and finish." });
  }
  // a Proposed piece a person has approved since becomes Filed in the log (filing.js)
  await settleProposals(await liveEnv()).catch((e) => log.warn(`settling approved proposals: ${String(e?.message ?? e).slice(0, 160)}`));
}

/** how a filing job's pieces ended, by outcome */
async function outcomeCounts(jobId) {
  const rows = await adbQuery("SELECT outcome, count(*) AS n FROM FilingEntry WHERE worker = :w GROUP BY outcome", { w: jobId }).catch(() => []);
  return Object.fromEntries(rows.map((r) => [r.outcome, Number(r.n)]));
}

/** a few jobs per tick, highest priority first; failures back off and give up after a few tries */
export async function workerTick() {
  if (workerTicking || !worker.enabled || !workerModel() || !SCOPED || !positionMap) return;
  // its model is out: nothing is claimed (or failed) until the pause ends
  if (health.down(`model:${workerModel()}`) || health.down(`model:${EMBED_MODEL}`)) return;
  workerTicking = true;
  try {
    const now = new Date().toISOString();
    const kinds = Object.keys(JOBS).map((k) => `'${k}'`).join(", ");
    if (!kinds) return;
    const due = await adbQuery(`SELECT id, kind, payload, attempts FROM Job WHERE status = 'pending' AND kind IN [${kinds}] AND run_after <= :now ORDER BY priority DESC, created_at ASC LIMIT 3`, { now });
    for (const job of due) {
      const claimed = await adbCommand("UPDATE Job SET status = 'running', updated_at = :now WHERE id = :id AND status = 'pending'", "sql", { now, id: job.id });
      if (Number(claimed?.[0]?.count ?? 0) !== 1) continue;
      try {
        if (!JOBS[job.kind]) throw new Error(`unknown job kind ${job.kind}`);
        await JOBS[job.kind](JSON.parse(job.payload || "{}"));
        await adbCommand("UPDATE Job SET status = 'done', updated_at = :now WHERE id = :id", "sql", { now: new Date().toISOString(), id: job.id });
      } catch (e) {
        const attempts = Number(job.attempts ?? 0) + (e.later ? 0 : 1);
        const giveUp = attempts >= 5;
        // put off: until a paused dependency's next probe, or an hour for a used-up budget
        const wait = e.later ? (e.until ? Math.max(30_000, e.until - Date.now()) : 3_600_000) : 30_000 * 4 ** attempts;
        await adbCommand("UPDATE Job SET status = :s, attempts = :a, run_after = :ra, error = :err, updated_at = :now WHERE id = :id", "sql", {
          s: giveUp ? "failed" : "pending",
          a: attempts,
          ra: new Date(Date.now() + wait).toISOString(),
          err: String(e?.message ?? e).slice(0, 300),
          now: new Date().toISOString(),
          id: job.id,
        });
        if (e.later) break; // out of budget or a dependency out: stop for this tick
      }
    }
  } finally {
    workerTicking = false;
  }
}

/** the graph worker: settings (pushed from the admin's Graph worker profile) and its backlog; root only */
export async function workerStatus() {
  const counts = await adbQuery("SELECT status, count(*) AS n FROM Job WHERE kind <> 'review' GROUP BY status").catch(() => []);
  const threads = await adbQuery("SELECT status, count(*) AS n FROM Job WHERE kind = 'review' GROUP BY status").catch(() => []);
  const questions = await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE status = 'open' AND asked_of IS NULL").catch(() => []);
  const proposals = await adbQuery("SELECT count(*) AS n FROM PendingWrite WHERE status = 'pending' AND job_id IS NOT NULL").catch(() => []);
  const things = await adbQuery(`SELECT count(*) AS n FROM ${ENTITY_LABEL} WHERE _kind = 'thing'`).catch(() => []);
  const failed = await adbQuery("SELECT kind, error, updated_at FROM Job WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 5").catch(() => []);
  const filed = await adbQuery("SELECT outcome, count(*) AS n FROM FilingEntry GROUP BY outcome").catch(() => []);
  const requests = await adbQuery("SELECT count(*) AS n FROM WorkerRequest WHERE status = 'open'").catch(() => []);
  const held = await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE status = 'open' AND asked_of IS NOT NULL").catch(() => []);
  return {
    ...worker,
    model: workerModel() || null,
    threads: { ...Object.fromEntries(threads.map((c) => [c.status, Number(c.n)])), today: await threadsToday() },
    master: await masterStatus().catch(() => null),
    open_questions: Number(questions[0]?.n ?? 0),
    open_proposals: Number(proposals[0]?.n ?? 0),
    jobs: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    things: Number(things[0]?.n ?? 0),
    // the filing log by outcome (R2), requests waiting on the orchestrator (R10), Held questions waiting on recorders
    filing: Object.fromEntries(filed.map((f) => [f.outcome, Number(f.n)])),
    open_requests: Number(requests[0]?.n ?? 0),
    open_held_questions: Number(held[0]?.n ?? 0),
    today: { calls: workerUsage.day === new Date().toISOString().slice(0, 10) ? workerUsage.calls : 0, budget: Number(WORKER_DAILY_CALLS) },
    recent_failures: failed,
    // what's out (its work waits) and which background loops keep failing
    dependencies: health.status(),
    loops: loops.status(),
    awaiting_grading: Number((await adbQuery(`SELECT count(*) AS n FROM ${ENTITY_LABEL} WHERE _ungraded IS NOT NULL`).catch(() => []))[0]?.n ?? 0),
  };
}
