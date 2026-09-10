/** ArcadeDB graph state snapshot: node/embedding counts + indexes */
import { readFileSync } from "node:fs";

const ip = process.argv[2];
if (!ip) {
  console.error("usage: node scripts/db-state.mjs <arcadedb-ip>");
  process.exit(1);
}
const env = readEnv("/home/cyber/gwarestrin/.env");
const auth = "Basic " + Buffer.from(`root:${env.ARCADEDB_ROOT_PASSWORD}`).toString("base64");

async function q(sql) {
  const r = await fetch(`http://${ip}:2480/api/v1/query/gwarestrin`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ language: "sql", command: sql }),
  });
  const t = await r.text();
  try {
    return JSON.parse(t).result;
  } catch {
    throw new Error(`${r.status} ${t.slice(0, 160)}`);
  }
}

function readEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const count = async (sql) => (await q(sql))[0]?.count ?? (await q(sql))[0]?.COUNT ?? "?";
console.log("entities:", await count("SELECT count(*) FROM Entity"));
console.log("embedded(identity):", await count("SELECT count(*) FROM Entity WHERE embed_identity IS NOT NULL"));
const indexes = await q("SELECT FROM schema:indexes");
console.log("indexes:", indexes.map((i) => i.name).join(", ") || "(none)");
