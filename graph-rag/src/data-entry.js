/**
 * Data entry: a worker's write to a source system, through a write-capable DAB instance. The class map
 * chooses Filed or Proposed (R6; model/class-map.js filedOrProposed): the authority that counts is the
 * recorder's, never the agent's; a class missing from the map, or a source that isn't writable, means
 * Proposed (R2, R11). There are no audit nodes (R9): the caller writes the outcome to the filing log
 * (model/filing.js), which the filing stream builds. The sources stream owns this module.
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
 * DAB's tools are as DAB 2.0.12 (the version dab/Dockerfile pins) serves them,
 * read off a running instance's tools/list and exercised against it:
 * read_records { entity, filter, first }, update_record { entity, keys, fields },
 * create_record { entity, data }. A filter's literal is typed by the column
 * (a number bare, text quoted: DAB refuses the other). describe_entities names
 * no primary key (its fields are empty under autoentities), so the key comes
 * from the first-page cursor (DAB pages by primary key): primaryKeyFrom.
 */
import { log } from "./context.js";
import { adbCommand as realCommand, adbQuery as realQuery } from "./db.js";
import { filedOrProposed, validatePolicy } from "./model/class-map.js";
import { isoDate, snakeCase } from "./model/text.js";
import { parseKey, parseTable } from "./model/schema.js";
import { commonAncestor, defaultHome, EVERYONE, heldPositions } from "./positions.js";
import { authorityMap } from "./policy.js";

const realDb = { adbCommand: realCommand, adbQuery: realQuery };
// the live position map, token map and pending-write queue, reached when used (not at load: a test imports this module alone)
const livePositions = async () => (await import("./scope.js")).positionMap;
const liveQueue = async () => import("./write.js");
/** a person as the token map holds them now ({ positions, caps }), or undefined */
const livePeople = async () => {
  const scope = await import("./scope.js");
  return (name) => scope.entriesByUser.get(name);
};

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
  // the tool answered and said no: nothing was done (a transport error says nothing about that)
  if (msg.result?.isError) throw Object.assign(new Error(`${name}: ${content.slice(0, 300)}`), { toolError: true });
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

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

const primaryKeys = new Map(); // read url + table -> [{ name, type }]

/** forget the learned primary keys (a test, or a source whose schema changed) */
export const forgetPrimaryKeys = () => primaryKeys.clear();

/**
 * A client for one system: read a row by its verified primary key, write fields to it. `urls` from
 * sourcesConfig; `fetch` injectable. The key column is the table's primary key, learned from the source;
 * a `key_column` a worker gives must be that column, or the call is refused, and a key that can't be
 * learned, or that spans several columns where a record key names one, refuses the call too.
 */
