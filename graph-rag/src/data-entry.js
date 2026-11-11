/**
 * Reading from and committing to source systems: the read adapter (names resolved against the source, rows read
 * by key; R3), the write adapter (create and update through the write-capable instance, never delete; R2), the
 * guard that runs before every write, and data entry, where the class map chooses Filed or Proposed (R6;
 * model/class-map.js filedOrProposed). The authority that counts is the recorder's, never the agent's; a class
 * missing from the map, or a source that isn't writable, means Proposed (R2, R11). There are no audit nodes
 * (R9): every write is begun in, and settled in, the filing log through a journal the caller gives (the filing
 * stream's filing.js `sourceJournal` by default); with none, nothing is written. The sources stream owns this
 * module.
 *
 * Every adapter call answers with a `status`, never a bare throw for something the source did:
 *   found | ambiguous | none            a read: one row, several, or none
 *   written | already                   a write landed, or the row already held it
 *   not_writable                        the declaration takes no such write: the piece is Proposed (R2)
 *   unreachable                         the source couldn't be reached: the piece is Held (R3)
 *   moved                               the row no longer holds what the worker read: Held, never overwritten (R2)
 *   not_found | refused | unknown       no such row; the source or the guard said no; a write whose end can't be told
 * and `filing`, the outcome it points to (filed, proposed, held). The worker's filing decides; this only says
 * what the source did.
 * NEEDS A RULING (read reachable, write not): smallest choice, Held, like any unreachable source (R3), not
 * Proposed: a person approving it could not apply it either. A source declared with no write side is Proposed.
 * NEEDS A RULING (a write whose end can't be told): the transport broke and the row can't be read back. None of
 * the four outcomes fits; smallest choice, Held, with the log entry left "unknown" for the next attempt to settle.
 *
 * Sources are declared (sources.js, model/sources.js) and reached through DAB's MCP endpoint (Data API builder's
 * SQL MCP Server), never copied into the graph. DAB's tools are as DAB 2.0.12 (the version dab/Dockerfile pins)
 * serves them, read off running instances, last the synthetic test SQL Server's (test-sql/):
 * read_records { entity, filter, select, orderby, first }, update_record { entity, keys, fields },
 * create_record { entity, data }. A filter is `col op literal` joined by and / or, op one of eq ne gt ge lt le;
 * there is no contains or startswith, so a prefix is found as a range. Text compares case-insensitively (the
 * server's collation). A literal is typed by the column (a number bare, text quoted: DAB refuses the other).
 * describe_entities names no fields, so the key comes from the first page's cursor (DAB pages by primary key):
 * primaryKeyFrom.
 */
import { log } from "./context.js";
import { adbCommand as realCommand, adbQuery as realQuery } from "./db.js";
import { filedOrProposed, validatePolicy } from "./model/class-map.js";
import { classIndex } from "./model/classes.js";
import { isoDate, snakeCase } from "./model/text.js";
import { parseKey, parseTable } from "./model/schema.js";
import { GUARD_ENTITY, writable as declaredWritable } from "./model/sources.js";
import { canSee, commonAncestor, defaultHome, EVERYONE, heldPositions } from "./positions.js";
import { authorityMap } from "./policy.js";
import { forgetSources, loadSources } from "./sources.js";

const realDb = { adbCommand: realCommand, adbQuery: realQuery };
// the live position map, token map and pending-write queue, reached when used (not at load: a test imports this module alone)
const livePositions = async () => (await import("./scope.js")).positionMap;
const liveQueue = async () => import("./write.js");
/** a person as the token map holds them now ({ positions, caps }), or undefined */
const livePeople = async () => {
  const scope = await import("./scope.js");
  return (name) => scope.entriesByUser.get(name);
};
/**
 * The class tree as stored now (the classes stream's classes.js allClasses), as model/classes.js classIndex, so a
 * subclass takes its parents' map entries (R9). Null when it can't be read: then only a class's own entry counts,
 * which fails safe (a class with no entry is Proposed).
 */
async function liveIndex() {
  try {
    const m = await import("./classes.js");
    return typeof m.allClasses === "function" ? classIndex(await m.allClasses()) : null;
  } catch (e) {
    log.warn(`the class tree couldn't be read, so only a class's own map entry counts: ${String(e?.message ?? e).slice(0, 160)}`);
    return null;
  }
}
/** the index a decision runs over: the one given (null for none), else the live tree */
const indexFor = async (index) => (index === undefined ? liveIndex() : index);
/** the filing log's journal for source writes, when the filing stream's filing.js exports one */
const liveJournal = async () => (await import("./filing.js").catch(() => null))?.sourceJournal ?? null;

export { forgetSources };

/**
 * Where each declared source is read and written, in the older shape { [system]: { read, write } } (write null when
 * the declaration takes no writes). Filing's source lookups and briefs read this; the declarations themselves are
 * sources.js loadSources.
 */
export async function sourcesConfig(db = realDb, opts = {}) {
  const decls = await loadSources(db, opts);
  return Object.fromEntries(Object.entries(decls).map(([system, d]) => [system, { read: d.read.url, write: d.commit.via === "none" ? null : d.commit.url }]));
}

/** ---- DAB over MCP (streamable HTTP) ---- */

/** the tool calls as DAB 2.0.12 serves them (checked against a running instance's tools/list) */
export const DAB_CALLS = {
  // a first page of one row: its cursor names the primary key (primaryKeyFrom)
  firstPage: (entity) => ({ name: "read_records", args: { entity, first: 1 } }),
  read: (entity, keyColumn, literal) => ({ name: "read_records", args: { entity, filter: `${keyColumn} eq ${literal}`, first: 2 } }),
  update: (entity, keys, fields) => ({ name: "update_record", args: { entity, keys, fields } }),
  create: (entity, data) => ({ name: "create_record", args: { entity, data } }),
};

/**
 * An OData literal for a column of `type` ("number" or "string"; DAB refuses a number for a text column
 * and the reverse). Null when the value can't be one of that type: no row of that column can hold it.
 */
export function odata(v, type) {
  if (type === "number") return /^-?\d+(\.\d+)?$/.test(String(v)) ? String(v) : null;
  return `'${String(v).replace(/'/g, "''")}'`;
}

