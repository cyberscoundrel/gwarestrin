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
import { authorityOf, decide, validatePolicy } from "./model/authority.js";
import { isoDate, normalizeAttribute } from "./model/claims.js";
import { parseKey, parseTable } from "./model/schema.js";
import { commonAncestor, defaultHome, EVERYONE, heldPositions } from "./positions.js";
import { authorityMap } from "./policy.js";
import { attemptProposed, openAttempts, recordAuditEvent, settleAttempt, settleAuditEvent } from "./audit.js";

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

/** a name with its case and punctuation gone: credit_limit, CreditLimit and CREDITLIMIT are one name */
const spelled = (name) => normalizeAttribute(name).replace(/_/g, "");

/**
 * The column a claim's attribute names, among a row's: the one with the same name however it is cased or
 * punctuated, or null (none, or several alike). Never a column that merely contains the word: `status` is
 * not `credit_status`.
 */
export function columnFor(attribute, row) {
  const a = spelled(attribute);
  const hits = a ? Object.keys(row ?? {}).filter((c) => spelled(c) === a) : [];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * What an entry on this claim writes: the claim's own value, into the one column its attribute names. A worker
 * writes what the claim says and nothing else, so `given` (the fields it asked for) can only restate that:
 * another column, a second column, or another value is refused. Throws saying which; the claim's stored value
 * is what is written, never the worker's spelling of it.
 */
export function fieldsForClaim(claim, given, hit) {
  const asked = given && Object.keys(given).length ? given : null;
  if (asked) assertWritable(asked, hit);
  const column = columnFor(claim.attribute, hit.row);
  if (!column) throw new Error(`the row has no column named for ${claim.attribute} (it has ${Object.keys(hit.row).join(", ")}), so the claim says nothing any column can hold: nothing is written. Report it.`);
  const value = claim.value_num ?? claim.value;
  if (asked) {
    const other = Object.keys(asked).filter((c) => c !== column);
    if (other.length) throw new Error(`this claim is about ${claim.attribute}, which is column ${column}: it says nothing about ${other.join(", ")}, so that isn't written`);
    if (!sameValue(asked[column], value)) throw new Error(`this claim says ${claim.attribute} is ${JSON.stringify(claim.value)}: a data entry writes what the claim says, not ${JSON.stringify(asked[column])}`);
  }
  const fields = { [column]: value };
  assertWritable(fields, hit);
  return fields;
}

/**
 * The row a claim is about, among its subject's record keys (parsed, parseKey), from what says so: the key the
 * claim's subject names, else the one key in the table its class records in, else the thing's only key.
 * `why` says what's missing when none can be determined; there is no first key to fall back on.
 */
export function rowKeyFor({ subjectKey, keys, recordTable }) {
  const named = subjectKey ? keys.find((k) => k.key === subjectKey) : null;
  if (named) return { key: named };
  if (recordTable) {
    const inTable = keys.filter((k) => `${k.system}:${k.table}` === recordTable);
    if (inTable.length === 1) return { key: inTable[0] };
    return { key: null, why: inTable.length ? `several of its record keys are in ${recordTable}: which row can't be determined` : `none of its record keys is in ${recordTable}, the table its class records in` };
  }
  if (keys.length === 1) return { key: keys[0] };
  return { key: null, why: keys.length ? `it has several record keys (${keys.map((k) => k.key).join(", ")}) and nothing says which row this claim is about` : "it has no record key" };
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
 * position map; {} (no rule: the writer's own position holds it) only when
 * none is stored. A policy that can't be read or doesn't validate throws: it
 * may hold a rule, so nothing is decided as if it held none. Cached a minute,
 * a failure never.
 */
export async function authorityPolicy(db = realDb, { positions, ttlMs = 60_000, now = Date.now() } = {}) {
  if (authorityCache.value && now - authorityCache.at < ttlMs) return authorityCache.value;
  positions ??= await livePositions();
  const row = (await db.adbQuery("SELECT json FROM OrgPolicy WHERE scope = 'authority' LIMIT 1"))[0];
  if (row?.json && !positions) throw new Error("no position map to read the stored authority policy against");
  const value = row?.json ? validatePolicy(JSON.parse(row.json), positions, { stored: true }) : { classes: {}, attributes: {} };
  Object.assign(authorityCache, { at: now, value });
  return value;
}

export const forgetAuthorityPolicy = () => Object.assign(authorityCache, { at: 0, value: null });

/** an authority map with at least one rule in it */
const hasRules = (m) => Boolean(m && typeof m === "object" && (Object.keys(m.classes ?? {}).length || Object.keys(m.attributes ?? {}).length));

/**
 * The organization's map as stored now (OrgPolicy scope "org"), else the one the deployment was started with.
 * Read here, not from org-policy.js's memory: that keeps the defaults when the row won't load or its map doesn't
 * validate, which is an empty map, and an empty map says everyone may commit. Throws instead.
 */
async function organizationMap(db, positions) {
  const row = (await db.adbQuery("SELECT json FROM OrgPolicy WHERE scope = 'org' LIMIT 1"))[0];
  const stored = row?.json ? JSON.parse(row.json) : null;
  if (stored?.authorityMap !== undefined) return authorityMap(stored.authorityMap, positions, { stored: true });
  return (await import("./org-policy.js")).policyDefaults.authorityMap;
}

/**
 * The authority map a decision runs over: the one given; else the organization policy's `authorityMap`
 * when it has a rule; else the stored OrgPolicy "authority" row (authorityPolicy: this stream's stub, and
 * what tests stub). Throws when a map can't be read or doesn't validate: the caller decides nothing direct
 * on a map it couldn't read.
 */
export async function authorityMapFor({ policy, positions, db = realDb } = {}) {
  if (policy) return policy;
  const live = await organizationMap(db, positions);
  if (hasRules(live)) return live;
  return authorityPolicy(db, { positions });
}

/**
 * The one write-or-propose decision: (identity, class, attribute) -> direct | propose | hidden, for
 * `identity` = { positions, caps } of the person the agent acts for. The map is resolved first
 * (authorityMapFor) and the Authority stream's `decideWrite` in write.js decides over it when that
 * export exists (called as it documents itself: decideWrite(identity, { kind: "data_entry", cls,
 * attribute }, { positions, policy }).action, pure with both given); without it the contract's
 * `authority.decide` runs here over the same map. One rule, one map, in tests and at run time alike.
 */
export async function decideWrite(identity, cls, attribute, { policy, positions, db = realDb } = {}) {
  positions ??= await livePositions();
  if (!positions) return "propose";
  let map;
  try {
    map = await authorityMapFor({ policy, positions, db });
  } catch (e) {
    log.warn(`authority map unreadable, so nothing is committed directly: ${String(e?.message ?? e).slice(0, 160)}`);
    return "propose";
  }
  const w = await liveQueue().catch(() => null);
  if (typeof w?.decideWrite === "function") {
    try {
      const r = w.decideWrite(identity, { kind: "data_entry", cls, attribute }, { positions, policy: map });
      const action = r && typeof r === "object" ? r.action : r;
      if (["direct", "propose", "hidden"].includes(action)) return action;
    } catch (e) {
      log.warn(`decideWrite (write.js) failed, deciding from the contract: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  return decide(identity, cls, attribute, map, positions);
}

/** ---- who authorizes ---- */

/**
 * The person an entry is made for, as they stand now (pure): `entry` is their token-map entry today
 * ({ positions, caps }, the provisioner's), `actsFor.position` the position recorded with the section.
 *   ok: false, why  they can't authorize: gone (no entry, or read and write taken away), holding no
 *                   position, or moved (the recorded position is not one they hold, or isn't a position
 *                   at all: a name typed in its place reaches nothing).
 *   ok: true        { identity, position }: their current positions and real write capability, which is
 *                   all the rule reads; the recorded position is only checked, never decided on.
 * With no position map loaded (unscoped), nothing is theirs to commit: the rule answers "propose".
 */
export function standingOf(actsFor, entry, positions) {
  const person = String(actsFor?.person ?? "").split("/agent:")[0];
  const recorded = actsFor?.position ?? null;
  const out = (why) => ({ ok: false, person, position: recorded, why });
  // only these two can write: anything else (deny, or nothing said) is not a capability the rule can read as one
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

/** the classes a table records (a column of the table can be governed by them whichever claim asked for the write) */
async function classesOfTable(table, db) {
  const rows = await db.adbQuery("SELECT name FROM CommitmentClass WHERE record_table = :t AND status = 'confirmed'", { t: table });
  return rows.map((r) => r.name).filter(Boolean);
}

/** every attribute a rule names, with the class it is on (null: on any class) */
const attributeRules = (map) => [
  ...Object.keys(map?.attributes ?? {}).map((attribute) => ({ cls: null, attribute })),
  ...Object.entries(map?.classes ?? {}).flatMap(([cls, r]) => Object.keys(r?.attributes ?? {}).map((attribute) => ({ cls, attribute }))),
];

/**
 * Every (class, attribute) a write bears on: the claim's own, and each column written under the claim's class
 * and the table's. With the authority map, a rule can't be missed by how a name is written, or by which entity
 * the column sits on:
 * - a class or attribute spelled differently from the rule's (`CREDITLIMIT`, `Jobs`) is decided under the rule's;
 * - a rule on the same attribute of another class counts too, unless a class here states its own rule for it:
 *   `orders.price` governs a Price column on another table until that table's class says otherwise. At worst
 *   that holds an entry for a person.
 */
export function decisionKeys(cls, attribute, columns, tableClasses = [], map = null) {
  const ofClass = (c) => (c === null ? [null] : [c, ...Object.keys(map?.classes ?? {}).filter((k) => k !== c && spelled(k) === spelled(c))]);
  const classes = [...new Set([cls ?? null, ...tableClasses].flatMap(ofClass))];
  const rules = attributeRules(map);
  const names = [...new Set([attribute, ...columns].filter(Boolean).map(normalizeAttribute))];
  const bearing = names.flatMap((n) => {
    const same = rules.filter((r) => spelled(r.attribute) === spelled(n));
    const own = same.some((r) => r.cls !== null && classes.includes(r.cls));
    return [
      ...[n, ...same.map((r) => r.attribute)].flatMap((a) => classes.map((c) => [c, a])),
      ...(own ? [] : same.filter((r) => r.cls !== null).map((r) => [r.cls, r.attribute])),
    ];
  });
  const keys = [[cls ?? null, attribute ?? null], ...bearing];
  return [...new Map(keys.map(([c, a]) => [`${c}\u0000${a}`, { cls: c, attribute: a }])).values()];
}

/** where a proposal waits: where someone can see what it rests on and holds the authority over all of it */
function reviewHome(positions, origin, map, keys, held) {
  if (!positions) return origin;
  const authorities = keys.map((k) => authorityOf(map, k.cls, k.attribute)).filter(Boolean);
  return commonAncestor(positions, [origin, ...authorities.map((a) => (positions.positions[a] ? a : positions.root)), ...(held ? [held.home] : [])]);
}

/** ---- the entry itself ---- */

/** the strictest of several answers: anything hidden stops it, anything proposed holds it */
const strictest = (answers) => (answers.includes("hidden") ? "hidden" : answers.includes("propose") ? "propose" : "direct");

/**
 * Enter data into a source row. `actsFor` is the person the agent acts for
 * ({ person, position }, as the section recorded them); `by` the agent identity (its user); `key` the row
 * (system:table:row); `fields` the columns to write; `cls`/`attribute` what
 * the write commits the organization to (the claim's). Decided for the person as
 * they stand now (standingOf), and over every column written (decisionKeys): the
 * strictest answer decides. `held` ({ home, why }) is the agent's own limit: what it read reaches fewer people
 * than the section's do, so what it would write can't be committed on its word alone, whoever it acts for.
 * Outcomes:
 *   direct  -> written through the write-capable instance; "applied" (or
 *              "failed" when the source refused it, with the error)
 *   propose -> a PendingWrite (kind "data_entry") for someone with authority;
 *              "proposed", and the worker waits
 *   hidden, or nobody standing behind it -> nothing written or proposed; "refused"
 * Every outcome is an AuditEvent WROTE to the row's SourceRef.
 */
export async function enterData({ actsFor, by, key, fields, cls, attribute, reason, identity, held = null }, { db = realDb, fetch: f, positions, policy, decideFn, queue, proposal, people } = {}) {
  const k = parseKey(key);
  if (!k) throw new Error(`not a record key (system:table:row): ${key}`);
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !Object.keys(fields).length) throw new Error("fields: the columns to write, with their values");
  if (!actsFor?.person) throw new Error("the person the entry is made for is needed");
  positions ??= await livePositions();
  const lookup = people ?? (await livePeople());
  const standing = standingOf(actsFor, await lookup(String(actsFor.person).split("/agent:")[0]), positions);
  const change = { fields, class: cls ?? null, attribute: attribute ?? null, reason: String(reason ?? "").slice(0, 600) || null, ...(held ? { held } : {}) };
  const base = { key: k.key, authorized_by: standing.person, acted_by: by, position: standing.position ?? "unknown" };
  if (!standing.ok) {
    const ev = await recordAuditEvent({ ...base, change: { ...change, refused: standing.why }, outcome: "refused" }, db);
    return { outcome: "refused", decision: "hidden", audit: ev.id, note: `Not written: ${standing.why}. Nothing was proposed; a person who holds the authority can make this entry themselves.` };
  }
  const tableClasses = await classesOfTable(`${k.system}:${k.table}`, db);
  // one map for the whole entry; one that can't be read decides nothing direct (a person at the root does)
  let map = null;
  let unreadable = false;
  if (!decideFn && positions) {
    try {
      map = await authorityMapFor({ policy, positions, db });
    } catch (e) {
      unreadable = true;
      log.warn(`authority map unreadable, so the entry on ${k.key} is proposed: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  const keys = decisionKeys(cls, attribute, Object.keys(fields), tableClasses, map);
  const answers = unreadable ? ["propose"] : await Promise.all(keys.map((d) => (decideFn ? decideFn(standing.identity, d.cls, d.attribute) : decideWrite(standing.identity, d.cls, d.attribute, { policy: map, positions, db }))));
  const ruled = strictest(answers);
  const decision = ruled === "direct" && held ? "propose" : ruled;
  const over = `${cls ?? "this"}${attribute ? `/${attribute}` : ""}${Object.keys(fields).some((c) => normalizeAttribute(c) !== attribute) ? ` and the columns written (${Object.keys(fields).join(", ")})` : ""}`;
  if (decision === "hidden") {
    const ev = await recordAuditEvent({ ...base, change, outcome: "refused" }, db);
    return { outcome: "refused", decision, audit: ev.id, note: `Not written: ${standing.person} (${base.position}) holds no authority over ${over} and reports to nobody who does; nothing was proposed.` };
  }
  if (decision === "propose") {
    const payload = { kind: "data_entry", key: k.key, fields, class: cls ?? null, attribute: attribute ?? null, acts_for: { person: standing.person, position: base.position }, by, reason: change.reason };
    const w = queue && proposal ? null : await liveQueue();
    const queued = await (queue ?? w.queueWrite)({ kind: "data_entry", payload: JSON.stringify(payload), user: by, home: unreadable ? positions.root : reviewHome(positions, base.position, map, keys, held), ...(proposal ?? w.proposalFields)(identity ?? { role: null }, reason) });
    let ev;
    try {
      ev = await recordAuditEvent({ ...base, change, outcome: "proposed", pending_id: queued.pendingId }, db);
    } catch (e) {
      // a proposal the trail doesn't hold must not wait for an approver: it is withdrawn, and the worker hears why
      await db.adbCommand("UPDATE PendingWrite SET status = 'rejected', note = :n WHERE id = :id", "sql", { n: "withdrawn: the audit event could not be recorded", id: queued.pendingId }).catch(() => {});
      throw new Error(`the proposal was withdrawn: its audit event could not be recorded: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    const queuedNote = unreadable ? "the authority map can't be read, so who holds this can't be told" : ruled === "direct" ? held.why : standing.identity.caps.write === "queued" ? "this person's writes are queued for approval" : `${standing.person} (${base.position}) reports to the position holding authority over ${over}`;
    return { outcome: "proposed", decision, pendingId: queued.pendingId, audit: ev.id, note: `Proposed: ${queuedNote}, so the entry waits for someone there.` };
  }
  return applyEntry({ ...base, change, fields, table: k.table, rowKey: k.row_key }, { db, fetch: f });
}

const holds = (row, fields) => Boolean(row) && Object.entries(fields).every(([c, v]) => c in row && (sameValue(row[c], v) || ((row[c] ?? null) === null && (v ?? null) === null)));

/**
 * Attempts on a row whose end was never recorded are settled by what the row holds now: `row` is the row as
 * just read. Returns what was settled. A retry goes through here first, so it finds what a lost write left.
 * Applied when the row holds what was written, failed when it still holds what it held before. Anything else
 * (someone has changed the row since) can't be told apart: the event stays "attempted", says so
 * (`row_moved_on`), and is not looked at again, rather than calling a write that landed a failure.
 */
export async function settleOpenAttempts(key, row, db = realDb, { except = null } = {}) {
  const settled = [];
  for (const ev of (await openAttempts(key, db)).filter((e) => e.id !== except && !e.change?.row_moved_on)) {
    const fields = ev.change?.fields ?? {};
    const columns = Object.keys(fields);
    const before = ev.change?.before;
    const applied = columns.length > 0 && holds(row, fields);
    const untouched = !applied && columns.length > 0 && Boolean(before) && columns.every((c) => c in before) && holds(row, before);
    if (!applied && !untouched) {
      await settleAttempt(ev.id, "attempted", { ...ev.change, row_moved_on: true }, { key, acted_by: ev.acted_by }, db);
      continue;
    }
    const outcome = applied ? "applied" : "failed";
    await settleAttempt(ev.id, outcome, { ...ev.change, ...(applied ? { after: fields } : {}), settled_later: true }, { key, acted_by: ev.acted_by }, db);
    settled.push({ id: ev.id, outcome });
  }
  return settled;
}

/**
 * The write itself, in three recorded steps so a row can't change without its event: the event goes on the trail
 * first ("attempted": no event, no write), the source is written, and the event is settled applied or failed.
 * A transport error says nothing about whether the row changed, so the row is read back before calling it failed;
 * if it can't be read the event stays "attempted" and the next attempt on the row settles it.
 */
async function applyEntry({ key, authorized_by, acted_by, position, change, fields, table, rowKey, pending_id = null }, { db, fetch: f }) {
  const auditDown = (e) => ({ outcome: "failed", decision: "direct", audit: null, error: `nothing was written: the audit trail could not record the attempt: ${String(e?.message ?? e).slice(0, 240)}` });
  const refusedHere = (e) => String(e?.message ?? e).slice(0, 300);
  let eventId = null;
  try {
    if (pending_id) eventId = await attemptProposed(pending_id, { authorized_by, position, change }, db);
  } catch (e) {
    return auditDown(e);
  }
  const settle = (outcome, c) => settleAttempt(eventId, outcome, c, { key, acted_by }, db);
  const noWrite = async (e) => {
    const c = { ...change, error: refusedHere(e) };
    if (eventId) await settle("failed", c);
    const ev = eventId ? { id: eventId } : await recordAuditEvent({ key, authorized_by, acted_by, position, change: c, outcome: "failed", pending_id }, db);
    return { outcome: "failed", decision: "direct", audit: ev.id, error: c.error };
  };
  let client;
  let hit;
  try {
    ({ client } = await clientFor(key, { db, fetch: f }));
    hit = await client.readRow(table, rowKey);
    if (!hit) throw new Error(`no row ${rowKey} in ${table}: the record key doesn't hold`);
    assertWritable(fields, hit);
  } catch (e) {
    return noWrite(e);
  }
  // an earlier attempt on this row that never finished is settled before this one starts
  await settleOpenAttempts(key, hit.row, db, { except: eventId }).catch((e) => log.warn(`open audit attempts on ${key} not settled: ${String(e).slice(0, 160)}`));
  const attempt = { ...change, before: pick(hit.row, Object.keys(fields)) };
  try {
    if (eventId) await settle("attempted", attempt);
    else eventId = (await recordAuditEvent({ key, authorized_by, acted_by, position, change: attempt, outcome: "attempted", pending_id }, db)).id;
  } catch (e) {
    return auditDown(e);
  }
  let result;
  try {
    result = await client.writeRow(table, hit, fields);
  } catch (e) {
    return afterWriteError(e, { attempt, eventId, settle, client, table, rowKey, fields });
  }
  const done = { ...attempt, after: fields };
  try {
    await settle("applied", done);
  } catch (e) {
    log.warn(`data entry on ${key} applied but its audit event ${eventId} wasn't settled: ${String(e).slice(0, 200)}`);
    return { outcome: "applied", decision: "direct", audit: eventId, audit_unsettled: true, result, note: "The row was written; its audit event stays open as attempted and is settled by the next entry on this row." };
  }
  return { outcome: "applied", decision: "direct", audit: eventId, result };
}

/** a write that threw: the source said no (failed), or the transport broke and the row is read back to tell */
async function afterWriteError(e, { attempt, eventId, settle, client, table, rowKey, fields }) {
  const error = String(e?.message ?? e).slice(0, 300);
  let row;
  let readable = true;
  if (!e?.toolError) {
    try {
      row = (await client.readRow(table, rowKey))?.row ?? null;
    } catch {
      readable = false;
    }
  }
  if (!readable) {
    await settle("attempted", { ...attempt, error }).catch(() => {});
    return { outcome: "failed", decision: "direct", audit: eventId, error, unverified: true, note: "The source couldn't be reached to tell whether the row changed; the audit event stays open as attempted." };
  }
  if (holds(row, fields)) {
    await settle("applied", { ...attempt, after: fields, note: `the source answered with an error (${error}) but the row holds the new values` }).catch((x) => log.warn(`audit event ${eventId} not settled: ${String(x).slice(0, 200)}`));
    return { outcome: "applied", decision: "direct", audit: eventId };
  }
  await settle("failed", { ...attempt, error }).catch((x) => log.warn(`audit event ${eventId} not settled: ${String(x).slice(0, 200)}`));
  return { outcome: "failed", decision: "direct", audit: eventId, error };
}

const pick = (row, cols) => Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]]));

/**
 * Refused unless the approver holds the authority over everything the entry bears on, as they stand now: being
 * able to see a proposal is not being able to commit it. A map that can't be read leaves it to the root.
 */
async function assertApproverHolds(p, k, person, entry, { positions, db }) {
  if (!positions) return;
  const standing = standingOf({ person, position: null }, entry, positions);
  if (!standing.ok) throw new Error(`not applied: ${standing.why}`);
  const atRoot = standing.identity.positions.includes(positions.root);
  const map = await authorityMapFor({ positions, db }).catch(() => null);
  if (!map) {
    if (atRoot) return;
    throw new Error(`not applied: the authority map can't be read, so only someone at the top of the organization can approve this`);
  }
  const keys = decisionKeys(p.class ?? null, p.attribute ?? null, Object.keys(p.fields ?? {}), await classesOfTable(`${k.system}:${k.table}`, db), map);
  const answers = await Promise.all(keys.map((d) => decideWrite(standing.identity, d.cls, d.attribute, { policy: map, positions, db })));
  if (strictest(answers) !== "direct") throw new Error(`not applied: ${person} doesn't hold the authority over ${Object.keys(p.fields ?? {}).join(", ")}, so can't approve this entry`);
}

/**
 * An approved data_entry proposal: the write runs now, authorized by the person who approved it (who must hold
 * the authority), acted by the agent that proposed it; one event, the proposal's own, carries it to its end
 * (who it was proposed for stays in `change`). The event names the person behind the approving identity.
 */
export async function applyProposedEntry(payload, pendingId, approver, { db = realDb, fetch: f, people, positions } = {}) {
  const p = typeof payload === "string" ? JSON.parse(payload) : payload;
  const k = parseKey(p.key);
  if (!k) throw new Error(`not a record key: ${p.key}`);
  positions ??= await livePositions();
  const authorized_by = approvingPerson(approver);
  if (!authorized_by) throw new Error("not applied: an approved entry needs the person who approved it");
  const entry = await (people ?? (await livePeople()))(authorized_by);
  try {
    await assertApproverHolds(p, k, authorized_by, entry, { positions, db });
  } catch (e) {
    if (pendingId) await settleAuditEvent(pendingId, "refused", db).catch((x) => log.warn(`audit event for ${pendingId} not refused: ${String(x).slice(0, 160)}`));
    throw e;
  }
  const position = (positions && defaultHome(positions, entry?.positions ?? [])) || p.acts_for?.position || "unknown";
  const r = await applyEntry(
    { key: k.key, authorized_by, acted_by: p.by ?? "unknown", position, change: { fields: p.fields, class: p.class, attribute: p.attribute, reason: p.reason, proposed_for: p.acts_for ?? null, approved_by: approver ?? null }, fields: p.fields, table: k.table, rowKey: k.row_key, pending_id: pendingId ?? null },
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
