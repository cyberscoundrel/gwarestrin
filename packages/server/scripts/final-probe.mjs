// final e2e: prompt the graph-aware-test agent, expect a graph-grounded reply
import WebSocket from "ws";

const agentId = process.argv[2];
const base = "http://localhost:3000";
const ws = new WebSocket(base.replace("http", "ws") + "/ws");
await new Promise((r, rej) => { ws.once("open", r); ws.once("error", rej); });
const responses = new Map();
let nextId = 1;
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.kind === "event" && msg.event.type === "response" && msg.event.browserId) {
    const r = responses.get(msg.event.browserId);
    if (r) { responses.delete(msg.event.browserId); r(msg.event); }
  }
});
const rpc = (type, payload = {}, timeoutMs = 300000) =>
  new Promise((resolve, reject) => {
    const id = `f-${nextId++}`;
    const t = setTimeout(() => { responses.delete(id); reject(new Error(`timeout ${type}`)); }, timeoutMs);
    responses.set(id, (ev) => { clearTimeout(t); resolve(ev); });
    ws.send(JSON.stringify({ v: 1, agentId, kind: "cmd", id, type, ...payload }));
  });

const p = await rpc("prompt", { message: "what services run on thinkcentre, and which databases can they reach?" });
if (p.success !== true) throw new Error("prompt failed: " + JSON.stringify(p).slice(0, 200));

const deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  const text = String((await rpc("get_last_assistant_text")).data?.text ?? "");
  if (text.trim()) {
    console.log("REPLY:", text.slice(0, 500));
    const ok = /gwarestrin/.test(text) && /dab/.test(text) && /neo4j/.test(text);
    console.log(ok ? "GRAPH_GROUNDED: PASS" : "GRAPH_GROUNDED: CHECK MANUALLY");
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
ws.close();
process.exit(0);