const sessions = new Map(); // url -> mcp-session-id
/** the tools that change a source: never sent twice, whatever the answer (a lost answer is settled by reading back) */
const WRITE_TOOLS = new Set(["create_record", "update_record", "delete_record", "execute_entity"]);

/** the source couldn't be reached (a network error, a timeout, a server error): nothing it says is known */
const unreachableError = (message, extra = {}) => Object.assign(new Error(message), { transport: true, ...extra });

/**
 * One MCP tool call; the result's text content parsed as JSON when it is some. Throws with `transport: true`
 * when the source couldn't be reached or failed as a server (5xx, a timeout, a wrong address), and with
 * `toolError: true` (and `errorType`, DAB's) when the tool answered no: nothing was done.
 */
export async function mcpToolCall(url, name, args, { fetch: f = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const rpc = async (method, params, id) => {
    const session = sessions.get(url) ?? null;
    let res;
    try {
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw unreachableError(`${name}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    const sid = res.headers?.get?.("mcp-session-id");
    if (sid) sessions.set(url, sid);
    const text = await res.text();
    if (!res.ok) {
      // only an answer that says the session is gone is a lost session: a 5xx may come after the source acted
      const lost = Boolean(session) && (res.status === 404 || (res.status === 400 && /session/i.test(text)));
      const e = Object.assign(new Error(`${name}: ${res.status} ${text.slice(0, 200)}`), { status: res.status, staleSession: lost });
      if (res.status >= 500 || res.status === 404) e.transport = true;
      throw e;
    }
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    try {
      return JSON.parse(line ? line.slice(5) : text || "{}");
    } catch {
      throw unreachableError(`${name}: the source answered with something that isn't JSON-RPC`);
    }
  };
  const handshake = () => rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "graph-rag", version: "0.3.0" } }, 1).catch(() => {});
  // a streamable-HTTP server wants a handshake first; one that doesn't answers the call anyway
  if (!sessions.has(url)) await handshake();
  let msg;
  try {
    msg = await rpc("tools/call", { name, arguments: args }, 2);
  } catch (e) {
    // a restarted server forgets its sessions: one fresh handshake, then the call once more; never a write, which
    // is reported unreachable and settled by its caller reading the row back
    if (!e.staleSession) throw e;
    sessions.delete(url);
    if (WRITE_TOOLS.has(name)) throw Object.assign(e, { transport: true });
    await handshake();
    msg = await rpc("tools/call", { name, arguments: args }, 2);
  }
  if (msg.error) throw new Error(`${name}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
  const content = msg.result?.content?.find((c) => c.type === "text")?.text ?? "";
  // the tool answered and said no: nothing was done (a transport error says nothing about that)
  if (msg.result?.isError) {
    let error = null;
    try {
      error = JSON.parse(content)?.error ?? null;
    } catch {}
    throw Object.assign(new Error(`${name}: ${error?.message ?? content.slice(0, 300)}`), { toolError: true, errorType: error?.type ?? null, errorMessage: error?.message ?? null });
  }
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** an error as an adapter status: the source couldn't be reached, or it (or a check here) said no */
export const statusOf = (e) => (e?.transport ? "unreachable" : "refused");

/** the rows in a read_records answer: DAB 2.0.12's { entity, result: { value: [...] } }, or a bare array or { value } */
export function rowsOf(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  for (const holder of [result.result, result]) {
    if (Array.isArray(holder)) return holder;
    if (Array.isArray(holder?.value)) return holder.value;
  }
  return [];
}

/**
 * An entity's primary key from a first page's cursor: DAB pages by primary key, and its `after` is base64 JSON
 * naming each key column ([{ EntityName, FieldName, FieldValue, Direction }]), in order, with a value of the
 * column's type. Null when the page has no cursor (a table of one row or none) or the cursor can't be read:
 * then the key is not known, and nothing is guessed in its place.
 */
export function primaryKeyFrom(page, entity) {
  const after = page?.result?.after ?? page?.after;
  if (typeof after !== "string" || !after) return null;
  let cols;
  try {
    cols = JSON.parse(Buffer.from(after, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(cols) || !cols.length) return null;
  if (cols.some((c) => typeof c?.FieldName !== "string" || !c.FieldName || (c.EntityName !== undefined && c.EntityName !== entity))) return null;
  return cols.map((c) => ({ name: c.FieldName, type: typeof c.FieldValue === "number" ? "number" : "string" }));
}

const firstPages = new Map(); // url + table -> { pk: [{ name, type }] | null, sample: row | null }

/** forget the learned primary keys and columns (a test, or a source whose schema changed) */
export const forgetPrimaryKeys = () => firstPages.clear();

/** a table's first page, once per endpoint: its key (from the cursor) and a row showing its columns and their types */
async function firstPageOf(url, table, call) {
  const k = `${url} ${table}`;
  if (!firstPages.has(k)) {
    const page = await call(url, DAB_CALLS.firstPage(table));
    firstPages.set(k, { pk: primaryKeyFrom(page, table), sample: rowsOf(page)[0] ?? null });
  }
  return firstPages.get(k);
}

/**
 * A client for one system: read a row by its verified primary key, write fields to it, create one. `urls`
 * { read, write }; `fetch` injectable. The key column is the table's primary key, learned from the source;
 * a `key_column` a worker gives must be that column, or the call is refused, and a key that can't be
 * learned, or that spans several columns where a record key names one, refuses the call too.
 * NEEDS A RULING (composite keys): a record key (system:table:row) names one column; a table keyed by several
 * is refused until the contract states a form for them.
 */
export function sourceClient(system, urls, opts = {}) {
  const call = (url, c) => mcpToolCall(url, c.name, c.args, opts);
  const primaryKey = async (table, keyColumn, url = urls.read) => {
    const { pk } = await firstPageOf(url, table, call);
    // NEEDS A RULING (tables of fewer than two rows): DAB 2.0.12 names a table's key only in the next-page cursor,
    // and describe_entities names no fields, so such a table can be neither read by key nor written: refused
    if (!pk) throw new Error(`the primary key of ${system}:${table} can't be learned from the source (it pages by key, and this table has no second row to page to): refused rather than guessed`);
    if (pk.length !== 1) throw new Error(`${system}:${table} has a composite primary key (${pk.map((c) => c.name).join(", ")}): a record key names one column, so the row can't be determined`);
    if (keyColumn && keyColumn !== pk[0].name) throw new Error(`${keyColumn} is not the primary key of ${system}:${table}; the row is keyed by ${pk[0].name}`);
    return pk[0];
  };
  return {
    system,
    canRead: Boolean(urls?.read),
    canWrite: Boolean(urls?.write),
    primaryKey,
    /** the columns a table shows and their types ("number", "string", or "unknown" for an empty value), from its first row */
    async columns(table) {
      const { sample } = await firstPageOf(urls.read, table, call);
      return sample ? Object.fromEntries(Object.entries(sample).map(([c, v]) => [c, typeof v === "number" ? "number" : v === null ? "unknown" : "string"])) : null;
    },
    /** rows by a filter DAB takes, as read_records answers them */
    async readWhere(table, args) {
      return rowsOf(await call(urls.read, { name: "read_records", args: { entity: table, ...args } }));
    },
    /** the entities the read endpoint exposes */
    async entities() {
      const r = await call(urls.read, { name: "describe_entities", args: { nameOnly: true } });
      return (r?.entities ?? []).map((e) => e.name).filter(Boolean);
    },
    /** the row by its primary key, or null when there is none; `key_value` is the key as the row holds it */
    async readRow(table, rowKey, { key_column } = {}) {
      if (!urls?.read) throw new Error(`no read endpoint for ${system}`);
      const pk = await primaryKey(table, key_column);
      const literal = odata(rowKey, pk.type);
      if (literal === null) return null;
      const rows = rowsOf(await call(urls.read, DAB_CALLS.read(table, pk.name, literal)));
      if (rows.length > 1) throw new Error(`${system}:${table}:${rowKey} matched ${rows.length} rows by ${pk.name}: not one row`);
      if (rows[0] && !sameValue(rows[0][pk.name], rowKey)) throw new Error(`${system}:${table}:${rowKey}: the source answered with a row whose ${pk.name} is ${rows[0][pk.name] ?? "not shown"}: not the row asked for`);
      return rows[0] ? { row: rows[0], key_column: pk.name, key_value: rows[0][pk.name] } : null;
    },
    /** write fields to the row (`hit`, what readRow returned for it); the source's answer */
    async writeRow(table, hit, fields) {
      if (!urls?.write) throw new Error(`no write-capable endpoint for ${system}: data entry can only be proposed`);
      assertWritable(fields, hit);
      return call(urls.write, DAB_CALLS.update(table, { [hit.key_column]: hit.key_value }, fields));
    },
    /** create a row; the row the source made (its key included) */
    async createRow(table, data) {
      if (!urls?.write) throw new Error(`no write-capable endpoint for ${system}: data entry can only be proposed`);
      return rowsOf(await call(urls.write, DAB_CALLS.create(table, data)))[0] ?? null;
    },
  };
}

