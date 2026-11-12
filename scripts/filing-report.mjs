#!/usr/bin/env node
// One run's report, or several runs compared (docs/build/integrate.md, section 2).
//
//   node scripts/filing-report.mjs run --url http://host:8000 (--token T | --tokens f) --run-dir <dir>
//        [--setup "orchestrator X, worker Y"] [--run 1] [--checks checks.json]
//        reads <dir>/records.json (make-records.mjs), <dir>/before.json and <dir>/after.json (source-dump.mjs),
//        and the instance's filing log and graph; writes <dir>/report.md, report.json, tree.md and
//        snapshot.json. Exit 1 when a gate fails (a row changed without a Filed entry; a marker leaked, was
//        stored below its recorder's position or never stored; no brief to scan), 0 otherwise: nothing else has a
//        pass mark. The two gates and their zero tolerance are proposal B's (the assistant's proposal, which the
//        user read and approved with docs/ORGANIZATION-MODEL.md), not a ruling of their own.
//
//   node scripts/filing-report.mjs rescore <dir> [--only ids] [--out dir] [--labels r12|r16|r19]   the report again from snapshot.json
//
//   node scripts/filing-report.mjs compare <dir> <dir> ...   writes compare.md next to the first dir's parent
//
// --url is required and has no default: this never finds an instance on its own. The token needs the raw
// capability (query_graph in SQL): the admin's.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { collectGraph } from "../graph-rag/eval/collect.mjs";
import { buildReport, compareRuns } from "../graph-rag/eval/report.mjs";
import { POSITIONS } from "../graph-rag/eval/s0.mjs";
import { parseLog, toolCallCounts } from "../graph-rag/eval/toolcalls.mjs";

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
  console.error("usage: filing-report.mjs run --url URL (--token T | --tokens f) --run-dir dir [--setup s] [--run n] [--checks f]\n       filing-report.mjs compare dir dir ...");
  process.exit(2);
};
const read = (f) => JSON.parse(readFileSync(f, "utf8"));
/** the run's tool calls with their errors split three ways (I-43), from its driver.log when there is one */
const toolCallsOf = (dir) => (existsSync(`${dir}/driver.log`) ? { toolCalls: toolCallCounts(parseLog(readFileSync(`${dir}/driver.log`, "utf8"))) } : {});
const args = parseArgs(process.argv.slice(2));

