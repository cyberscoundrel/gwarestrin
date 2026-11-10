// A fake test source for the replay harness: the synthetic database's rows (test-sql/data.mjs, through
// graph-rag/eval/s0.mjs) served as two Data API builder MCP
// endpoints over one dataset, the read-only one on 5000 and the write-capable one on 5001, answering exactly as
// fake-dab-core.mjs (the sources stream's) says DAB 2.0.12 does. Control routes, on either port:
//
//   GET  /__dump        every table: { table: { primaryKey, rows } } (the evaluation's before and after)
//   POST /__reset       the dataset back to S0
//   POST /__plant {table, keys, fields}   change a row behind everyone's back (a gate's teeth: no Filed entry)
//   GET  /__calls       every tools/call: { port, name, args, error }
//
// No real data, no real database; nothing here is reachable outside the harness's private network.
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dabTool } from "./fake-dab-core.mjs";
import { dataset } from "../eval/s0.mjs";

/** what the fake's identity view answers: test-sql's dbo_GwConnectionIdentity, as the guards read it */
export const IDENTITY = { server_name: "gr-e2e-fake", database_name: "S0Fake", login_name: "s0_write" };
const withIdentity = (tables) => ({ ...tables, dbo_GwConnectionIdentity: { primaryKey: ["id"], rows: [{ id: 1, ...IDENTITY }] } });

export const READ_PORT = 5000;
export const WRITE_PORT = 5001;

/** the state and the handler, apart from the sockets (test/harness-fakes.test.js drives it directly) */
export function fakeSource() {
  let tables = withIdentity(dataset());
  const calls = [];
  const rpc = (msg, write, port) => {
    const reply = (result) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
    if (msg.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: `fake-dab-${write ? "write" : "read"}`, version: "2.0.12" } });
    if (msg.method === "notifications/initialized") return null;
    if (msg.method === "tools/list") return reply({ tools: ["describe_entities", "read_records", ...(write ? ["create_record", "update_record"] : [])].map((name) => ({ name, inputSchema: { type: "object" } })) });
    if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params ?? {};
      const out = dabTool(tables, name, args ?? {}, { write });
      calls.push({ port, name, args: args ?? {}, error: Boolean(out.isError) });
      return reply(out);
    }
    return { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32601, message: `no method ${msg.method}` } };
  };
  const control = (method, path, body) => {
    if (method === "GET" && path === "/__dump") return JSON.parse(JSON.stringify(tables));
    if (method === "GET" && path === "/__calls") return calls;
    if (method === "POST" && path === "/__reset") {
      tables = withIdentity(dataset());
      calls.length = 0;
      return { ok: true };
    }
    if (method === "POST" && path === "/__plant") {
      const t = tables[body?.table];
      const row = t?.rows.find((r) => Object.entries(body.keys ?? {}).every(([k, v]) => String(r[k]) === String(v)));
      if (!row) return { ok: false, error: "no such row" };
      Object.assign(row, body.fields ?? {});
      return { ok: true, row };
    }
    return undefined;
  };
  return { rpc, control, tables: () => tables };
}

function serve(state, port, write) {
  return createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json", ...(write !== null ? { "mcp-session-id": `fake-${port}` } : {}) });
      res.end(obj === null ? "" : JSON.stringify(obj));
    };
    const path = new URL(req.url, "http://x").pathname;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      return send(400, { error: "not JSON" });
    }
    const c = state.control(req.method, path, body);
    if (c !== undefined) return send(200, c);
    if (req.method === "POST" && path === "/mcp") {
      const out = state.rpc(body ?? {}, write, port);
      return out === null ? send(202, null) : send(200, out);
    }
    send(404, { error: `no route ${req.method} ${path}` });
  }).listen(port);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const state = fakeSource();
  serve(state, READ_PORT, false);
  serve(state, WRITE_PORT, true);
  console.log(`fake source: read :${READ_PORT}/mcp, write :${WRITE_PORT}/mcp (${fileURLToPath(import.meta.url)})`);
}
