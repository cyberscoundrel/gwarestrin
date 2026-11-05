/**
 * The graph worker's job queue and the pool of threads (see pool.js): claiming, finishing and resuming threads,
 * their questions and proposals, the change log, and the worker's settings and status.
 */
import { randomUUID } from "node:crypto";
import { effectiveHome, EVERYONE, homeName, moveKind } from "./positions.js";
import { POOL_DEFAULTS, poolSettings, resumeBrief, taskBrief, taskThreadBrief } from "./pool.js";
import { EMBED_MODEL, health, log, loops, WORKER_DAILY_CALLS, WORKER_MODEL, WORKER_TIMEOUT_MS } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, PENDING_ID_RE, RID_RE } from "./db.js";
import { chat } from "./models.js";
import { positionMap, SCOPED } from "./scope.js";
import { jobMentions } from "./linker.js";
import { recordTriageOutcome, triageStats } from "./triage.js";
import { emitSignal, MASTER, masterStatus, openItems } from "./server.js";

/** ---- the graph worker: a job queue and loop (things and their links; see things.js) ---- */

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
  for (const prop of ["_thing_type", "_norm", "_mentions_at"]) await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS STRING`).catch(() => {});
  for (const prop of ["_homes", "_alias_norms", "_keys"]) await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS LIST`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (_norm) NOTUNIQUE`).catch(() => {});
  for (const prop of ["agent_id", "summary", "lease_until", "claimed_at", "changes"]) await adbCommand(`CREATE PROPERTY Job.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._reviewed_at IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand("CREATE DOCUMENT TYPE WorkerQuestion IF NOT EXISTS").catch(() => {});
  for (const prop of ["id", "job_id", "entry", "entry_name", "question", "options", "why", "asked_by", "status", "answer", "answered_by", "created_at", "answered_at"]) {
    await adbCommand(`CREATE PROPERTY WorkerQuestion.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
  await adbCommand("CREATE INDEX IF NOT EXISTS ON WorkerQuestion (job_id) NOTUNIQUE").catch(() => {});
  await adbCommand("CREATE EDGE TYPE ABOUT IF NOT EXISTS").catch(() => {});
  await adbCommand("CREATE EDGE TYPE RELATES IF NOT EXISTS").catch(() => {});
  for (const prop of ["rel", "evidence", "job", "at"]) await adbCommand(`CREATE PROPERTY RELATES.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._task_by IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand("CREATE PROPERTY ABOUT.role IF NOT EXISTS STRING").catch(() => {});
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

/** ---- the worker pool (see pool.js): one agent thread per queue entry, run by the admin's workspace ---- */

export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);

/** threads started today (first starts and resumes) */
async function threadsToday() {
  const rows = await adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'review' AND claimed_at >= :day", { day: today() }).catch(() => []);
  return Number(rows[0]?.n ?? 0);
}

/** what a thread is told about its entry */
async function entryForBrief(rid) {
  const row = (await adbQuery(`SELECT FROM ${rid}`))[0];
  if (!row?.name) return null;
  const facets = Object.fromEntries(
    Object.keys(row)
      .filter((k) => k.startsWith("text_") && row[k])
      .map((k) => [k.slice(5), row[k]]),
  );
  const edges = await adbQuery(`SELECT @in AS dst, role FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`).catch(() => []);
  const dsts = edges.map((e) => String(e.dst)).filter((r) => RID_RE.test(r));
  const things = dsts.length ? await adbQuery(`SELECT @rid AS rid, label, _thing_type FROM [${dsts.join(",")}]`).catch(() => []) : [];
  const byRid = new Map(things.map((t) => [String(t.rid), t]));
  const links = edges.filter((e) => byRid.has(String(e.dst))).map((e) => ({ name: byRid.get(String(e.dst)).label, type: byRid.get(String(e.dst))._thing_type, role: e.role }));
  const home = effectiveHome(positionMap, row._home);
  return {
    entry: {
      name: row.name,
      home,
      home_name: homeName(positionMap, home),
      saved_at: row.updated_at ? String(row.updated_at) : undefined,
      valid_until: row._valid_until ?? undefined,
      facets,
    },
    links: links.map((l) => ({ name: l.name, type: l.type, role: l.role })),
    document: row._kind === "section" ? { title: row._doc_title, section: row._section } : null,
  };
}

/**
 * The admin's workspace claims up to `limit` threads to run: due review jobs,
 * highest priority first, within the day's budget. Each comes with its brief
 * (a first start) or its resume message (an answered question, a decided
 * proposal) and the thread's agent if it has one.
 */
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
    const brief = RID_RE.test(String(payload.rid)) ? await entryForBrief(payload.rid) : null;
    if (!brief) {
      await adbCommand("UPDATE Job SET status = 'done', summary = 'the entry is gone', updated_at = :now WHERE id = :id", "sql", { now: now.toISOString(), id: job.id });
      continue;
    }
    out.push({
      job: job.id,
      entry: payload.rid,
      name: brief.entry.name,
      agent_id: job.agent_id ?? null,
      ...(payload.level ? { level: payload.level } : {}),
      minutes: Number(payload.minutes) || worker.pool.threadMinutes,
      message: payload.resume ? resumeBrief(payload.resume) : payload.task ? taskThreadBrief(payload.task) : taskBrief({ ...brief, why: payload.why }),
    });
  }
  return { threads: out };
}

