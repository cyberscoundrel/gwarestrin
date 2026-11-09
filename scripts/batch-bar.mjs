#!/usr/bin/env node
// The clean-batch bar as code: the check every live batch was held to
// (docs/GRAPH-WORKER-RELIABILITY.md, graph-rag/test/fixtures/ORACLE.md), now
// reading claims. Given a conversation batch's expected placements and an
// instance, it reads the batch's documents, sections, CLAIMS edges and
// approved moves and prints one verdict line:
//
//   CLEAN oracle-sixty: 62/62 documents, 100/100 claims; rescues 0, misplaced 0, lost 0, hidden titles 0, wrong content 0
//
// no operator rescue (nobody moved or approved a move of a batch entry), no
// wrong placement (every claim and section seen from where the authority map
// says), no lost text (every section's text stored), no hidden title in a
// lower section (no section names an entry homed above it), and every landed
// claim saying what the batch says it should (subject, kind, class, attribute,
// value, dates, recorder, its section). Findings are
// listed before the verdict; exit 0 when clean, 1 when not, 2 on usage.
//
//   node scripts/batch-bar.mjs <batch.json> --url http://host:8000 (--token T | --tokens tokens.json [--as admin])
//
// --url is required and has no default: this never finds an instance on its
// own. The token needs the raw capability (query_graph in SQL): the admin's.
import { readFileSync } from "node:fs";
import { bar, collectRows, verdictLine } from "../graph-rag/e2e/conversations.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
      else out[a.slice(2)] = argv[++i];
    } else out._.push(a);
  }
  return out;
}
const usage = (msg) => {
  if (msg) console.error(msg);
  console.error("usage: batch-bar.mjs <batch.json> --url URL (--token T | --tokens f [--as user])");
  process.exit(2);
};

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
if (!file) usage("give the batch file");
if (typeof args.url !== "string" || !/^https?:\/\//.test(args.url)) usage("--url http://host:port is required; there is no default instance");
let token = typeof args.token === "string" ? args.token : null;
if (!token && typeof args.tokens === "string") {
  const raw = JSON.parse(readFileSync(args.tokens, "utf8"));
  const who = typeof args.as === "string" ? args.as : "admin";
  token = Array.isArray(raw.tokens) ? raw.tokens.find((t) => t.user === who)?.token : raw[who];
  if (!token) usage(`no token for ${who} in ${args.tokens}`);
}
if (!token) usage("--token or --tokens is required");
const url = args.url.replace(/\/$/, "");
const batch = JSON.parse(readFileSync(file, "utf8"));

let id = 1;
async function query(sql) {
  const r = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "query_graph", arguments: { query: sql, language: "sql" } } }),
  });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  const msg = JSON.parse(line ? line.slice(5) : t);
  if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
  const text = msg.result?.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.rows ?? [];
}

// the tree the instance runs, so "above" is judged against it, not the batch's
const positions = await (await fetch(`${url}/api/positions`, { headers: { authorization: `Bearer ${token}` } })).json();
const treeDoc = positions?.tree?.length
  ? { root: positions.root, positions: Object.fromEntries(positions.tree.map((p) => [p.id, { name: p.name, ...(p.parent ? { parent: p.parent } : {}) }])) }
  : batch.tree;

const rows = await collectRows(batch, query);
const result = bar(batch, rows, treeDoc);
for (const [check, list] of Object.entries(result.findings)) for (const f of list) console.log(`${check.toUpperCase().padEnd(9)} ${f}`);
console.log(verdictLine(batch, result));
process.exit(result.ok ? 0 : 1);
