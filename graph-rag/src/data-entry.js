/**
 * Data entry: a worker's write to a source system, through a write-capable
 * DAB instance, under the authority rule (docs/ORGANIZATION-MODEL.md,
 * "Reference, never copy"): direct when the person the agent acts for could
 * do it, proposed otherwise, refused when that person is on another branch.
 * Every attempt is an AuditEvent (audit.js), whatever became of it.
 *
 * Sources. Rows are read and written through DAB's MCP endpoint (Data API
 * builder's SQL MCP Server), never copied into the graph. Two instances per
 * system (docs/DATA-SCOPING.md): the read-only one agents already reach, and
 * a write-capable one with its own SQL login that only graph-rag reaches
 * (docker-compose.yml `dab-write`). Where they are comes from the environment
 * (DAB_READ_URL, DAB_WRITE_URL, DAB_SYSTEM) or, per system, from the
 * organization's stored `sources` (an OrgPolicy row, scope "sources":
 * { "<system>": { "read": url, "write": url } }), which an admin route or the
 * replay harness sets; the stored one wins.
 *
 * Stubs, until the Authority and Admission streams land (say so when they do):
 * - `decideWrite` is the contract's `authority.decide` over the stored
 *   authority policy (an OrgPolicy row, scope "authority", in the shape
 *   `authority.validatePolicy` takes). The Authority stream's `decideWrite`
 *   in write.js replaces it; the call stays
 *   decideWrite(identity, class, attribute) -> direct | propose | hidden.
 *
 * DAB's tool arguments are assumed as DAB 2.x documents them
 * (read_records { entity, filter, first }, update_record { entity, keys,
 * item }, create_record { entity, item }, describe_entities {}); they are
 * kept in DAB_CALLS so a running instance's tools/list can correct them in
 * one place.
 */
import { log } from "./context.js";
import { adbCommand as realCommand, adbQuery as realQuery } from "./db.js";
import { decide, validatePolicy } from "./model/authority.js";
import { isoDate, normalizeAttribute } from "./model/claims.js";
import { parseKey, parseTable } from "./model/schema.js";
import { recordAuditEvent, settleAuditEvent } from "./audit.js";

const realDb = { adbCommand: realCommand, adbQuery: realQuery };
// the live position map and the pending-write queue, reached when used (not at load: a test imports this module alone)
const livePositions = async () => (await import("./scope.js")).positionMap;
const liveQueue = async () => import("./write.js");

/** ---- where the source systems are ---- */

const ENV = () => ({
  system: process.env.DAB_SYSTEM || "mssql",
  read: process.env.DAB_READ_URL ?? "http://dab:5000/mcp",
  write: process.env.DAB_WRITE_URL || null,
});

const sourcesCache = { at: 0, value: null };

/** the systems and their read and write endpoints: the stored ones over the environment's */
export async function sourcesConfig(db = realDb, { ttlMs = 60_000, now = Date.now() } = {}) {
  if (sourcesCache.value && now - sourcesCache.at < ttlMs) return sourcesCache.value;
  const env = ENV();
  const out = { [env.system]: { read: env.read || null, write: env.write } };
  try {
    const row = (await db.adbQuery("SELECT json FROM OrgPolicy WHERE scope = 'sources' LIMIT 1"))[0];
    if (row?.json) {
      for (const [system, v] of Object.entries(JSON.parse(row.json) ?? {})) {
        if (!v || typeof v !== "object") continue;
        out[system] = { read: typeof v.read === "string" && v.read ? v.read : (out[system]?.read ?? null), write: typeof v.write === "string" && v.write ? v.write : (out[system]?.write ?? null) };
      }
    }
  } catch (e) {
    log.warn(`sources not read (keeping the environment's): ${String(e).slice(0, 120)}`);
  }
  Object.assign(sourcesCache, { at: now, value: out });
  return out;
}

