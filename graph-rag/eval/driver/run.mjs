#!/usr/bin/env node
// One filing run, end to end, against one graph-rag and the synthetic test database (docs/build/integrate.md):
// discovery, the class map, the records seeded, every record filed by the orchestrator and its workers, the source
// dumped before and after, and the report. It plays the workspace's part (packages/server graph-pool.ts): it claims
// threads from graph-rag, gives each agent the brief graph-rag composed and the real instruction texts, and runs its
// turns over graph-rag's tools and the connection's read tools. graph-rag decides everything it decides in production.
//
//   node graph-rag/eval/driver/run.mjs --graph URL --tokens tokens.json --dab-read URL --dab-write URL --run-dir DIR
//        --models fake | --models real --setup A   [--run 1] [--seed N] [--concurrency 4] [--timeout-min 240]
//
// --models real reads the setup's model names from the environment and reaches them through the evaluation's litellm
// or directly (EVAL_VIA, below; eval/run.sh sets this up, and nothing here prints a key). Proposal B's plan (the assistant's, approved with the doc):
// at least two setups, three runs each; this runs one.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mcpSession, runAgent, toolsFrom } from "./agent.mjs";
import { fakeClient, openaiClient } from "./models.mjs";
import { signAgentToken } from "../../src/delegation.js";
import { MAP } from "../s0.mjs";
import { classMapFrom } from "../classmap.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
const need = (k) => {
  if (typeof args[k] !== "string") {
    console.error(`--${k} is required (see the header)`);
    process.exit(2);
  }
  return args[k];
};
const GRAPH = need("graph").replace(/\/$/, "");
const RUN_DIR = need("run-dir").replace(/\/$/, "");
const DAB_READ = need("dab-read");
const DAB_WRITE = need("dab-write");
const MODE = need("models");
const SETUP = MODE === "real" ? need("setup") : "fake";
const RUN = Number(args.run ?? 1);
const CONCURRENCY = Number(args.concurrency ?? 8);
const DEADLINE = Date.now() + Number(args["timeout-min"] ?? 240) * 60_000;
const CONNECTION = "mssql";
mkdirSync(RUN_DIR, { recursive: true });

const tokenMap = JSON.parse(readFileSync(need("tokens"), "utf8"));
const adminEntry = tokenMap.tokens.find((t) => t.user === "admin");
const tokenOf = (user) => tokenMap.tokens.find((t) => t.user === user)?.token;
const ADMIN = tokenOf("admin");
const sign = (claims) => signAgentToken(adminEntry.delegationKey, { u: "admin", a: randomUUID(), p: adminEntry.positions, iat: Math.floor(Date.now() / 1000), ...claims });

const logFile = `${RUN_DIR}/driver.log`;
// every key this process holds (a direct endpoint's, the run's own litellm key) is taken out of a line before it's
// written; the OpenRouter key isn't in this process at all through litellm, and run.sh's files are scanned after
const SECRETS = Object.entries(process.env).filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k) && String(v ?? "").length >= 12).map(([, v]) => String(v));
const scrub = (line) => SECRETS.reduce((s, k) => s.split(k).join("[key removed]"), line);
const log = (event) => appendFileSync(logFile, `${scrub(JSON.stringify({ at: new Date().toISOString(), ...event }))}\n`);
const say = (s) => {
  console.log(s);
  log({ say: s });
};

