/** temp: exact searchGraph SQL probes with wrench present */
const MCP = process.argv[2] ? `http://${process.argv[2]}:8000/mcp` : "http://172.31.99.13:8000/mcp";
async function q(command, language = "sql") {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name: "query_graph", arguments: { query: command, language } } }),
  });
  const t = await r.text();
  const j = JSON.parse((t.split("\n").find((l) => l.startsWith("data:")) ?? t).replace(/^data:\s*/, ""));
  if (j.result?.isError) return { TOOL_ERROR: j.result.content[0].text.slice(0, 220) };
  const parsed = JSON.parse(j.result?.content?.[0]?.text ?? "{}");
  return { n: (parsed.rows ?? []).length, first: JSON.stringify((parsed.rows ?? [])[0] ?? null).slice(0, 160) };
}

console.log("1 embed_temporal:", JSON.stringify(await q("SELECT FROM Entity WHERE embed_temporal IS NOT NULL LIMIT 5")));
console.log("2 arrived_at:", JSON.stringify(await q("SELECT FROM Entity WHERE arrived_at IS NOT NULL LIMIT 5")));
console.log("3 range:", JSON.stringify(await q("SELECT FROM Entity WHERE embed_temporal IS NOT NULL AND arrived_at IS NOT NULL AND arrived_at >= '2026-08-01' AND arrived_at <= '2026-08-31' LIMIT 5")));
console.log("4 full search shape:", JSON.stringify(await q("SELECT FROM (SELECT FROM Entity WHERE embed_temporal IS NOT NULL AND arrived_at IS NOT NULL AND arrived_at >= '2026-08-01' AND arrived_at <= '2026-08-31') LIMIT 5")));
