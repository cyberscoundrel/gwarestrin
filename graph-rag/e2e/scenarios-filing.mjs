// The filing stream's scenarios (docs/build/filing.md): a worker files a record piece by piece over its real MCP
// tools against a fake DAB (fake-dab-core.mjs: DAB 2.0.12's answers), and every outcome lands in the filing log
// outside the graph (R2, R9). The worker here is scripted: it says what it would write, and graph-rag decides the
// outcome from the row, the class map and the recorder's standing (R11). Nothing here tells the code its answer.
//
// Each scenario makes its own record (a document and its sections, on record) and the Job its worker runs as,
// with names prefixed e2e-filing. The class map entries are merged into the organization's and restored after.
import { createServer } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import { dabTool } from "./fake-dab-core.mjs";

const PREFIX = "e2e-filing";
const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const fake = { tables: {}, calls: [], url: null, server: null };

function runnerAddress() {
  for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  return hostname();
}

async function startFakeDab() {
  if (fake.url) return fake.url;
  fake.server = createServer(async (req, res) => {
    let s = "";
    for await (const c of req) s += c;
    const body = s ? JSON.parse(s) : {};
    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fake-dab-filing" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    };
    if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-dab" } });
    if (body.method !== "tools/call") return reply({});
    const { name, arguments: args } = body.params ?? {};
    fake.calls.push({ url: req.url, name, args });
    const write = req.url.includes("/write");
    // the write side's identity view: the guard asks it which server and database the write connection holds
    reply(dabTool(write ? { ...fake.tables, dbo_GwConnectionIdentity: { primaryKey: ["id"], rows: [{ id: 1, server_name: "gwsynth-sql", database_name: "GwSynthMfg", login_name: "gwsynth_write" }] } } : fake.tables, name, args, { write }));
  });
  await new Promise((r) => fake.server.listen(4291, "0.0.0.0", r));
  fake.server.unref();
  fake.url = `http://${runnerAddress()}:4291`;
  return fake.url;
}

const CLASSES = [
  // seen on the floor, the floor holds the authority: bob's pieces are Filed
  { key: "e2e_filing_jobs", home: "floor", table: "mssql:dbo_FJob", authority: "floor" },
  // seen on the floor, Operations holds the authority: bob's pieces are Proposed
  { key: "e2e_filing_deliveries", home: "floor", table: "mssql:dbo_FJob", authority: "ops" },
  // lasting individuals no source holds: what a Kept piece links to
  { key: "e2e_filing_equipment", home: "floor", table: null, authority: "floor", rowsAreNodes: true },
];

async function upsertPolicyRow(ctx, scope, json) {
  const have = await ctx.sql(`SELECT scope FROM OrgPolicy WHERE scope = '${scope}'`);
  const r = await ctx.tool("admin", "execute_graph", { language: "sql", command: have.length ? `UPDATE OrgPolicy SET json = '${q(json)}' WHERE scope = '${scope}'` : `INSERT INTO OrgPolicy SET scope = '${scope}', json = '${q(json)}', updated_by = 'e2e', updated_at = '${new Date().toISOString()}'` });
  ctx.check(!r.error, `${scope} stored: ${JSON.stringify(r).slice(0, 200)}`);
}

/** the fake source, the sources row, and the classes (each scenario resets the rows) */
async function setup(ctx) {
  const url = await startFakeDab();
  // a table's cursor needs a second row: DAB pages by primary key, and this is how the key is learned
  fake.tables = { dbo_FJob: { primaryKey: ["Job"], rows: [{ Job: 4471, Status: null, Quantity: 500 }, { Job: 4472, Status: "open", Quantity: 20 }] } };
  fake.calls = [];
  // the declaration (model/sources.js): read at the floor's home, written to dbo_FJob behind the guard
  await upsertPolicyRow(ctx, "sources", JSON.stringify([{ system: "mssql", read: { via: "dab-mcp", url: `${url}/read/mcp`, home: "floor" }, commit: { via: "dab-mcp", url: `${url}/write/mcp`, tables: ["dbo_FJob"], guard: { server: "gwsynth-sql", database: "GwSynthMfg" } } }]));
  for (const c of CLASSES) {
    const have = await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE _kind = 'class' AND _class_key = '${c.key}'`);
    if (have.length) continue;
    const r = await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = '${c.key}', _kind = 'class', _class_key = '${c.key}', _class_name = '${c.key}', _home = '${c.home}', _origin = '${c.home}', _record_table = ${c.table ? `'${c.table}'` : "null"}, _rows_are_nodes = ${c.rowsAreNodes === true}, _status = 'active'` });
    ctx.check(!r.error, `class ${c.key} made: ${JSON.stringify(r).slice(0, 200)}`);
  }
}

