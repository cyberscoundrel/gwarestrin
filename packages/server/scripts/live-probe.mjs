// quick live-model probe: prompt the first agent over WS, print reply
import WebSocket from "ws";

const base = "http://localhost:3000";
const j = async (p, init) => {
  const res = await fetch(base + p, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
};

const agents = (await j("/api/agents")).agents;
const agent = agents.find((a) => a.runtime?.status === "running") ?? agents[0];
console.log("agent:", agent.id, "status:", agent.runtime?.status ?? agent.status);

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
const rpc = (type, payload = {}, timeoutMs = 180000) =>
  new Promise((resolve, reject) => {
    const id = `p-${nextId++}`;
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

const prompt = await rpc("prompt", { message: "Reply with exactly: LOCAL_INFERENCE_OK" });
if (prompt.success !== true) throw new Error("prompt failed: " + JSON.stringify(prompt).slice(0, 200));
console.log("prompt accepted; waiting for model…");

const deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  const last = await rpc("get_last_assistant_text");
  const text = String(last.data?.text ?? "");
  if (text.trim()) {
    console.log("REPLY:", text.slice(0, 300));
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
  if (Date.now() > deadline) console.log("NO REPLY within deadline");
}
ws.close();
process.exit(0);
