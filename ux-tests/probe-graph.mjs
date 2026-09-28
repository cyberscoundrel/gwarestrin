// Probe: does the running pi agent's env carry a valid graph token?
import { readdirSync, readFileSync } from "node:fs";

// find the pi rpc-entry process
const pids = [];
for (const p of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
  try {
    const cmd = readFileSync(`/proc/${p}/cmdline`, "utf8") + readFileSync(`/proc/${p}/comm`, "utf8");
    if (cmd.includes("pi-rpc") || cmd.includes("rpc-entry")) pids.push(p);
  } catch { /* vanished */ }
}
console.log("pi pids:", pids.join(",") || "none");
if (pids.length === 0) process.exit(1);

const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
const tok = env.find((l) => l.startsWith("GWARESTRIN_GRAPH_TOKEN="))?.slice("GWARESTRIN_GRAPH_TOKEN=".length);
console.log("GWARESTRIN_GRAPH_TOKEN present:", !!tok, "len:", tok?.length);

const res = await fetch("http://graph-rag:8000/mcp", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(tok ? { authorization: `Bearer ${tok}` } : {}),
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }),
});
console.log("graph-rag initialize with pi's token:", res.status);