// ---- the models: what each role runs on ----
// EVAL_VIA says how agents reach their models: "litellm" (the evaluation's own litellm in the run's compose project,
// with the committed model configuration; run.sh gives EVAL_LITELLM_URL and the run's own EVAL_LITELLM_KEY), or
// "direct" (any OpenAI-compatible endpoint: EVAL_AGENT_BASE_URL and EVAL_AGENT_API_KEY from the user's env file).
// The setup's model names are EVAL_SETUP_<setup>_ORCHESTRATOR and _WORKER: litellm aliases, or the endpoint's ids.
// --models fake with no EVAL_VIA: the fake policies in this process (the dry run).
const VIA = process.env.EVAL_VIA || (MODE === "fake" ? "none" : "direct");
const modelOf = (role) => process.env[`EVAL_SETUP_${SETUP}_${role === "worker" || role === "part" ? "WORKER" : "ORCHESTRATOR"}`];
function clientFor(role) {
  if (VIA === "none") return fakeClient(role === "part" ? "worker" : role);
  const env = process.env;
  const model = modelOf(role);
  if (!model) throw new Error(`the env file names no model for setup ${SETUP}'s ${role === "worker" || role === "part" ? "worker" : "orchestrator"} (EVAL_SETUP_${SETUP}_...)`);
  if (VIA === "litellm") return openaiClient({ baseUrl: env.EVAL_LITELLM_URL, apiKey: env.EVAL_LITELLM_KEY, model });
  return openaiClient({ baseUrl: env.EVAL_AGENT_BASE_URL || "https://openrouter.ai/api/v1", apiKey: env.EVAL_AGENT_API_KEY, model });
}
/** through litellm, refuse early when a setup names a model the committed configuration doesn't define */
async function checkLitellmModels() {
  if (VIA !== "litellm") return;
  const r = await fetch(`${String(process.env.EVAL_LITELLM_URL).replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${process.env.EVAL_LITELLM_KEY}` } });
  if (!r.ok) throw new Error(`litellm's model list: ${r.status}`);
  const defined = new Set(((await r.json()).data ?? []).map((m) => m.id));
  for (const role of ["orchestrator", "worker"]) {
    const m = modelOf(role);
    if (!defined.has(m)) throw new Error(`setup ${SETUP}'s ${role} model "${m}" is not in the committed litellm configuration (it defines: ${[...defined].join(", ")})`);
  }
}
/** each thread's conversation by job: a resumed thread goes on with the agent it had, as the workspace's does */
const conversations = new Map();

const usage = {};
const addUsage = (role, u) => {
  const x = (usage[role] ??= { input: 0, output: 0, calls: 0, agents: 0, sentChars: 0, outChars: 0, dsml: 0, providers: {} });
  x.input += u.input;
  x.output += u.output;
  x.calls += u.calls;
  x.sentChars += u.sentChars ?? 0;
  x.outChars += u.outChars ?? 0;
  x.dsml += u.dsml ?? 0;
  for (const [k, n] of Object.entries(u.providers ?? {})) x.providers[k] = (x.providers[k] ?? 0) + n;
  x.agents++;
  // as it stands, for the runaway guard watching each setup's spend while the run goes
  writeFileSync(`${RUN_DIR}/usage-live.json`, JSON.stringify({ setup: SETUP, run: RUN, at: new Date().toISOString(), usage }));
};

// ---- the instruction texts, as the workspace builds them (packages/server graph-roles.ts) ----
const { WORKER_INSTRUCTIONS } = await import(`${REPO}packages/server/src/agents/instructions/worker.ts`);
const { MASTER_INSTRUCTIONS } = await import(`${REPO}packages/server/src/agents/instructions/master.ts`);
function instructions(role) {
  const src = ["Your sources", ""];
  src.push(role === "worker" ? "- The knowledge graph (graph-rag): as the people who see your sections see it, and nothing above it." : "- The knowledge graph (graph-rag): the whole organization's, in full.");
  src.push(`- ${CONNECTION} (read-only): the synthetic test ERP (jobs, operations, work centers, equipment, employees, customers, vendors, material, orders, purchases, maintenance)`);
  src.push("  Look up what you need directly, with a filter. Never read a whole table.");
  return [src.join("\n"), role === "worker" ? WORKER_INSTRUCTIONS : MASTER_INSTRUCTIONS].join("\n\n");
}

