// M5 acceptance: an MCP server registered in the gwarestrin registry is
// enabled per-agent; the agent's generated .mcp.json carries the subset, the
// pi-mcp-adapter loads in the pi child, and the model's `mcp` proxy tool call
// round-trips through the mock MCP stdio server.
// Usage: node scripts/e2e-m5.mjs [baseUrl] [mockMcpScript]
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

const base = process.argv[2] ?? "http://localhost:3100";
const mockMcp =
  process.argv[3] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mock-mcp.mjs");
const wsUrl = base.replace("http", "ws") + "/ws";

const j = async (p, init) => {
  const res = await fetch(base + p, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
};

// 1. register the MCP server in the registry
await j("/api/mcp/tester", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ command: process.execPath, args: [mockMcp], description: "e2e mock" }),
});
console.log("registry: tester registered ->", mockMcp);

const { agent } = await j("/api/agents", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: `m5-${Date.now()}`, mcpServers: ["tester"], gondolin: { enabled: false } }),
});
console.log("created", agent.id);

const start = await j(`/api/agents/${agent.id}/start`, { method: "POST" });
if (start.runtime.status !== "running") throw new Error("agent not running: " + JSON.stringify(start));
console.log("started pid", start.runtime.pid);

// 2. generated .mcp.json must carry the subset (readable via files API)
const dl = await fetch(base + `/api/agents/${agent.id}/files/download?path=${encodeURIComponent(".mcp.json")}`);
if (!dl.ok) throw new Error(".mcp.json not downloadable: " + dl.status);
const mcpJson = JSON.parse(await dl.text());
if (!mcpJson.mcpServers?.tester?.command) throw new Error("subset missing in .mcp.json: " + JSON.stringify(mcpJson));
if ("description" in mcpJson.mcpServers.tester) throw new Error("metadata leaked into .mcp.json");
console.log(".mcp.json subset ok:", JSON.stringify(mcpJson.mcpServers.tester.args));

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.once("open", res);
  ws.once("error", rej);
});
const events = [];
const responses = new Map();
let nextId = 1;
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.kind === "event") {
    if (msg.event.type === "response" && msg.event.browserId) {
      const r = responses.get(msg.event.browserId);
      if (r) {
        responses.delete(msg.event.browserId);
        r(msg.event);
      }
    } else if (msg.agentId === agent.id) {
      events.push(msg.event);
    }
  }
});
const rpc = (type, payload = {}, timeoutMs = 180000) =>
  new Promise((resolve, reject) => {
    const id = `m5-${nextId++}`;
    const t = setTimeout(() => {
      responses.delete(id);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    responses.set(id, (ev) => {
      clearTimeout(t);
      resolve(ev);
    });
    ws.send(JSON.stringify({ v: 1, agentId: agent.id, kind: "cmd", id, type, ...payload }));
  });

const prompt = await rpc("prompt", { message: "Use the MCP tester echo tool." });
if (prompt.success !== true) throw new Error("prompt failed: " + JSON.stringify(prompt));
console.log("prompt accepted; waiting for adapter connect + tool round-trip...");

const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  if (events.some((e) => e.type === "agent_settled")) break;
  await new Promise((r) => setTimeout(r, 500));
}
const types = events.map((e) => e.type);
for (const expected of ["tool_execution_start", "tool_execution_end", "agent_settled"]) {
  if (!types.includes(expected)) throw new Error(`missing event ${expected}; saw ${types.join(",")}`);
}
const toolStart = events.find((e) => e.type === "tool_execution_start");
if (toolStart.toolName !== "mcp") throw new Error("expected mcp tool call, got " + toolStart.toolName);
const toolEnd = events.find((e) => e.type === "tool_execution_end");
if (toolEnd.isError) throw new Error("mcp tool errored: " + JSON.stringify(toolEnd).slice(0, 300));
console.log("mcp proxy tool executed ok");

const last = await rpc("get_last_assistant_text");
const text = String(last.data.text ?? "");
console.log("final reply:", text.slice(0, 160));
if (!text.includes("MCP_TOOL_PASS")) throw new Error("MCP round-trip failed; reply: " + text);

// 3. subset toggle: disabling must rewrite .mcp.json (agent not running -> no restart needed)
await j(`/api/agents/${agent.id}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ mcpServers: [] }),
});
const dl2 = await fetch(base + `/api/agents/${agent.id}/files/download?path=${encodeURIComponent(".mcp.json")}`);
const mcpJson2 = JSON.parse(await dl2.text());
if (Object.keys(mcpJson2.mcpServers ?? {}).length !== 0) {
  throw new Error("subset not cleared: " + JSON.stringify(mcpJson2));
}
console.log("subset toggle rewrites .mcp.json ok");

await j(`/api/agents/${agent.id}/stop`, { method: "POST" });
await j(`/api/agents/${agent.id}?purge=true`, { method: "DELETE" });
await j("/api/mcp/tester", { method: "DELETE" });
ws.close();
console.log("E2E-M5 PASS");
process.exit(0);