/** the columns to write must be the row's, and never its key: a write changes one row's facts, not which row it is */
export function assertWritable(fields, hit) {
  const unknown = Object.keys(fields).filter((c) => !(c in hit.row));
  if (unknown.length) throw new Error(`the row has no column ${unknown.join(", ")}: it has ${Object.keys(hit.row).join(", ")}`);
  if (hit.key_column in fields) throw new Error(`${hit.key_column} is the row's key: a data entry doesn't change it`);
  // the write names its row by this value, and a key past what a JSON number holds exactly would name its neighbour
  if (typeof hit.key_value === "number" && !Number.isSafeInteger(Math.trunc(hit.key_value))) throw new Error(`${hit.key_column} ${hit.key_value} is too large to name one row exactly: nothing is written`);
}

/** ---- the read adapter (R3: workers resolve names against the source with read tools) ---- */

/** the filing outcome a status points to */
const FILING = { written: "filed", already: "filed", not_writable: "proposed" };
const answer = (status, rest = {}) => ({ status, filing: FILING[status] ?? (["found", "ambiguous", "none"].includes(status) ? null : "held"), ...rest });
const failed = (e, rest = {}) => answer(statusOf(e), { why: String(e?.message ?? e).slice(0, 300), ...rest });

/** the declaration for a system, and a refusal when there is none or the table isn't one the caller allows */
/**
 * The declaration for a system, and a refusal when there is none, when the connection's home is above the
 * `audience` read for (R11.6: a worker sees only its audience; R11.9: a table's data takes the home of the
 * connection that reads it), or when the table isn't one the caller allows. `audience` is a position, or
 * everyone; `positions` the position map (the live one when not given). Nothing is read from a source above it.
 * NEEDS A RULING (narrowing tables within one connection): a caller may pass `tables`; no rule here says which
 * tables of a connection an audience may read beyond the connection's own home.
 */
async function declared(system, table, { db = realDb, sources, tables, audience, positions } = {}) {
  const decl = (sources ?? (await loadSources(db, { ttlMs: 0 })))[system] ?? null;
  if (!decl) return { refusal: answer("refused", { why: `no connected source called ${system}` }) };
  if (audience !== undefined) {
    positions ??= await livePositions();
    if (!positions) return { refusal: answer("refused", { why: "no position map is loaded, so no audience can be told what it sees" }) };
    const known = audience === EVERYONE || Boolean(positions.positions?.[audience]);
    const home = decl.read.home ?? positions.root;
    if (!known || !canSee(positions, [audience], home)) return { refusal: answer("refused", { why: `${system} is read at ${home}, which is above this audience (${audience ?? "none"}): nothing is read` }) };
  }
  if (table && tables && !tables.includes(table)) return { refusal: answer("refused", { why: `${system}:${table} is not among the tables this read may see` }) };
  return { decl };
}

const readClient = (decl, f) => sourceClient(decl.system, { read: decl.read.url, write: null }, f ? { fetch: f } : {});
const keyOf = (system, table, pk, row) => (pk?.length === 1 && row?.[pk[0].name] !== undefined && row[pk[0].name] !== null ? `${system}:${table}:${row[pk[0].name]}` : null);

/** the tables a source's read side exposes (within `tables` when the caller narrows them) */
export async function describeSource(system, opts = {}) {
  const { decl, refusal } = await declared(system, null, opts);
  if (refusal) return refusal;
  try {
    const names = await readClient(decl, opts.fetch).entities();
    return answer("found", { system, tables: opts.tables ? names.filter((n) => opts.tables.includes(n)) : names });
  } catch (e) {
    return failed(e);
  }
}

