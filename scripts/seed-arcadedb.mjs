/**
 * Seed the ArcadeDB knowledge graph via the graph-rag MCP sidecar:
 *   node scripts/seed-arcadedb.mjs [graph-rag-host]
 *
 * Executes graph/seed-homelab.cypher statement-by-statement (openCypher).
 * Idempotent-ish: CREATE statements assume an empty database; MERGE-style
 * re-runs are not guaranteed for this seed (clear the db to re-seed).
 */
import { readFileSync } from "node:fs";

const HOST = process.argv[2] ?? "172.31.99.13";
const MCP = `http://${HOST}:8000/mcp`;

async function rpc(method, params, id) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await r.text();
  const line = text.split("\n").find((l) => l.startsWith("data:")) ?? text;
  return JSON.parse(line.replace(/^data:\s*/, ""));
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "seed", version: "0" } }, 0);

const raw = readFileSync(new URL("../graph/seed-homelab.cypher", import.meta.url), "utf8");
const statements = raw
  .split(/;\s*\n/)
  .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n").trim())
  .filter((s) => s.length > 0);

let ok = 0;
for (const [i, stmt] of statements.entries()) {
  // DDL is SQL in ArcadeDB; data manipulation is openCypher
  const language = /^(CREATE|DROP|ALTER)\b/i.test(stmt) ? "sql" : "cypher";
  const r = await rpc("tools/call", { name: "execute_graph", arguments: { command: stmt, language } }, i + 1);
  if (r.error || r.result?.isError) {
    console.error(`FAIL statement ${i + 1}: ${stmt.split("\n")[0].slice(0, 80)}`);
    console.error("  ", (r.error?.message ?? r.result?.content?.[0]?.text ?? "").slice(0, 200));
    process.exit(1);
  }
  ok++;
}
console.log(`seeded: ${ok} statements ok`);