// ---- HTTP to graph-rag, as the workspace's own token ----
async function api(path, init = {}) {
  const r = await fetch(`${GRAPH}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: r.status, body };
}
const admin = mcpSession(`${GRAPH}/mcp`, ADMIN);
const sql = async (query) => JSON.parse((await admin.call("query_graph", { query, language: "sql" })).text || "{}").rows ?? [];
const dabRead = mcpSession(DAB_READ);
const READ_TOOLS = ["describe_entities", "read_records"];

async function agent(role, token, prompt, extra = {}) {
  const tools = await toolsFrom([
    { prefix: "graph-rag", session: mcpSession(`${GRAPH}/mcp`, token) },
    { prefix: CONNECTION, session: dabRead, only: READ_TOOLS },
  ]);
  const client = clientFor(role);
  const id = extra.job ?? role;
  // sizes, for the cost estimate: what every request of this agent carries before its own history
  const system = instructions(role === "orchestrator" || role === "discovery" ? "master" : "worker");
  log({ agent: role, id, model: client.model, tools: tools.length, toolChars: JSON.stringify(tools.map((t) => ({ n: t.name, d: t.description, s: t.schema }))).length, systemChars: system.length, promptChars: String(prompt).length });
  const r = await runAgent({ client, system, prompt, tools, history: extra.history ?? null, maxTurns: extra.maxTurns ?? 40, log: (e) => log({ agent: role, id, ...e }) });
  addUsage(role, r.usage);
  // its last words too: why a record went unfiled is often only in what the worker answered
  log({ agent: role, id, ended: r.stopped ?? "answered", turns: r.turns, calls: r.calls, finish: r.finish ?? null, text: String(r.text ?? "").slice(0, 600) });
  return r;
}

// ---- the class map (I-2, I-32) ----
// M0 by each class's source table: the record_table the model set; else (harness only, the coordinator's call after
// round 1) the one table its evidence names, when that table exists in the source. Nothing is written on the class:
// a model leaving record_table empty stays visible, and class-map.json says which way each class was mapped.
const SOURCE_TABLES = () => {
  try {
    return new Set(Object.keys(JSON.parse(readFileSync(`${RUN_DIR}/before.json`, "utf8"))).map((t) => `${CONNECTION}:${t}`.toLowerCase()));
  } catch {
    return new Set();
  }
};
let classMapKeys = "";
let classMapAt = 0;
async function applyClassMap(reason) {
  const rows = await sql("SELECT _class_key, _class_name, _record_table, _evidence FROM Entity WHERE _kind = 'class'");
  const { classes, ...out } = classMapFrom(rows, SOURCE_TABLES(), MAP);
  const keys = Object.keys(classes).sort().join(",");
  if (keys !== classMapKeys) {
    const pol = await api("/api/policy");
    const put = await api("/api/policy", { method: "PUT", body: { authorityMap: { ...(pol.body?.policy?.authorityMap ?? {}), classes } } });
    if (put.status !== 200) throw new Error(`the class map wasn't set: ${put.status} ${JSON.stringify(put.body).slice(0, 300)}`);
    classMapKeys = keys;
    log({ class_map: reason, by_record_table: out.by_record_table.length, by_evidence: out.by_evidence.length, unmapped_with_table: out.unmapped_with_table.length, record_table_not_in_map: out.record_table_not_in_map.length, no_table: out.no_table.length });
  }
  writeFileSync(`${RUN_DIR}/class-map.json`, `${JSON.stringify({ at: new Date().toISOString(), total: rows.length, ...out }, null, 2)}\n`);
  return { total: rows.length, mapped: Object.keys(classes).length, by_record_table: out.by_record_table.length, by_evidence: out.by_evidence.length };
}

// ---- the steps ----
const node = (script, argv) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [`${REPO}${script}`, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });

