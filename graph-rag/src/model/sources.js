// A source declaration: how each connected source is read and committed to (R2: "Each source declares
// how it is committed to"). Information is committed to its relevant source by whatever means that source
// takes; for SQL Server, a write. Pure.
//
//   { system, description, read: { via, url, home }, commit: { via, url, tables, actions, guard } | { via: "none" } }
//
// `read.home` is the home of the connection: R11.9, "a class from a table gets the home of the connection
// that can read that table". NEEDS A RULING (which home a connection has): smallest choice, null, meaning the
// root, the strictest, until a person declares one. A test configuration may declare "everyone".
// `commit.guard` is what the write connection must say it holds before any write: { server, database }, read
// through `entity` (only dbo_GwConnectionIdentity passes, test-sql/README.md), and `login` when declared. Without
// one, nothing is written.
//
// `system` is the first part of a record key (`mssql` in mssql:dbo_Job:4471). A source that is not
// writable makes a clear piece Proposed (R2).
// NEEDS A RULING (what a write may do): smallest choice, create and update only, as the write login's grants
// already are (dab-config.example/dab-config-write.json). "delete" may be declared only to undo a row graph-rag added
// (R19, I-52): it is refused for any table that doesn't take new rows, and the write adapter uses it for nothing else.
//
// R18 and R19: each table the write side names may carry its shape, so code knows what the table takes without asking
// a model or guessing from the rows present (model/write-conditions.js):
//   commit.tables: [ "dbo_Job" | { name, adds, columns, required, defaults } ]
//     adds:     true when the table takes new rows (R19; "create" must be among the actions). Default false.
//     columns:  { Column: "boolean" | { values: [..] } }: a yes/no column, or one with a fixed set of values (R18).
//     required: the columns a new row needs; defaults: those the source fills itself when not given.
// Normalized, `tables` stays the list of names and `shapes` holds each table's shape by name.
import { clip, nonEmpty, ShapeError } from "./text.js";

/** how a source is reached: Data API builder's MCP endpoint today */
export const SOURCE_VIA = ["dab-mcp"];
export const COMMIT_ACTIONS = ["create", "update", "delete"];
const DEFAULT_ACTIONS = ["create", "update"];
const SYSTEM_RE = /^[a-z0-9_-]{1,40}$/i;