/** a thread's agent (recorded when the workspace makes it) */
export async function threadAgent(jobId, agentId) {
  if (!JOB_ID_RE.test(String(jobId)) || typeof agentId !== "string" || !/^[\w-]{1,80}$/.test(agentId)) throw Object.assign(new Error("invalid job or agent"), { status: 400 });
  await adbCommand("UPDATE Job SET agent_id = :a, updated_at = :now WHERE id = :id AND kind = 'review'", "sql", { a: agentId, now: new Date().toISOString(), id: jobId });
  return { ok: true };
}

/** the thread ended its turn: done, or waiting on its open questions */
/** a thread whose turn died on the model connection waits it out this many times before it counts as a failure */
const MAX_OUTAGE_DEFERRALS = 6;

export async function finishThread(jobId, { status, summary, outage }) {
  if (!JOB_ID_RE.test(String(jobId))) throw Object.assign(new Error("invalid job"), { status: 400 });
  const job = (await adbQuery("SELECT payload, attempts FROM Job WHERE id = :id AND kind = 'review'", { id: jobId }))[0];
  if (!job) throw Object.assign(new Error("no such thread"), { status: 404 });
  // open questions and undecided proposals: it waits for the admin
  const open =
    Number((await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: jobId }).catch(() => []))[0]?.n ?? 0) +
    Number((await adbQuery("SELECT count(*) AS n FROM PendingWrite WHERE job_id = :id AND status = 'pending'", { id: jobId }).catch(() => []))[0]?.n ?? 0);
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
  const next = failed ? (attempts >= 3 ? "failed" : "pending") : queued ? "pending" : open ? "waiting" : "done";
  await adbCommand("UPDATE Job SET status = :s, attempts = :a, summary = :sum, payload = :p, run_after = :ra, updated_at = :now WHERE id = :id", "sql", {
    s: next,
    a: attempts,
    sum: String(summary ?? "").slice(0, 4000),
    p: JSON.stringify(payload),
    ra: new Date(Date.now() + (failed ? 120_000 * attempts : 0)).toISOString(),
    now,
    id: jobId,
  });
  if (next === "done" && RID_RE.test(String(payload.rid))) await adbCommand(`UPDATE ${payload.rid} SET _reviewed_at = :now`, "sql", { now }).catch(() => {});
  // the master hears how its worker ended: done, or stopped (waiting on a decision, or failed for good)
  if (payload.parent === MASTER && payload.entries?.length && (next === "done" || next === "waiting" || next === "failed")) {
    const meaningful = JSON.parse((await adbQuery("SELECT changes FROM Job WHERE id = :id", { id: jobId }))[0]?.changes || "[]").filter((c) => ["link", "merge", "relate", "unlink", "delete", "upsert", "move"].includes(c.kind)).length;
    await recordTriageOutcome(payload.entries, { job: jobId, status: next, changes: meaningful, stopped: next !== "done" });
  }
  if (payload.parent === MASTER && (next === "done" || next === "waiting" || next === "failed")) {
    const title = payload.task?.title ?? "a worker";
    if (next === "done") await emitSignal("done", { job_id: jobId, data: { title, summary: String(summary ?? "").slice(0, 2000) } });
    else await emitSignal("stopped", { job_id: jobId, data: { title, reason: next === "failed" ? "it failed three times" : "it's waiting on a decision", ...(next === "failed" ? { error: String(summary ?? "").slice(0, 600) } : { ...(await openItems(jobId)), summary: String(summary ?? "").slice(0, 1200) }) } });
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

/** a thread asks: the liaison (or the admin) answers later; the thread ends its turn meanwhile */
export async function raiseQuestion(identity, { question, options, why }) {
  await assertNotWaiting(identity);
  const job = identity.role.job;
  const open = await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: job });
  if (Number(open[0]?.n ?? 0) >= 3) throw new Error("this thread already has 3 open questions: end your turn and wait for answers");
  const entryName = (await adbQuery(`SELECT name FROM ${identity.role.entry}`).catch(() => []))[0]?.name ?? null;
  const id = randomUUID();
  await adbCommand(
    "INSERT INTO WorkerQuestion SET id = :id, job_id = :job, entry = :entry, entry_name = :ename, question = :q, options = :o, why = :w, asked_by = :u, status = 'open', created_at = :now",
    "sql",
    { id, job, entry: identity.role.entry, ename: entryName, q: question, o: JSON.stringify(options ?? []), w: why ?? "", u: identity.user, now: new Date().toISOString() },
  );
  return { asked: true, id, note: "Recorded. End your turn now with a short report; you'll be resumed with the answer." };
}