/** one row by its record key (system:table:row): found, none, or why not */
export async function getRow(key, opts = {}) {
  const k = parseKey(key);
  if (!k) return answer("refused", { why: `not a record key (system:table:row): ${key}` });
  const { decl, refusal } = await declared(k.system, k.table, opts);
  if (refusal) return refusal;
  try {
    const hit = await readClient(decl, opts.fetch).readRow(k.table, k.row_key);
    return hit ? answer("found", { key: `${k.system}:${k.table}:${hit.key_value}`, row: hit.row }) : answer("none", { key: k.key });
  } catch (e) {
    return failed(e, { key: k.key });
  }
}

/**
 * Rows whose `column` matches `value`: `mode` "eq" (the whole value, case-insensitively, as the source compares)
 * or "prefix" (text starting with it), and `also` ({ column: value }) each equal too, to narrow by another column
 * (an active employee called Diep). At most `first` rows come back, with `more` when there are others; one
 * row is found, several ambiguous, none none. Which column to search is the caller's, from the table's columns:
 * there are no word lists here (R3). DAB has no contains, so a prefix is read as a range (`ge`, in the column's
 * order) and checked here.
 */
export async function findRows({ system, table, column, value, mode = "eq", first = 5, also = null }, opts = {}) {
  const { decl, refusal } = await declared(system, table, opts);
  if (refusal) return refusal;
  if (!["eq", "prefix"].includes(mode)) return answer("refused", { why: `mode must be eq or prefix, not ${mode}` });
  if (value === undefined || value === null || String(value).trim() === "") return answer("refused", { why: "a value to find is needed" });
  const cap = Math.max(1, Math.min(Number(first) || 5, 20));
  const c = readClient(decl, opts.fetch);
  try {
    const cols = await c.columns(table);
    if (cols && !(column in cols)) return answer("refused", { why: `${system}:${table} has no column ${column}: it has ${Object.keys(cols).join(", ")}` });
    const unknown = Object.keys(also ?? {}).filter((c) => cols && !(c in cols));
    if (unknown.length) return answer("refused", { why: `${system}:${table} has no column ${unknown.join(", ")}: it has ${Object.keys(cols).join(", ")}` });
    const extra = [];
    for (const [c, v] of Object.entries(also ?? {})) {
      const l = odata(v, cols?.[c] === "number" ? "number" : "string");
      if (l === null) return answer("none", { rows: [], more: false });
      extra.push(`${c} eq ${l}`);
    }
    const and = extra.map((x) => ` and ${x}`).join("");
    const type = cols?.[column] === "number" ? "number" : "string";
    if (mode === "prefix" && type === "number") return answer("refused", { why: `${column} is a number column: find it by eq` });
    const literal = odata(String(value).trim(), type);
    if (literal === null) return answer("none", { rows: [], more: false });
    const { pk } = await firstPageOf(decl.read.url, table, (url, call) => mcpToolCall(url, call.name, call.args, opts.fetch ? { fetch: opts.fetch } : {}));
    let rows;
    if (mode === "eq") rows = await c.readWhere(table, { filter: `${column} eq ${literal}${and}`, first: cap + 1 });
    else {
      const page = 4 * cap;
      const prefix = String(value).trim().toLowerCase();
      const read = await c.readWhere(table, { filter: `${column} ge ${literal}${and}`, orderby: [`${column} asc`], first: page });
      rows = read.filter((r) => String(r[column] ?? "").toLowerCase().startsWith(prefix));
      // a full page all matching may have more past it
      if (read.length === page && rows.length === page) rows.push(null);
    }
    const more = rows.length > cap;
    const out = rows.filter(Boolean).slice(0, cap).map((row) => ({ key: keyOf(system, table, pk, row), row }));
    return answer(out.length === 0 ? "none" : out.length === 1 && !more ? "found" : "ambiguous", { rows: out, more });
  } catch (e) {
    return failed(e);
  }
}

/** the rows searchRows reads per page, and at most in all, before it says it stopped short */
export const SEARCH_PAGE = 200;
export const SEARCH_SCAN = 5000;

/**
 * Rows of one table found by text and by column values, for an agent (I-40). DAB 2.0.12's filter has no string
 * functions (contains, startswith: "$filter query parameter is not well formed"), and an agent writing valid OData
 * can't know that, so the text match is done here: `text` is words that must all appear, case-insensitively, in a
 * row's `columns` (all of them when none are named), numbers read as text. `where` ({ column: value }) narrows by
 * equal values, sent to the source: a number column takes a number (a numeric string is read as one; anything else
 * is refused with why), a text column takes the value as text. A table or column that isn't there is refused with
 * the real ones, before anything is read. Pages are read by primary key (`key gt last`), never by a cursor, up to
 * SEARCH_SCAN rows; the caller pages through what matched by `offset`. `select` narrows the columns shown (the key
 * stays). Returns { status: found | ambiguous | none, rows: [{ key, row }], matched, offset, more, next_offset?,
 * complete }; complete is false when the scan stopped short (narrow it with where).
 */
