/** temp: post-approve state inspection */
import { readFileSync } from "node:fs";
const ip = process.argv[2];
const env = readFileSync("/home/cyber/gwarestrin/.env", "utf8");
const pw = env.match(/ARCADEDB_ROOT_PASSWORD=(.*)/)[1].trim();
const auth = "Basic " + Buffer.from(`root:${pw}`).toString("base64");

async function q(sql) {
  const r = await fetch(`http://${ip}:2480/api/v1/query/gwarestrin`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ language: "sql", command: sql }),
  });
  const t = await r.text();
  try {
    return JSON.parse(t).result ?? JSON.parse(t);
  } catch {
    return t.slice(0, 200);
  }
}

console.log("qtest node:", JSON.stringify(await q("SELECT name, note FROM Entity WHERE name = '__qtest__'")));
console.log("qtest2 node:", JSON.stringify(await q("SELECT name FROM Entity WHERE name = '__qtest2__'")));
console.log("pending rows:", JSON.stringify(await q("SELECT id, status, requested_by FROM PendingWrite")));
console.log("entity count:", JSON.stringify(await q("SELECT count(*) AS c FROM Entity")));