/** run with the e2e classes in the organization's class map, restoring it after */
async function withMap(ctx, fn) {
  const before = (await ctx.api("/api/policy")).policy?.authorityMap ?? { classes: {}, attributes: {} };
  const classes = { ...(before.classes ?? {}) };
  for (const c of CLASSES) classes[c.key] = { authority: c.authority };
  const put = await ctx.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: { ...before, classes } }) });
  ctx.check(!put.error, `the class map takes the e2e classes: ${JSON.stringify(put).slice(0, 200)}`);
  try {
    return await fn();
  } finally {
    await ctx.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: before }) });
  }
}

/** a record on record by bob at the floor: a document and its sections; and the filing job its worker runs as */
async function record(ctx, tag, texts) {
  const doc = `${PREFIX}-${tag}-${ctx.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  let r = await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = '${doc} title', _kind = 'document', _doc_id = '${doc}', _home = 'floor', _origin = 'floor', _on_record = true, _recorded_by = 'bob', _record_position = 'floor', _record_reason = 'e2e', updated_at = '${now}'` });
  ctx.check(!r.error, `document made: ${JSON.stringify(r).slice(0, 200)}`);
  const sections = [];
  for (const [i, text] of texts.entries()) {
    r = await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = '${doc} §${i + 1}', _kind = 'section', _doc_id = '${doc}', _section = ${i}, _home = 'floor', _origin = 'floor', _written_by = 'bob', text_identity = '${q(text)}', updated_at = '${now}'` });
    ctx.check(!r.error, `section made: ${JSON.stringify(r).slice(0, 200)}`);
    sections.push(String((await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE name = '${doc} §${i + 1}' AND _kind = 'section'`))[0].rid));
  }
  const job = ctx.randomUUID();
  const payload = JSON.stringify({ rid: sections[0], sections, record: doc, home: "floor", parent: "master", label: `${PREFIX} ${tag}` });
  r = await ctx.tool("admin", "execute_graph", { language: "sql", command: `INSERT INTO Job SET id = '${job}', kind = 'review', job_key = 'file:${doc}:floor', payload = '${q(payload)}', status = 'running', attempts = 0, priority = 0, created_at = '${now}', updated_at = '${now}'` });
  ctx.check(!r.error, `job made: ${JSON.stringify(r).slice(0, 200)}`);
  return { doc, sections, job, worker: ctx.workerToken(sections[0], job) };
}

const log = (ctx, doc) => ctx.sql(`SELECT id, outcome, target, pending_id, question, request, refiled_from, account, verdict, recorder FROM FilingEntry WHERE record = '${doc}' ORDER BY at ASC`);
const writes = () => fake.calls.filter((c) => c.name === "update_record");
const orchestrator = (ctx) => ctx.delegated({ r: "master" });