export async function searchRows({ system, table, text = null, columns = null, where = null, select = null, first = 10, offset = 0 }, opts = {}) {
  const { decl, refusal } = await declared(system, table, opts);
  if (refusal) return refusal;
  const cap = Math.max(1, Math.min(Number(first) || 10, 50));
  const from = Math.max(0, Math.trunc(Number(offset) || 0));
  const c = readClient(decl, opts.fetch);
  try {
    const names = (await c.entities()).filter((n) => !opts.tables || opts.tables.includes(n));
    if (!names.includes(table)) return answer("refused", { why: `${system} has no table ${table}: it has ${names.join(", ")}` });
    const cols = await c.columns(table);
    if (!cols) return answer("none", { rows: [], matched: 0, offset: from, more: false, complete: true });
    const named = [...(columns ?? []), ...Object.keys(where ?? {}), ...(select ?? [])];
    const unknown = [...new Set(named.filter((x) => !(x in cols)))];
    if (unknown.length) return answer("refused", { why: `${system}:${table} has no column ${unknown.join(", ")}: it has ${Object.keys(cols).join(", ")}` });
    const words = String(text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length && !Object.keys(where ?? {}).length) return answer("refused", { why: "give text to find, or where: { column: value }" });
    // equal values: sent to the source where the column's type is known, compared here where it isn't (a null in the sample row)
    const sent = [];
    const here = [];
    for (const [col, v] of Object.entries(where ?? {})) {
      const s = String(v ?? "").trim();
      if (v === null || v === undefined || s === "") return answer("refused", { why: `where ${col}: give a value` });
      if (cols[col] === "number") {
        if (!/^-?\d+(\.\d+)?$/.test(s)) return answer("refused", { why: `${col} is a number column: compare it with a number, not "${s.slice(0, 60)}"; to find words in it, use text` });
        sent.push(`${col} eq ${s}`);
      } else if (cols[col] === "string") sent.push(`${col} eq ${odata(s, "string")}`);
      else here.push([col, s]);
    }
    const searchIn = columns?.length ? columns : Object.keys(cols);
    const hit = (row) => here.every(([col, s]) => sameValue(row[col], s)) && words.every((w) => searchIn.some((col) => row[col] !== null && row[col] !== undefined && String(row[col]).toLowerCase().includes(w)));
    const { pk } = await firstPageOf(decl.read.url, table, (url, call) => mcpToolCall(url, call.name, call.args, opts.fetch ? { fetch: opts.fetch } : {}));
    const byKey = pk?.length === 1 ? pk[0] : null;
    const limit = Math.max(SEARCH_PAGE, Number(opts.scanLimit ?? SEARCH_SCAN));
    const matches = [];
    let scanned = 0;
    let last = null;
    let complete = false;
    while (scanned < limit) {
      const after = byKey && last !== null ? odata(last, byKey.type) : null;
      if (byKey && last !== null && after === null) break;
      const filter = [...sent, ...(after !== null ? [`${byKey.name} gt ${after}`] : [])].join(" and ");
      const size = byKey ? SEARCH_PAGE : limit;
      const rows = await c.readWhere(table, { ...(filter ? { filter } : {}), ...(byKey ? { orderby: [`${byKey.name} asc`] } : {}), first: size });
      scanned += rows.length;
      for (const r of rows) if (hit(r)) matches.push(r);
      if (rows.length < size || !byKey) {
        complete = rows.length < size;
        break;
      }
      last = rows.at(-1)[byKey.name];
    }
    const show = (row) => (select?.length ? Object.fromEntries(Object.entries(row).filter(([k]) => select.includes(k) || k === byKey?.name)) : row);
    const page = matches.slice(from, from + cap).map((row) => ({ key: keyOf(system, table, pk, row), row: show(row) }));
    const more = matches.length > from + cap || !complete;
    return answer(page.length === 0 ? "none" : page.length === 1 && !more && from === 0 ? "found" : "ambiguous", {
      rows: page,
      matched: matches.length,
      offset: from,
      more,
      ...(matches.length > from + cap ? { next_offset: from + cap } : {}),
      complete,
      ...(complete ? {} : { note: `searched the first ${scanned} rows of ${system}:${table} only: narrow it with where` }),
    });
  } catch (e) {
    return failed(e);
  }
}

/** ---- the guard ---- */

const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * Before any write: ask the write connection which server and database it holds, and refuse unless they are the
 * declared names (`commit.guard`). It reads the identity view through the write endpoint, which computes them on
 * that connection (test-sql/seed.mjs), so the answer is where the write would land. No guard declared, no view,
 * or any other answer: refused. A restored copy changes only the declared names.
 */
export async function checkGuard(decl, { fetch: f } = {}) {
  if (!decl || decl.commit?.via === "none") return answer("not_writable", { ok: false, why: `${decl?.system ?? "this source"} takes no writes` });
  const g = decl.commit.guard;
  if (!g) return answer("refused", { ok: false, why: `no guard is declared for ${decl.system}'s write connection, so nothing is written through it` });
  if (g.entity !== GUARD_ENTITY) return answer("refused", { ok: false, why: `the guard must be read through ${GUARD_ENTITY}, the view that computes the connection's names, not ${g.entity}` });
  let rows;
  try {
    rows = rowsOf(await mcpToolCall(decl.commit.url, "read_records", { entity: g.entity, first: 2 }, f ? { fetch: f } : {}));
  } catch (e) {
    return failed(e, { ok: false, why: `the guard couldn't read ${g.entity} through the write connection: ${String(e?.message ?? e).slice(0, 200)}` });
  }
  if (rows.length !== 1) return answer("refused", { ok: false, why: `the write connection's ${g.entity} answered ${rows.length} rows, not one` });
  const { server_name: server, database_name: database, login_name: login } = rows[0];
  if (!sameName(server, g.server) || !sameName(database, g.database)) {
    return answer("refused", { ok: false, server, database, why: `the write connection holds ${server ?? "?"}/${database ?? "?"}, not the declared ${g.server}/${g.database}: nothing is written` });
  }
  if (g.login && !sameName(login, g.login)) return answer("refused", { ok: false, server, database, why: `the write connection is logged in as ${login ?? "?"}, not the declared ${g.login}: nothing is written` });
  return { status: "ok", ok: true, server, database, login: login ?? null };
}

/** ---- the write adapter ---- */

const holds = (row, fields) => Boolean(row) && Object.entries(fields).every(([c, v]) => c in row && (sameValue(row[c], v) || ((row[c] ?? null) === null && (v ?? null) === null)));
const pick = (row, cols) => Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]]));

/** settle a journal entry; a failure to settle is said, never thrown over a write that landed */
async function settle(journal, id, status, detail) {
  try {
    await journal.settle(id, status, detail);
    return true;
  } catch (e) {
    log.warn(`filing log entry ${id} not settled as ${status}: ${String(e?.message ?? e).slice(0, 160)}`);
    return false;
  }
}

/** what every write needs before it starts: a write the declaration takes, a journal, and the guard passed */
async function writeGate(system, table, action, opts) {
  const { decl, refusal } = await declared(system, table, opts);
  if (refusal) return { refusal };
  if (!declaredWritable(decl, table, action)) return { refusal: answer("not_writable", { why: `${system} takes no ${action} on ${table}` }) };
  if (!decl.commit.tables) return { refusal: answer("refused", { why: `${system}'s write side names no tables, so it may not write any: declare the tables it writes` }) };
  const journal = opts.journal === undefined ? await liveJournal() : opts.journal;
  if (!journal || typeof journal.begin !== "function" || typeof journal.settle !== "function") return { refusal: answer("refused", { why: "there is no filing log to record the write in, so nothing is written" }) };
  const guard = await checkGuard(decl, opts);
  if (!guard.ok) return { refusal: guard };
  return { decl, journal, guard };
}

