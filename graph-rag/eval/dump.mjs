// Dumping a test source through its read endpoint, for the row diff (docs/build/integrate.md, 2.2), and the
// guard proposal B puts before any write: the write connection says which server and database it holds, and
// the run stops unless they are the test names. Written apart from data-entry.js on purpose: the evaluation
// reads the source with its own code, so a bug in the adapter can't hide a change from the gate.

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
  const names = tables ?? (described?.entities ?? []).map((e) => e.name);
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
 * Proposal B's guard: the write connection must say it holds the test server and database. `whoami` returns
 * { server, database } read through the write connection; throws unless both match.
 */
export async function guardTestSource(whoami, { server, database }) {
  const got = await whoami();
  if (!server || !database) throw new Error("the guard needs the test server and database names");
  if (String(got?.server) !== String(server) || String(got?.database) !== String(database)) {
    throw new Error(`refusing to run: the write connection holds ${got?.server}/${got?.database}, not the test source ${server}/${database}`);
  }
  return got;
}
