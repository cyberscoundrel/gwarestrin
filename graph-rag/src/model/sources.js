// A source declaration: how each connected source is read and committed to (R2: "Each source declares
// how it is committed to"). Information is committed to its relevant source by whatever means that source
// takes; for SQL Server, a write. Pure.
//
//   { system, description, read: { via, url }, commit: { via, url, tables, actions } | { via: "none" } }
//
// `system` is the first part of a record key (`mssql` in mssql:dbo_Job:4471). A source that is not
// writable makes a clear piece Proposed (R2).
// NEEDS A RULING (what a write may do): smallest choice, create and update only, never delete, as the
// write login's grants already are (dab-config.example/dab-config-write.json).
import { clip, nonEmpty, ShapeError } from "./text.js";

/** how a source is reached: Data API builder's MCP endpoint today */
export const SOURCE_VIA = ["dab-mcp"];
export const COMMIT_ACTIONS = ["create", "update"];
const SYSTEM_RE = /^[a-z0-9_-]{1,40}$/i;

function endpoint(raw, field) {
  if (!raw || typeof raw !== "object") throw new ShapeError(field, "must be an object");
  if (!SOURCE_VIA.includes(raw.via)) throw new ShapeError(`${field}.via`, `must be one of ${SOURCE_VIA.join(", ")}`);
  if (!nonEmpty(raw.url) || !/^https?:\/\//.test(String(raw.url).trim())) throw new ShapeError(`${field}.url`, "needs an http(s) URL");
  return { via: raw.via, url: String(raw.url).trim() };
}

/** one declaration, normalized; throws ShapeError naming the field */
export function normalizeSource(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ShapeError("source", "must be an object");
  if (!nonEmpty(raw.system) || !SYSTEM_RE.test(String(raw.system).trim())) throw new ShapeError("system", "needs the system id a record key starts with");
  const read = endpoint(raw.read, "read");
  const c = raw.commit ?? { via: "none" };
  let commit;
  if (c?.via === "none") commit = { via: "none" };
  else {
    commit = endpoint(c, "commit");
    if (commit.url === read.url) throw new ShapeError("commit.url", "the write endpoint must not be the read endpoint");
    const tables = c.tables === undefined || c.tables === null ? null : c.tables;
    if (tables !== null && (!Array.isArray(tables) || tables.some((t) => !nonEmpty(t)))) throw new ShapeError("commit.tables", "must list table names");
    const actions = c.actions === undefined ? [...COMMIT_ACTIONS] : c.actions;
    if (!Array.isArray(actions) || !actions.length || actions.some((a) => !COMMIT_ACTIONS.includes(a))) throw new ShapeError("commit.actions", `must be some of ${COMMIT_ACTIONS.join(", ")}`);
    commit = { ...commit, tables: tables && tables.map((t) => String(t).trim()), actions: [...new Set(actions)] };
  }
  return { system: String(raw.system).trim(), description: nonEmpty(raw.description) ? clip(raw.description, 600) : null, read, commit };
}

/** may this source take this action on this table (a table list of null means any table it grants) */
export function writable(decl, table, action = "update") {
  if (!decl || decl.commit.via === "none") return false;
  if (!decl.commit.actions.includes(action)) return false;
  return decl.commit.tables === null || decl.commit.tables.includes(String(table));
}

/** what a brief says about a source: how it is committed to, never its URLs */
export const briefSource = (decl) => ({ system: decl.system, description: decl.description, commits: decl.commit.via !== "none", actions: decl.commit.actions ?? [], tables: decl.commit.tables ?? null });