/**
 * Update one row (`key`, system:table:row) with `fields`. `before` is what the worker read in those columns: if
 * the row no longer holds it, nothing is written (`moved`, R2: never overwrite). The steps: the declaration
 * takes the write, the guard passes, the row is read through the write connection, the attempt is begun in the
 * filing log, the write, then the entry settled; a transport error reads the row back before calling it.
 * `piece` is passed to the journal as the caller's (the filing entry it belongs to).
 */
export async function commitRow({ key, fields, before = null, piece = null }, opts = {}) {
  const k = parseKey(key);
  if (!k) return answer("refused", { why: `not a record key (system:table:row): ${key}` });
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) return answer("refused", { why: "fields: the columns to write, with their values" });
  const { decl, journal, refusal } = await writeGate(k.system, k.table, "update", opts);
  if (refusal) return { ...refusal, key: k.key };
  const client = sourceClient(k.system, { read: decl.commit.url, write: decl.commit.url }, opts.fetch ? { fetch: opts.fetch } : {});
  let hit;
  try {
    hit = await client.readRow(k.table, k.row_key);
    if (!hit) return answer("not_found", { key: k.key, why: `no row ${k.row_key} in ${k.table}` });
    assertWritable(fields, hit);
  } catch (e) {
    return failed(e, { key: k.key });
  }
  const now = pick(hit.row, Object.keys(fields));
  if (!before || typeof before !== "object") return answer("refused", { key: k.key, why: "before: what was read in the columns written is needed, so a row that moved is never written over" });
  {
    const missing = Object.keys(fields).filter((c) => !(c in before));
    if (missing.length) return answer("refused", { key: k.key, why: `before must say what was read in every column written; it doesn't name ${missing.join(", ")}` });
    if (!holds(hit.row, before)) return answer("moved", { key: k.key, row: hit.row, why: "the row no longer holds what was read: nothing is written over it" });
  }
  let id;
  try {
    id = await journal.begin({ system: k.system, table: k.table, key: k.key, action: "update", fields, before: now, piece });
  } catch (e) {
    return answer("refused", { key: k.key, why: `the filing log couldn't record the attempt, so nothing is written: ${String(e?.message ?? e).slice(0, 200)}` });
  }
  // the row already holds it: nothing is sent, and the log still says so, so the piece gets its Filed entry
  if (holds(hit.row, fields)) {
    const settled = await settle(journal, id, "written", { after: fields, note: "the row already held it: nothing was sent" });
    return answer("already", { key: k.key, before: now, after: fields, log_id: id, ...(settled ? {} : { log_unsettled: true }) });
  }
  try {
    const result = await client.writeRow(k.table, hit, fields);
    const settled = await settle(journal, id, "written", { after: fields });
    return answer("written", { key: k.key, before: now, after: fields, log_id: id, result, ...(settled ? {} : { log_unsettled: true }) });
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 300);
    if (!e?.transport) {
      await settle(journal, id, "refused", { error });
      return answer("refused", { key: k.key, log_id: id, why: error });
    }
    let row;
    try {
      row = (await client.readRow(k.table, k.row_key))?.row ?? null;
    } catch {
      await settle(journal, id, "unknown", { error });
      return answer("unknown", { key: k.key, log_id: id, why: `${error}; the row couldn't be read back, so whether it changed is not known` });
    }
    if (holds(row, fields)) {
      await settle(journal, id, "written", { after: fields, note: `the source answered with an error (${error}) but the row holds the new values` });
      return answer("written", { key: k.key, before: now, after: fields, log_id: id, note: "the row holds the new values despite the transport error" });
    }
    await settle(journal, id, "unreachable", { error });
    return answer("unreachable", { key: k.key, log_id: id, why: error });
  }
}

/**
 * Create one row in `table` (DAB's entity name) of `system`. The key the source makes comes back as `key`; a
 * table whose key can't be learned is refused first, since a Filed piece names the row it wrote. A transport
 * error can't be read back (there is no key yet): `unknown`.
 */
export async function createRow({ system, table, data, piece = null }, opts = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.keys(data).length) return answer("refused", { why: "data: the new row's columns, with their values" });
  const { decl, journal, refusal } = await writeGate(system, table, "create", opts);
  if (refusal) return refusal;
  const client = sourceClient(system, { read: decl.commit.url, write: decl.commit.url }, opts.fetch ? { fetch: opts.fetch } : {});
  let pk;
  try {
    pk = await client.primaryKey(table);
  } catch (e) {
    return failed(e);
  }
  let id;
  try {
    id = await journal.begin({ system, table, key: null, action: "create", fields: data, before: null, piece });
  } catch (e) {
    return answer("refused", { why: `the filing log couldn't record the attempt, so nothing is written: ${String(e?.message ?? e).slice(0, 200)}` });
  }
  try {
    const row = await client.createRow(table, data);
    const key = keyOf(system, table, [pk], row);
    const settled = await settle(journal, id, "written", { key, after: row });
    return answer("written", { key, row, log_id: id, ...(settled ? {} : { log_unsettled: true }) });
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 300);
    const status = e?.transport ? "unknown" : "refused";
    await settle(journal, id, status, { error });
    return answer(status, { log_id: id, why: error });
  }
}

/** a client for the system a key names (`mssql:dbo_Job:4471` -> mssql), read side only */
export async function clientFor(key, { db = realDb, fetch: f, sources } = {}) {
  const k = parseKey(key);
  if (!k) throw new Error(`not a record key (system:table:row): ${key}`);
  const decl = (sources ?? (await loadSources(db, { ttlMs: 0 })))[k.system];
  if (!decl) throw new Error(`no connected source called ${k.system}`);
  // read only: every write goes through commitRow or createRow (the declaration, the journal, the guard)
  return { client: sourceClient(k.system, { read: decl.read.url, write: null }, f ? { fetch: f } : {}), key: k, declaration: decl };
}

/** ---- columns and values (pure) ---- */

/** a name with its case and punctuation gone: credit_limit, CreditLimit and CREDITLIMIT are one name */
const spelled = (name) => snakeCase(name).replace(/_/g, "");

