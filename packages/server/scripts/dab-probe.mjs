// dab/SQL MCP Server end-to-end probe: drive a running agent through the
// pi-mcp-adapter proxy to describe entities and read a record.
// usage: node scripts/dab-probe.mjs <agentId> [baseUrl]
import WebSocket from "ws";

const agentId = process.argv[2];
const base = process.argv[3] ?? "http://localhost:3000";
if (!agentId) throw new Error("agentId required");

const ws = new WebSocket(base.replace("http", "ws") + "/ws");
await new Promise((r, rej) => {
  ws.once("open", r);
  ws.once("error", rej);
});
const responses = new Map();
const settledWaiters = [];
let nextId = 1;
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.kind === "event" && msg.event.type === "response" && msg.event.browserId) {
    const r = responses.get(msg.event.browserId);
    if (r) {
      responses.delete(msg.event.browserId);
      r(msg.event);
    }
  } else if (msg.agentId === agentId && msg.kind === "event" && msg.event.type === "agent_settled") {
    for (const w of settledWaiters.splice(0)) w();
  }
});
const rpc = (type, payload = {}, timeoutMs = 300000) =>
  new Promise((resolve, reject) => {
    const id = `d-${nextId++}`;
    const t = setTimeout(() => {
      responses.delete(id);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    responses.set(id, (ev) => {
      clearTimeout(t);
      resolve(ev);
    });
    ws.send(JSON.stringify({ v: 1, agentId, kind: "cmd", id, type, ...payload }));
  });

async function turn(message) {
  const settled = new Promise((r) => settledWaiters.push(r));
  const initial = String((await rpc("get_last_assistant_text")).data?.text ?? "");
  const p = await rpc("prompt", { message });
  if (p.success !== true) throw new Error("prompt failed: " + JSON.stringify(p).slice(0, 300));
  await Promise.race([settled, new Promise((r) => setTimeout(r, 420000))]);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const text = String((await rpc("get_last_assistant_text")).data?.text ?? "");
    if (text.trim() && text !== initial) return text;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "(no new reply)";
}

console.log(
  "TURN1:",
  (
    await turn(
      'You have an `mcp` proxy tool connected to MCP servers. Use it: call it with {"search": "describe entities"} to find the entity-description tool (exact name likely mssql_describe_entities). Then CALL that tool to list the database entities. Reply with the first 8 entity names the tool returns.',
    )
  ).slice(0, 600),
);

console.log(
  "TURN2:",
  (
    await turn(
      'Good. Now use the mcp proxy again: call the records-reading tool (likely mssql_read_records) with the entity "dbo_MT_Jobs" and limit 1. Reply with the names of 5 fields present in that record.',
    )
  ).slice(0, 600),
);

ws.close();
process.exit(0);
