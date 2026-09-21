/**
 * Queued-write verification against graph-rag (run on the deploy host):
 *   node scripts/queue-verify.mjs [graph-rag-ip]
 *
 * Requires the token map to have write: queued for the exercised token.
 * Flow: read check -> write attempt (expect queued) -> approve -> verify
 * node exists -> second write -> reject -> verify absent.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ip =
  process.argv[2] ??
  execSync('docker inspect gwarestrin-graph-rag-1 --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"')
    .toString()
    .trim();

const env = readFileSync("/home/cyber/gwarestrin/.env", "utf8");
const entry = JSON.parse(readFileSync("/home/cyber/gwarestrin/graph-rag-config/token-map.json", "utf8")).tokens[0];

let fails = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

async function call(name, args) {
  const r = await fetch(`http://${ip}:8000/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${entry.token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e6),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const t = await r.text();
  const j = JSON.parse((t.split("\n").find((l) => l.startsWith("data:")) ?? t).replace(/^data:\s*/, ""));
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 150));
  if (j.result?.isError) return { TOOL_ERROR: (j.result?.content?.[0]?.text ?? "").slice(0, 150) };
  return JSON.parse(j.result?.content?.[0]?.text ?? "{}");
}

console.log(`token user: ${entry.user} | write: ${entry.caps?.write ?? "?"}`);

// 1) read works
const schema = await call("schema_graph", {});
check("read (schema_graph)", Array.isArray(schema.types), `${schema.types?.length ?? 0} types`);

// 2) write attempt -> queued
const w1 = await call("execute_graph", {
  command: "INSERT INTO Entity SET name = '__qtest__', note = 'queued write one'",
  language: "cypher",
});
check("write queued (not executed)", w1.queued === true, JSON.stringify(w1).slice(0, 120));
const pid1 = w1.pendingId;

// 3) pending list shows it
const list = await call("list_pending_writes", {});
const entryRow = (list.pending ?? []).find((p) => p.id === pid1);
check("pending list", Boolean(entryRow), `${list.pending?.length ?? 0} pending`);

// 4) approve -> executes (probe the fetch SQL inline first)
const dbg = await call("query_graph", {
  query: "SELECT FROM PendingWrite WHERE id = '" + pid1 + "' AND status = 'pending'",
  language: "sql",
});
console.log("approve-fetch probe:", JSON.stringify(dbg).slice(0, 250));
const ap = await call("approve_write", { id: pid1 });
check("approve executes", ap.approved === true, JSON.stringify(ap).slice(0, 120));

// 5) node exists
const probe = await call("query_graph", {
  query: "SELECT FROM Entity WHERE name = '__qtest__'",
  language: "sql",
});
check("node exists after approval", (probe.rows ?? []).length === 1);

// 6) second write -> reject
const w2 = await call("execute_graph", {
  command: "INSERT INTO Entity SET name = '__qtest2__', note = 'queued write two'",
  language: "cypher",
});
check("second write queued", w2.queued === true);
const pid2 = w2.pendingId;

const rj = await call("reject_write", { id: pid2 });
check("reject works", rj.rejected === true);

// 7) node absent
const probe2 = await call("query_graph", {
  query: "SELECT FROM Entity WHERE name = '__qtest2__'",
  language: "sql",
});
check("rejected node absent", (probe2.rows ?? []).length === 0);

// 8) cleanup approved test node
await call("execute_graph", { command: "DELETE FROM Entity WHERE name = '__qtest__'", language: "cypher" });
console.log("cleanup done");

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
