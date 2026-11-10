#!/usr/bin/env node
// The real-model evaluation's input (docs/build/integrate.md, section 3): the 62 notes as records, plus the
// marker records for the leak gate, and the labels' check.
//
//   node scripts/make-records.mjs generate --out <run-dir> [--seed N]
//        writes <run-dir>/records.json: { seed, records: [{ note, batch, person, document }], markers: [{ word, record, section }] }
//        and prints the label counts. The seed makes the markers; keep it with the run.
//
//   node scripts/make-records.mjs check [--data dump.json]
//        the labels against the oracle's ids and against a dataset (default S0, graph-rag/eval/s0.mjs; or a
//        source dump, scripts/source-dump.mjs, of the sources stream's synthetic database); exit 1 on a problem
//
//   node scripts/make-records.mjs table
//        prints the labels as the Markdown table docs/build/integrate.md carries (generated, so they can't drift)
//
//   node scripts/make-records.mjs seed <run-dir>/records.json --url http://host:8000 --tokens tokens.json
//        [--tool record_document] [--only marker-1,ux-m01] [--dry-run]
//        posts every record, in order, as its person (tokens.json: { user: token } or graph-rag's token map).
//        --url is required and has no default: this never finds an instance on its own, and it is never run
//        against the development instance or the demo. Batches go one at a time: after each batch it waits
//        until the filing log holds an entry for every record so far (--wait-ms, default 30 minutes), unless
//        --no-wait. Run only against a throwaway graph and the synthetic test source.
//        This writes only records to graph-rag. Every source write graph-rag then makes passes the sources
//        stream's guard first (data-entry.js checkGuard: the write connection must name the declared test server,
//        database and login), so nothing here reaches a source unguarded. source-dump.mjs guards its reads.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkLabels, labelCounts, NOTES, STATED_NOTES } from "../graph-rag/eval/labels.mjs";
import { markerRecords, recordsFrom } from "../graph-rag/eval/records.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORACLE = `${ROOT}graph-rag/test/fixtures/oracle-sixty.json`;

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
  console.error("usage: make-records.mjs generate --out dir [--seed N]\n       make-records.mjs check [--data dump.json]\n       make-records.mjs table\n       make-records.mjs seed records.json --url URL --tokens f [--tool name] [--only ids] [--dry-run] [--no-wait]");
  process.exit(2);
};

const args = parseArgs(process.argv.slice(2));
const oracle = JSON.parse(readFileSync(ORACLE, "utf8"));

