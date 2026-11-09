/**
 * The graph worker's job queue and the pool of threads (see pool.js): claiming, finishing and resuming threads,
 * their questions and proposals, the change log, and the worker's settings and status.
 *
 * Under the organization model (docs/ORGANIZATION-MODEL.md, "The worker's job") a thread's unit of work is a
 * document section with its claims: the brief hands it the section, the claims, each claim's subject
 * (resolved to an instance, or not), and the prior state of each subject (the latest claims on the same
 * attribute), and nothing outside the floor of the section's people. The brief is a read, recorded like any
 * other (floor.js `recordReads`), so it bounds the worker's writes.
 *
 * Claims are CLAIMS edges (model/schema.js) from the section to the subject thing. The Condenser's record
 * path (ingest.js recordClaims) resolves the subject as any mention is (linker.js recordSubject) and mints
 * only what admission allows. A claim with no thing for its subject (several things it could be, or
 * content inside the claim) points back at its section, with the subject as written in a `subject`
 * property (JSON): the contract has no shape for an unresolved subject, and this is the one read here.
 * resolve_subject (worker-tools.js) re-points the edge at the thing.
 */
import { randomUUID } from "node:crypto";
import { effectiveHome, EVERYONE, homeName, moveKind, visibleHomes } from "./positions.js";
import { checkBriefFloor, POOL_DEFAULTS, poolSettings, resumeBrief, taskBrief, taskThreadBrief } from "./pool.js";
import { EMBED_MODEL, health, log, loops, WORKER_DAILY_CALLS, WORKER_MODEL, WORKER_TIMEOUT_MS } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, PENDING_ID_RE, RID_RE } from "./db.js";
import { chat } from "./models.js";
import { recordReads } from "./floor.js";
import { entriesByUser, positionMap, SCOPED } from "./scope.js";
import { jobMentions, thingLookup } from "./linker.js";
import { resolveSubject } from "./resolve.js";
import { recordTriageOutcome, triageStats } from "./triage.js";
import { emitSignal, MASTER, masterStatus, openItems } from "./master-tools.js";
import { ensureAuditSchema } from "./audit.js";
import { describeEntry } from "./data-entry.js";
import { statements, TYPES } from "./model/schema.js";

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

