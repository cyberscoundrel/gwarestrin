/** temp: probe which MERGE forms ArcadeDB cypher accepts (via graph-rag) */
const MCP = process.argv[2] ? `http://${process.argv[2]}:8000/mcp` : "http://172.31.99.13:8000/mcp";
async function call(command, language) {
  const body = {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e6),
    method: "tools/call",
    params: { name: "execute_graph", arguments: { command, language } },
  };
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  const line = text.split("\n").find((l) => l.startsWith("data:")) ?? text;
  const j = JSON.parse(line.replace(/^data:\s*/, ""));
  return j.error
    ? "ERR " + JSON.stringify(j.error).slice(0, 100)
    : j.result?.isError
      ? "TOOLERR " + (j.result?.content?.[0]?.text ?? "").slice(0, 110)
      : "OK";
}
const t1 = await call("MERGE (n:Entity {name: '__mt__a'})", "cypher");
console.log("merge alone:", t1);
const t2 = await call("MERGE (n:Entity {name: '__mt__b'}) SET n.ip = '1.2.3.4'", "cypher");
console.log("merge+set prop:", t2);
const t3 = await call("MERGE (n:Entity {name: '__mt__c'}) SET n:Machine", "cypher");
console.log("merge+set label:", t3);
const t4 = await call("MERGE (n:Machine {name: '__mt__d'})", "cypher");
console.log("merge typed:", t4);
const t5 = await call("MERGE (n:Machine {name: '__mt__e'}) SET n.ip = '1.2.3.5'", "cypher");
console.log("merge typed+set:", t5);
const t6 = await call("MATCH (n:Entity) WHERE n.name STARTS WITH '__mt__' DETACH DELETE n", "cypher");
console.log("cleanup:", t6);