/** forget the cached sources (a test, or a settings change) */
export const forgetSources = () => Object.assign(sourcesCache, { at: 0, value: null });

/** ---- DAB over MCP (streamable HTTP) ---- */

/** the tool calls as DAB 2.x documents them; one place to correct against a running instance's tools/list */
export const DAB_CALLS = {
  describe: () => ({ name: "describe_entities", args: {} }),
  read: (entity, keyColumn, rowKey) => ({ name: "read_records", args: { entity, filter: `${keyColumn} eq ${odata(rowKey)}`, first: 2 } }),
  update: (entity, keys, item) => ({ name: "update_record", args: { entity, keys, item } }),
  create: (entity, item) => ({ name: "create_record", args: { entity, item } }),
};

/** an OData literal: numbers bare, everything else quoted with doubled quotes */
export const odata = (v) => (typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v)) ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const sessions = new Map(); // url -> mcp-session-id

/** one MCP tool call; the result's text content parsed as JSON when it is some */
export async function mcpToolCall(url, name, args, { fetch: f = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const rpc = async (method, params, id) => {
    const session = sessions.get(url) ?? null;
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers?.get?.("mcp-session-id");
    if (sid) sessions.set(url, sid);
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`${name}: ${res.status} ${text.slice(0, 200)}`), { status: res.status });
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text || "{}");
  };
  if (!sessions.has(url)) {
    // a streamable-HTTP server wants a handshake first; one that doesn't answers the call anyway
    await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "graph-rag", version: "0.3.0" } }, 1).catch(() => {});
  }
  const msg = await rpc("tools/call", { name, arguments: args }, 2);
  if (msg.error) throw new Error(`${name}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
  const content = msg.result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (msg.result?.isError) throw new Error(`${name}: ${content.slice(0, 300)}`);
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** the rows in a tool's answer, whatever DAB wraps them in */
export function rowsOf(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  for (const k of ["records", "value", "items", "rows", "data", "result"]) if (Array.isArray(result[k])) return result[k];
  const arr = Object.values(result).find(Array.isArray);
  return arr ?? [];
}

/** the key column of an entity, from a describe_entities answer (several shapes tolerated); null when it isn't said */
export function keyColumnFrom(described, entity) {
  const list = rowsOf(described).length ? rowsOf(described) : Array.isArray(described?.entities) ? described.entities : [];
  const e = list.find((x) => String(x?.name ?? x?.entity ?? "") === entity);
  if (!e) return null;
  const direct = e.primaryKey ?? e.primary_key ?? e.keyFields ?? e.key_fields ?? e.keys;
  if (Array.isArray(direct) && direct.length) return String(typeof direct[0] === "string" ? direct[0] : (direct[0]?.name ?? ""));
  if (typeof direct === "string" && direct) return direct;
  const fields = e.fields ?? e.columns ?? e.properties ?? [];
  const key = (Array.isArray(fields) ? fields : Object.entries(fields).map(([name, v]) => ({ name, ...(v && typeof v === "object" ? v : {}) }))).find((f) => f && (f.isPrimaryKey || f.primaryKey || f.isKey || f.key === true || f["primary-key"]));
  return key ? String(key.name) : null;
}

const keyColumns = new Map(); // system:table -> column

/**
 * A client for one system: read a row by key, write fields to it. `urls` from
 * sourcesConfig; `fetch` injectable. Throws a plain error when the system has
 * no endpoint for what was asked.
 */
export function sourceClient(system, urls, opts = {}) {
  const call = (url, c) => mcpToolCall(url, c.name, c.args, opts);
  const keyColumn = async (table, given) => {
    if (given) return given;
    const k = `${system}:${table}`;
    if (keyColumns.has(k)) return keyColumns.get(k);
    const col = keyColumnFrom(await call(urls.read, DAB_CALLS.describe()), table);
    if (!col) throw new Error(`the key column of ${system}:${table} isn't known: give key_column`);
    keyColumns.set(k, col);
    return col;
  };
  return {
    system,
    canRead: Boolean(urls?.read),
    canWrite: Boolean(urls?.write),
    /** the row, or null when there is none */
    async readRow(table, rowKey, { key_column } = {}) {
      if (!urls?.read) throw new Error(`no read endpoint for ${system}`);
      const col = await keyColumn(table, key_column);
      const rows = rowsOf(await call(urls.read, DAB_CALLS.read(table, col, rowKey)));
      if (rows.length > 1) throw new Error(`${system}:${table}:${rowKey} matched ${rows.length} rows by ${col}: not one row`);
      return rows[0] ? { row: rows[0], key_column: col } : null;
    },
    /** write fields to the row (update); the source's answer */
    async writeRow(table, rowKey, fields, { key_column } = {}) {
      if (!urls?.write) throw new Error(`no write-capable endpoint for ${system}: data entry can only be proposed`);
      const col = await keyColumn(table, key_column);
      return call(urls.write, DAB_CALLS.update(table, { [col]: rowKey }, fields));
    },
  };
}

