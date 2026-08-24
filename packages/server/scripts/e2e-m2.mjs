// M2 acceptance: drive the running server exactly like the browser does.
// REST create/start + WS cmd (prompt/get_state/get_messages) + event stream.
// Usage: node scripts/e2e-m2.mjs [baseUrl]
import WebSocket from "ws";

const base = process.argv[2] ?? "http://localhost:3100";
const wsUrl = base.replace("http", "ws") + "/ws";

const j = async (path, init) => {
  const res = await fetch(base + path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
};

// 1. create + start agent
const { agent } = await j("/api/agents", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: `e2e-${Date.now()}` }),
});
console.log("created", agent.id);
const start = await j(`/api/agents/${agent.id}/start`, { method: "POST" });
if (start.runtime.status !== "running") throw new Error("agent not running: " + JSON.stringify(start));
console.log("started pid", start.runtime.pid);

// 2. connect WS
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
const rpc = (type, payload = {}, timeoutMs = 60000) =>
  new Promise((resolve, reject) => {
    const id = `e2e-${nextId++}`;
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

// 3. state + prompt via the same path the browser uses
const state = await rpc("get_state");
console.log("ws get_state ok, model:", state.data.model.id, "provider:", state.data.model.provider);
if (state.data.model.provider !== "mock") throw new Error("expected mock provider, got " + state.data.model.provider);

const prompt = await rpc("prompt", { message: "Reply with exactly: GWARESTRIN_OK" });
if (prompt.success !== true) throw new Error("prompt failed: " + JSON.stringify(prompt));
console.log("prompt accepted");

// 4. wait for settle + assert streaming events
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  if (events.some((e) => e.type === "agent_settled")) break;
  await new Promise((r) => setTimeout(r, 200));
}
const types = events.map((e) => e.type);
for (const expected of ["message_start", "message_update", "message_end", "turn_end", "agent_settled"]) {
  if (!types.includes(expected)) throw new Error(`missing event ${expected}; saw ${types.join(",")}`);
}
const last = await rpc("get_last_assistant_text");
if (!String(last.data.text ?? "").includes("GWARESTRIN_OK")) throw new Error("bad reply: " + JSON.stringify(last.data));
console.log("streamed events ok; reply:", last.data.text);

// 5. stop + cleanup
await j(`/api/agents/${agent.id}/stop`, { method: "POST" });
await j(`/api/agents/${agent.id}?purge=true`, { method: "DELETE" });
ws.close();
console.log("E2E-M2 PASS");
process.exit(0);
