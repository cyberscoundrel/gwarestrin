/**
 * The audit trail of agent actions on source systems (docs/ORGANIZATION-MODEL.md,
 * "Reference, never copy"): the ERP will not record what an agent did to it,
 * so the graph holds the event: the row referenced (a SourceRef by key, never
 * a copy of the row), who authorized it, who acted, under which position,
 * when, what changed, and what became of it (model/schema.js: AuditEvent,
 * WROTE, SourceRef, REFERS_TO).
 *
 * Pure shaping (`auditEvent`, `sourceRef`) is separate from storage, and every
 * storing function takes a `db` ({ adbCommand, adbQuery }) so tests run with
 * a fake. The DDL is the contract's own `schema.statements()`, idempotent.
 */
import { randomUUID } from "node:crypto";
import { adbCommand as realCommand, adbQuery as realQuery, RID_RE } from "./db.js";
import { AUDIT_OUTCOMES, parseKey, statements, TYPES } from "./model/schema.js";

const realDb = { adbCommand: realCommand, adbQuery: realQuery };

/** the DDL for what this module stores: the whole contract, every statement safe to repeat */
export async function ensureAuditSchema(db = realDb) {
  for (const sql of statements({ Entity: TYPES.Entity, SourceRef: TYPES.SourceRef, REFERS_TO: TYPES.REFERS_TO, AuditEvent: TYPES.AuditEvent, WROTE: TYPES.WROTE })) {
    await db.adbCommand(sql).catch(() => {});
  }
}

/** a SourceRef as stored, from a key; throws when the key isn't one */
export function sourceRef(key, { seen_by = null, last_seen = null } = {}) {
  const k = parseKey(key);
  if (!k) throw new Error(`not a record key (system:table:row): ${key}`);
  return { key: k.key, system: k.system, table: k.table, row_key: k.row_key, last_seen: last_seen ?? null, seen_by: seen_by ?? null };
}

/**
 * An AuditEvent as stored; throws naming the field. `change` is kept as JSON
 * ({ before, after }, the fields written, or the statement); `pending_id` is
 * the PendingWrite when the write was proposed.
 */
export function auditEvent({ key, authorized_by, acted_by, position, change, outcome, pending_id = null, at = null, id = null }) {
  const ref = sourceRef(key);
  if (!AUDIT_OUTCOMES.includes(outcome)) throw new Error(`outcome: must be one of ${AUDIT_OUTCOMES.join(", ")}`);
  const nonEmpty = (v, field) => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${field}: needs a value`);
    return v.trim().slice(0, 200);
  };
  if (outcome === "proposed" && !pending_id) throw new Error("pending_id: a proposed write names its PendingWrite");
  const when = at ? new Date(at) : new Date();
  if (Number.isNaN(when.getTime())) throw new Error(`at: not a date: ${at}`);
  return {
    id: id ?? randomUUID(),
    key: ref.key,
    authorized_by: nonEmpty(authorized_by, "authorized_by"),
    acted_by: nonEmpty(acted_by, "acted_by"),
    position: nonEmpty(position, "position"),
    at: when.toISOString(),
    change: typeof change === "string" ? change.slice(0, 4000) : JSON.stringify(change ?? null).slice(0, 4000),
    outcome,
    pending_id: pending_id ?? null,
  };
}

/**
 * The SourceRef for a key, created when the graph has none; `seen` marks it
 * as confirmed to exist now by `seen_by`. Returns its rid.
 */
export async function ensureSourceRef(key, { seen_by = null, seen = false } = {}, db = realDb) {
  const ref = sourceRef(key);
  const found = (await db.adbQuery("SELECT @rid AS rid FROM SourceRef WHERE key = :k LIMIT 1", { k: ref.key }).catch(() => []))[0];
  const now = new Date().toISOString();
  if (found) {
    if (seen) await db.adbCommand("UPDATE SourceRef SET last_seen = :now, seen_by = :who WHERE key = :k", "sql", { now, who: seen_by, k: ref.key });
    return String(found.rid);
  }
  await db.adbCommand("CREATE VERTEX SourceRef SET key = :k, system = :s, table = :t, row_key = :r, last_seen = :ls, seen_by = :who", "sql", {
    k: ref.key,
    s: ref.system,
    t: ref.table,
    r: ref.row_key,
    ls: seen ? now : null,
    who: seen ? seen_by : null,
  });
  const made = (await db.adbQuery("SELECT @rid AS rid FROM SourceRef WHERE key = :k LIMIT 1", { k: ref.key }))[0];
  if (!made) throw new Error(`the source reference for ${ref.key} wasn't written`);
  return String(made.rid);
}

