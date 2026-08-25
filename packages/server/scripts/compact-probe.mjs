// compact + verify an agent session over WS
// usage: node scripts/compact-probe.mjs <agentId> [baseUrl]
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
let nextId = 1;
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.kind === "event" && msg.event.type === "response" && msg.event.browserId) {
    const r = responses.get(msg.event.browserId);
    if (r) {
      responses.delete(msg.event.browserId);
      r(msg.event);
    }
  }
});
const rpc = (type, payload = {}, timeoutMs = 300000) =>
  new Promise((resolve, reject) => {
    const id = `c-${nextId++}`;
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

const before = await rpc("get_session_stats");
console.log("stats before:", JSON.stringify(before.data?.contextUsage ?? before.data).slice(0, 200));

console.log("compacting…");
const compact = await rpc("compact", { instructions: "Discard binary/file-dump noise; keep task context." });
console.log("compact:", compact.success === true ? "ok" : JSON.stringify(compact).slice(0, 300));

const after = await rpc("get_session_stats");
console.log("stats after:", JSON.stringify(after.data?.contextUsage ?? after.data).slice(0, 200));

const prompt = await rpc("prompt", { message: "Reply with exactly: COMPACT_OK" });
if (prompt.success !== true) throw new Error("prompt failed: " + JSON.stringify(prompt).slice(0, 200));

const initial = String((await rpc("get_last_assistant_text")).data?.text ?? "");
const deadline = Date.now() + 300000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const text = String((await rpc("get_last_assistant_text")).data?.text ?? "");
  if (text.trim() && text !== initial) {
    console.log("REPLY:", text.slice(0, 200));
    break;
  }
}
ws.close();
process.exit(0);
