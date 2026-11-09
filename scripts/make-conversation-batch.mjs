#!/usr/bin/env node
// Conversation batches from the sixty-note oracle (docs/ORGANIZATION-MODEL.md,
// "Batches: on-record conversations that get condensed"): the generator, and
// the seeder that posts a batch to an instance the way ~/ux-live's scripts
// post notes (one MCP call per person, with that person's token).
//
//   node scripts/make-conversation-batch.mjs generate [--oracle graph-rag/test/fixtures/oracle-sixty.json]
//        [--out graph-rag/test/fixtures/conversations/oracle-sixty.batch.json] [--recorded-at ISO] [--check]
//        writes the batch (shape: graph-rag/test/fixtures/conversations/README.md) and prints its counts;
//        --check only compares the file on disk with what the oracle generates (exit 1 when stale)
//
//   node scripts/make-conversation-batch.mjs seed <batch.json> --url http://host:8000 --tokens tokens.json
//        [--tool ingest_document | <the Condenser stream's tool>] [--only conv-ux-m01,conv-ux-al04] [--dry-run]
//        posts every conversation's condensed document as its person. --url is required and has no
//        default: this never finds an instance on its own, and it is not run against the development
//        instance without the user saying so. tokens.json is the graph-rag token map ({ tokens: [{ token,
//        user }] }) or a plain { user: token } map; every conversation's person needs a token in it.
//        With ingest_document (today's API) the document's sections go in as the text, no claims; with
//        the Condenser stream's tool the expected document itself is the call's arguments.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkBatch, generateBatch } from "../graph-rag/e2e/conversations.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_ORACLE = `${ROOT}graph-rag/test/fixtures/oracle-sixty.json`;
const DEFAULT_OUT = `${ROOT}graph-rag/test/fixtures/conversations/oracle-sixty.batch.json`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

const usage = (msg) => {
  if (msg) console.error(msg);
  console.error("usage: make-conversation-batch.mjs generate [--oracle f] [--out f] [--recorded-at ISO] [--check]\n       make-conversation-batch.mjs seed <batch.json> --url URL --tokens f [--tool name] [--only ids] [--dry-run]");
  process.exit(2);
};

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (cmd === "generate") {
  const oraclePath = args.oracle ?? DEFAULT_ORACLE;
  const outPath = args.out ?? DEFAULT_OUT;
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8"));
  const opts = { source: oraclePath.split("/").pop() };
  if (typeof args["recorded-at"] === "string") opts.recordedAt = args["recorded-at"];
  const batch = generateBatch(oracle, opts);
  const problems = checkBatch(batch);
  if (problems.length) {
    console.error(`the generated batch has ${problems.length} problem(s):\n${problems.slice(0, 20).join("\n")}`);
    process.exit(1);
  }
  const text = `${JSON.stringify(batch, null, 2)}\n`;
  if (args.check) {
    const onDisk = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
    if (onDisk === text) console.log(`up to date: ${outPath}`);
    else {
      console.error(`stale: ${outPath} differs from what the oracle generates (run generate)`);
      process.exit(1);
    }
  } else {
    writeFileSync(outPath, text);
    console.log(`wrote ${outPath}`);
  }
  const c = batch.counts;
  console.log(`${c.conversations} conversations, ${c.turns} turns, ${c.sections} sections, ${c.claims} claims (from ${oracle.length} oracle notes)`);
} else if (cmd === "seed") {
  const file = args._[1];
  if (!file) usage("seed: give the batch file");
  if (typeof args.url !== "string" || !/^https?:\/\//.test(args.url)) usage("seed: --url http://host:port is required; there is no default instance");
  if (typeof args.tokens !== "string") usage("seed: --tokens <file> is required (the token map, or { user: token })");
  const url = args.url.replace(/\/$/, "");
  const batch = JSON.parse(readFileSync(file, "utf8"));
  const problems = checkBatch(batch);
  if (problems.length) {
    console.error(`${file}: ${problems.length} problem(s), not seeding:\n${problems.slice(0, 20).join("\n")}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(args.tokens, "utf8"));
  const tokens = Array.isArray(raw.tokens) ? Object.fromEntries(raw.tokens.map((t) => [t.user, t.token])) : raw;
  const only = typeof args.only === "string" ? new Set(args.only.split(",").map((s) => s.trim())) : null;
  const toolName = typeof args.tool === "string" ? args.tool : "ingest_document";
  const list = batch.conversations.filter((c) => !only || only.has(c.id) || only.has(c.note));
  const missing = [...new Set(list.map((c) => c.person))].filter((u) => !tokens[u]);
  if (missing.length) usage(`seed: no token for ${missing.join(", ")} in ${args.tokens}`);
  let id = 1;
  async function call(who, name, params) {
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: params } }),
    });
    const t = await r.text();
    const line = t.split("\n").find((l) => l.startsWith("data:"));
    const msg = JSON.parse(line ? line.slice(5) : t);
    const text = msg.result?.content?.[0]?.text ?? msg.error?.message ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return { error: text || `${r.status}` };
    }
  }
  const argumentsFor = (c) => {
    const d = c.expected.document;
    if (toolName === "ingest_document") {
      // today's API: the condensed text, no claims (the Condenser stream's tool takes the document itself)
      const text = d.sections.map((s) => `${s.heading ? `${s.heading}\n\n` : ""}${s.text}`).join("\n\n");
      return { title: d.title, description: d.description, text, extract: false };
    }
    return { ...d, conversation: c.turns };
  };
  console.log(`seeding ${list.length} conversation(s) from ${batch.batch} to ${url} with ${toolName}${args["dry-run"] ? " (dry run)" : ""}`);
  let failed = 0;
  for (const c of list) {
    const params = argumentsFor(c);
    if (args["dry-run"]) {
      console.log(`WOULD POST ${c.person} ${toolName} ${JSON.stringify(params).slice(0, 160)}`);
      continue;
    }
    const r = await call(c.person, toolName, params);
    const ok = !r.error;
    if (!ok) failed++;
    console.log(`SEED ${c.id} ${c.person} ${ok ? JSON.stringify(r).slice(0, 120) : `FAILED ${String(r.error).slice(0, 160)}`}`);
  }
  console.log(failed ? `${failed} of ${list.length} failed` : `all ${list.length} posted`);
  process.exit(failed ? 1 : 0);
} else usage();
