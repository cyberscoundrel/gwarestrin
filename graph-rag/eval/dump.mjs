// Dumping a test source through its read endpoint, for the row diff (docs/build/integrate.md, 2.2), and the
// guard proposal B puts before any write: the write connection says which server and database it holds, and
// the run stops unless they are the test names. Written apart from data-entry.js on purpose: the evaluation
// reads the source with its own code, so a bug in the adapter can't hide a change from the gate.

import { DATABASE as SYNTH_DATABASE, SERVER as SYNTH_SERVER, WRITE_LOGIN as SYNTH_WRITE_LOGIN } from "../../test-sql/data.mjs";

let nextId = 1;

/** a minimal MCP client for one endpoint: tools/call, the text content parsed as JSON */
export function mcpClient(url, { fetch: f = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  let session = null;
  let ready = false;
  const rpc = async (method, params) => {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    session = res.headers.get("mcp-session-id") ?? session;
    const text = await res.text();
    if (!res.ok) throw new Error(`${method}: ${res.status} ${text.slice(0, 200)}`);
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text || "{}");
  };
  return async (name, args) => {
    if (!ready) {
      await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gr-eval", version: "1" } }).catch(() => {});
      ready = true;
    }
    const msg = await rpc("tools/call", { name, arguments: args });
    if (msg.error) throw new Error(`${name}: ${msg.error.message}`);
    const text = msg.result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (msg.result?.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
}

const valueOf = (r) => (Array.isArray(r) ? r : (r?.result?.value ?? r?.value ?? []));
const afterOf = (r) => r?.result?.after ?? r?.after ?? null;

/** the key columns DAB pages by, from a first page's cursor; null when the table has one row or none */
export function keyFromCursor(cursor) {
  if (!cursor) return null;
  try {
    const parts = JSON.parse(Buffer.from(String(cursor), "base64").toString("utf8"));
    return Array.isArray(parts) && parts.length ? parts.map((p) => p.FieldName) : null;
  } catch {
    return null;
  }
}

/**
 * Every table's rows: { table: { primaryKey, rows } }. `call(name, args)` is a read endpoint's tools/call.
 * `tables` limits it; `keys` gives a table's key columns when its cursor can't (one row or none).
 */
export async function dumpSource(call, { tables = null, keys = {}, page = 500, maxPages = 2000 } = {}) {
  const described = await call("describe_entities", {});
  // the identity view (test-sql's guard) is no table: its row names the connection, not data
  const names = tables ?? (described?.entities ?? []).map((e) => e.name).filter((n) => n !== IDENTITY_ENTITY);
  const out = {};
  for (const entity of names) {
    const first = await call("read_records", { entity, first: 1 });
    const primaryKey = keys[entity] ?? keyFromCursor(afterOf(first)) ?? Object.keys(valueOf(first)[0] ?? {}).slice(0, 1);
    const rows = [];
    let after = null;
    for (let n = 0; n < maxPages; n++) {
      const r = await call("read_records", { entity, first: page, ...(after ? { after } : {}) });
      const v = valueOf(r);
      rows.push(...v);
      const next = afterOf(r);
      if (!next || next === after || v.length < page) break;
      after = next;
    }
    out[entity] = { primaryKey, rows };
  }
  return out;
}

/**
 * The identities a run may write into: the synthetic test database's write login (test-sql/data.mjs), and, for the
 * replay harness only, its fake source. Nothing else is a test database.
 */
export const SYNTHETIC_WRITE = Object.freeze({ server: SYNTH_SERVER, database: SYNTH_DATABASE, login: SYNTH_WRITE_LOGIN });
export const HARNESS_FAKE = Object.freeze({ server: "gr-e2e-fake", database: "S0Fake", login: "s0_write" });

/**
 * Refuse a seeding target unless every write source graph-rag declares is, by its live guard answer
 * (`GET /api/sources/guard`), the synthetic test database: server, database and login all as test-sql names them
 * (or the harness's fake, when `harness`). No writable source, a guard that didn't pass, or any other name: refused.
 * The login is checked here even where graph-rag's own guard has none declared. Returns the sources; throws why.
 */
export function assertSeedTarget(report, { harness = false } = {}) {
  const allowed = harness ? [HARNESS_FAKE] : [SYNTHETIC_WRITE];
  const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  const writable = (report?.sources ?? []).filter((s) => s.writable);
  if (!writable.length) throw new Error("refusing to seed: the instance declares no write source, so its guard can't be checked");
  for (const s of writable) {
    const l = s.live ?? {};
    if (!l.ok) throw new Error(`refusing to seed: ${s.system}'s guard didn't pass (${l.why ?? l.status ?? "no answer"})`);
    const hit = allowed.find((a) => same(a.server, l.server) && same(a.database, l.database) && same(a.login, l.login));
    if (!hit) throw new Error(`refusing to seed: ${s.system} writes into ${l.server}/${l.database} as ${l.login ?? "?"}, not the ${harness ? "harness's fake source" : "synthetic test database"} (${allowed.map((a) => `${a.server}/${a.database} as ${a.login}`).join(", ")})`);
  }
  return writable;
}

/** the view test-sql/seed.mjs creates, whose one row names the server, database and login of the connection reading it */
export const IDENTITY_ENTITY = "dbo_GwConnectionIdentity";

/** the identity a connection reports, through that connection: { server, database, login } (throws if it has none) */
export async function connectionIdentity(call) {
  const v = valueOf(await call("read_records", { entity: IDENTITY_ENTITY, first: 2 }));
  if (v.length !== 1) throw new Error(`${IDENTITY_ENTITY} answered ${v.length} rows, not one`);
  return { server: v[0].server_name, database: v[0].database_name, login: v[0].login_name ?? null };
}

/**
 * Proposal B's guard: the write connection must say it holds the test server and database. `whoami` returns
 * { server, database } read through the write connection; throws unless both match.
 */
export async function guardTestSource(whoami, { server, database }) {
  const got = await whoami();
  if (!server || !database) throw new Error("the guard needs the test server and database names");
  const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  if (!same(got?.server, server) || !same(got?.database, database)) {
    throw new Error(`refusing to run: the write connection holds ${got?.server}/${got?.database}, not the test source ${server}/${database}`);
  }
  return got;
}