export async function listQuestions(status = "open") {
  const rows = await adbQuery("SELECT id, job_id, entry_name, question, options, why, status, answer, answered_by, created_at, answered_at FROM WorkerQuestion WHERE status = :s ORDER BY created_at ASC LIMIT 200", { s: status }).catch(() => []);
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
    const q = (await adbQuery("SELECT FROM WorkerQuestion WHERE id = :id AND status = 'open'", { id }))[0];
    if (!q) continue;
    const now = new Date().toISOString();
    await adbCommand("UPDATE WorkerQuestion SET status = :s, answer = :a, answered_by = :u, answered_at = :now WHERE id = :id", "sql", {
      s: dismiss ? "dismissed" : "answered",
      a: String(answer ?? "").slice(0, 2000),
      u: by,
      now,
      id,
    });
    const left = Number((await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: q.job_id }))[0]?.n ?? 0);
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
  const q = Number((await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: job }).catch(() => []))[0]?.n ?? 0);
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
 * A task thread: not one saved entry but a piece of work (a survey of a
 * connection, a follow-up a survey queued). Its "entry" is a task entry
 * (_kind 'task', at the root: only the admin sees it) that holds its brief
 * and, once done, what it found.
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

// the jobs graph-rag runs itself (review jobs are threads: the admin's workspace runs them)
const JOBS = { mentions: jobMentions };

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
    const q = Number((await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: r.id }))[0]?.n ?? 0);
    const p = Number((await adbQuery("SELECT count(*) AS n FROM PendingWrite WHERE job_id = :id AND status = 'pending'", { id: r.id }))[0]?.n ?? 0);
    if (!q && !p) await resumeThread(r.id, { proposal: "your last proposal", decision: "handled", reason: "nothing of yours is waiting any more: check what's in place now and finish." });
  }
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
  const questions = await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE status = 'open'").catch(() => []);
  const proposals = await adbQuery("SELECT count(*) AS n FROM PendingWrite WHERE status = 'pending' AND job_id IS NOT NULL").catch(() => []);
  const things = await adbQuery(`SELECT count(*) AS n FROM ${ENTITY_LABEL} WHERE _kind = 'thing'`).catch(() => []);
  const failed = await adbQuery("SELECT kind, error, updated_at FROM Job WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 5").catch(() => []);
  return {
    ...worker,
    model: workerModel() || null,
    threads: { ...Object.fromEntries(threads.map((c) => [c.status, Number(c.n)])), today: await threadsToday() },
    master: await masterStatus().catch(() => null),
    triage: await triageStats().catch(() => null),
    open_questions: Number(questions[0]?.n ?? 0),
    open_proposals: Number(proposals[0]?.n ?? 0),
    jobs: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    things: Number(things[0]?.n ?? 0),
    today: { calls: workerUsage.day === new Date().toISOString().slice(0, 10) ? workerUsage.calls : 0, budget: Number(WORKER_DAILY_CALLS) },
    recent_failures: failed,
    // what's out (its work waits) and which background loops keep failing
    dependencies: health.status(),
    loops: loops.status(),
    awaiting_grading: Number((await adbQuery(`SELECT count(*) AS n FROM ${ENTITY_LABEL} WHERE _ungraded IS NOT NULL`).catch(() => []))[0]?.n ?? 0),
  };
}
