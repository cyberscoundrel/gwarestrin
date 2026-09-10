/** temp: direct vector_search diagnosis against ArcadeDB */
import { readFileSync } from "node:fs";

const ip = process.argv[2];
if (!ip) {
  console.error("usage: node scripts/vec-debug.mjs <arcadedb-ip>");
  process.exit(1);
}
const env = readFileSync("/home/cyber/gwarestrin/.env", "utf8");
const pw = env.match(/ARCADEDB_ROOT_PASSWORD=(.*)/)[1].trim();
const key = env.match(/LOCAL_INFERENCE_API_KEY=(.*)/)[1].trim();
const auth = "Basic " + Buffer.from(`root:${pw}`).toString("base64");
async function adbQuery(sql) {
  const r = await fetch(`http://${ip}:2480/api/v1/query/gwarestrin`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ language: "sql", command: sql }),
  });
  const t = await r.text();
  try {
    return JSON.parse(t).result ?? [];
  } catch {
    throw new Error(t.slice(0, 160));
  }
}

const e = await fetch("http://172.31.99.12:4000/v1/embeddings", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: "embed-minilm", input: ["test wrench for facet indexing"] }),
});
const body = await e.text();
let vec;
try {
  vec = JSON.parse(body).data[0].embedding;
} catch {
  console.log("litellm raw:", body.slice(0, 200));
  process.exit(1);
}
console.log("dims:", vec.length);

const r = await fetch(`http://${ip}:2480/api/v1/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: auth },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "vector_search",
      arguments: { database: "gwarestrin", indexName: "Entity[embed_identity]", queryVector: vec, k: 3 },
    },
  }),
});
const t = await r.text();
const j = JSON.parse((t.split("\n").find((l) => l.startsWith("data:")) ?? t).replace(/^data:\s*/, ""));
console.log("vector_search:", (j.result?.content?.[0]?.text ?? JSON.stringify(j)).slice(0, 400));

// rebuild the facet index (crash lost the unbuilt HNSW graph)
const rb = await fetch(`http://${ip}:2480/api/v1/command/gwarestrin`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: auth },
  body: JSON.stringify({ language: "sql", command: "REBUILD INDEX `Entity[embed_identity]`" }),
});
console.log("rebuild:", (await rb.text()).slice(0, 150));
await new Promise((r) => setTimeout(r, 1500));
const idx = await adbQuery("SELECT FROM schema:indexes");
const embedIdx = idx.filter((i) => String(i.name ?? "").includes("embed"));
console.log(
  "embed indexes:",
  JSON.stringify(embedIdx.map((i) => ({ name: i.name, def: i.definition ?? i.indexDefinition ?? null })).map((x) => ({ name: x.name }))[0] ?? "(none)"),
);
console.log("total indexes:", idx.length);

// vector.neighbors SQL form
const qn = await fetch(`http://${ip}:2480/api/v1/query/gwarestrin`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: auth },
  body: JSON.stringify({
    language: "sql",
    command: "SELECT name, distance FROM (SELECT expand(vector.neighbors('Entity[embed_identity]', :vec, 3)))",
    params: { vec },
  }),
});
console.log("neighbors SQL:", (await qn.text()).slice(0, 300));

// index stats
const q = await fetch(`http://${ip}:2480/api/v1/query/gwarestrin`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: auth },
  body: JSON.stringify({
    language: "sql",
    command: "SELECT FROM (SELECT expand(stats) FROM schema:indexes WHERE name = 'Entity[embed_identity]')",
  }),
});
const qt = await q.text();
try {
  const jq = JSON.parse(qt);
  console.log("index stats:", JSON.stringify(jq.result?.[0] ?? jq).slice(0, 400));
} catch {
  console.log("stats raw:", qt.slice(0, 200));
}