export function sourceClient(system, urls, opts = {}) {
  const call = (url, c) => mcpToolCall(url, c.name, c.args, opts);
  const primaryKey = async (table, keyColumn) => {
    const k = `${urls.read} ${table}`;
    if (!primaryKeys.has(k)) {
      const found = primaryKeyFrom(await call(urls.read, DAB_CALLS.firstPage(table)), table);
      if (!found) throw new Error(`the primary key of ${system}:${table} can't be learned from the source (it pages by key, and this table has no second row to page to): refused rather than guessed`);
      primaryKeys.set(k, found);
    }
    const pk = primaryKeys.get(k);
    if (pk.length !== 1) throw new Error(`${system}:${table} has a composite primary key (${pk.map((c) => c.name).join(", ")}): a record key names one column, so the row can't be determined`);
    if (keyColumn && keyColumn !== pk[0].name) throw new Error(`${keyColumn} is not the primary key of ${system}:${table}; the row is keyed by ${pk[0].name}`);
    return pk[0];
  };
  return {
    system,
    canRead: Boolean(urls?.read),
    canWrite: Boolean(urls?.write),
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

/** a client for the system a key names (`mssql:dbo_Job:4471` -> mssql) */
export async function clientFor(key, { db = realDb, fetch: f } = {}) {
  const k = parseKey(key);
  if (!k) throw new Error(`not a record key (system:table:row): ${key}`);
  const sources = await sourcesConfig(db, { ttlMs: 0 }); // a row check reads the sources as they stand now
  const urls = sources[k.system];
  if (!urls) throw new Error(`no connected source called ${k.system}`);
  return { client: sourceClient(k.system, urls, f ? { fetch: f } : {}), key: k };
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
 * section's do, so its write is proposed whoever it acts for. Returns
 *   { outcome: "filed", result }                 written through the write-capable instance
 *   { outcome: "proposed", pendingId, reason }   a PendingWrite (kind data_entry) for a person with authority
 *   { outcome: "failed", error }                 the source refused it, or the row didn't hold
 *   { outcome: "refused", reason }               nobody stands behind it (the recorder left or moved)
 * NEEDS A RULING (recorder gone or moved): which filing outcome such a piece gets; smallest choice, the adapter
 * says "refused" and the filing stream records it as Held, asking whoever put it on record.
 */
export async function enterData({ actsFor, by, key, fields, cls, reason, identity, held = null }, { db = realDb, fetch: f, positions, policy, queue, proposal, people } = {}) {
  const k = parseKey(key);
  if (!k) throw new Error(`not a record key (system:table:row): ${key}`);
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) throw new Error("fields: the columns to write, with their values");
  if (!actsFor?.person) throw new Error("the person the entry is made for is needed");
  positions ??= await livePositions();
  const lookup = people ?? (await livePeople());
  const standing = standingOf(actsFor, await lookup(String(actsFor.person).split("/agent:")[0]), positions);
  if (!standing.ok) return { outcome: "refused", reason: `Not written: ${standing.why}.` };
  const writable = Boolean((await sourcesConfig(db, { ttlMs: 0 }))[k.system]?.write);
  let map = null;
  let decision;
  try {
    map = await authorityMapFor({ policy, positions, db });
    decision = positions
      ? filedOrProposed({ recorder: standing.identity, cls, columns: Object.keys(fields), map, positions, writable })
      : { outcome: "proposed", authority: null, reason: "no position map is loaded" };
  } catch (e) {
    log.warn(`class map unreadable, so the entry on ${k.key} is proposed: ${String(e?.message ?? e).slice(0, 160)}`);
    decision = { outcome: "proposed", authority: null, reason: "the class map can't be read" };
  }
  if (decision.outcome === "filed" && standing.identity.caps.write === "queued") decision = { ...decision, outcome: "proposed", reason: "this person's writes are queued for approval" };
  if (decision.outcome === "filed" && held) decision = { ...decision, outcome: "proposed", reason: held.why };
  if (decision.outcome === "proposed") {
    const payload = { kind: "data_entry", key: k.key, fields, class: cls ?? null, acts_for: { person: standing.person, position: standing.position }, by, reason: String(reason ?? "").slice(0, 600) || null };
    // where it waits: where the map's position (else the root) and anything the agent's limit holds it at are seen
    const home = positions ? commonAncestor(positions, [standing.position ?? positions.root, decision.authority ?? positions.root, ...(held ? [held.home] : [])]) : undefined;
    const w = queue && proposal ? null : await liveQueue();
    const queued = await (queue ?? w.queueWrite)({ kind: "data_entry", payload: JSON.stringify(payload), user: by, home, ...(proposal ?? w.proposalFields)(identity ?? { role: null }, reason) });
    return { outcome: "proposed", pendingId: queued.pendingId, reason: decision.reason };
  }
  return applyEntry({ fields, key: k.key, table: k.table, rowKey: k.row_key }, { db, fetch: f });
}

const holds = (row, fields) => Boolean(row) && Object.entries(fields).every(([c, v]) => c in row && (sameValue(row[c], v) || ((row[c] ?? null) === null && (v ?? null) === null)));

/**
 * The write itself: the row read by its key, the columns checked writable, the write, and on a transport error
 * the row read back before calling it failed (a broken connection says nothing about whether the row changed).
 */
async function applyEntry({ key, fields, table, rowKey }, { db, fetch: f }) {
  let client;
  let hit;
  try {
    ({ client } = await clientFor(key, { db, fetch: f }));
    hit = await client.readRow(table, rowKey);
    if (!hit) throw new Error(`no row ${rowKey} in ${table}: the record key doesn't hold`);
    assertWritable(fields, hit);
  } catch (e) {
    return { outcome: "failed", error: String(e?.message ?? e).slice(0, 300) };
  }
  const before = Object.fromEntries(Object.keys(fields).filter((c) => c in hit.row).map((c) => [c, hit.row[c]]));
  try {
    const result = await client.writeRow(table, hit, fields);
    return { outcome: "filed", key, before, after: fields, result };
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 300);
    if (e?.toolError) return { outcome: "failed", key, error };
    let row;
    try {
      row = (await client.readRow(table, rowKey))?.row ?? null;
    } catch {
      return { outcome: "failed", key, error, unverified: true, note: "The source couldn't be reached to tell whether the row changed." };
    }
    return holds(row, fields) ? { outcome: "filed", key, before, after: fields, note: `the source answered with an error (${error}) but the row holds the new values` } : { outcome: "failed", key, error };
  }
}

/** an approver must hold the authority the map names for the class, as they stand now; a map that can't be read leaves it to the root */
async function assertApproverHolds(p, person, entry, { positions, db }) {
  if (!positions) return;
  const standing = standingOf({ person, position: null }, entry, positions);
  if (!standing.ok) throw new Error(`not applied: ${standing.why}`);
  const map = await authorityMapFor({ positions, db }).catch(() => null);
  if (!map) {
    if (standing.identity.positions.includes(positions.root)) return;
    throw new Error("not applied: the class map can't be read, so only someone at the top of the organization can approve this");
  }
  const d = filedOrProposed({ recorder: standing.identity, cls: p.class ?? null, columns: Object.keys(p.fields ?? {}), map, positions });
  // a class missing from the map: a person at the root approves (R11: a person with authority for that class approves; the orchestrator never does)
  if (d.outcome !== "filed" && !(d.authority === null && standing.identity.positions.includes(positions.root))) throw new Error(`not applied: ${person} doesn't hold the authority the map names for ${p.class ?? "this class"}, so can't approve this entry`);
}

/**
 * An approved data_entry proposal: the write runs now, authorized by the person who approved it (who must hold
 * the authority), acted by the agent that proposed it.
 * NEEDS A RULING (approving a class missing from the map): smallest choice, a person at the root approves it.
 */
export async function applyProposedEntry(payload, pendingId, approver, { db = realDb, fetch: f, people, positions } = {}) {
  const p = typeof payload === "string" ? JSON.parse(payload) : payload;
  const k = parseKey(p.key);
  if (!k) throw new Error(`not a record key: ${p.key}`);
  positions ??= await livePositions();
  const authorized_by = approvingPerson(approver);
  if (!authorized_by) throw new Error("not applied: an approved entry needs the person who approved it");
  const entry = await (people ?? (await livePeople()))(authorized_by);
  await assertApproverHolds(p, authorized_by, entry, { positions, db });
  const r = await applyEntry({ key: k.key, fields: p.fields, table: k.table, rowKey: k.row_key }, { db, fetch: f });
  if (r.outcome === "failed") throw new Error(r.error);
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
