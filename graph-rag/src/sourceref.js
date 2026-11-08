// Source references (docs/ORGANIZATION-MODEL.md, "Reference, never copy"):
// the graph holds no copy of a source system's row, only a `SourceRef` by key
// (`mssql:dbo_Job:4471` -> system, table, row_key, when a worker last saw it
// and who) and a `REFERS_TO` edge from the instance that stands for it, both
// per model/schema.js. Nothing here stores a row's contents, and nothing here
// is given one: a key is all it takes.
//
// The database is behind `db` ({ query, command }), ArcadeDB by default, so
// the functions run against a fake in tests (test/resolve.test.js).
import { adbCommand, adbQuery, RID_RE } from "./db.js";
import { parseKey, statements, TYPES } from "./model/schema.js";

/** the types this module needs declared (schema.statements() for just these two) */
export const SOURCE_REF_TYPES = ["SourceRef", "REFERS_TO"];
/** the fields a SourceRef carries: nothing of the row */
export const SOURCE_REF_FIELDS = Object.keys(TYPES.SourceRef.properties);

const arcade = { query: (sql, params) => adbQuery(sql, params), command: (sql, params) => adbCommand(sql, "sql", params) };
const ensured = new WeakSet();

/** the DDL for SourceRef and REFERS_TO, idempotent, run once per db (lazily: this stream owns no startup hook) */
export async function ensureSourceRefSchema(db = arcade) {
  if (ensured.has(db)) return;
  for (const sql of statements(Object.fromEntries(SOURCE_REF_TYPES.map((t) => [t, TYPES[t]])))) await db.command(sql).catch(() => {});
  ensured.add(db);
}

/**
 * The reference a key stands for, as a row to store: { key, system, table,
 * row_key, last_seen, seen_by }, or null for anything that isn't a key.
 * Whatever else is passed (a row's columns) is dropped here, on purpose.
 */
export function sourceRefOf(key, { seen_by = null, at = new Date().toISOString() } = {}) {
  const k = parseKey(key);
  if (!k) return null;
  return { key: k.key, system: k.system, table: k.table, row_key: k.row_key, last_seen: at, seen_by: seen_by === undefined || seen_by === null ? null : String(seen_by).slice(0, 120) };
}

/** the SourceRef for a key, or null */
export async function findSourceRef(key, db = arcade) {
  const k = parseKey(key);
  if (!k) return null;
  const rows = await db.query("SELECT @rid AS rid, key, system, `table`, row_key, last_seen, seen_by FROM SourceRef WHERE key = :k LIMIT 1", { k: k.key }).catch(() => []);
  return rows[0] ? { ...rows[0], rid: String(rows[0].rid) } : null;
}

/**
 * Create the SourceRef for a key, or touch the one that exists (last_seen,
 * seen_by). Returns { rid, ref, created }. Throws for a non-key.
 */
export async function touchSourceRef(key, { seen_by, at, db = arcade } = {}) {
  const ref = sourceRefOf(key, { seen_by, at });
  if (!ref) throw new Error(`not a record key (system:table:row): ${key}`);
  await ensureSourceRefSchema(db);
  const existing = await findSourceRef(ref.key, db);
  if (existing) {
    // (`by` is a reserved word in ArcadeDB SQL: never a parameter name)
    await db.command("UPDATE SourceRef SET last_seen = :last_seen, seen_by = :seen_by WHERE key = :k", { last_seen: ref.last_seen, seen_by: ref.seen_by ?? existing.seen_by ?? null, k: ref.key });
    return { rid: existing.rid, ref: { ...existing, last_seen: ref.last_seen, seen_by: ref.seen_by ?? existing.seen_by ?? null }, created: false };
  }
  await db.command("CREATE VERTEX SourceRef SET key = :key, system = :system, `table` = :table, row_key = :row_key, last_seen = :last_seen, seen_by = :seen_by", ref);
  const made = await findSourceRef(ref.key, db);
  return { rid: made?.rid ?? null, ref: made ?? ref, created: true };
}

/**
 * An instance refers to a row: touch the SourceRef and make the REFERS_TO
 * edge from the instance once. Returns { ref: rid, created, edge: "created" | "existing" | "none" }.
 */
export async function referTo(instanceRid, key, { seen_by, at, db = arcade } = {}) {
  const rid = String(instanceRid ?? "");
  if (!RID_RE.test(rid)) throw new Error(`not a record id: ${instanceRid}`);
  const touched = await touchSourceRef(key, { seen_by, at, db });
  if (!touched.rid) return { ref: null, created: touched.created, edge: "none" };
  const edges = await db.query(`SELECT @in AS dst FROM (SELECT expand(outE('REFERS_TO')) FROM ${rid})`).catch(() => []);
  if (edges.some((e) => String(e.dst) === touched.rid)) return { ref: touched.rid, created: touched.created, edge: "existing" };
  await db.command(`CREATE EDGE REFERS_TO FROM ${rid} TO ${touched.rid}`);
  return { ref: touched.rid, created: touched.created, edge: "created" };
}

/** the rows an instance stands for: its SourceRefs */
export async function sourceRefsOf(instanceRid, db = arcade) {
  const rid = String(instanceRid ?? "");
  if (!RID_RE.test(rid)) return [];
  const rows = await db.query(`SELECT @rid AS rid, key, system, \`table\`, row_key, last_seen, seen_by FROM (SELECT expand(out('REFERS_TO')) FROM ${rid})`).catch(() => []);
  return rows.filter((r) => r.key).map((r) => ({ ...r, rid: String(r.rid) }));
}
