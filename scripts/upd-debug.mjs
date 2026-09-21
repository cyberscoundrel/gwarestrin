/** temp: UPDATE diagnose + node check */
import { readFileSync } from "node:fs";
const ip = process.argv[2];
const env = readFileSync("/home/cyber/gwarestrin/.env", "utf8");
const pw = env.match(/ARCADEDB_ROOT_PASSWORD=(.*)/)[1].trim();
const key = env.match(/LOCAL_INFERENCE_API_KEY=(.*)/)[1].trim();
const auth = "Basic " + Buffer.from(`root:${pw}`).toString("base64");

const e = await fetch("http://172.31.99.12:4000/v1/embeddings", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: "embed-minilm", input: ["probe"] }),
});
const vec = (await e.json()).data[0].embedding;

async function sql(command, params) {
  const r = await fetch(`http://${ip}:2480/api/v1/command/gwarestrin`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ language: "sql", command, ...(params ? { params } : {}) }),
  });
  const t = await r.text();
  return `${r.status} ${t.slice(0, 260)}`;
}

console.log("node check:", await sql("SELECT name, note FROM Entity WHERE name = '__qtest__'"));
console.log("update full:", await sql(
  "UPDATE PendingWrite SET status = 'approved', executed_at = :now, approved_by = :by WHERE id = :id",
  { now: new Date().toISOString(), by: "admin", id: "5d48b6b4-6d34-4904-9664-462e1e834994" },
));
console.log("update simple:", await sql(
  "UPDATE PendingWrite SET status = 'approved' WHERE id = :id",
  { id: "5d48b6b4-6d34-4904-9664-462e1e834994" },
));
console.log("update literal:", await sql(
  "UPDATE PendingWrite SET status = 'approved' WHERE id = '5d48b6b4-6d34-4904-9664-462e1e834994'",
));