if (args._[0] === "run") {
  if (typeof args.url !== "string" || !/^https?:\/\//.test(args.url)) usage("--url http://host:port is required; there is no default instance");
  if (typeof args["run-dir"] !== "string") usage("--run-dir is required");
  let token = typeof args.token === "string" ? args.token : null;
  if (!token && typeof args.tokens === "string") {
    const raw = read(args.tokens);
    token = Array.isArray(raw.tokens) ? raw.tokens.find((t) => t.user === "admin")?.token : raw.admin;
  }
  if (!token) usage("--token or --tokens (with an admin token) is required");
  const dir = args["run-dir"].replace(/\/$/, "");
  const url = args.url.replace(/\/$/, "");
  let id = 1;
  const query = async (sql) => {
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "query_graph", arguments: { query: sql, language: "sql" } } }),
    });
    const t = await r.text();
    const line = t.split("\n").find((l) => l.startsWith("data:"));
    const msg = JSON.parse(line ? line.slice(5) : t);
    if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
    const parsed = JSON.parse(msg.result?.content?.[0]?.text ?? "{}");
    if (parsed.error) throw new Error(parsed.error);
    return parsed.rows ?? [];
  };
  const run = read(`${dir}/records.json`);
  const graph = await collectGraph(query, { records: run.records });
  const markers = run.markers.map((m) => ({ ...m, recordId: graph.recordIds[m.record] ?? null }));
  const snap = {
    meta: { setup: typeof args.setup === "string" ? args.setup : "setup", run: Number(args.run ?? 1), seed: run.seed, ...(run.only ? { only: run.only } : {}), labels: typeof args.labels === "string" ? args.labels : "r19", noteOf: graph.noteOf, markers },
    positions: POSITIONS,
    before: read(`${dir}/before.json`),
    after: read(`${dir}/after.json`),
    ...graph,
    checks: typeof args.checks === "string" ? read(args.checks) : null,
    ...toolCallsOf(dir),
  };
  const report = buildReport(snap);
  writeFileSync(`${dir}/snapshot.json`, `${JSON.stringify(snap, null, 2)}\n`);
  writeFileSync(`${dir}/report.md`, report.markdown);
  writeFileSync(`${dir}/tree.md`, report.tree);
  const { markdown: _m, tree: _t, ...rest } = report;
  writeFileSync(`${dir}/report.json`, `${JSON.stringify(rest, null, 2)}\n`);
  const t = report.outcomes.totals;
  console.log(`${report.gates.ok ? "GATES PASS" : "GATES FAIL"}: rows ${report.gates.rows ? "pass" : "FAIL"}, leaks ${report.gates.leaks ? "pass" : "FAIL"}; pieces ${t.pieces}: ${t.exact} exact, ${t.accepted} accepted, ${t.wrong} wrong, ${t.missing} missing; ${report.changes.length} rows changed`);
  console.log(`wrote ${dir}/report.md, tree.md, report.json, snapshot.json`);
  process.exit(report.gates.ok ? 0 : 1);
} else if (args._[0] === "rescore") {
  // a finished run's report again, from its snapshot (the graph is gone): the old report kept as report.v1.*.
  // --only ids scores just those notes (a full run on a subset run's notes); --out dir writes there instead and
  // leaves the run's own files as they are
  const dir = args._[1];
  if (!dir) usage("give the run dir");
  const snap = { ...read(`${dir}/snapshot.json`), ...toolCallsOf(dir) };
  if (typeof args.only === "string") snap.meta = { ...snap.meta, only: args.only.split(",").map((s) => s.trim()).filter(Boolean) };
  // --labels r12|r16|r19 (I-47, I-53): a run is scored by the labels it was made under unless asked otherwise
  if (typeof args.labels === "string") snap.meta = { ...snap.meta, labels: args.labels };
  const to = typeof args.out === "string" ? args.out.replace(/\/$/, "") : dir;
  if (to === dir) {
    for (const f of ["report.md", "report.json", "tree.md"]) if (existsSync(`${dir}/${f}`) && !existsSync(`${dir}/${f.replace("report", "report.v1").replace("tree", "tree.v1")}`)) copyFileSync(`${dir}/${f}`, `${dir}/${f.replace("report", "report.v1").replace("tree", "tree.v1")}`);
  } else mkdirSync(to, { recursive: true });
  const report = buildReport(snap);
  writeFileSync(`${to}/report.md`, report.markdown);
  writeFileSync(`${to}/tree.md`, report.tree);
  const { markdown: _m, tree: _t, ...rest } = report;
  writeFileSync(`${to}/report.json`, `${JSON.stringify(rest, null, 2)}\n`);
  const t = report.outcomes.totals;
  console.log(`${dir}: ${report.gates.ok ? "GATES PASS" : "GATES FAIL"}; pieces ${t.pieces}: ${t.exact} exact, ${t.accepted} accepted, ${t.wrong} wrong, ${t.missing} missing; must-not ${report.outcomes.mustNot.length}`);
} else if (args._[0] === "compare") {
  const dirs = args._.slice(1);
  if (!dirs.length) usage("give the run dirs");
  const runs = dirs.map((d) => ({ report: read(`${d}/report.json`), classes: read(`${d}/snapshot.json`).classes }));
  const out = `${dirname(dirs[0].replace(/\/$/, ""))}/compare.md`;
  writeFileSync(out, compareRuns(runs).markdown);
  console.log(`wrote ${out}`);
} else usage();