function endpoint(raw, field) {
  if (!raw || typeof raw !== "object") throw new ShapeError(field, "must be an object");
  if (!SOURCE_VIA.includes(raw.via)) throw new ShapeError(`${field}.via`, `must be one of ${SOURCE_VIA.join(", ")}`);
  if (!nonEmpty(raw.url) || !/^https?:\/\//.test(String(raw.url).trim())) throw new ShapeError(`${field}.url`, "needs an http(s) URL");
  return { via: raw.via, url: String(raw.url).trim() };
}

/** the entity the guard reads through the write connection (test-sql/seed.mjs makes it) */
export const GUARD_ENTITY = "dbo_GwConnectionIdentity";

function home(raw) {
  if (raw === undefined || raw === null) return null;
  if (!nonEmpty(raw)) throw new ShapeError("read.home", "must name a position, or be left out for the root");
  return String(raw).trim();
}

function guard(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ShapeError("commit.guard", "must be { server, database }");
  for (const k of ["server", "database"]) if (!nonEmpty(raw[k])) throw new ShapeError(`commit.guard.${k}`, "needs the name the write connection must hold");
  const out = { server: String(raw.server).trim(), database: String(raw.database).trim(), entity: nonEmpty(raw.entity) ? String(raw.entity).trim() : GUARD_ENTITY };
  if (nonEmpty(raw.login)) out.login = String(raw.login).trim();
  return out;
}

/** one declaration, normalized; throws ShapeError naming the field */
export function normalizeSource(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ShapeError("source", "must be an object");
  if (!nonEmpty(raw.system) || !SYSTEM_RE.test(String(raw.system).trim())) throw new ShapeError("system", "needs the system id a record key starts with");
  const read = { ...endpoint(raw.read, "read"), home: home(raw.read.home) };
  const c = raw.commit ?? { via: "none" };
  let commit;
  if (c?.via === "none") commit = { via: "none" };
  else {
    commit = endpoint(c, "commit");
    if (commit.url === read.url) throw new ShapeError("commit.url", "the write endpoint must not be the read endpoint");
    const raw = c.tables === undefined || c.tables === null ? null : c.tables;
    if (raw !== null && !Array.isArray(raw)) throw new ShapeError("commit.tables", "must list table names, or { name, adds, columns, required, defaults }");
    const actions = c.actions === undefined ? [...DEFAULT_ACTIONS] : c.actions;
    if (!Array.isArray(actions) || !actions.length || actions.some((a) => !COMMIT_ACTIONS.includes(a))) throw new ShapeError("commit.actions", `must be some of ${COMMIT_ACTIONS.join(", ")}`);
    const shapes = {};
    // a declaration normalized already keeps its shapes beside the names: normalizing it again changes nothing
    const tables = raw && raw.map((t, i) => {
      const sh = tableShapeOf(typeof t === "string" && c.shapes?.[t.trim()] ? c.shapes[t.trim()] : t, `commit.tables[${i}]`);
      shapes[sh.name] = sh;
      return sh.name;
    });
    if (Object.values(shapes).some((sh) => sh.adds) && !actions.includes("create")) throw new ShapeError("commit.actions", "a table that takes new rows needs create among the actions");
    if (actions.includes("delete") && !Object.values(shapes).some((sh) => sh.adds)) throw new ShapeError("commit.actions", "delete only undoes a row graph-rag added, so it needs a table that takes new rows");
    commit = { ...commit, tables, shapes, actions: [...new Set(actions)], guard: guard(c.guard) };
  }
  return { system: String(raw.system).trim(), description: nonEmpty(raw.description) ? clip(raw.description, 600) : null, read, commit };
}

/** one table of the write side, as a shape: { name, adds, columns, required, defaults } */
function tableShapeOf(raw, field) {
  if (typeof raw === "string") {
    if (!nonEmpty(raw)) throw new ShapeError(field, "must name a table");
    return { name: raw.trim(), adds: false, columns: {}, required: [], defaults: [] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !nonEmpty(raw.name)) throw new ShapeError(field, "must be a table name or { name, adds, columns, required, defaults }");
  const names = (v, f) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => !nonEmpty(x))) throw new ShapeError(`${field}.${f}`, "must list column names");
    return v.map((x) => String(x).trim());
  };
  const columns = {};
  for (const [col, k] of Object.entries(raw.columns ?? {})) {
    if (k === "boolean" || k?.type === "boolean") columns[col] = { type: "boolean" };
    else if (Array.isArray(k?.values) && k.values.length && k.values.every((v) => nonEmpty(v))) columns[col] = { values: k.values.map((v) => String(v).trim()) };
    else throw new ShapeError(`${field}.columns.${col}`, 'must be "boolean" or { values: [..] }');
  }
  if (raw.adds !== undefined && typeof raw.adds !== "boolean") throw new ShapeError(`${field}.adds`, "must be true or false");
  return { name: String(raw.name).trim(), adds: raw.adds === true, columns, required: names(raw.required, "required"), defaults: names(raw.defaults, "defaults") };
}

/** a table's shape as declared (R18, R19), or an empty one: no column is yes/no or fixed-choice, and it takes no new rows */
export function tableShape(decl, table) {
  return decl?.commit?.shapes?.[String(table)] ?? { name: String(table), adds: false, columns: {}, required: [], defaults: [] };
}

/**
 * may this source take this action on this table (a table list of null means any table it grants, for an update).
 * Adding a row (create) needs the table declared as taking new rows (R19); delete, only to undo one, the same.
 */
export function writable(decl, table, action = "update") {
  if (!decl || decl.commit.via === "none") return false;
  if (!decl.commit.actions.includes(action)) return false;
  if (action === "create" || action === "delete") return tableShape(decl, table).adds;
  return decl.commit.tables === null || decl.commit.tables.includes(String(table));
}

/** what a brief says about a source: how it is committed to, never its URLs */
export const briefSource = (decl) => ({ system: decl.system, description: decl.description, commits: decl.commit.via !== "none", actions: (decl.commit.actions ?? []).filter((a) => a !== "delete"), tables: decl.commit.tables ?? null, ...(decl.commit.shapes ? { adds: Object.values(decl.commit.shapes).filter((sh) => sh.adds).map((sh) => sh.name) } : {}) });