/** an instance (a thing with the key) refers to its row: REFERS_TO once */
export async function referTo(thingRid, sourceRefRid, db = realDb) {
  if (!RID_RE.test(String(thingRid)) || !RID_RE.test(String(sourceRefRid))) return false;
  const out = await db.adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('REFERS_TO')) FROM ${thingRid})`).catch(() => []);
  if (out.some((e) => String(e.dst) === String(sourceRefRid))) return false;
  await db.adbCommand(`CREATE EDGE REFERS_TO FROM ${thingRid} TO ${sourceRefRid}`);
  return true;
}

/**
 * Record what an agent did (or tried to do) to a row: the AuditEvent, WROTE
 * to the row's SourceRef (made if the graph has none). Every outcome is
 * recorded, applied, proposed, refused and failed alike: the trail is of
 * attempts, not of successes. Returns the stored event.
 */
export async function recordAuditEvent(fields, db = realDb) {
  const ev = auditEvent(fields);
  const refRid = await ensureSourceRef(ev.key, { seen_by: ev.acted_by, seen: ev.outcome === "applied" }, db);
  await db.adbCommand(
    "CREATE VERTEX AuditEvent SET id = :id, key = :key, authorized_by = :auth, acted_by = :acted, position = :pos, at = :at, change = :change, outcome = :outcome, pending_id = :pending",
    "sql",
    { id: ev.id, key: ev.key, auth: ev.authorized_by, acted: ev.acted_by, pos: ev.position, at: ev.at, change: ev.change, outcome: ev.outcome, pending: ev.pending_id },
  );
  const made = (await db.adbQuery("SELECT @rid AS rid FROM AuditEvent WHERE id = :id LIMIT 1", { id: ev.id }))[0];
  if (made) await db.adbCommand(`CREATE EDGE WROTE FROM ${String(made.rid)} TO ${refRid}`).catch(() => {});
  return ev;
}

/** a proposed write was decided: the event's outcome follows (applied, failed, or refused when rejected) */
export async function settleAuditEvent(pendingId, outcome, db = realDb) {
  if (!AUDIT_OUTCOMES.includes(outcome)) throw new Error(`outcome: must be one of ${AUDIT_OUTCOMES.join(", ")}`);
  const r = await db.adbCommand("UPDATE AuditEvent SET outcome = :o WHERE pending_id = :p AND outcome = 'proposed'", "sql", { o: outcome, p: String(pendingId) });
  return Number(r?.[0]?.count ?? 0);
}

/**
 * The trail: newest first, filtered by the row (`key`), the table
 * (`table`: system:table), the outcome, the person (`authorized_by`) or a
 * time (`since`, ISO). At most `limit` (default 50, at most 500).
 */
export async function listAuditEvents({ key, table, outcome, authorized_by, since, limit = 50 } = {}, db = realDb) {
  const conds = [];
  const params = {};
  if (key) {
    conds.push("key = :key");
    params.key = String(key);
  }
  // a table prefix: LIKE narrows it in the database (an underscore there matches any one character,
  // so the exact prefix is checked again below)
  const prefix = table ? `${String(table).replace(/[%\\]/g, "")}:` : null;
  if (prefix) {
    conds.push("key LIKE :table");
    params.table = `${prefix}%`;
  }
  if (outcome) {
    if (!AUDIT_OUTCOMES.includes(outcome)) throw new Error(`outcome: must be one of ${AUDIT_OUTCOMES.join(", ")}`);
    conds.push("outcome = :outcome");
    params.outcome = outcome;
  }
  if (authorized_by) {
    conds.push("authorized_by = :auth");
    params.auth = String(authorized_by);
  }
  if (since) {
    const t = new Date(since);
    if (Number.isNaN(t.getTime())) throw new Error(`since: not a date: ${since}`);
    conds.push("at >= :since");
    params.since = t.toISOString();
  }
  const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
  const rows = await db.adbQuery(`SELECT id, key, authorized_by, acted_by, position, at, change, outcome, pending_id FROM AuditEvent${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ${n}`, params).catch(() => []);
  return rows.filter((r) => !prefix || String(r.key).startsWith(prefix)).map((r) => ({ ...r, change: parseChange(r.change) }));
}

function parseChange(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s ?? null;
  }
}
