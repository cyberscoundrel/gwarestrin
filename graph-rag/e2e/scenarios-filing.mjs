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
  // R19: a table that takes new rows; the floor adds them, and a class whose authority is Operations' proposes them
  { key: "e2e_filing_maint", home: "floor", table: "mssql:dbo_FMaint", authority: "floor" },
  { key: "e2e_filing_maint_ops", home: "floor", table: "mssql:dbo_FMaint", authority: "ops" },
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
  fake.tables = {
    dbo_FJob: { primaryKey: ["Job"], rows: [{ Job: 4471, Status: null, Quantity: 500 }, { Job: 4472, Status: "open", Quantity: 20 }] },
    // R19: its key made by the source, deletable only to undo an added row
    dbo_FMaint: { primaryKey: ["Maint"], identity: true, deletes: true, rows: [{ Maint: 1, Work_Center: "CNC 2", Opened: "2026-10-27", Description: "Warm-up runs long", Status: "Open" }, { Maint: 2, Work_Center: null, Opened: "2026-09-14", Description: "Annual inspection", Status: "Closed" }] },
  };
  fake.calls = [];
  // the declaration (model/sources.js): read at the floor's home, written to dbo_FJob behind the guard, and new rows to dbo_FMaint
  await upsertPolicyRow(ctx, "sources", JSON.stringify([{ system: "mssql", read: { via: "dab-mcp", url: `${url}/read/mcp`, home: "floor" }, commit: { via: "dab-mcp", url: `${url}/write/mcp`, tables: ["dbo_FJob", { name: "dbo_FMaint", adds: true, columns: { Status: { values: ["Open", "Closed"] } }, required: ["Opened", "Description", "Status"] }], actions: ["create", "update", "delete"], guard: { server: "gwsynth-sql", database: "GwSynthMfg" } } }]));
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
async function record(ctx, tag, texts, { home = "floor", by = "bob" } = {}) {
  const doc = `${PREFIX}-${tag}-${ctx.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  let r = await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = '${doc} title', _kind = 'document', _doc_id = '${doc}', _home = '${home}', _origin = '${home}', _on_record = true, _recorded_by = '${by}', _record_position = '${home}', _record_reason = 'e2e', updated_at = '${now}'` });
  ctx.check(!r.error, `document made: ${JSON.stringify(r).slice(0, 200)}`);
  const sections = [];
  for (const [i, text] of texts.entries()) {
    r = await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = '${doc} §${i + 1}', _kind = 'section', _doc_id = '${doc}', _section = ${i}, _home = '${home}', _origin = '${home}', _written_by = '${by}', text_identity = '${q(text)}', updated_at = '${now}'` });
    ctx.check(!r.error, `section made: ${JSON.stringify(r).slice(0, 200)}`);
    sections.push(String((await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE name = '${doc} §${i + 1}' AND _kind = 'section'`))[0].rid));
  }
  const job = ctx.randomUUID();
  const payload = JSON.stringify({ rid: sections[0], sections, record: doc, home, parent: "master", label: `${PREFIX} ${tag}` });
  r = await ctx.tool("admin", "execute_graph", { language: "sql", command: `INSERT INTO Job SET id = '${job}', kind = 'review', job_key = 'file:${doc}:${home}', payload = '${q(payload)}', status = 'running', attempts = 0, priority = 0, created_at = '${now}', updated_at = '${now}'` });
  ctx.check(!r.error, `job made: ${JSON.stringify(r).slice(0, 200)}`);
  return { doc, sections, job, worker: ctx.workerToken(sections[0], job) };
}

const log = (ctx, doc) => ctx.sql(`SELECT id, outcome, target, pending_id, question, request, refiled_from, account, verdict, recorder FROM FilingEntry WHERE record = '${doc}' ORDER BY at ASC`);
const writes = () => fake.calls.filter((c) => c.name === "update_record");
const orchestrator = (ctx) => ctx.delegated({ r: "master" });

