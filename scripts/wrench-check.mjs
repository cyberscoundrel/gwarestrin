/** temp: wrench visibility checks */
const MCP = process.argv[2] ? `http://${process.argv[2]}:8000/mcp` : "http://172.31.99.13:8000/mcp";
async function q(command, language = "cypher") {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name: "query_graph", arguments: { query: command, language } } }),
  });
  const t = await r.text();
  const j = JSON.parse((t.split("\n").find((l) => l.startsWith("data:")) ?? t).replace(/^data:\s*/, ""));
  if (j.result?.isError) return { TOOL_ERROR: j.result.content[0].text.slice(0, 150) };
  const parsed = JSON.parse(j.result?.content?.[0]?.text ?? "{}");
  return parsed.rows ?? parsed;
}

console.log("count total:", JSON.stringify(await q("SELECT count(*) FROM Entity", "sql")));
console.log("count wrench cypher:", JSON.stringify(await q("MATCH (n:Entity) WHERE n.name = '__probe__wrench' RETURN count(n) AS c", "cypher")));
console.log("count wrench sql:", JSON.stringify(await q("SELECT count(*) FROM Entity WHERE name = '__probe__wrench'", "sql")));
console.log("wrench row sql:", JSON.stringify(await q("SELECT name, arrived_at FROM Entity WHERE name = '__probe__wrench'", "sql")));
const all = await q("SELECT name FROM Entity LIMIT 20", "sql");
console.log("all names:", JSON.stringify(all.map((r) => r.name)));
