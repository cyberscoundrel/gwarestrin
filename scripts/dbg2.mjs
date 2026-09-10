/** temp: identity search dump + temporal error detail */
import { readFileSync } from "node:fs";
const ip = process.argv[2] ?? "172.31.99.4";
const env = readFileSync("/home/cyber/gwarestrin/.env", "utf8");
const pw = env.match(/ARCADEDB_ROOT_PASSWORD=(.*)/)[1].trim();
const auth = "Basic " + Buffer.from(`root:${pw}`).toString("base64");

async function mcpTool(tool, args) {
  const r = await fetch("http://172.31.99.13:8000/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const t = await r.text();
  const j = JSON.parse((t.split("\n").find((l) => l.startsWith("data:")) ?? t).replace(/^data:\s*/, ""));
  return JSON.parse(j.result?.content?.[0]?.text ?? JSON.stringify(j));
}

const s1 = await mcpTool("search_graph", { query: "test wrench for facet indexing", facets: ["identity"], k: 3 });
console.log("identity results:", s1.results?.length ?? "none");
console.log("top:", JSON.stringify(s1.results?.slice(0, 3).map((r) => ({ n: r.name, s: Number(r.score?.toFixed?.(3) ?? r.score) }))));
console.log("wrench present:", s1.results?.some((r) => r.name === "__probe__wrench"));

const adbCmd = async (command, language = "sql") => {
  const ip2 = process.argv[3];
  const r = await fetch(`http://${ip2}:2480/api/v1/command/gwarestrin`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ language, command }),
  });
  return `${r.status} ${(await r.text()).slice(0, 220)}`;
};
console.log("temporal sql:", await adbCmd("SELECT FROM Entity WHERE embed_temporal IS NOT NULL AND arrived_at IS NOT NULL AND arrived_at >= '2026-08-01' LIMIT 5"));
