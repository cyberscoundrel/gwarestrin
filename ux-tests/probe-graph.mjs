// Probe: do the running pi agents' envs carry a valid graph token?
import { readdirSync, readFileSync } from "node:fs";

const pids = [];
for (const p of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
  try {
    const cmd = readFileSync(`/proc/${p}/cmdline`, "utf8") + readFileSync(`/proc/${p}/comm`, "utf8");
    if (cmd.includes("pi-rpc") || cmd.includes("rpc-entry")) pids.push(p);
  } catch { /* vanished */ }
}
console.log("pi pids:", pids.join(",") || "none");
if (pids.length === 0) process.exit(1);

for (const pid of pids) {
  const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  const tokLine = env.find((l) => l.startsWith("GWARESTRIN_GRAPH_TOKEN="));
  const tok = tokLine?.slice("GWARESTRIN_GRAPH_TOKEN=".length);
  console.log(`pid ${pid}: token present=${!!tok} len=${tok?.length ?? 0}`);
  if (!tok) continue;
  const res = await fetch("http://graph-rag:8000/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }),
  });
  console.log(`pid ${pid}: graph-rag initialize -> ${res.status}`);
}