/** tools/list for a token: each tool's input schema by name */
async function toolSchemas(ctx, token) {
  const r = await fetch(`${ctx.GRAPH}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  return new Map((JSON.parse(line ? line.slice(5) : t).result?.tools ?? []).map((x) => [x.name, x.inputSchema ?? {}]));
}

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
    name: "R16: a write lands when the record names the row and gives the value, whatever the row held; a value not in the record is Held, asking the recorder, nothing overwritten; it can be undone",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        // the row holds "open": no state-versus-change test, and the worker has nothing to assert about it
        const rec = await record(ctx, "r16", ["Job 4472 is complete."]);
        const r = await ctx.tool(rec.worker, "file_to_source", { section: rec.sections[0], piece: "job 4472 is complete", said: "writing Status complete to job 4472", class: "e2e_filing_jobs", key: "mssql:dbo_FJob:4472", fields: { Status: "complete" } });
        ctx.check(r.outcome === "filed" && fake.tables.dbo_FJob.rows[1].Status === "complete", `named row, value in the record: Filed: ${JSON.stringify(r).slice(0, 300)}`);
        const entry = (await ctx.sql(`SELECT reason FROM FilingEntry WHERE id = '${r.entry}'`))[0];
        ctx.check(entry?.reason === 'before: {"Status":"open"}', `logged with the value it replaced: ${JSON.stringify(entry?.reason)}`);
        // a value the record doesn't give: Held, the recorder asked which condition failed, nothing overwritten
        const other = await record(ctx, "r16-held", ["Job 4471 is finished."]);
        const finished = { section: other.sections[0], piece: "job 4471 is finished", said: "writing Status complete to job 4471", class: "e2e_filing_jobs", key: "mssql:dbo_FJob:4471", fields: { Status: "complete" } };
        // I-50: told once, nothing filed; the same piece again is Held
        const told = await ctx.tool(other.worker, "file_to_source", finished);
        ctx.check(told.outcome === "not_filed" && told.fields?.[0]?.column === "Status" && !told.error, `told once, as an answer, not an error: ${JSON.stringify(told).slice(0, 300)}`);
        const h = await ctx.tool(other.worker, "file_to_source", finished);
        ctx.check(h.outcome === "held" && /R16 condition 3/.test(h.note ?? ""), `Held by condition 3: ${JSON.stringify(h).slice(0, 300)}`);
        ctx.check(fake.tables.dbo_FJob.rows[0].Status === null && writes().length === 1, "nothing written for it");
        const q1 = (await ctx.sql(`SELECT asked_of, status, question FROM WorkerQuestion WHERE job_id = '${other.job}'`))[0];
        ctx.check(q1?.asked_of === "bob" && /Not every value is in your words/.test(q1.question ?? ""), `asked of whoever put it on record, saying which condition: ${JSON.stringify(q1)}`);
        const listed = await ctx.api("/api/worker/questions");
        ctx.check(!JSON.stringify(listed).includes(other.job), "not among the admin's questions: no operator is involved");
        // the Filed write undone by a person with authority: the old value back, the entry marked
        const agent = await fetch(`${ctx.GRAPH}/api/filing/entries/${r.entry}/undo`, { method: "POST", headers: { authorization: `Bearer ${rec.worker}` } });
        ctx.check(agent.status === 403, `an agent can't undo: ${agent.status}`);
        const u = await ctx.api(`/api/filing/entries/${r.entry}/undo`, { method: "POST" });
        ctx.check(u.restored?.Status === "open" && fake.tables.dbo_FJob.rows[1].Status === "open", `undone, the old value back: ${JSON.stringify(u).slice(0, 300)}`);
        const marked = (await ctx.sql(`SELECT outcome, undone FROM FilingEntry WHERE id = '${r.entry}'`))[0];
        ctx.check(marked?.outcome === "filed" && /"by"/.test(String(marked?.undone ?? "")), `the entry stays, marked undone: ${JSON.stringify(marked)}`);
        const again = await ctx.api(`/api/filing/entries/${r.entry}/undo`, { method: "POST" });
        ctx.check(/undone already/.test(again.error ?? ""), `not twice: ${JSON.stringify(again).slice(0, 200)}`);
      });
    },
  },
  {
    name: "I-50, per field: told once which values aren't in the record; then what holds lands and the rest is its own Held piece, asking the recorder",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const rec = await record(ctx, "per-field", ["Job 4471 is complete."]);
        const p = { section: rec.sections[0], piece: "job 4471 shipped", said: "writing Status complete and 800 shipped to job 4471", class: "e2e_filing_jobs", key: "mssql:dbo_FJob:4471", fields: { Status: "complete", Quantity: 800 } };
        const told = await ctx.tool(rec.worker, "file_to_source", p);
        ctx.check(told.outcome === "not_filed" && told.fields?.map((x) => x.column).join() === "Quantity" && writes().length === 0, `told which, nothing written: ${JSON.stringify(told).slice(0, 300)}`);
        const r = await ctx.tool(rec.worker, "file_to_source", { ...p, fields: { Status: "complete" } });
        ctx.check(r.outcome === "filed" && r.held?.fields?.join() === "Quantity", `Status Filed, the 800 left out and held: ${JSON.stringify(r).slice(0, 300)}`);
        ctx.check(fake.tables.dbo_FJob.rows[0].Status === "complete" && fake.tables.dbo_FJob.rows[0].Quantity === 500, "Status written, Quantity not");
        const entries = await log(ctx, rec.doc);
        ctx.check(entries.map((e) => e.outcome).sort().join() === "filed,held", `one Filed, one Held: ${JSON.stringify(entries.map((e) => e.outcome))}`);
        const q1 = (await ctx.sql(`SELECT asked_of, question FROM WorkerQuestion WHERE job_id = '${rec.job}'`))[0];
        ctx.check(q1?.asked_of === "bob" && /Quantity wasn't written/.test(q1.question ?? ""), `the recorder is asked about the 800: ${JSON.stringify(q1)}`);
      });
    },
  },
  {
    name: "R19: a worker adds a row to a table that takes new rows; the key is the source's; one piece adds one row however often it is filed; a person undoes it by removing the row",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const rec = await record(ctx, "r19", ["On 11/09 coolant concentration on CNC 1 read 4 percent. Topped up and rechecked at 7."]);
        const p = { section: rec.sections[0], piece: "CNC 1 coolant topped up", said: "adding a maintenance row for CNC 1", class: "e2e_filing_maint", key: "mssql:dbo_FMaint:new", fields: { Work_Center: "CNC 1", Opened: "2026-11-09", Description: "coolant concentration on CNC 1 read 4 percent", Status: "Closed", Maint: 9 } };
        const r = await ctx.tool(rec.worker, "file_to_source", p);
        ctx.check(r.outcome === "filed" && r.key === "mssql:dbo_FMaint:3" && fake.tables.dbo_FMaint.rows.length === 3, `added, its key the source's: ${JSON.stringify(r).slice(0, 300)}`);
        const created = () => fake.calls.filter((c) => c.name === "create_record");
        ctx.check(created().length === 1 && !("Maint" in created()[0].args.data), `the key the worker gave is never sent: ${JSON.stringify(created()[0]?.args).slice(0, 200)}`);
        for (const key of ["mssql:dbo_FMaint:new", "mssql:dbo_FMaint", "mssql:dbo_FMaint:77"]) {
          const again = await ctx.tool(rec.worker, "file_to_source", { ...p, key });
          ctx.check(again.outcome === "filed" && again.key === "mssql:dbo_FMaint:3", `filed again (${key}): the same row: ${JSON.stringify(again).slice(0, 200)}`);
        }
        ctx.check(created().length === 1 && fake.tables.dbo_FMaint.rows.length === 3, "one row, however often the piece is filed");
        const e = (await ctx.sql(`SELECT reason, target FROM FilingEntry WHERE id = '${r.entry}'`))[0];
        ctx.check(e?.reason === "added: mssql:dbo_FMaint:3" && JSON.parse(e.target).added === true, `logged as an added row: ${JSON.stringify(e)}`);
        const u = await ctx.api(`/api/filing/entries/${r.entry}/undo`, { method: "POST" });
        ctx.check(u.removed === true && fake.tables.dbo_FMaint.rows.length === 2 && fake.calls.some((c) => c.name === "delete_record" && c.url.includes("/write")), `undone: the row removed: ${JSON.stringify(u).slice(0, 300)}`);
        // a proposed add (the recorder lacks the authority): one proposal, however often filed; approved, the row is added
        const ops = await record(ctx, "r19-ops", ["On 11/09 the Toyota forklift beeper was tagged out until maintenance replaces it."]);
        const q2 = { section: ops.sections[0], piece: "forklift beeper tagged out", said: "adding a maintenance row", class: "e2e_filing_maint_ops", key: "mssql:dbo_FMaint:new", fields: { Opened: "2026-11-09", Description: "the Toyota forklift beeper was tagged out until maintenance replaces it", Status: "Open" } };
        const pr = await ctx.tool(ops.worker, "file_to_source", q2);
        const pr2 = await ctx.tool(ops.worker, "file_to_source", q2);
        const pending = [...new Set((await log(ctx, ops.doc)).map((x) => x.pending_id).filter(Boolean))];
        ctx.check(pr.outcome === "proposed" && pr2.outcome === "proposed" && pending.length === 1, `proposed once: ${JSON.stringify([pr, pr2, pending]).slice(0, 300)}`);
        const ok = await ctx.api(`/api/queue/${pending[0]}/approve`, { method: "POST", body: "{}" });
        ctx.check(!ok.error && fake.tables.dbo_FMaint.rows.length === 3 && fake.tables.dbo_FMaint.rows.at(-1).Maint === 4, `approved: the row added, key 4 (the source never reuses 3): ${JSON.stringify(ok).slice(0, 300)}`);
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
        // a re-filing is done by the refile job's own worker (I-41: only it is offered refiles)
        const keep = async (refiles, worker = rec.worker) => (await ctx.tool(worker, "keep_piece", { section: rec.sections[0], piece: "the forklift is booked Thursday", instances: [fork.instance], ...(refiles ? { refiles } : {}) })).entry;
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
          const next = await keep(prev, ctx.workerToken(rec.sections[0], r.started?.[0]?.job));
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
        await ctx.api("/api/worker/signals/ack", { method: "POST", body: JSON.stringify({ ids: [sa.id] }) });
        const nexta = await ctx.api("/api/worker/signals");
        ctx.check(!(nexta.kept_by_graph_rag ?? []).some((x) => x.request === ra.id), "settled by the fresh worker: nothing for the floor");
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
        // the master's turn starts with the signal (graph-pool.ts acks it as the prompt goes in) and ends before it next
        // asks for signals: a kick-back not yet delivered is never floored, one delivered and left open is
        const early = await ctx.api("/api/worker/signals");
        ctx.check(!(early.kept_by_graph_rag ?? []).some((x) => x.request === rb.id), "not delivered yet: not floored");
        await ctx.api("/api/worker/signals/ack", { method: "POST", body: JSON.stringify({ ids: [sb.id] }) });
        const nextb = await ctx.api("/api/worker/signals");
        ctx.check((nextb.kept_by_graph_rag ?? []).some((x) => x.request === rb.id), `left open past the turn: Kept by graph-rag at the master's next fetch: ${JSON.stringify(nextb.kept_by_graph_rag ?? null).slice(0, 300)}`);
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
    name: "sections by the names models give: s2, Section #rid, §1, a lone section's own text; anything else is refused with the ids",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const two = await record(ctx, "names", ["Job 4471 is complete.", "The forklift is booked Thursday."]);
        const fork = await ctx.tool(two.worker, "create_instance", { section: "s2", name: "e2e-filing names forklift", class: "e2e_filing_equipment" });
        ctx.check(fork.instance, `s2 is the second section: ${JSON.stringify(fork).slice(0, 200)}`);
        const k = await ctx.tool(two.worker, "keep_piece", { section: `Section ${two.sections[1]}`, piece: "the forklift is booked Thursday", instances: [fork.instance] });
        ctx.check(k.outcome === "kept", `"Section #rid" is that section: ${JSON.stringify(k).slice(0, 200)}`);
        const bad = await ctx.tool(two.worker, "keep_piece", { section: "The forklift is booked Thursday for the Toro move next week", piece: "the forklift is booked", instances: [fork.instance] });
        ctx.check(bad.error && bad.error.includes(`s1 (${two.sections[0]})`) && bad.error.includes(`s2 (${two.sections[1]})`) && /not its text/.test(bad.error), `with two sections, text in the field is refused with the ids: ${JSON.stringify(bad).slice(0, 400)}`);
        const filed = await ctx.tool(two.worker, "file_to_source", { section: "§1", piece: "job 4471 is complete", said: "writing it: job 4471 is complete", class: "e2e_filing_jobs", key: "mssql:dbo_FJob:4471", fields: { Status: "complete" } });
        ctx.check(filed.outcome === "filed", `§1 is the first section: ${JSON.stringify(filed).slice(0, 200)}`);
        const lt = await log(ctx, two.doc);
        const sectionOf = async (id) => (await ctx.sql(`SELECT section FROM FilingEntry WHERE id = '${id}'`))[0]?.section;
        ctx.check((await sectionOf(k.entry)) === two.sections[1] && (await sectionOf(filed.entry)) === two.sections[0] && lt.length === 2, "each entry names the record id of the section meant");
        const one = await record(ctx, "lone", ["The crate is in bay 2."]);
        const crate = await ctx.tool(one.worker, "create_instance", { section: "The crate is in bay 2, and it has been there since Tuesday, waiting for the Toro pallet to come back from plating.", name: "e2e-filing lone crate", class: "e2e_filing_equipment" });
        ctx.check(crate.instance, `with one section, the piece's text in the field (past 40 characters) means that section: ${JSON.stringify(crate).slice(0, 200)}`);
        const k1 = await ctx.tool(one.worker, "keep_piece", { section: "1", piece: "the crate is in bay 2", instances: [crate.instance] });
        ctx.check(k1.outcome === "kept" && (await sectionOf(k1.entry)) === one.sections[0], `"1" is s1: ${JSON.stringify(k1).slice(0, 200)}`);
      });
    },
  },
  {
    name: "a class's source table by the bare name a model gives: the one declared source that has it; otherwise refused with the form",
    run: async (ctx) => {
      await setup(ctx);
      const tag = ctx.randomUUID().slice(0, 8);
      const made = await ctx.tool(orchestrator(ctx), "create_class", { name: `e2e filing table ${tag}`, parents: ["resource"], evidence: [{ kind: "table", ref: "mssql:dbo_FJob" }], record_table: "dbo_FJob" });
      ctx.check(!made.error, `a bare table name is taken: ${JSON.stringify(made).slice(0, 300)}`);
      const row = (await ctx.sql(`SELECT _record_table FROM Entity WHERE _kind = 'class' AND _class_name = 'e2e filing table ${tag}'`))[0];
      ctx.check(row?._record_table === "mssql:dbo_FJob", `stored as system:table: ${JSON.stringify(row)}`);
      const bad = await ctx.tool(orchestrator(ctx), "create_class", { name: `e2e filing table ${tag} b`, parents: ["resource"], evidence: [{ kind: "table", ref: "mssql:dbo_FJob" }], record_table: "dbo_NoSuchTable" });
      ctx.check(bad.error && /not system:table: dbo_NoSuchTable/.test(bad.error) && /for example mssql:dbo_NoSuchTable/.test(bad.error), `a table no source has is refused with the form: ${JSON.stringify(bad).slice(0, 300)}`);
      // its class records dbo_FJob, homed at the root (the harness sets no connection home for classes): retired, so later
      // scenarios still file to that table (a retired class records no table: filing.js classesForTable)
      const ret = await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Entity SET _status = 'retired' WHERE _kind = 'class' AND _class_name = 'e2e filing table ${tag}'` });
      const left = await ctx.sql(`SELECT _status FROM Entity WHERE _kind = 'class' AND _class_name = 'e2e filing table ${tag}'`);
      ctx.check(left[0]?._status === "retired", `its class is retired: ${JSON.stringify(ret).slice(0, 200)} ${JSON.stringify(left)}`);
    },
  },
  {
    name: "handles: entries e1.., requests r1.. and bare table names stand for their ids; names, questions and other values are refused with the list",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const rec = await record(ctx, "handles", ["Job 4471 is complete. The forklift is booked Thursday."]);
        const fork = await ctx.tool(rec.worker, "create_instance", { section: "s1", name: "e2e-filing handles forklift", class: "e2e_filing_equipment" });
        const byName = await ctx.tool(rec.worker, "keep_piece", { section: "s1", piece: "the forklift is booked Thursday", instances: ["e2e-filing nobody by this name"] });
        ctx.check(byName.error && /graph-rag_resolve_name or graph-rag_create_instance/.test(byName.error), `a name no instance the worker sees has is refused, pointing to where ids come from (I-42 takes a name only with one candidate): ${JSON.stringify(byName).slice(0, 300)}`);
        const k = await ctx.tool(rec.worker, "keep_piece", { section: "s1", piece: "the forklift is booked Thursday", instances: [fork.instance] });
        ctx.check(k.handle === "e1" && k.entry, `the first entry's handle is e1: ${JSON.stringify(k).slice(0, 200)}`);
        const f = await ctx.tool(rec.worker, "file_to_source", { section: "s1", piece: "job 4471 is complete", said: "writing it: job 4471 is complete", class: "e2e_filing_jobs", key: "dbo_FJob:4471", fields: { Status: "complete" } });
        ctx.check(f.outcome === "filed" && f.handle === "e2", `a key with a bare table is the source's row: ${JSON.stringify(f).slice(0, 300)}`);
        const fe = (await ctx.sql(`SELECT target FROM FilingEntry WHERE id = '${f.entry}'`))[0];
        ctx.check(JSON.stringify(fe?.target ?? "").includes("mssql:dbo_FJob:4471"), `stored as system:table:row: ${JSON.stringify(fe).slice(0, 200)}`);
        const rn = await ctx.tool(rec.worker, "resolve_name", { name: "4471", table: "dbo_FJob", column: "Job" });
        ctx.check(!rn.error, `resolve_name takes a bare table name: ${JSON.stringify(rn).slice(0, 200)}`);
        const badAcc = await ctx.tool(rec.worker, "give_account", { pieces: [{ entry: "section_s1", said: "kept the forklift booking" }] });
        ctx.check(badAcc.error && badAcc.error.includes("e1 (kept") && badAcc.error.includes("e2 (filed"), `an account for something that isn't an entry is refused with the worker's entries: ${JSON.stringify(badAcc).slice(0, 300)}`);
        const acc = await ctx.tool(rec.worker, "give_account", { pieces: [{ entry: "e1", said: "kept the forklift booking" }] });
        ctx.check(acc.missing?.length === 0, `an account by handle: ${JSON.stringify(acc).slice(0, 200)}`);
        const q1 = await ctx.tool(rec.worker, "request", { kind: "other", question: "Which forklift is meant in this note?", section: "s1" });
        const q2 = await ctx.tool(rec.worker, "request", { kind: "class", question: "No class fits a booking: should one be made?", section: "s1" });
        const open = (await ctx.tool(orchestrator(ctx), "open_requests", {})).requests ?? [];
        const h1 = open.find((r) => r.id === q1.request)?.handle;
        const h2 = open.find((r) => r.id === q2.request)?.handle;
        ctx.check(/^r\d+$/.test(h1 ?? "") && /^r\d+$/.test(h2 ?? ""), `open requests carry handles: ${h1}, ${h2}`);
        const bad = await ctx.tool(orchestrator(ctx), "answer_request", { request: "Which forklift is meant in this note?", decision: "keep" });
        ctx.check(bad.error && /never its question/.test(bad.error) && bad.error.includes(`${h1} (other`) && bad.error.includes(`${h2} (class`), `a question as the id is refused with the open requests: ${JSON.stringify(bad).slice(0, 400)}`);
        const ok = await ctx.tool(orchestrator(ctx), "answer_request", { request: h1, decision: "keep" });
        ctx.check(ok.answered === q1.request, `answered by handle: ${JSON.stringify(ok).slice(0, 200)}`);
        await ctx.tool(orchestrator(ctx), "answer_request", { request: h2, decision: "keep" });
      });
    },
  },
  {
    name: "R17 narrows I-39: a section at its recorder's own level updates a table read lower, by authority; one the check raised above its recorder is Proposed, nothing lands",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const marker = `zebra-r17-${ctx.randomUUID().slice(0, 6)}`;
        // alice's Operations note, as in A-4, into a source read at the floor: her authority over jobs decides (R17), and
        // its words are hers (R16), so it lands; the leak gate lists such a write apart (eval/leaks.mjs)
        const ops = await record(ctx, "r17-own", [`Job 4471 is complete; ${marker} covers setups until the new hire is trained.`], { home: "ops", by: "alice" });
        const f = await ctx.tool(ops.worker, "file_to_source", { section: "s1", piece: `Job 4471 is complete; ${marker} covers setups`, said: "writing Status to job 4471", class: "e2e_filing_jobs", key: "mssql:dbo_FJob:4471", fields: { Status: `complete; ${marker} covers setups` } });
        ctx.check(f.outcome === "filed" && fake.tables.dbo_FJob.rows[0].Status === `complete; ${marker} covers setups`, `at her own level, by her authority: Filed: ${JSON.stringify(f).slice(0, 300)}`);
        // bob's note the check raised to Operations, above his own position: an agent doesn't write it to the floor's table
        const raised = await record(ctx, "r17-raised", [`Job 4472 is complete; ${marker}-b covers setups.`], { home: "ops", by: "bob" });
        await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Entity SET _record_position = 'floor' WHERE _kind = 'document' AND _doc_id = '${raised.doc}'` });
        const g = await ctx.tool(raised.worker, "file_to_source", { section: "s1", piece: `Job 4472 is complete; ${marker}-b covers setups`, said: "writing Status to job 4472", class: "e2e_filing_jobs", key: "mssql:dbo_FJob:4472", fields: { Status: `complete; ${marker}-b covers setups` } });
        ctx.check(g.outcome === "proposed" && /R17, I-39 as narrowed/.test(g.note ?? ""), `raised above its recorder: Proposed, saying why: ${JSON.stringify(g).slice(0, 300)}`);
        ctx.check(!JSON.stringify(fake.tables).includes(`${marker}-b`), "nothing of it lands in the source");
        const pend = (await ctx.sql(`SELECT home FROM PendingWrite WHERE payload LIKE '%${marker}-b%'`))[0];
        ctx.check(pend?.home === "ops", `the pending write waits where the section is seen: ${JSON.stringify(pend)}`);
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
        ctx.check(refused.error && /no section|isn't one of yours/.test(refused.error), `another record's section is refused: ${JSON.stringify(refused)}`);
        const noClass = await ctx.tool(rec.worker, "file_to_source", { section: rec.sections[0], piece: "a pallet", said: "writing it: " + "a pallet", class: "e2e_filing_no_such_class", key: "mssql:dbo_FJob:4471", fields: { Status: "x" } });
        ctx.check(noClass.error && /request one/.test(noClass.error), `no class: request one, never make one (R5): ${JSON.stringify(noClass)}`);
      });
    },
  },
  {
    name: "I-40: find_rows finds rows by words the source's filter can't take, pages by key, and refuses an unknown table or column with the real ones",
    run: async (ctx) => {
      await setup(ctx);
      fake.tables.dbo_FCust = { primaryKey: ["Cust"], rows: [{ Cust: "EXA", Name: "Exatron Corp", Terms: "Net 30" }, { Cust: "TOR", Name: "Toro", Terms: "Net 45" }] };
      await withMap(ctx, async () => {
        const rec = await record(ctx, "findrows", ["Exatron wants the next batch earlier."]);
        const exa = await ctx.tool(rec.worker, "find_rows", { table: "mssql:dbo_FCust", text: "exatron" });
        ctx.check(exa.status === "found" && exa.rows?.[0]?.key === "mssql:dbo_FCust:EXA", `a word inside a name is found: ${JSON.stringify(exa).slice(0, 300)}`);
        const bare = await ctx.tool(rec.worker, "find_rows", { table: "dbo_FCust", text: "net 45" });
        ctx.check(bare.rows?.[0]?.key === "mssql:dbo_FCust:TOR", `a bare table name is qualified; words across columns: ${JSON.stringify(bare).slice(0, 300)}`);
        const job = await ctx.tool(rec.worker, "find_rows", { table: "mssql:dbo_FJob", where: { Job: "4472" } });
        ctx.check(job.status === "found" && job.rows?.[0]?.row?.Status === "open", `a number given as text is read as a number: ${JSON.stringify(job).slice(0, 300)}`);
        const notNumber = await ctx.tool(rec.worker, "find_rows", { table: "mssql:dbo_FJob", where: { Job: "job 4472" } });
        ctx.check(/number column/.test(notNumber.error ?? ""), `a number column compared with words is explained: ${JSON.stringify(notNumber)}`);
        const col = await ctx.tool(rec.worker, "find_rows", { table: "mssql:dbo_FCust", text: "x", columns: ["Code"] });
        ctx.check(/has no column Code: it has Cust, Name, Terms/.test(col.error ?? ""), `an unknown column is refused with the real ones: ${JSON.stringify(col)}`);
        const table = await ctx.tool(rec.worker, "find_rows", { table: "mssql:dbo_FNope", text: "x" });
        ctx.check(/has no table dbo_FNope: it has/.test(table.error ?? ""), `an unknown table is refused with the real ones: ${JSON.stringify(table)}`);
        const filters = fake.calls.filter((c) => c.name === "read_records").map((c) => String(c.args?.filter ?? ""));
        ctx.check(filters.every((x) => !/contains|startswith|endswith/.test(x)) && fake.calls.every((c) => c.args?.after === undefined), `no string function and no cursor reach the source: ${JSON.stringify(filters)}`);
        // the orchestrator has it too, with no audience
        const o = await ctx.tool(orchestrator(ctx), "find_rows", { table: "mssql:dbo_FCust", text: "toro" });
        ctx.check(o.rows?.[0]?.key === "mssql:dbo_FCust:TOR", `the orchestrator's find_rows: ${JSON.stringify(o).slice(0, 200)}`);
      });
    },
  },
  {
    name: "I-59: an agent reads a source through graph-rag alone: describe_source gives a worker its tables, a table's key, columns, rows and values; a discovery part has it and find_rows",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const rec = await record(ctx, "describe", ["Job 4471 is complete."]);
        const all = await ctx.tool(rec.worker, "describe_source", {});
        ctx.check(all.sources?.[0]?.system === "mssql" && all.sources[0].tables?.includes("dbo_FJob"), `the tables: ${JSON.stringify(all).slice(0, 300)}`);
        const one = await ctx.tool(rec.worker, "describe_source", { table: "mssql:dbo_FJob" });
        ctx.check(one.primary_key?.[0] === "Job" && one.rows === 2 && "Quantity" in (one.columns ?? {}) && one.sample?.length === 2, `a table: ${JSON.stringify(one).slice(0, 300)}`);
        const bare = await ctx.tool(rec.worker, "describe_source", { table: "mssql" });
        ctx.check(bare.tables?.includes("dbo_FJob"), `a system alone: ${JSON.stringify(bare).slice(0, 200)}`);
        const schemas = await toolSchemas(ctx, rec.worker);
        ctx.check(schemas.has("describe_source") && schemas.has("find_rows"), `the worker has both: ${[...schemas.keys()].join(", ").slice(0, 300)}`);
        const orch = await toolSchemas(ctx, orchestrator(ctx));
        ctx.check(orch.has("describe_source") && orch.has("find_rows"), "and the orchestrator");
      });
    },
  },
  {
    name: "I-40: find_rows keeps the audience rules: a worker below the source's read home reads nothing",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        // the source read at Operations: a floor worker may not read it, through find_rows as through anything else
        const url = fake.url;
        await upsertPolicyRow(ctx, "sources", JSON.stringify([{ system: "mssql", read: { via: "dab-mcp", url: `${url}/read/mcp`, home: "ops" }, commit: { via: "dab-mcp", url: `${url}/write/mcp`, tables: ["dbo_FJob"], guard: { server: "gwsynth-sql", database: "GwSynthMfg" } } }]));
        try {
          const rec = await record(ctx, "findrows-aud", ["Job 4471."]);
          // the sources declaration is cached for a minute; wait it out so the ops read home is what the read sees
          let r;
          for (let i = 0; i < 15; i++) {
            fake.calls = [];
            r = await ctx.tool(rec.worker, "find_rows", { table: "mssql:dbo_FJob", text: "4471" });
            if (r.error) break;
            await new Promise((res) => setTimeout(res, 5000));
          }
          ctx.check(/above your audience|above this audience/.test(r.error ?? ""), `refused: ${JSON.stringify(r).slice(0, 300)}`);
          ctx.check(!fake.calls.some((c) => c.name === "read_records" && c.args?.entity === "dbo_FJob" && c.args?.first !== 1), "no rows were read for it");
          const d = await ctx.tool(rec.worker, "describe_source", { table: "mssql:dbo_FJob" });
          ctx.check(/above your audience|above this audience/.test(d.error ?? ""), `describe_source refused the same way (I-59): ${JSON.stringify(d).slice(0, 300)}`);
        } finally {
          await upsertPolicyRow(ctx, "sources", JSON.stringify([{ system: "mssql", read: { via: "dab-mcp", url: `${url}/read/mcp`, home: "floor" }, commit: { via: "dab-mcp", url: `${url}/write/mcp`, tables: ["dbo_FJob"], guard: { server: "gwsynth-sql", database: "GwSynthMfg" } } }]));
        }
      });
    },
  },
  {
    name: "I-41: a first-time worker isn't offered refiles (a stray one is dropped); once it holds a piece, it is, and a wrong entry is refused with the ones it may",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const rec = await record(ctx, "refile-offer", ["The forklift is booked Thursday; which Toro job was it?"]);
        const crate = await ctx.tool(rec.worker, "create_instance", { section: "s1", name: `e2e-filing forklift ${ctx.randomUUID().slice(0, 6)}`, class: "e2e_filing_equipment" });
        let tools = await toolSchemas(ctx, rec.worker);
        ctx.check(["file_to_source", "hold_piece", "keep_piece"].every((t) => tools.has(t) && !("refiles" in (tools.get(t).properties ?? {}))), "no refiles on a first-time filing's tools");
        ctx.check(tools.has("find_rows"), "find_rows is offered");
        const stray = await ctx.tool(rec.worker, "keep_piece", { section: "s1", piece: "the forklift is booked Thursday", instances: [crate.instance], refiles: "shipment" });
        ctx.check(stray.outcome === "kept", `a stray refiles is dropped, not refused: ${JSON.stringify(stray).slice(0, 200)}`);
        const held = await ctx.tool(rec.worker, "hold_piece", { section: "s1", piece: "which Toro job", question: "Which Toro job did you mean?", table: "mssql:dbo_FJob" });
        ctx.check(held.outcome === "held", `held: ${JSON.stringify(held).slice(0, 200)}`);
        tools = await toolSchemas(ctx, rec.worker);
        ctx.check(["file_to_source", "hold_piece", "keep_piece"].every((t) => "refiles" in (tools.get(t).properties ?? {})), "refiles is offered once it holds a piece to re-file");
        const wrong = await ctx.tool(rec.worker, "keep_piece", { section: "s1", piece: "the Toro job", instances: [crate.instance], refiles: "hold-1" });
        ctx.check(wrong.error?.includes(held.entry), `a made-up entry is refused with the ones it may re-file: ${JSON.stringify(wrong).slice(0, 300)}`);
        const ok = await ctx.tool(rec.worker, "keep_piece", { section: "s1", piece: "the Toro job", instances: [crate.instance], refiles: held.entry });
        const row = (await log(ctx, rec.doc)).find((e) => e.id === ok.entry);
        ctx.check(row?.refiled_from === held.entry, `re-filed from the Held entry: ${JSON.stringify(row).slice(0, 200)}`);
        const first = (await log(ctx, rec.doc)).find((e) => e.id === stray.entry);
        ctx.check(first && !first.refiled_from, "the stray one re-filed nothing");
      });
    },
  },
  {
    name: "I-42: a name where an instance id is wanted is taken when one instance the worker sees has it; two by that name are refused",
    run: async (ctx) => {
      await setup(ctx);
      await withMap(ctx, async () => {
        const rec = await record(ctx, "byname", ["The press is booked Thursday."]);
        const name = `e2e-filing press ${ctx.randomUUID().slice(0, 6)}`;
        const press = await ctx.tool(rec.worker, "create_instance", { section: "s1", name, class: "e2e_filing_equipment" });
        const k = await ctx.tool(rec.worker, "keep_piece", { section: "s1", piece: "the press is booked Thursday", instances: [name.toUpperCase()] });
        const row = (await log(ctx, rec.doc)).find((e) => e.id === k.entry);
        ctx.check(k.outcome === "kept", `kept by name: ${JSON.stringify(k).slice(0, 200)}`);
        const linked = await ctx.sql(`SELECT instances FROM FilingEntry WHERE id = '${k.entry}'`);
        ctx.check(JSON.stringify(linked).includes(press.instance), `linked to the one instance by that name: ${JSON.stringify(linked)} ${JSON.stringify(row).slice(0, 100)}`);
        const rel = await ctx.tool(rec.worker, "relate_section", { section: "s1", instance: name });
        ctx.check(!rel.error, `relate_section takes the name too: ${JSON.stringify(rel).slice(0, 200)}`);
        // a second instance by the same name, under another class the worker sees: now two, so refused
        await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = '${name}', label = '${name}', _kind = 'thing', _norm = '${name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}', _homes = ['floor'], _home = 'floor'` });
        const two = await ctx.tool(rec.worker, "keep_piece", { section: "s1", piece: "the press again", instances: [name] });
        ctx.check(/no one instance you can see is called that/.test(two.error ?? ""), `two by that name: refused: ${JSON.stringify(two)}`);
      });
    },
  },
];