async function until(label, fn, ms = 300_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out: ${label}`);
}

const simpleTokens = `${RUN_DIR}/tokens.simple.json`;
writeFileSync(simpleTokens, JSON.stringify(Object.fromEntries(tokenMap.tokens.map((t) => [t.user, t.token]))));
const dumpArgs = ["--read-url", DAB_READ, "--identity-url", DAB_WRITE, "--expect-server", "gwsynth-sql", "--expect-database", "GwSynthMfg"];

say(`run ${SETUP}/${RUN}: ${MODE} models${VIA === "none" ? "" : ` via ${VIA} (orchestrator ${modelOf("orchestrator")}, worker ${modelOf("worker")})`}, graph-rag ${GRAPH}`);
await checkLitellmModels();
await until("graph-rag up", async () => (await api("/api/worker")).status === 200);

// 1. the records, and the source before anything happens
const gen = await node("scripts/make-records.mjs", ["generate", "--out", RUN_DIR, ...(args.seed ? ["--seed", String(args.seed)] : [])]);
if (gen.code) throw new Error(`records: ${gen.out}`);
const before = await node("scripts/source-dump.mjs", [...dumpArgs, "--out", `${RUN_DIR}/before.json`]);
if (before.code) throw new Error(`the before dump refused or failed: ${before.out}`);
say(before.out.trim().split("\n").at(-1));

// 2. discovery: the orchestrator with read tools only (a token carrying the run), plus any parts it starts, which
//    are claimed like any thread: the pool gets room first, with the orchestrator's batches still off
const poolBase = { ...((await api("/api/worker")).body?.pool ?? {}), poolSize: Math.max(CONCURRENCY, 1), batchSize: 10, batchMinutes: 1, dailyThreads: 2000, threadMinutes: 30, maxHandlers: 50 };
const sized = await api("/api/worker", { method: "PUT", body: { enabled: true, pool: { ...poolBase, master: false } } });
if (sized.status !== 200) throw new Error(`the pool wasn't sized: ${sized.status} ${JSON.stringify(sized.body).slice(0, 300)}`);
const disc = await api("/api/classes/discovery", { method: "POST", body: { connections: [{ name: CONNECTION, digest: null }], focus: "" } });
if (disc.status !== 200) throw new Error(`discovery didn't start: ${disc.status} ${JSON.stringify(disc.body).slice(0, 300)}`);
say(`discovery run ${disc.body.run}`);
let discoveryFinished = false;
const discoveryDone = agent("discovery", sign({ r: "master", d: disc.body.run }), disc.body.brief, { maxTurns: 80 });
const discoveryParts = poolLoop({ stopWhen: async () => discoveryFinished && (await idle()), quietPolls: 2 });
const d = await discoveryDone;
discoveryFinished = true;
await discoveryParts;
say(`discovery: ${d.stopped ?? "answered"} after ${d.turns} turns`);

// 3. the class map: M0, from each class's source table (the test configuration; NEEDS A RULING I-2), applied again
//    whenever classes appear during the run (applyClassMap, above)
const cm = await applyClassMap("after discovery");
say(`class map: ${cm.mapped} of ${cm.total} classes mapped (${cm.by_record_table} by the record_table the model set, ${cm.by_evidence} by their one table in evidence)`);

// 4. the orchestrator on, then the records seeded (batch by batch) while the pool files them
const set = await api("/api/worker", { method: "PUT", body: { enabled: true, pool: { ...poolBase, master: true } } });
if (set.status !== 200) throw new Error(`the pool wasn't set: ${set.status} ${JSON.stringify(set.body).slice(0, 300)}`);
let seeding = true;
const seeded = node("scripts/make-records.mjs", ["seed", `${RUN_DIR}/records.json`, "--url", GRAPH, "--tokens", simpleTokens, ...(process.env.EVAL_HARNESS_SOURCE ? ["--harness"] : [])]).then((r) => {
  seeding = false;
  writeFileSync(`${RUN_DIR}/seed.log`, r.out);
  return r;
});
await poolLoop({ stopWhen: async () => !seeding && (await idle()), quietPolls: 3 });
const seedResult = await seeded;
if (seedResult.code) say(`the seeder ended with ${seedResult.code}: ${seedResult.out.trim().split("\n").at(-1)}`);

// 5. the source after, and the report
const after = await node("scripts/source-dump.mjs", [...dumpArgs, "--out", `${RUN_DIR}/after.json`]);
if (after.code) throw new Error(`the after dump refused or failed: ${after.out}`);
// which worker filed which record: each review job's record and home (job_key file:<record>:<home>) and how it ended,
// so a record left unfiled can be traced to its workers' last answers in driver.log
// (every filing job: the first per record and home, re-filings and R15's fresh workers), with when it last changed
// and the requests it still waits on at the end
const jobs = await sql("SELECT id, job_key, status, updated_at FROM Job WHERE kind = 'review' AND (job_key LIKE 'file:%' OR job_key LIKE 'refile:%' OR job_key LIKE 'kickback:%')").catch(() => []);
const openReqs = await sql("SELECT worker, id, kind, at FROM WorkerRequest WHERE status = 'open'").catch(() => []);
const endedAt = new Date().toISOString();
writeFileSync(
  `${RUN_DIR}/jobs.json`,
  `${JSON.stringify(
    jobs.map((j) => ({ job: j.id, kind: String(j.job_key).split(":")[0], record: String(j.job_key).split(":")[1], home: String(j.job_key).split(":")[2], status: j.status, updated_at: j.updated_at ?? null, open_requests: openReqs.filter((r) => r.worker === j.id).map((r) => ({ id: r.id, kind: r.kind, at: r.at })), ended_at: endedAt })),
    null,
    2,
  )}\n`,
);
writeFileSync(`${RUN_DIR}/usage.json`,`${JSON.stringify({ setup: SETUP, run: RUN, models: MODE, via: VIA, ...(VIA === "none" ? {} : { orchestrator: modelOf("orchestrator"), worker: modelOf("worker") }), usage }, null, 2)}\n`);
const rep = await node("scripts/filing-report.mjs", ["run", "--url", GRAPH, "--tokens", simpleTokens, "--run-dir", RUN_DIR, "--setup", SETUP, "--run", String(RUN)]);
say(rep.out.trim());
process.exit(rep.code ?? 1);

// ---- the pool: signals to the orchestrator, threads to workers, as graph-pool.ts does ----
async function idle() {
  const jobs = await sql("SELECT count(*) AS n FROM Job WHERE kind IN ['review', 'intake'] AND status IN ['pending', 'running']");
  const signals = await sql("SELECT count(*) AS n FROM Signal WHERE status = 'new'");
  return Number(jobs[0]?.n ?? 0) === 0 && Number(signals[0]?.n ?? 0) === 0;
}

async function poolLoop({ stopWhen, quietPolls }) {
  const running = new Set();
  let quiet = 0;
  // the orchestrator's turn runs beside the workers, as the workspace's master does (graph-pool.ts masterTurn): its
  // workers are claimed and run while it works, and it is asked for signals again only once its turn has ended
  let orchestrating = null;
  while (Date.now() < DEADLINE) {
    let signals = [];
    if (!orchestrating) {
      const sig = await api("/api/worker/signals");
      signals = sig.body?.signals ?? [];
      if (sig.body?.kept_by_graph_rag?.length) log({ r15_floor: sig.body.kept_by_graph_rag });
      if (signals.length) {
        quiet = 0;
        // acked as the turn starts, as the workspace acks once the prompt is in
        await api("/api/worker/signals/ack", { method: "POST", body: { ids: signals.map((s) => s.id) } });
        orchestrating = agent("orchestrator", sign({ r: "master" }), sig.body.message, { job: `signals:${signals.length}` })
          .catch((e) => log({ orchestrator: "failed", error: String(e?.message ?? e).slice(0, 300) }))
          .finally(() => (orchestrating = null));
      }
    }
    // workers: as many threads as there is room for
    const room = CONCURRENCY - running.size;
    if (room > 0) {
      const claimed = (await api("/api/worker/threads/claim", { method: "POST", body: { limit: room } })).body?.threads ?? [];
      for (const t of claimed) {
        quiet = 0;
        const p = (async () => {
          const token = sign({ r: "worker", j: t.job, e: t.entry });
          const agentId = randomUUID();
          await api(`/api/worker/threads/${t.job}/agent`, { method: "POST", body: { agent_id: agentId } });
          const r = await agent("worker", token, t.message, { job: t.job, history: conversations.get(t.job) ?? null });
          conversations.set(t.job, r.messages);
          await api(`/api/worker/threads/${t.job}/finish`, { method: "POST", body: r.stopped ? { status: "failed", summary: r.stopped } : { status: "done", summary: String(r.text || "done").slice(0, 2000) } });
        })().catch((e) => log({ thread: t.job, error: String(e?.message ?? e).slice(0, 300) }));
        running.add(p);
        p.finally(() => running.delete(p));
      }
    }
    // classes made during the run get their authority too (the same rule, both setups)
    if (Date.now() - classMapAt > 20_000) {
      classMapAt = Date.now();
      await applyClassMap("during the run").catch((e) => log({ class_map_error: String(e?.message ?? e).slice(0, 200) }));
    }
    if (!orchestrating && !signals.length && !running.size && (await stopWhen())) {
      if (++quiet >= quietPolls) break;
    }
    await new Promise((r) => setTimeout(r, running.size ? 2000 : 5000));
  }
  await Promise.allSettled([...running, ...(orchestrating ? [orchestrating] : [])]);
  if (Date.now() >= DEADLINE) say("the run's deadline passed: what was filed by then is reported");
}
