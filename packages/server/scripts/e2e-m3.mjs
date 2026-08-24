// M3 acceptance (run on a host with qemu/kvm): the model issues a bash tool
// call; it must execute inside the agent's gondolin microvm (workspace mount
// + alpine guest), and the final answer must quote in-VM output.
// Usage: node scripts/e2e-m3.mjs [baseUrl]
import WebSocket from "ws";

const base = process.argv[2] ?? "http://localhost:3100";
const wsUrl = base.replace("http", "ws") + "/ws";

const j = async (path, init) => {
  const res = await fetch(base + path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
};

const { agent } = await j("/api/agents", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: `m3-${Date.now()}` }),
});
console.log("created", agent.id);
const start = await j(`/api/agents/${agent.id}/start`, { method: "POST" });
if (start.runtime.status !== "running") throw new Error("agent not running: " + JSON.stringify(start));
console.log("started pid", start.runtime.pid);

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
    const id = `m3-${nextId++}`;
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

const state = await rpc("get_state");
console.log("model:", state.data.model.provider + "/" + state.data.model.id);

const prompt = await rpc("prompt", { message: "Run the sandbox environment check." });
if (prompt.success !== true) throw new Error("prompt failed: " + JSON.stringify(prompt));
console.log("prompt accepted; driving VM round-trip (boot + exec)...");

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
if (toolStart.toolName !== "bash") throw new Error("expected bash tool call, got " + toolStart.toolName);
console.log("bash tool executed (exit:", events.find((e) => e.type === "tool_execution_end")?.isError === false ? "ok" : "error", ")");

const last = await rpc("get_last_assistant_text");
const text = String(last.data.text ?? "");
console.log("final reply:", text.slice(0, 160));
if (!text.includes("VM_CHECK_PASS")) {
  throw new Error("VM check did not pass; reply: " + text);
}
if (!/\/workspace/.test(text) || !/Alpine/i.test(text)) {
  throw new Error("reply lacks in-VM evidence (/workspace + Alpine)");
}

// egress policy: non-allowlisted host must be blocked from inside the VM
const blocked = await rpc("prompt", { message: "Run: curl -sS -m 10 -o /dev/null -w '%{http_code}' http://example.com/ ; echo done" });
if (blocked.success !== true) throw new Error("second prompt failed");
const deadline2 = Date.now() + 180000;
while (Date.now() < deadline2) {
  if (events.filter((e) => e.type === "agent_settled").length >= 2) break;
  await new Promise((r) => setTimeout(r, 500));
}
const last2 = await rpc("get_last_assistant_text");
const text2 = String(last2.data.text ?? "");
console.log("egress reply:", text2.slice(0, 200));
if (/^200/.test(text2.trim()) || text2.includes("Example Domain")) {
  throw new Error("non-allowlisted egress was NOT blocked");
}

await j(`/api/agents/${agent.id}/stop`, { method: "POST" });
await j(`/api/agents/${agent.id}?purge=true`, { method: "DELETE" });
ws.close();
console.log("E2E-M3 PASS");
process.exit(0);