if (args._[0] === "generate") {
  if (typeof args.out !== "string") usage("--out <run-dir> is required");
  const seed = Number(args.seed ?? Math.floor(Math.random() * 2 ** 31));
  const notes = recordsFrom(oracle);
  const { records: marks, markers } = markerRecords(seed, { avoid: oracle.map((n) => n.text).join(" ") });
  mkdirSync(args.out, { recursive: true });
  const file = `${args.out.replace(/\/$/, "")}/records.json`;
  writeFileSync(file, `${JSON.stringify({ seed, records: [...marks, ...notes], markers }, null, 2)}\n`);
  const c = labelCounts();
  console.log(`wrote ${file}: ${marks.length} marker records, then ${notes.length} notes in ${new Set(notes.map((r) => r.batch)).size} batches (seed ${seed})`);
  console.log(`labels: ${c.pieces} pieces, ${c.filed} Filed, ${c.proposed} Proposed, ${c.held} Held, ${c.kept} Kept; ${c.unheld} accept Kept or Held (item 5); stated changes and states (R12): ${STATED_NOTES.join(", ")}`);
} else if (args._[0] === "check") {
  const opts = {};
  if (typeof args.data === "string") opts.data = JSON.parse(readFileSync(args.data, "utf8"));
  const problems = checkLabels(NOTES, oracle.map((n) => n.id), opts);
  for (const p of problems) console.log(p);
  console.log(problems.length ? `${problems.length} problem(s)` : `labels sound: ${NOTES.length} notes`);
  process.exit(problems.length ? 1 : 0);
} else if (args._[0] === "table") {
  const O = { filed: "**F**", proposed: "**P**", held: "**H**", kept: "**K**" };
  const target = (t) => (t.kind === "row" ? `\`${t.key.replace(/^mssql:dbo_/, "")}\` ${t.columns.join(", ")}` : t.kind === "new-row" ? `new \`${t.table.replace(/^mssql:dbo_/, "")}\` row` : t.kind === "unclear" ? t.why : "doc");
  const short = (k) => String(k).replace(/^mssql:dbo_/, "");
  const rule = (m) => (m.change ? `change ${short(m.change)}` : m.write ? `write to ${short(m.write)}` : m.link ? `link ${short(m.link)}` : `mint "${m.mint}"`);
  const cell = (x) => String(x).replace(/\|/g, "/");
  console.log("| Note | By | Pieces: outcome, where, what | Also accepted | Must not | Resolves |");
  console.log("|---|---|---|---|---|---|");
  for (const n of NOTES) {
    const pieces = n.pieces.map((p) => `${O[p.outcome]} ${p.about}${p.target.kind === "doc" ? "" : ` [${target(p.target)}]`}${p.stated ? ` (R12: ${p.stated})` : ""}`).join("; ");
    const acc = [...new Set(n.pieces.flatMap((p) => p.accept ?? []))].map((o) => O[o]).join(" ") + (n.pieces.some((p) => p.unheld) ? " (item 5)" : "");
    console.log(`| ${n.id.replace(/^ux-/, "")} | ${n.recorder} | ${cell(pieces)} | ${acc.trim()} | ${cell((n.mustNot ?? []).map(rule).join("; "))} | ${cell((n.resolves ?? []).map(short).join(", "))} |`);
  }
} else if (args._[0] === "seed") {
  const file = args._[1];
  if (!file) usage("give the records file");
  if (typeof args.url !== "string" || !/^https?:\/\//.test(args.url)) usage("--url http://host:port is required; there is no default instance");
  if (typeof args.tokens !== "string") usage("--tokens is required");
  const url = args.url.replace(/\/$/, "");
  const raw = JSON.parse(readFileSync(args.tokens, "utf8"));
  const tokenOf = (user) => (Array.isArray(raw.tokens) ? raw.tokens.find((t) => t.user === user)?.token : raw[user]);
  const tool = typeof args.tool === "string" ? args.tool : "record_document";
  const only = typeof args.only === "string" ? new Set(args.only.split(",")) : null;
  const { records } = JSON.parse(readFileSync(file, "utf8"));
  let id = 1;
  const call = async (token, name, a) => {
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: a } }),
    });
    const t = await r.text();
    const line = t.split("\n").find((l) => l.startsWith("data:"));
    const msg = JSON.parse(line ? line.slice(5) : t);
    if (msg.error) return { error: msg.error.message };
    try {
      return JSON.parse(msg.result?.content?.[0]?.text ?? "{}");
    } catch {
      return { text: msg.result?.content?.[0]?.text };
    }
  };
  const adminToken = tokenOf("admin");
  const filedRecords = async () => {
    const r = await call(adminToken, "query_graph", { query: "SELECT DISTINCT(record) AS record FROM FilingEntry", language: "sql" });
    return new Set((r.rows ?? []).map((x) => x.record));
  };
  let lastBatch = null;
  let sent = 0;
  for (const rec of records) {
    if (only && !only.has(rec.note)) continue;
    if (!args["no-wait"] && !args["dry-run"] && lastBatch && rec.batch !== lastBatch) {
      const end = Date.now() + Number(args["wait-ms"] ?? 30 * 60_000);
      process.stdout.write(`waiting for batch ${lastBatch} to file`);
      while (Date.now() < end && (await filedRecords()).size < sent) {
        process.stdout.write(".");
        await new Promise((r) => setTimeout(r, 10_000));
      }
      console.log("");
    }
    lastBatch = rec.batch;
    const token = tokenOf(rec.person);
    if (!token) usage(`no token for ${rec.person} in ${args.tokens}`);
    if (args["dry-run"]) {
      console.log(`would send ${rec.note} as ${rec.person}: ${rec.document.title}`);
      continue;
    }
    const r = await call(token, tool, { document: rec.document });
    sent++;
    console.log(`${r.error ? "FAILED" : "sent"} ${rec.note} as ${rec.person}${r.error ? `: ${r.error}` : ""}`);
  }
}
else usage();