/** the kinds of change a reconciliation thread makes (what the triage outcome counts) */
export const RECONCILE_CHANGES = ["confirm", "conflict", "resolve", "need_met", "data_entry"];

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
  // the organization model's shapes the worker reads and writes: classes, instances, claims (the contract's DDL,
  // idempotent), the unresolved subject on a claim, conflicts between claims, and the audit trail
  for (const sql of statements({ CommitmentClass: TYPES.CommitmentClass, Entity: TYPES.Entity, CLAIMS: TYPES.CLAIMS })) await adbCommand(sql).catch(() => {});
  await adbCommand("CREATE PROPERTY CLAIMS.subject IF NOT EXISTS STRING").catch(() => {});
  await adbCommand("CREATE DOCUMENT TYPE ClaimConflict IF NOT EXISTS").catch(() => {});
  for (const prop of ["id", "subject", "attribute", "claim_a", "claim_b", "found_by", "job", "at", "status", "note"]) await adbCommand(`CREATE PROPERTY ClaimConflict.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON ClaimConflict (subject, attribute) NOTUNIQUE").catch(() => {});
  await ensureAuditSchema();
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

/** ---- claims as the worker sees them (CLAIMS edges; see the header) ---- */

const CLAIM_FIELDS = "id, kind, class, attribute, value, value_num, valid_from, valid_until, recorded_at, recorded_by, closed_by, _home, subject";

/** a stored claim as data: the edge's properties, its subject (the thing, or what was written when unresolved), where it lives */
export function shapeClaim(row, sectionRid) {
  const dst = String(row.dst ?? "");
  const src = String(row.src ?? sectionRid ?? "");
  const resolved = RID_RE.test(dst) && dst !== src;
  let written = null;
  try {
    written = row.subject ? JSON.parse(row.subject) : null;
  } catch {
    written = { name: String(row.subject) };
  }
  return {
    id: row.id,
    edge: String(row.erid ?? ""),
    section: src,
    kind: row.kind,
    class: row.class,
    attribute: row.attribute,
    value: row.value,
    value_num: row.value_num ?? null,
    valid_from: row.valid_from,
    valid_until: row.valid_until ?? null,
    recorded_at: row.recorded_at,
    recorded_by: row.recorded_by,
    closed_by: row.closed_by ?? null,
    home: row._home ?? null,
    resolved,
    thing: resolved ? dst : null,
    subject: written ?? (resolved ? { key: null, name: null } : { key: null, name: null }),
  };
}

/** the claims a section makes */
export async function claimsOfSection(rid) {
  if (!RID_RE.test(String(rid))) return [];
  const rows = await adbQuery(`SELECT @rid AS erid, @out AS src, @in AS dst, ${CLAIM_FIELDS} FROM (SELECT expand(outE('CLAIMS')) FROM ${rid})`).catch(() => []);
  return rows.map((r) => shapeClaim(r, String(rid)));
}

/** one claim by its id, or null */
export async function claimById(id) {
  if (typeof id !== "string" || !id.trim()) return null;
  const row = (await adbQuery(`SELECT @rid AS erid, @out AS src, @in AS dst, ${CLAIM_FIELDS} FROM CLAIMS WHERE id = :id LIMIT 1`, { id: id.trim() }).catch(() => []))[0];
  return row ? shapeClaim(row) : null;
}

/** the claims on one attribute of a thing (from any section), newest valid_from first, at most `limit` */
export async function claimsOnAttribute(thingRid, attribute, { limit = 20 } = {}) {
  if (!RID_RE.test(String(thingRid))) return [];
  const rows = await adbQuery(`SELECT @rid AS erid, @out AS src, @in AS dst, ${CLAIM_FIELDS} FROM (SELECT expand(inE('CLAIMS')) FROM ${thingRid}) WHERE attribute = :a ORDER BY valid_from DESC LIMIT ${Math.floor(limit)}`, { a: attribute }).catch(() => []);
  return rows.map((r) => shapeClaim(r));
}

/** where a claim is seen from: its own home, else its section's */
async function claimHome(c) {
  if (c.home) return effectiveHome(positionMap, c.home);
  const s = RID_RE.test(c.section) ? (await adbQuery(`SELECT _home FROM ${c.section}`).catch(() => []))[0] : null;
  return effectiveHome(positionMap, s?._home);
}

/**
 * The prior state of a claim's subject on its attribute, as the people at `floor` see it: the latest
 * claims from other sections, each with where it lives. Claims above the floor are left out: the brief
 * holds nothing its worker's people can't see.
 */
export async function priorState(claim, floor, { limit = 5 } = {}) {
  if (!claim.resolved) return [];
  const vis = positionMap ? visibleHomes(positionMap, [effectiveHome(positionMap, floor)]) : null;
  const out = [];
  for (const c of await claimsOnAttribute(claim.thing, claim.attribute, { limit: 20 })) {
    if (c.id === claim.id || c.section === claim.section) continue;
    const home = await claimHome(c);
    if (vis !== null && !vis.has(home)) continue;
    out.push({ ...c, home, home_name: homeName(positionMap, home) });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Resolve a claim's subject to an existing thing. With the Admission stream's resolve.js present, its
 * `resolveSubject` decides (by key, by confirmed class and name, by alias, by embedding; the graph behind
 * a lookup built here) and a key no instance holds comes back as { mint } for the worker to make on
 * purpose. Without it: by record key, else by name (one thing of that name, whatever its type). Null
 * when there is none, or several. Nothing is minted here.
 */
/**
 * The confirmed classes a resolution runs against (the Discovery stream's confirm flow writes them as
 * CommitmentClass rows, status 'confirmed'): the linker's `confirmedClassList` when it exports one (the
 * Admission stream's, cached a minute), else the rows themselves; the organization's stored list
 * (OrgPolicy, scope 'classes') only where neither has any. `db` and `linker` are injectable for tests.
 */
export async function confirmedClassesFor({ db = { adbQuery }, linker } = {}) {
  const mod = linker ?? (await import("./linker.js").catch(() => null));
  if (typeof mod?.confirmedClassList === "function") {
    const list = await mod.confirmedClassList().catch(() => []);
    if (Array.isArray(list) && list.length) return list;
  }
  const rows = await db.adbQuery("SELECT name, description, stages, record_table, status, confirmed_by FROM CommitmentClass WHERE status = 'confirmed'").catch(() => []);
  if (rows.length) return rows.map((r) => ({ name: r.name, description: r.description ?? "", stages: Array.isArray(r.stages) ? r.stages : [], record_table: r.record_table ?? null, status: "confirmed", ...(r.confirmed_by ? { confirmed_by: r.confirmed_by } : {}) }));
  const row = (await db.adbQuery("SELECT json FROM OrgPolicy WHERE scope = 'classes' LIMIT 1").catch(() => []))[0];
  try {
    const stored = row?.json ? JSON.parse(row.json) : [];
    return Array.isArray(stored) ? stored : Array.isArray(stored?.classes) ? stored.classes : [];
  } catch {
    return [];
  }
}

export async function resolveSubjectStub(subject, home) {
  if (!subject) return null;
  const classes = await confirmedClassesFor();
  const r = await resolveSubject(subject, { classes, lookup: thingLookup(home) }).catch(() => null);
  if (r?.rid && r.how !== "none") return { rid: String(r.rid), label: r.thing?.label ?? r.thing?.name ?? subject.name ?? null, _thing_type: r.thing?._thing_type ?? null, _homes: r.thing?._homes ?? [] };
  if (r?.mint) return { mint: r.mint };
  return null;
}

/** ---- the worker pool (see pool.js): one agent thread per section, run by the admin's workspace ---- */

export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);

/** threads started today (first starts and resumes) */
async function threadsToday() {
  const rows = await adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'review' AND claimed_at >= :day", { day: today() }).catch(() => []);
  return Number(rows[0]?.n ?? 0);
}

/** the document a section is part of (its on-record marker: who put it on record, under which position, why) */
async function documentOf(rid, row) {
  const doc = (await adbQuery(`SELECT name, _recorded_by, _recorded_at, _record_position, _record_reason, _written_by, _home FROM (SELECT expand(out('PART_OF')) FROM ${rid}) LIMIT 1`).catch(() => []))[0];
  const recordedBy = doc?._recorded_by ?? row._recorded_by ?? row._written_by ?? doc?._written_by ?? null;
  const position = doc?._record_position ?? row._record_position ?? null;
  return {
    title: doc?.name ?? row._doc_title ?? null,
    recorded_by: recordedBy,
    recorded_at: doc?._recorded_at ?? row._recorded_at ?? null,
    position: position ? effectiveHome(positionMap, position) : effectiveHome(positionMap, row._home),
    recorded_position: position,
    position_name: homeName(positionMap, position ?? row._home),
    reason: doc?._record_reason ?? row._record_reason ?? null,
  };
}

/**
 * Who a section's worker acts for: the person who put it on record, and the position as stored, unread
 * (null when none was recorded). Never the effective home: that fails upward to the root for an unknown
 * value, which is right for who sees a section and wrong for who authorizes a write (data-entry.js decides
 * on the person's current standing).
 */
export async function actsForOf(sectionRid) {
  if (!RID_RE.test(String(sectionRid))) return null;
  const row = (await adbQuery(`SELECT _home, _recorded_by, _record_position, _written_by, _doc_title, _recorded_at, _record_reason FROM ${sectionRid}`).catch(() => []))[0];
  if (!row) return null;
  const d = await documentOf(sectionRid, row);
  return d.recorded_by ? { person: d.recorded_by, position: d.recorded_position } : null;
}

/**
 * What a thread is told about one section: the section itself (its document's record, its text), its
 * claims with their subjects, and the prior state of each resolved subject as the section's people see it.
 */
export async function sectionForBrief(rid) {
  const row = (await adbQuery(`SELECT FROM ${rid}`).catch(() => []))[0];
  if (!row?.name) return null;
  const home = effectiveHome(positionMap, row._home);
  const claims = await claimsOfSection(rid);
  const subjects = [];
  for (const c of claims) {
    if (c.resolved) {
      const t = (await adbQuery(`SELECT label, _thing_type, _class, _keys FROM ${c.thing}`).catch(() => []))[0];
      subjects.push({ claim: c.id, resolved: true, rid: c.thing, label: t?.label ?? null, type: t?._thing_type ?? null, class: t?._class ?? c.class, keys: Array.isArray(t?._keys) ? t._keys : [] });
    } else {
      subjects.push({ claim: c.id, resolved: false, written: c.subject });
    }
  }
  const prior = [];
  for (const c of claims) for (const p of await priorState(c, home)) prior.push({ claim: c.id, ...p });
  return {
    rid: String(rid),
    kind: row._kind ?? "entry",
    // names the linker could resolve to nothing (linker.js `_unresolved`): a worker or a person decides
    unresolved_names: unresolvedNames(row._unresolved),
    name: row.name,
    heading: row.heading ?? null,
    text: String(row.text_identity ?? "").slice(0, 4000),
    home,
    home_name: homeName(positionMap, home),
    document: await documentOf(rid, row),
    claims,
    subjects,
    prior,
  };
}

/** an entry's `_unresolved` (JSON the linker stores: a list of mentions, or of names) as [{ name, type, role }] */
export function unresolvedNames(raw) {
  if (raw === null || raw === undefined || raw === "") return [];
  let list = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) list = Array.isArray(list?.unresolved) ? list.unresolved : [];
  return list
    .map((m) => (typeof m === "string" ? { name: m, type: null, role: null } : m && typeof m === "object" && m.name ? { name: String(m.name), type: m.type ?? null, role: m.role ?? null, ...(m.key ? { key: m.key } : {}) } : null))
    .filter(Boolean)
    .slice(0, 25);
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
 * within the day's budget. Each comes with its brief (a first start: its sections, claims, subjects and
 * prior state, checked against the floor) or its resume message (an answered question, a decided
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
      const rids = [...new Set([payload.rid, ...(Array.isArray(payload.sections) ? payload.sections : [])].filter((r) => RID_RE.test(String(r))))];
      const sections = [];
      for (const r of rids) {
        const s = await sectionForBrief(r);
        if (s) sections.push(s);
      }
      if (!sections.length) {
        await adbCommand("UPDATE Job SET status = 'done', summary = 'the section is gone', updated_at = :now WHERE id = :id", "sql", { now: now.toISOString(), id: job.id });
        continue;
      }
      try {
        homes = checkBriefFloor(positionMap, sections);
      } catch (e) {
        // the brief would show the worker something its section's people can't see: refused here, never sent
        await adbCommand("UPDATE Job SET status = 'failed', summary = :s, error = :s, updated_at = :now WHERE id = :id", "sql", { s: `brief refused: ${String(e.message).slice(0, 600)}`, now: now.toISOString(), id: job.id });
        if (payload.parent === MASTER) await emitSignal("stopped", { job_id: job.id, data: { title: payload.label ?? "a worker", reason: "its brief was refused", error: String(e.message).slice(0, 600) } });
        log.warn(`thread ${String(job.id).slice(0, 8)}: brief refused: ${String(e.message).slice(0, 160)}`);
        continue;
      }
      message = taskBrief({ sections, why: payload.why });
      name = payload.label ?? labelFor(sections);
      // the brief is a read: recorded for the thread's agent now when it has one, else when the workspace names it
      if (job.agent_id) recordBriefRead(job.agent_id, homes);
      else {
        payload.brief_homes = homes;
        await adbCommand("UPDATE Job SET payload = :p WHERE id = :id", "sql", { p: JSON.stringify(payload), id: job.id }).catch(() => {});
      }
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

/** a thread's label for the rail: its claims' classes and attributes, never a title or text */
export function labelFor(sections) {
  const parts = [...new Set(sections.flatMap((s) => s.claims.map((c) => `${c.class}/${c.attribute}`)))];
  const n = sections.reduce((a, s) => a + s.claims.length, 0);
  return `${parts.slice(0, 2).join(", ") || "no claims"}${parts.length > 2 ? ` +${parts.length - 2}` : ""} (${n} claim${n === 1 ? "" : "s"})`;
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
  const sections = [...new Set([payload.rid, ...(Array.isArray(payload.sections) ? payload.sections : [])].filter((r) => RID_RE.test(String(r))))];
  if (next === "done") for (const r of sections) await adbCommand(`UPDATE ${r} SET _reviewed_at = :now`, "sql", { now }).catch(() => {});
  // the master hears how its worker ended: done, or stopped (waiting on a decision, or failed for good)
  if (payload.parent === MASTER && sections.length && !payload.task && (next === "done" || next === "waiting" || next === "failed")) {
    const meaningful = JSON.parse((await adbQuery("SELECT changes FROM Job WHERE id = :id", { id: jobId }))[0]?.changes || "[]").filter((c) => RECONCILE_CHANGES.includes(c.kind)).length;
    await recordTriageOutcome(sections, { job: jobId, status: next, changes: meaningful, stopped: next !== "done" });
  }
  if (payload.parent === MASTER && (next === "done" || next === "waiting" || next === "failed")) {
    const title = payload.label ?? payload.task?.title ?? "a worker";
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
  const conflicts = await adbQuery("SELECT count(*) AS n FROM ClaimConflict WHERE status = 'open'").catch(() => []);
  const audited = await adbQuery("SELECT outcome, count(*) AS n FROM AuditEvent GROUP BY outcome").catch(() => []);
  const failed = await adbQuery("SELECT kind, error, updated_at FROM Job WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 5").catch(() => []);
  return {
    ...worker,
    model: workerModel() || null,
    threads: { ...Object.fromEntries(threads.map((c) => [c.status, Number(c.n)])), today: await threadsToday() },
    master: await masterStatus().catch(() => null),
    triage: await triageStats().catch(() => null),
    open_questions: Number(questions[0]?.n ?? 0),
    open_proposals: Number(proposals[0]?.n ?? 0),
    open_conflicts: Number(conflicts[0]?.n ?? 0),
    data_entries: Object.fromEntries(audited.map((a) => [a.outcome, Number(a.n)])),
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