/**
 * The column a name means, among a row's: the one with the same name however it is cased or punctuated, or
 * null (none, or several alike). Never a column that merely contains the word: `status` is not `credit_status`.
 */
export function columnFor(name, row) {
  const a = spelled(name);
  const hits = a ? Object.keys(row ?? {}).filter((c) => spelled(c) === a) : [];
  return hits.length === 1 ? hits[0] : null;
}

/** two values as the same fact: numbers by value, dates by instant, text case- and space-insensitively */
export function sameValue(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const na = Number(a);
  const nb = Number(b);
  if (String(a).trim() !== "" && String(b).trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  const da = isoDate(String(a).trim());
  const db = isoDate(String(b).trim());
  if (da && db) return da === db;
  const norm = (v) => String(v).toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

/** ---- the class map ---- */

const authorityCache = { at: 0, value: null };

/**
 * The map as stored in OrgPolicy scope "authority" (an older place for it), validated against the position
 * map; {} only when none is stored. A map that can't be read or doesn't validate throws: nothing is decided as
 * if it named nothing. Cached a minute, a failure never.
 */
export async function authorityPolicy(db = realDb, { positions, ttlMs = 60_000, now = Date.now() } = {}) {
  if (authorityCache.value && now - authorityCache.at < ttlMs) return authorityCache.value;
  positions ??= await livePositions();
  const row = (await db.adbQuery("SELECT json FROM OrgPolicy WHERE scope = 'authority' LIMIT 1"))[0];
  if (row?.json && !positions) throw new Error("no position map to read the stored map against");
  const value = row?.json ? validatePolicy(JSON.parse(row.json), positions, { stored: true }) : { classes: {}, attributes: {} };
  Object.assign(authorityCache, { at: now, value });
  return value;
}

export const forgetAuthorityPolicy = () => Object.assign(authorityCache, { at: 0, value: null });

/** a map with at least one entry in it */
const hasRules = (m) => Boolean(m && typeof m === "object" && (Object.keys(m.classes ?? {}).length || Object.keys(m.attributes ?? {}).length));

/** the organization's map as stored now (OrgPolicy scope "org"), else the deployment's; throws when it can't be read */
async function organizationMap(db, positions) {
  const row = (await db.adbQuery("SELECT json FROM OrgPolicy WHERE scope = 'org' LIMIT 1"))[0];
  const stored = row?.json ? JSON.parse(row.json) : null;
  if (stored?.authorityMap !== undefined) return authorityMap(stored.authorityMap, positions, { stored: true });
  return (await import("./org-policy.js")).policyDefaults.authorityMap;
}

/** the map a decision runs over: the one given; else the organization's when it names something; else the stored "authority" row */
export async function authorityMapFor({ policy, positions, db = realDb } = {}) {
  if (policy) return policy;
  const live = await organizationMap(db, positions);
  if (hasRules(live)) return live;
  return authorityPolicy(db, { positions });
}

/** ---- who authorizes ---- */

/**
 * The person an entry is made for, as they stand now (pure): `entry` is their token-map entry today
 * ({ positions, caps }, the provisioner's), `actsFor.position` the position recorded with the section.
 *   ok: false, why  they can't authorize: gone, holding no position, or moved
 *   ok: true        { identity, position }: their current positions and write capability
 */
export function standingOf(actsFor, entry, positions) {
  const person = String(actsFor?.person ?? "").split("/agent:")[0];
  const recorded = actsFor?.position ?? null;
  const out = (why) => ({ ok: false, person, position: recorded, why });
  if (!entry || !["direct", "queued"].includes(entry.caps?.write) || entry.caps?.read === false) return out(`${person} is no longer in the organization, so can't authorize a write`);
  const caps = { write: entry.caps.write };
  if (!positions) return { ok: true, person, position: recorded, identity: { positions: [], caps } };
  const held = heldPositions(positions, entry.positions);
  if (!held.length) return out(`${person} holds no position, so can't authorize a write`);
  if (recorded !== null && recorded !== EVERYONE) {
    if (!positions.positions[recorded]) return out(`this was recorded under "${recorded}", which is not a position: it authorizes nothing`);
    if (!held.includes(recorded)) return out(`${person} has moved from ${recorded} since this was recorded, so it no longer authorizes the write`);
  }
  return { ok: true, person, position: recorded ?? defaultHome(positions, held), identity: { positions: held, caps } };
}

/** the person behind an approver's identity: "admin" for admin, admin/liaison:ab12 and "admin (on the operator's word)" */
export const approvingPerson = (user) => String(user ?? "").split(/[/ ]/)[0];

/** ---- the entry itself ---- */

/**
 * Enter data into a source row, for the person who put the record on record (`actsFor`, { person, position }),
 * by the agent `by`, into `key` (system:table:row) with `fields`, bearing on class `cls`. Filed or Proposed by
 * the class map over the recorder as they stand now (standingOf; R11: the recorder's authority, never the
 * agent's). `held` ({ home, why }) is the agent's own limit: what it read reaches fewer people than the
 * section's do, so its write is proposed whoever it acts for. `before` is what the worker read in the columns it
 * writes (commitRow: a row that has moved since is never written over). Returns
 *   { outcome: "filed", status, key, before, after }   written through the write-capable instance (commitRow)
 *   { outcome: "proposed", pendingId, reason }         a PendingWrite (kind data_entry) for a person with authority
 *   { outcome: "held", status, why }                   the write didn't land: the source unreachable, the row moved
 *                                                      or missing, the source or the guard said no (commitRow)
 *   { outcome: "refused", reason }                     nobody stands behind it (the recorder left or moved)
 * NEEDS A RULING (recorder gone or moved): which filing outcome such a piece gets; smallest choice, the adapter
 * says "refused" and the filing stream records it as Held, asking whoever put it on record.
 */
export async function enterData({ actsFor, by, key, fields, before = null, cls, reason, identity, held = null, piece = null }, { db = realDb, fetch: f, positions, policy, queue, proposal, people, journal, sources, index } = {}) {
  const k = parseKey(key);
  if (!k) throw new Error(`not a record key (system:table:row): ${key}`);
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) throw new Error("fields: the columns to write, with their values");
  if (!actsFor?.person) throw new Error("the person the entry is made for is needed");
  positions ??= await livePositions();
  const lookup = people ?? (await livePeople());
  const standing = standingOf(actsFor, await lookup(String(actsFor.person).split("/agent:")[0]), positions);
  if (!standing.ok) return { outcome: "refused", reason: `Not written: ${standing.why}.` };
  const decl = (sources ?? (await loadSources(db, { ttlMs: 0 })))[k.system] ?? null;
  if (!decl) return { outcome: "held", status: "refused", why: `no connected source called ${k.system}` };
  const writable = declaredWritable(decl, k.table, "update");
  let map = null;
  let decision;
  try {
    map = await authorityMapFor({ policy, positions, db });
    decision = positions
      ? filedOrProposed({ recorder: standing.identity, cls, columns: Object.keys(fields), map, positions, writable, index: await indexFor(index) })
      : { outcome: "proposed", authority: null, reason: "no position map is loaded" };
  } catch (e) {
    log.warn(`class map unreadable, so the entry on ${k.key} is proposed: ${String(e?.message ?? e).slice(0, 160)}`);
    decision = { outcome: "proposed", authority: null, reason: "the class map can't be read" };
  }
  if (decision.outcome === "filed" && standing.identity.caps.write === "queued") decision = { ...decision, outcome: "proposed", reason: "this person's writes are queued for approval" };
  if (decision.outcome === "filed" && held) decision = { ...decision, outcome: "proposed", reason: held.why };
  if (decision.outcome === "proposed") {
    const payload = { kind: "data_entry", key: k.key, fields, ...(before ? { before } : {}), class: cls ?? null, acts_for: { person: standing.person, position: standing.position }, by, reason: String(reason ?? "").slice(0, 600) || null };
    // where it waits: where the map's position (else the root) and anything the agent's limit holds it at are seen
    const home = positions ? commonAncestor(positions, [standing.position ?? positions.root, decision.authority ?? positions.root, ...(held ? [held.home] : [])]) : undefined;
    const w = queue && proposal ? null : await liveQueue();
    const queued = await (queue ?? w.queueWrite)({ kind: "data_entry", payload: JSON.stringify(payload), user: by, home, ...(proposal ?? w.proposalFields)(identity ?? { role: null }, reason) });
    return { outcome: "proposed", pendingId: queued.pendingId, reason: decision.reason };
  }
  return asEntry(await commitRow({ key: k.key, fields, before, piece }, { db, fetch: f, journal, sources: sources ?? { [k.system]: decl } }));
}

/** a write adapter's answer as data entry's outcome: filed when it landed, held otherwise */
const asEntry = (r) => (r.filing === "filed" ? { outcome: "filed", ...r } : { outcome: r.filing === "proposed" ? "proposed" : "held", ...r });

/** an approver must hold the authority the map names for the class, as they stand now; a map that can't be read leaves it to the root */
async function assertApproverHolds(p, person, entry, { positions, db, index }) {
  // R11.7: a person with authority for the class approves, and without a map nobody can be shown to hold it
  if (!positions) throw new Error("not applied: no position map is loaded, so nobody can be shown to hold the authority");
  const standing = standingOf({ person, position: null }, entry, positions);
  if (!standing.ok) throw new Error(`not applied: ${standing.why}`);
  const map = await authorityMapFor({ positions, db }).catch(() => null);
  if (!map) {
    if (standing.identity.positions.includes(positions.root)) return;
    throw new Error("not applied: the class map can't be read, so only someone at the top of the organization can approve this");
  }
  const d = filedOrProposed({ recorder: standing.identity, cls: p.class ?? null, columns: Object.keys(p.fields ?? {}), map, positions, index: await indexFor(index) });
  // a class missing from the map: a person at the root approves (R11: a person with authority for that class approves; the orchestrator never does)
  if (d.outcome !== "filed" && !(d.authority === null && standing.identity.positions.includes(positions.root))) throw new Error(`not applied: ${person} doesn't hold the authority the map names for ${p.class ?? "this class"}, so can't approve this entry`);
}

/**
 * An approved data_entry proposal: the write runs now, authorized by the person who approved it (who must hold
 * the authority), acted by the agent that proposed it. The write is begun and settled in the filing log like any
 * other (commitRow), its `piece` naming the proposal and who approved it, so the filing stream writes the Filed
 * entry from it; with no journal, nothing is written.
 * NEEDS A RULING (approving a class missing from the map): smallest choice, a person at the root approves it.
 */
export async function applyProposedEntry(payload, pendingId, approver, { db = realDb, fetch: f, people, positions, journal, sources, index } = {}) {
  const p = typeof payload === "string" ? JSON.parse(payload) : payload;
  const k = parseKey(p.key);
  if (!k) throw new Error(`not a record key: ${p.key}`);
  positions ??= await livePositions();
  if (/\/agent:/.test(String(approver ?? ""))) throw new Error("not applied: an agent can't approve a data entry; a person with authority for the class does (R11.7)");
  const authorized_by = approvingPerson(approver);
  if (!authorized_by) throw new Error("not applied: an approved entry needs the person who approved it");
  const entry = await (people ?? (await livePeople()))(authorized_by);
  await assertApproverHolds(p, authorized_by, entry, { positions, db, index });
  const r = asEntry(await commitRow({ key: k.key, fields: p.fields, before: p.before ?? null, piece: { ...(p.piece ?? {}), pending_id: pendingId ?? null, approved_by: authorized_by } }, { db, fetch: f, journal, sources }));
  if (r.outcome !== "filed") throw new Error(`not applied (${r.status}): ${r.why ?? "the write didn't land"}`);
  return { ...r, authorized_by, pending_id: pendingId ?? null };
}

/** a rejected data_entry proposal: nothing to undo (there are no audit nodes; the filing log records it) */
export async function refuseProposedEntry() {
  return null;
}

/** what a data_entry proposal would do, in plain words (worker-pool's proposalLands) */
export function describeEntry(payload) {
  try {
    const p = typeof payload === "string" ? JSON.parse(payload) : payload;
    const t = parseTable(`${parseKey(p.key)?.system}:${parseKey(p.key)?.table}`);
    return [`writes ${Object.entries(p.fields ?? {}).map(([c, v]) => `${c} = ${JSON.stringify(v)}`).join(", ")} to row ${parseKey(p.key)?.row_key} of ${t ? `${t.table} (${t.system})` : p.key}, for ${p.acts_for?.person ?? "?"} at ${p.acts_for?.position ?? "?"}`];
  } catch {
    return [];
  }
}
