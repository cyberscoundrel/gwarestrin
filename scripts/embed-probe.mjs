/**
 * graph-rag embedding/vector verification (run on the deploy host):
 *   node scripts/embed-probe.mjs [host]   # host = 172.31.99.13 default
 *
 * Exercises: litellm embeddings (384-dim), graph-rag MCP tools
 * (upsert_entities incl. a custom facet, search_graph per facet,
 * temporal_filter, embed_backfill), then cleans up the test entity.
 */
const HOST = process.argv[2] ?? "172.31.99.13";
const MCP = `http://${HOST}:8000/mcp`;
const LITELLM = process.env.LITELLM_URL ?? "http://172.31.99.12:4000/v1";
const KEY = process.env.LITELLM_KEY ?? "";

let fails = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

// 0) litellm embeddings direct
{
  const r = await fetch(`${LITELLM}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ model: "embed-minilm", input: ["sanity check"] }),
  });
  const j = await r.json();
  check("litellm embeddings", r.ok && j.data?.[0]?.embedding?.length === 384, `dim=${j.data?.[0]?.embedding?.length}`);
}

// 1) MCP initialize + tools/list
async function rpc(method, params, id = 1) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await r.text();
  // stateless server may answer as JSON or SSE frame; extract the JSON payload
  const line = text.split("\n").find((l) => l.startsWith("data:")) ?? text;
  return JSON.parse(line.replace(/^data:\s*/, ""));
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } });
const tools = await rpc("tools/list", {}, 2);
const names = tools.result?.tools?.map((t) => t.name) ?? [];
check("tools/list", ["search_graph", "upsert_entities", "embed_backfill"].every((t) => names.includes(t)), names.join(","));

async function callTool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args }, Math.floor(Math.random() * 1e6));
  if (r.error) throw new Error(JSON.stringify(r.error).slice(0, 200));
  return JSON.parse(r.result?.content?.[0]?.text ?? "{}");
}

// 2) upsert with advertised + custom facets
const up = await callTool("upsert_entities", {
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
check("upsert_entities (custom facet)", up.embedded === 4, JSON.stringify(up).slice(0, 120));
await new Promise((r) => setTimeout(r, 1500)); // index population is async

// 3) identity facet search
const s1 = await callTool("search_graph", { query: "test wrench for facet indexing", facets: ["identity"], k: 3 });
check("search identity facet", s1.results?.some((r) => r.name === "__probe__wrench"), JSON.stringify(s1.results?.[0] ?? {}).slice(0, 80));

// 4) custom facet search
const s2 = await callTool("search_graph", { query: "validate the purchasing flow for custom facets", facets: ["procurement"], k: 3 });
check("search custom facet", s2.results?.some((r) => r.name === "__probe__wrench"), JSON.stringify(s2.results?.[0] ?? {}).slice(0, 80));

// 5) temporal filter (inside range)
const s3 = await callTool("search_graph", {
  query: "when did the wrench arrive",
  facets: ["temporal"],
  k: 3,
  temporal_filter: { property: "arrived_at", after: "2026-08-01", before: "2026-08-31" },
});
check("temporal filter hit", s3.results?.some((r) => r.name === "__probe__wrench"), JSON.stringify(s3.results?.[0] ?? {}).slice(0, 80));

// 6) temporal filter (excluded range)
const s4 = await callTool("search_graph", {
  query: "when did the wrench arrive",
  facets: ["temporal"],
  k: 3,
  temporal_filter: { property: "arrived_at", after: "2027-01-01" },
});
check("temporal filter excludes", !s4.results?.some((r) => r.name === "__probe__wrench"), `results=${s4.results?.length ?? 0}`);

// 7) backfill (idempotent here — node already embedded)
const bf = await callTool("embed_backfill", { limit: 10 });
check("embed_backfill runs", typeof bf.backfilled === "number", JSON.stringify(bf).slice(0, 80));

// 8) cleanup via raw cypher through the neo4j-mcp sidecar
{
  const NEO4J_MCP = process.env.NEO4J_MCP ?? "http://172.31.99.11:8000/mcp/";
  const r = await fetch(NEO4J_MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "neo4j_write_neo4j_cypher", arguments: { query: "MATCH (n:Entity {name: '__probe__wrench'}) DETACH DELETE n" } } }),
  });
  const text = await r.text();
  check("cleanup", r.ok, text.slice(0, 60));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
