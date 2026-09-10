/** temp: replicate probe sequence with full temporal-search dump */
const MCP = process.argv[2] ? `http://${process.argv[2]}:8000/mcp` : "http://172.31.99.13:8000/mcp";
async function call(name, args) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name, arguments: args } }),
  });
  const t = await r.text();
  const j = JSON.parse((t.split("\n").find((l) => l.startsWith("data:")) ?? t).replace(/^data:\s*/, ""));
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
  if (j.result?.isError) throw new Error((j.result?.content?.[0]?.text ?? "").slice(0, 200));
  return JSON.parse(j.result?.content?.[0]?.text ?? "{}");
}

const up = await call("upsert_entities", {
  entities: [
    {
      name: "__probe__wrench",
      labels: ["Tool"],
      properties: { location: "probe drawer", arrived_at: "2026-08-20", ordered_at: "2026-08-01" },
      facets: {
        identity: "__probe__wrench: a test wrench used to verify facet indexing",
        location: "the wrench lives in the probe drawer under the bench",
        temporal: "ordered on 2026-08-01 from the probe catalog; arrived 2026-08-20",
        procurement: "procured via the probe purchasing flow to validate custom facets",
      },
    },
  ],
});
console.log("upsert:", JSON.stringify(up));
await new Promise((r) => setTimeout(r, 1500));

const s = await call("search_graph", {
  query: "when did the wrench arrive",
  facets: ["temporal"],
  k: 3,
  temporal_filter: { property: "arrived_at", after: "2026-08-01", before: "2026-08-31" },
});
console.log("temporal search FULL:", JSON.stringify(s).slice(0, 500));

const s2 = await call("search_graph", { query: "test wrench for facet indexing", facets: ["identity"], k: 3 });
console.log("identity results:", s2.results?.length, "wrench:", s2.results?.some((r) => r.name === "__probe__wrench"));

await call("execute_graph", { command: "MATCH (n:Entity {name: '__probe__wrench'}) DETACH DELETE n", language: "cypher" });
console.log("cleaned");
