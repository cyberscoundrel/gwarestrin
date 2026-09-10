/** temp: temporal-filter SQL diagnosis via graph-rag query_graph */
const MCP = process.argv[2] ? `http://${process.argv[2]}:8000/mcp` : "http://172.31.99.13:8000/mcp";
async function q(command, language = "sql") {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name: "query_graph", arguments: { query: command, language } } }),
  });
  const t = await r.text();
  const j = JSON.parse((t.split("\n").find((l) => l.startsWith("data:")) ?? t).replace(/^data:\s*/, ""));
  const parsed = JSON.parse(j.result?.content?.[0]?.text ?? "{}");
  return parsed.rows ?? parsed;
}

console.log("a:", JSON.stringify(await q("SELECT name, arrived_at FROM Entity WHERE name = '__probe__wrench'")));
console.log("b:", JSON.stringify(await q("SELECT name FROM Entity WHERE embed_temporal IS NOT NULL LIMIT 3")));
console.log("c:", JSON.stringify(await q("SELECT name FROM Entity WHERE arrived_at IS NOT NULL LIMIT 3")));
console.log("d:", JSON.stringify(await q("SELECT name FROM Entity WHERE embed_temporal IS NOT NULL AND arrived_at IS NOT NULL LIMIT 3")));
console.log("e:", JSON.stringify(await q("SELECT name, arrived_at FROM Entity WHERE embed_temporal IS NOT NULL AND arrived_at IS NOT NULL AND arrived_at >= '2026-08-01' AND arrived_at <= '2026-08-31' LIMIT 3")));