export default [
  {
    name: "a worker files a piece its recorder has authority for: the source row is written and the log names it, Filed",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const rec = await record(ctx, "filed", ["Job 4471 is complete."]);
        const r = await ctx.tool(rec.worker, "file_to_source", { section: rec.sections[0], piece: "job 4471 is complete", said: "writing it: " + "job 4471 is complete", class: "e2e_filing_jobs", key: "mssql:dbo_FJob:4471", fields: { Status: "complete" } });
        ctx.check(r.outcome === "filed", `Filed: ${JSON.stringify(r).slice(0, 300)}`);
        ctx.check(fake.tables.dbo_FJob.rows[0].Status === "complete", "the row holds it");
        ctx.check(writes().length === 1 && writes()[0].url.includes("/write"), "one write, through the write endpoint");
        const [e] = await log(ctx, rec.doc);
        ctx.check(e?.outcome === "filed" && JSON.parse(e.target).key === "mssql:dbo_FJob:4471" && e.recorder === "bob", `the entry: ${JSON.stringify(e).slice(0, 300)}`);
      });
    },
  },
  {
    name: "a piece whose class's authority lies above the recorder is Proposed, nothing written; a person with authority approves it and it becomes Filed",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const rec = await record(ctx, "proposed", ["Job 4471 ships Friday."]);
        const r = await ctx.tool(rec.worker, "file_to_source", { section: rec.sections[0], piece: "job 4471 ships Friday", said: "writing it: " + "job 4471 ships Friday", class: "e2e_filing_deliveries", key: "mssql:dbo_FJob:4471", fields: { Status: "shipping" } });
        ctx.check(r.outcome === "proposed", `Proposed: ${JSON.stringify(r).slice(0, 300)}`);
        ctx.check(writes().length === 0 && fake.tables.dbo_FJob.rows[0].Status === null, "nothing written");
        const [e] = await log(ctx, rec.doc);
        ctx.check(e?.pending_id, `the entry names its proposal: ${JSON.stringify(e).slice(0, 300)}`);
        const pw = (await ctx.sql(`SELECT kind, job_id, status FROM PendingWrite WHERE id = '${e.pending_id}'`))[0];
        ctx.check(pw?.kind === "data_entry" && !pw.job_id, `a person's proposal, no thread waiting on it: ${JSON.stringify(pw)}`);
        // the admin, at the root, holds the authority over Operations' class and approves it themselves
        const ok = await ctx.api(`/api/queue/${e.pending_id}/approve`, { method: "POST", body: "{}" });
        ctx.check(!ok.error, `approved: ${JSON.stringify(ok).slice(0, 300)}`);
        ctx.check(fake.tables.dbo_FJob.rows[0].Status === "shipping", "the approval wrote it");
        // the worker loop settles it: a Filed entry pointing back, the Proposed one kept (F2, F6)
        await ctx.until("the approved piece is Filed in the log", async () => (await log(ctx, rec.doc)).some((x) => x.outcome === "filed" && x.refiled_from === e.id), 150000);
        ctx.check((await log(ctx, rec.doc)).some((x) => x.id === e.id && x.outcome === "proposed"), "the Proposed entry stays");
      });
    },
  },
  {
    name: "R12: a record describing a state the source disagrees with is Held, asking the recorder, never overwritten; a stated change is written",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const rec = await record(ctx, "held", ["Job 4472 is complete."]);
        const r = await ctx.tool(rec.worker, "file_to_source", { section: rec.sections[0], piece: "job 4472 is complete", said: "writing Status complete to job 4472", class: "e2e_filing_jobs", key: "mssql:dbo_FJob:4472", fields: { Status: "complete" } });
        ctx.check(r.outcome === "held" && !r.request, `Held, no request: ${JSON.stringify(r).slice(0, 300)}`);
        ctx.check(fake.tables.dbo_FJob.rows[1].Status === "open" && writes().length === 0, "never overwritten");
        const q1 = (await ctx.sql(`SELECT asked_of, status FROM WorkerQuestion WHERE job_id = '${rec.job}'`))[0];
        ctx.check(q1?.asked_of === "bob" && q1.status === "open", `asked of whoever put it on record: ${JSON.stringify(q1)}`);
        // the record says it changed: an update, written given the recorder's authority (R12)
        const changed = await ctx.tool(rec.worker, "file_to_source", { section: rec.sections[0], piece: "job 4472 was finished today", said: "updated job 4472 from open to complete", class: "e2e_filing_jobs", key: "mssql:dbo_FJob:4472", fields: { Status: "complete" }, says_change: true });
        ctx.check(changed.outcome === "filed" && fake.tables.dbo_FJob.rows[1].Status === "complete", `a stated change is written: ${JSON.stringify(changed).slice(0, 300)}`);
        // the admin's question list doesn't carry it: it's the recorder's (R2)
        const listed = await ctx.api("/api/worker/questions");
        ctx.check(!JSON.stringify(listed).includes(rec.job), "not among the admin's questions");
      });
    },
  },
  {
    name: "Kept, the account and the orchestrator's check: every entry needs an account, and the check reads the source itself (R10, R11)",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const rec = await record(ctx, "account", ["Job 4471 is complete. The forklift is booked Thursday."]);
        const f = await ctx.tool(rec.worker, "file_to_source", { section: rec.sections[0], piece: "job 4471 is complete", said: "writing it: " + "job 4471 is complete", class: "e2e_filing_jobs", key: "mssql:dbo_FJob:4471", fields: { Status: "complete" } });
        const fork = await ctx.tool(rec.worker, "create_instance", { section: rec.sections[0], name: "e2e-filing forklift 2", class: "e2e_filing_equipment" });
        ctx.check(fork.instance, `the forklift is an instance: ${JSON.stringify(fork).slice(0, 300)}`);
        const k = await ctx.tool(rec.worker, "keep_piece", { section: rec.sections[0], piece: "the forklift is booked Thursday", instances: [fork.instance] });
        ctx.check(f.outcome === "filed" && k.outcome === "kept", `filed and kept: ${JSON.stringify([f, k]).slice(0, 300)}`);
        const half = await ctx.tool(rec.worker, "give_account", { pieces: [] });
        ctx.check(half.missing?.length === 1 && half.missing[0] === k.entry, `the Filed piece came with its account, the Kept one still needs one: ${JSON.stringify(half)}`);
        const all = await ctx.tool(rec.worker, "give_account", { pieces: [{ entry: k.entry, said: "kept the forklift booking: no system holds it" }] });
        ctx.check(all.missing?.length === 0, `accounted: ${JSON.stringify(all)}`);
        // someone changes the row after: the check against the source sees it
        fake.tables.dbo_FJob.rows[0].Status = "reopened";
        const ev = await ctx.tool(orchestrator(ctx), "check_account", { job: rec.job });
        const fe = ev.entries?.find((x) => x.entry === f.entry);
        ctx.check(fe?.suggested?.result === "differs" && fe.source_now?.Status === "reopened", `the source itself, read now: ${JSON.stringify(ev).slice(0, 400)}`);
        const v = await ctx.tool(orchestrator(ctx), "record_verdict", { entry: f.entry, result: "differs", note: "the row was reopened" });
        ctx.check(v.verdict?.result === "differs", `the verdict: ${JSON.stringify(v)}`);
        const kept = await ctx.tool(orchestrator(ctx), "kept_pieces", {});
        ctx.check(Array.isArray(kept.kept) && !kept.kept.some((p) => p.entry === k.entry), `no class or source table since it was Kept, so it isn't offered (R14): ${JSON.stringify(kept).slice(0, 300)}`);
      });
    },
  },
  {
    name: "R14: a Kept piece is re-filed only after a new class or source table, and at most 3 times",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const rec = await record(ctx, "r14", ["The forklift is booked Thursday."]);
        const fork = await ctx.tool(rec.worker, "create_instance", { section: rec.sections[0], name: "e2e-filing r14 forklift", class: "e2e_filing_equipment" });
        const keep = async (refiles) => (await ctx.tool(rec.worker, "keep_piece", { section: rec.sections[0], piece: "the forklift is booked Thursday", instances: [fork.instance], ...(refiles ? { refiles } : {}) })).entry;
        const offered = async () => (await ctx.tool(orchestrator(ctx), "kept_pieces", {})).kept?.map((p) => p.entry) ?? [];
        const refile = (entry) => ctx.tool(orchestrator(ctx), "refile", { entries: [entry] });
        const tag = ctx.randomUUID().slice(0, 8);
        const newClass = async (i) => {
          const c = await ctx.tool(orchestrator(ctx), "create_class", { name: `e2e filing r14 ${tag} ${i}`, parents: ["resource"], evidence: [{ kind: "table", ref: "mssql:dbo_FJob" }] });
          ctx.check(!c.error, `class ${i} made: ${JSON.stringify(c).slice(0, 200)}`);
        };
        let prev = await keep();
        ctx.check(Boolean(prev), "Kept");
        ctx.check(!(await offered()).includes(prev), "nothing new since it was Kept: not offered");
        const early = await refile(prev);
        ctx.check(early.refused?.[0]?.entry === prev && /no class was created/.test(early.refused[0].reason) && !early.started?.length, `refile refuses it, with the reason: ${JSON.stringify(early).slice(0, 300)}`);
        for (let i = 1; i <= 3; i++) {
          await newClass(i);
          ctx.check((await offered()).includes(prev), `a class made since: offered (re-filing ${i})`);
          const r = await refile(prev);
          ctx.check(!r.error && !r.refused, `re-filing ${i} goes ahead: ${JSON.stringify(r).slice(0, 300)}`);
          const next = await keep(prev);
          ctx.check(Boolean(next) && next !== prev, `the re-filing's worker Keeps it again (${i})`);
          const now = await offered();
          ctx.check(!now.includes(prev) && !now.includes(next), `re-filed with no class since: neither the old entry nor the new one is offered (${i})`);
          prev = next;
        }
        await newClass(4);
        ctx.check(!(await offered()).includes(prev), "re-filed 3 times: never offered again, even after a new class");
        const late = await refile(prev);
        ctx.check(late.refused?.[0]?.entry === prev && /re-filed 3 times already/.test(late.refused[0].reason), `refile refuses a fourth: ${JSON.stringify(late).slice(0, 300)}`);
        const chain = (await log(ctx, rec.doc)).filter((e) => e.outcome === "kept");
        ctx.check(chain.length === 4 && chain.filter((e) => e.refiled_from).length === 3, `one piece, Kept once and re-filed three times: ${chain.length} Kept entries`);
      });
    },
  },
  {
    name: "R15: a worker that ends without filing: graph-rag sends the section back; a fresh worker files it, or, left open, it is Kept",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const requestsOf = (doc) => ctx.sql(`SELECT id, section, status, raised_by, worker, question, answer FROM WorkerRequest WHERE record = '${doc}'`);
        const signalFor = async (request) => ((await ctx.api("/api/worker/signals")).signals ?? []).find((x) => x.kind === "request" && x.data?.request === request);
        // (a) the worker answers with nothing filed (its empty account given): graph-rag sends the section back
        const a = await record(ctx, "r15a", ["Job 4471 is complete."]);
        const acc = await ctx.tool(a.worker, "give_account", { pieces: [], summary: "nothing filed" });
        ctx.check(!acc.error, `an empty account: ${JSON.stringify(acc).slice(0, 200)}`);
        const fin = await ctx.api(`/api/worker/threads/${a.job}/finish`, { method: "POST", body: JSON.stringify({ status: "done", summary: "I read the jobs table and couldn't tell which job it was." }) });
        ctx.check(fin.status === "done", `the worker ended: ${JSON.stringify(fin)}`);
        const [ra] = await requestsOf(a.doc);
        ctx.check(ra?.raised_by === "graph-rag" && ra.section === a.sections[0] && ra.worker === a.job && ra.status === "open", `graph-rag raised a request for the section: ${JSON.stringify(ra).slice(0, 300)}`);
        ctx.check(/Job 4471 is complete/.test(ra.question) && /couldn't tell which job/.test(ra.question), "it carries the section's text and the worker's last reply");
        const sa = await signalFor(ra.id);
        ctx.check(sa?.data?.raised_by === "graph-rag", "the orchestrator hears of it with its signals");
        const none = await ctx.tool(orchestrator(ctx), "start_worker", { record: a.doc, section: a.sections[0] + "0" });
        ctx.check(none.error && /no open kick-back/.test(none.error), `no fresh worker for a section that wasn't sent back: ${JSON.stringify(none).slice(0, 200)}`);
        const fresh = await ctx.tool(orchestrator(ctx), "start_worker", { record: a.doc, section: a.sections[0] });
        const job = fresh.started?.[0]?.job;
        ctx.check(job && fresh.started[0].kickback === ra.id, `a fresh worker for just that section: ${JSON.stringify(fresh).slice(0, 300)}`);
        await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Job SET status = 'running' WHERE id = '${job}'` });
        const again = await ctx.tool(orchestrator(ctx), "start_worker", { record: a.doc, section: a.sections[0] });
        ctx.check(again.error && /no open kick-back/.test(again.error), "one fresh worker per kick-back");
        const filed = await ctx.tool(ctx.workerToken(a.sections[0], job), "file_to_source", { section: a.sections[0], piece: "job 4471 is complete", said: "writing it: job 4471 is complete", class: "e2e_filing_jobs", key: "mssql:dbo_FJob:4471", fields: { Status: "complete" } });
        ctx.check(filed.outcome === "filed", `the fresh worker files it: ${JSON.stringify(filed).slice(0, 300)}`);
        const acka = await ctx.api("/api/worker/signals/ack", { method: "POST", body: JSON.stringify({ ids: [sa.id] }) });
        ctx.check(!acka.kept_by_graph_rag, "settled by the fresh worker: nothing for the floor");
        const la = await log(ctx, a.doc);
        ctx.check(la.length === 1 && la[0].outcome === "filed", `one entry, the fresh worker's: ${JSON.stringify(la).slice(0, 300)}`);
        // (b) the orchestrator closes a worker that filed nothing and leaves the kick-back: at its turn's end it is Kept
        const b = await record(ctx, "r15b", ["The forklift is booked Thursday for the Toro move."]);
        const fork = await ctx.tool(b.worker, "create_instance", { section: b.sections[0], name: "e2e-filing r15 forklift", class: "e2e_filing_equipment" });
        ctx.check(fork.instance, `the worker related an instance: ${JSON.stringify(fork).slice(0, 200)}`);
        const closed = await ctx.tool(orchestrator(ctx), "close_worker", { job: b.job, summary: "it read for a long time and filed nothing" });
        ctx.check(closed.sent_back?.length === 1, `closing it sends the section back: ${JSON.stringify(closed).slice(0, 300)}`);
        const [rb] = await requestsOf(b.doc);
        const sb = await signalFor(rb.id);
        const ackb = await ctx.api("/api/worker/signals/ack", { method: "POST", body: JSON.stringify({ ids: [sb.id] }) });
        ctx.check(ackb.kept_by_graph_rag?.[0]?.request === rb.id, `left open past the turn: Kept by graph-rag: ${JSON.stringify(ackb).slice(0, 300)}`);
        const lb = await log(ctx, b.doc);
        ctx.check(lb.length === 1 && lb[0].outcome === "kept" && !lb[0].target, `one Kept entry, no source: ${JSON.stringify(lb).slice(0, 300)}`);
        const kept = (await ctx.sql(`SELECT piece, reason, instances, home FROM FilingEntry WHERE id = '${lb[0].id}'`))[0];
        ctx.check(kept.reason === "worker ended without filing" && kept.piece === "The forklift is booked Thursday for the Toro move." && kept.home === "floor", `the whole section at its home, marked: ${JSON.stringify(kept).slice(0, 300)}`);
        ctx.check(JSON.stringify(kept.instances).includes(fork.instance), "with the instance the worker related");
        ctx.check((await requestsOf(b.doc))[0].status === "answered", "the request is settled");
        ctx.check(!fake.calls.some((c) => c.name === "update_record" && JSON.stringify(c.args).includes("forklift")), "no source written for it");
      });
    },
  },
  {
    name: "the filing log is outside the graph: no graph read returns an entry, and the worker can't file another record's section (R7, R9)",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const rec = await record(ctx, "outside", ["The zebra-filing-marker crate arrived."]);
        const crate = await ctx.tool(rec.worker, "create_instance", { section: rec.sections[0], name: "e2e-filing crate", class: "e2e_filing_equipment" });
        const none = await ctx.tool(rec.worker, "keep_piece", { section: rec.sections[0], piece: "the zebra-filing-marker crate arrived", instances: [] });
        ctx.check(none.error, "a Kept piece is linked to instances (R2)");
        await ctx.tool(rec.worker, "keep_piece", { section: rec.sections[0], piece: "the zebra-filing-marker crate arrived", instances: [crate.instance] });
        ctx.check((await log(ctx, rec.doc)).length === 1, "the entry is in the log");
        const found = await ctx.tool("admin", "search_graph", { query: "zebra-filing-marker crate" });
        ctx.check(!JSON.stringify(found).includes("FilingEntry") && !JSON.stringify(found).includes('"outcome"'), `no search returns a log entry: ${JSON.stringify(found).slice(0, 300)}`);
        const edges = await ctx.sql("SELECT count(*) AS n FROM FilingEntry WHERE @type = 'FilingEntry'");
        ctx.check(Number(edges[0]?.n ?? 0) >= 1, "a document type of its own");
        const other = await record(ctx, "other", ["Another record."]);
        const refused = await ctx.tool(rec.worker, "keep_piece", { section: other.sections[0], piece: "not mine", instances: [crate.instance] });
        ctx.check(refused.error && /no section/.test(refused.error), `another record's section is refused: ${JSON.stringify(refused)}`);
        const noClass = await ctx.tool(rec.worker, "file_to_source", { section: rec.sections[0], piece: "a pallet", said: "writing it: " + "a pallet", class: "e2e_filing_no_such_class", key: "mssql:dbo_FJob:4471", fields: { Status: "x" } });
        ctx.check(noClass.error && /request one/.test(noClass.error), `no class: request one, never make one (R5): ${JSON.stringify(noClass)}`);
      });
    },
  },
];