/** a client for the system a key names (`mssql:dbo_Job:4471` -> mssql) */
export async function clientFor(key, { db = realDb, fetch: f } = {}) {
  const k = parseKey(key);
  if (!k) throw new Error(`not a record key (system:table:row): ${key}`);
  const sources = await sourcesConfig(db);
  const urls = sources[k.system];
  if (!urls) throw new Error(`no connected source called ${k.system}`);
  return { client: sourceClient(k.system, urls, f ? { fetch: f } : {}), key: k };
}

/** ---- confirming a claim against its row (pure) ---- */

/** the column a claim's attribute names, among a row's: the same name once normalized, else one ending in it */
export function columnFor(attribute, row) {
  const a = normalizeAttribute(attribute);
  const cols = Object.keys(row ?? {});
  return cols.find((c) => normalizeAttribute(c) === a) ?? cols.find((c) => normalizeAttribute(c).endsWith(`_${a}`) || a.endsWith(`_${normalizeAttribute(c)}`)) ?? null;
}

/** two values as the same fact: numbers by value, dates by instant, text case- and space-insensitively */
export function sameValue(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const na = Number(a);
  const nb = Number(b);
  if (String(a).trim() !== "" && String(b).trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  // dates as the condenser and the source write them (a date alone is its start; no zone is UTC)
  const da = isoDate(String(a).trim());
  const db = isoDate(String(b).trim());
  if (da && db) return da === db;
  const norm = (v) => String(v).toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

/**
 * A claim against the source row: confirmed when the row's column for the
 * attribute holds the claim's value; `column: null` when the row has no such
 * column (the attribute isn't recorded there: nothing to confirm or deny).
 */
export function confirmAgainstRow(claim, row) {
  if (!row) return { confirmed: false, column: null, row_value: null, claim_value: claim.value, reason: "no such row in the source" };
  const column = columnFor(claim.attribute, row);
  if (!column) return { confirmed: false, column: null, row_value: null, claim_value: claim.value, reason: `the row has no column for ${claim.attribute}` };
  const rowValue = row[column];
  const claimValue = claim.value_num ?? claim.value;
  const confirmed = sameValue(rowValue, claimValue);
  return { confirmed, column, row_value: rowValue, claim_value: claim.value, reason: confirmed ? "the row holds the claimed value" : "the row holds a different value" };
}

/** ---- the authority rule (stub until the Authority stream's decideWrite lands) ---- */

const authorityCache = { at: 0, value: null };

/**
 * The authority policy (classes and attributes to the position holding
 * authority), as stored in OrgPolicy scope "authority", validated against the
 * position map; {} (no rule: the writer's own position holds it) when there
 * is none or it doesn't validate. Cached a minute.
 */
export async function authorityPolicy(db = realDb, { positions, ttlMs = 60_000, now = Date.now() } = {}) {
  if (authorityCache.value && now - authorityCache.at < ttlMs) return authorityCache.value;
  positions ??= await livePositions();
  let value = { classes: {}, attributes: {} };
  try {
    const row = (await db.adbQuery("SELECT json FROM OrgPolicy WHERE scope = 'authority' LIMIT 1"))[0];
    if (row?.json && positions) value = validatePolicy(JSON.parse(row.json), positions);
  } catch (e) {
    log.warn(`authority policy not used: ${String(e).slice(0, 160)}`);
  }
  Object.assign(authorityCache, { at: now, value });
  return value;
}

export const forgetAuthorityPolicy = () => Object.assign(authorityCache, { at: 0, value: null });

/**
 * The one write-or-propose decision: (identity, class, attribute) -> direct | propose | hidden, for
 * `identity` = { positions, caps } of the person the agent acts for. When the Authority stream's
 * `decideWrite` is in write.js it decides (called as it documents itself:
 * decideWrite(identity, { kind: "data_entry", cls, attribute }, { policy, positions }).action, over the
 * organization policy's `authorityMap`); until then the contract's `authority.decide` runs here over the
 * policy's `authorityMap` when it has one, else the stored OrgPolicy "authority" row (authorityPolicy).
 */
export async function decideWrite(identity, cls, attribute, { policy, positions, db = realDb } = {}) {
  positions ??= await livePositions();
  if (!positions) return "propose";
  const w = await liveQueue().catch(() => null);
  if (typeof w?.decideWrite === "function" && !policy) {
    try {
      const r = w.decideWrite(identity, { kind: "data_entry", cls, attribute }, { positions });
      const action = r && typeof r === "object" ? r.action : r;
      if (["direct", "propose", "hidden"].includes(action)) return action;
    } catch (e) {
      log.warn(`decideWrite (write.js) failed, deciding from the contract: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  const live = policy ? null : await import("./org-policy.js").then((m) => m.policy?.authorityMap ?? null).catch(() => null);
  const p = policy ?? live ?? (await authorityPolicy(db, { positions }));
  return decide(identity, cls, attribute, p, positions);
}

/** ---- the entry itself ---- */

/**
 * Enter data into a source row. `actsFor` is the person the agent acts for
 * ({ person, position }); `by` the agent identity (its user); `key` the row
 * (system:table:row); `fields` the columns to write; `cls`/`attribute` what
 * the write commits the organization to (the claim's). Outcomes:
 *   direct  -> written through the write-capable instance; "applied" (or
 *              "failed" when the source refused it, with the error)
 *   propose -> a PendingWrite (kind "data_entry") for someone with authority;
 *              "proposed", and the worker waits
 *   hidden  -> nothing written or proposed; "refused"
 * Every outcome is an AuditEvent WROTE to the row's SourceRef.
 */
export async function enterData({ actsFor, by, key, fields, cls, attribute, reason, identity }, { db = realDb, fetch: f, positions, policy, decideFn, queue, proposal } = {}) {
  const k = parseKey(key);
  if (!k) throw new Error(`not a record key (system:table:row): ${key}`);
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) throw new Error("fields: the columns to write, with their values");
  if (!actsFor?.person || !actsFor?.position) throw new Error("the person and position the entry is made for are needed");
  const who = { positions: [actsFor.position], caps: { write: "direct" } };
  const decision = decideFn ? await decideFn(who, cls, attribute) : await decideWrite(who, cls, attribute, { policy, positions, db });
  const base = { key: k.key, authorized_by: actsFor.person, acted_by: by, position: actsFor.position };
  const change = { fields, class: cls ?? null, attribute: attribute ?? null, reason: String(reason ?? "").slice(0, 600) || null };
  if (decision === "hidden") {
    const ev = await recordAuditEvent({ ...base, change, outcome: "refused" }, db);
    return { outcome: "refused", decision, audit: ev.id, note: `Not written: ${actsFor.person} (${actsFor.position}) holds no authority over ${cls ?? "this"}${attribute ? `/${attribute}` : ""} and reports to nobody who does; nothing was proposed.` };
  }
  if (decision === "propose") {
    const payload = { kind: "data_entry", key: k.key, fields, class: cls ?? null, attribute: attribute ?? null, acts_for: actsFor, by, reason: change.reason };
    const w = queue && proposal ? null : await liveQueue();
    const queued = await (queue ?? w.queueWrite)({ kind: "data_entry", payload: JSON.stringify(payload), user: by, home: actsFor.position, ...(proposal ?? w.proposalFields)(identity ?? { role: null }, reason) });
    const ev = await recordAuditEvent({ ...base, change, outcome: "proposed", pending_id: queued.pendingId }, db);
    return { outcome: "proposed", decision, pendingId: queued.pendingId, audit: ev.id, note: `Proposed: ${actsFor.person} (${actsFor.position}) reports to the position holding authority over ${cls ?? "this"}${attribute ? `/${attribute}` : ""}, so the entry waits for someone there.` };
  }
  return applyEntry({ ...base, change, fields, table: k.table, rowKey: k.row_key }, { db, fetch: f });
}

/** the write itself, audited as applied or failed */
async function applyEntry({ key, authorized_by, acted_by, position, change, fields, table, rowKey, pending_id = null }, { db, fetch: f }) {
  let result;
  let before = null;
  try {
    const { client } = await clientFor(key, { db, fetch: f });
    before = (await client.readRow(table, rowKey).catch(() => null))?.row ?? null;
    result = await client.writeRow(table, rowKey, fields);
  } catch (e) {
    const ev = await recordAuditEvent({ key, authorized_by, acted_by, position, change: { ...change, error: String(e?.message ?? e).slice(0, 300) }, outcome: "failed", pending_id }, db);
    if (pending_id) await settleAuditEvent(pending_id, "failed", db).catch(() => {});
    return { outcome: "failed", decision: "direct", audit: ev.id, error: String(e?.message ?? e).slice(0, 300) };
  }
  const ev = await recordAuditEvent({ key, authorized_by, acted_by, position, change: { ...change, before: before ? pick(before, Object.keys(fields)) : null, after: fields }, outcome: "applied", pending_id }, db);
  if (pending_id) await settleAuditEvent(pending_id, "applied", db).catch(() => {});
  return { outcome: "applied", decision: "direct", audit: ev.id, result };
}

const pick = (row, cols) => Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]]));

/**
 * An approved data_entry proposal: the write runs now, authorized by the
 * approver (who holds the authority), acted by the agent that proposed it.
 * For write.js `executePending` to call on kind "data_entry" (the Authority
 * stream owns that switch); until then an approved entry is applied from here.
 */
export async function applyProposedEntry(payload, pendingId, approver, { db = realDb, fetch: f } = {}) {
  const p = typeof payload === "string" ? JSON.parse(payload) : payload;
  const k = parseKey(p.key);
  if (!k) throw new Error(`not a record key: ${p.key}`);
  const r = await applyEntry(
    { key: k.key, authorized_by: approver ?? p.acts_for?.person ?? "unknown", acted_by: p.by ?? "unknown", position: p.acts_for?.position ?? "unknown", change: { fields: p.fields, class: p.class, attribute: p.attribute, reason: p.reason, approved_by: approver ?? null }, fields: p.fields, table: k.table, rowKey: k.row_key, pending_id: pendingId ?? null },
    { db, fetch: f },
  );
  if (r.outcome === "failed") throw new Error(r.error);
  return r;
}

/** a rejected data_entry proposal: its audit event says so */
export async function refuseProposedEntry(pendingId, db = realDb) {
  return settleAuditEvent(pendingId, "refused", db);
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
