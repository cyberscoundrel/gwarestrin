// The Reconciliation and data entry stream's acceptance scenarios
// (docs/ORGANIZATION-MODEL.md, "The worker's job"), in the shape SCENARIOS.md
// gives: an array of { name, run(ctx) }, run by the Test harness stream's
// loader inside the replay harness (a real ArcadeDB, graph-rag from this
// checkout, fake models). Each scenario seeds its own sections and claims
// (CLAIMS edges, worker-pool.js) through the admin's raw commands, since the
// Condenser's ingest is not in the harness yet, and talks to a fake DAB this
// file hosts in the runner's own process: graph-rag is pointed at it through
// the organization's stored `sources` (an OrgPolicy row, data-entry.js), and
// the authority rule through the stored policy (the fixture policy.json, as
// `authorityMap` through /api/policy once the Authority stream lands, else the
// stub's OrgPolicy "authority" row). graph-rag caches the stored sources for a minute, so a loader that
// reruns this file against one stack within that minute sees the previous run's fake address.
import { createServer } from "node:http";
import { networkInterfaces, hostname } from "node:os";
import { dabTool } from "./fake-dab-core.mjs";
import { triageRequest } from "../src/decisions.js";

const PREFIX = "e2e-reconcile";
const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** ---- a fake DAB: one MCP endpoint, its tools as DAB 2.0.12 answers them (fake-dab-core.mjs), the tool calls it saw ---- */
const fake = {
  // a table's cursor needs a second row: DAB pages by primary key, and this is how the key is learned
  tables: { dbo_Job: { primaryKey: ["Job"], rows: [] }, dbo_Customer: { primaryKey: ["Customer"], rows: [{ Customer: "TORO", Name: "Toro" }, { Customer: "ACME", Name: "Acme" }] }, dbo_Line: { primaryKey: ["Order", "Line"], rows: [{ Order: 78912, Line: 1, Qty: 5 }, { Order: 78912, Line: 2, Qty: 7 }] } },
  get rows() {
    return { dbo_Job: this.tables.dbo_Job.rows };
  },
  calls: [],
  url: null,
  server: null,
};

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
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fake-dab" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    };
    if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-dab" } });
    if (body.method !== "tools/call") return reply({});
    const { name, arguments: args } = body.params ?? {};
    fake.calls.push({ url: req.url, name, args });
    if (process.env.FAKE_DAB_LOG) console.log(`fake DAB: ${name} ${req.url}`);
    reply(dabTool(fake.tables, name, args, { write: req.url.includes("/write") }));
  });
  await new Promise((r) => fake.server.listen(4290, "0.0.0.0", r));
  fake.server.unref();
  fake.url = `http://${runnerAddress()}:4290`;
  console.log(`fake DAB at ${fake.url}`);
  return fake.url;
}

/** ---- what every scenario needs once: the sources, the authority policy, a keyed instance ---- */
let ready = null;
async function setup(ctx) {
  if (ready) return ready;
  ready = (async () => {
    const url = await startFakeDab();
    const sources = JSON.stringify({ mssql: { read: `${url}/read/mcp`, write: `${url}/write/mcp` } });
    const upsertPolicy = async (scope, json) => {
      const have = await ctx.sql(`SELECT scope FROM OrgPolicy WHERE scope = '${scope}'`);
      const r = await ctx.tool("admin", "execute_graph", { language: "sql", command: have.length ? `UPDATE OrgPolicy SET json = '${q(json)}' WHERE scope = '${scope}'` : `INSERT INTO OrgPolicy SET scope = '${scope}', json = '${q(json)}', updated_by = 'e2e', updated_at = '${new Date().toISOString()}'` });
      ctx.check(!r.error, `${scope} stored: ${JSON.stringify(r).slice(0, 200)}`);
    };
    await upsertPolicy("sources", sources);
    // the authority policy: through the organization policy when the Authority stream's field is there, else the stub's row
    const policy = ctx.fixtures.read("policy.json");
    const viaPolicy = await ctx.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: policy }) });
    if (viaPolicy.error) await upsertPolicy("authority", JSON.stringify(policy));
    // an instance of jobs with its record key, seen from the floor; the row behind it in the fake source
    fake.tables.dbo_Job.rows = [
      { Job: 4471, Status: "running", Quantity: 500, credit_status: "good", job_status: "open", created_date: "2026-01-02T00:00:00", Price: 12.5 },
      { Job: 4472, Status: "planned", Quantity: 20, credit_status: "hold", job_status: "open", created_date: "2026-02-03T00:00:00", Price: 3 },
    ];
    const thing = async (rowKey) => {
      const existing = (await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND _keys CONTAINS 'mssql:dbo_Job:${rowKey}'`))[0];
      if (existing) return String(existing.rid);
      const r = await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = '${PREFIX} job ${rowKey} (order)', label = '${PREFIX} job ${rowKey}', _kind = 'thing', _thing_type = 'order', _norm = '${PREFIX} job ${rowKey}', _alias_norms = [], _keys = ['mssql:dbo_Job:${rowKey}'], _class = 'jobs', _homes = ['floor'], _home = 'org', updated_at = '${new Date().toISOString()}'` });
      ctx.check(!r.error, `thing made: ${JSON.stringify(r).slice(0, 200)}`);
      return String((await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND _keys CONTAINS 'mssql:dbo_Job:${rowKey}'`))[0].rid);
    };
    return { url, job4471: await thing("4471"), job4472: await thing("4472") };
  })();
  return ready;
}

/** a section on record: by `person` at `position`, with the text */
async function section(ctx, name, { person, position, text }) {
  const r = await ctx.tool("admin", "execute_graph", {
    language: "sql",
    command: `CREATE VERTEX Entity SET name = '${q(name)}', _kind = 'section', _home = '${position}', _origin = '${position}', _written_by = '${person}', _recorded_by = '${person}', _record_position = '${position}', _record_reason = 'e2e', text_identity = '${q(text)}', updated_at = '${new Date().toISOString()}'`,
  });
  ctx.check(!r.error, `section ${name} made: ${JSON.stringify(r).slice(0, 200)}`);
  return String((await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE name = '${q(name)}' AND _kind = 'section'`))[0].rid);
}

/** a claim the section makes about a thing (or, with no thing, an unresolved one pointing back at the section) */
async function claim(ctx, sectionRid, thingRid, { kind = "state", cls, attribute, value, valid_from = "2026-11-08T09:00:00.000Z", valid_until = null, recorded_by, home, subject }) {
  const id = ctx.randomUUID();
  const num = typeof value === "number" ? value : /^-?\d+(\.\d+)?$/.test(String(value)) ? Number(value) : null;
  const r = await ctx.tool("admin", "execute_graph", {
    language: "sql",
    command: `CREATE EDGE CLAIMS FROM ${sectionRid} TO ${thingRid ?? sectionRid} SET id = '${id}', kind = '${kind}', class = '${cls}', attribute = '${attribute}', value = '${q(String(value))}', value_num = ${num ?? "null"}, valid_from = '${valid_from}', valid_until = ${valid_until ? `'${valid_until}'` : "null"}, recorded_at = '${valid_from}', recorded_by = '${recorded_by}', _home = '${home}', subject = '${q(JSON.stringify(subject ?? {}))}'`,
  });
  ctx.check(!r.error, `claim made: ${JSON.stringify(r).slice(0, 200)}`);
  return id;
}

const audit = (ctx, key) => ctx.sql(`SELECT id, outcome, pending_id, authorized_by, position, change FROM AuditEvent WHERE key = '${key}' ORDER BY at ASC`);

export default [
  {
    name: "a section whose claim matches the source row is confirmed with no write",
    run: async (ctx) => {
      const { job4471 } = await setup(ctx);
      const s = await section(ctx, `${PREFIX} s1 running`, { person: "bob", position: ctx.POS.floor, text: "Job 4471 is running on CNC 2." });
      const c = await claim(ctx, s, job4471, { cls: "jobs", attribute: "status", value: "running", recorded_by: "bob", home: ctx.POS.floor, subject: { key: "mssql:dbo_Job:4471" } });
      const job = ctx.randomUUID();
      const before = (await audit(ctx, "mssql:dbo_Job:4471")).length;
      const calls = fake.calls.length;
      const r = await ctx.tool(ctx.workerToken(s, job), "confirm_claim", { claim_id: c });
      ctx.check(r.confirmed === true, `confirmed: ${JSON.stringify(r).slice(0, 300)}`);
      ctx.check(r.column === "Status" && r.row_found === true, `the row's column: ${JSON.stringify(r).slice(0, 200)}`);
      ctx.check(fake.calls.slice(calls).every((x) => x.name !== "update_record" && !x.url.includes("/write")), "nothing written to the source");
      ctx.check((await audit(ctx, "mssql:dbo_Job:4471")).length === before, "no audit event: a confirmation writes nothing");
      ctx.check(!(await ctx.sql(`SELECT id FROM PendingWrite WHERE job_id = '${job}'`)).length, "nothing proposed");
      const ref = (await ctx.sql("SELECT last_seen, seen_by FROM SourceRef WHERE key = 'mssql:dbo_Job:4471'"))[0];
      ctx.check(ref?.last_seen && /worker/.test(String(ref.seen_by)), `the row's reference says the worker saw it: ${JSON.stringify(ref)}`);
      ctx.check((await ctx.sql(`SELECT count(*) AS n FROM (SELECT expand(out('REFERS_TO')) FROM ${job4471})`))[0]?.n >= 1, "the instance refers to its row");
      // a claim the row contradicts is not confirmed, and still nothing is written
      const s2 = await section(ctx, `${PREFIX} s1b paused`, { person: "bob", position: ctx.POS.floor, text: "Job 4471 is paused." });
      const c2 = await claim(ctx, s2, job4471, { cls: "jobs", attribute: "status", value: "paused", recorded_by: "bob", home: ctx.POS.floor, subject: { key: "mssql:dbo_Job:4471" } });
      const r2 = await ctx.tool(ctx.workerToken(s2, ctx.randomUUID()), "confirm_claim", { claim_id: c2 });
      ctx.check(r2.confirmed === false && r2.row_value === "running", `not confirmed, the row's value shown: ${JSON.stringify(r2).slice(0, 300)}`);
      ctx.check(fake.rows.dbo_Job[0].Status === "running", "the row is untouched");
    },
  },
  {
    name: "a conflicting claim yields a conflict record, not a contradiction verdict",
    run: async (ctx) => {
      const { job4472 } = await setup(ctx);
      const sA = await section(ctx, `${PREFIX} s2a running`, { person: "bob", position: ctx.POS.floor, text: "Job 4472 is running." });
      const sB = await section(ctx, `${PREFIX} s2b paused`, { person: "bob", position: ctx.POS.floor, text: "Job 4472 is paused for parts." });
      const at = "2026-11-08T10:00:00.000Z";
      const a = await claim(ctx, sA, job4472, { cls: "jobs", attribute: "stage", value: "running", valid_from: at, recorded_by: "bob", home: ctx.POS.floor, subject: { key: "mssql:dbo_Job:4472" } });
      const b = await claim(ctx, sB, job4472, { cls: "jobs", attribute: "stage", value: "paused", valid_from: at, recorded_by: "bob", home: ctx.POS.floor, subject: { key: "mssql:dbo_Job:4472" } });
      const w = ctx.workerToken(sB, ctx.randomUUID());
      const r = await ctx.tool(w, "record_conflict", { claim_ids: [a, b], note: "two values at the same instant" });
      ctx.check(r.conflict, `a conflict record: ${JSON.stringify(r).slice(0, 300)}`);
      const row = (await ctx.sql(`SELECT status, attribute, claim_a, claim_b FROM ClaimConflict WHERE id = '${r.conflict}'`))[0];
      ctx.check(row?.status === "open" && row.attribute === "stage" && [row.claim_a, row.claim_b].sort().join() === [a, b].sort().join(), `recorded for a person: ${JSON.stringify(row)}`);
      const again = await ctx.tool(w, "record_conflict", { claim_ids: [b, a] });
      ctx.check(again.already === true, `once per pair: ${JSON.stringify(again).slice(0, 200)}`);
      // a later claim that moves the state on is a succession, not a conflict: the query refuses it
      const sC = await section(ctx, `${PREFIX} s2c done`, { person: "bob", position: ctx.POS.floor, text: "Job 4472 is done." });
      const c = await claim(ctx, sC, job4472, { cls: "jobs", attribute: "stage", value: "done", valid_from: "2026-11-09T10:00:00.000Z", recorded_by: "bob", home: ctx.POS.floor, subject: { key: "mssql:dbo_Job:4472" } });
      const no = await ctx.tool(ctx.workerToken(sC, ctx.randomUUID()), "record_conflict", { claim_ids: [a, c] });
      ctx.check(/not a conflict/.test(no.error ?? ""), `a succession is refused: ${JSON.stringify(no).slice(0, 300)}`);
      // no decision model verdict is involved: triage asks no contradiction question, in what it builds and in every request the model has seen
      const built = triageRequest({ name: "e2e", text: "e2e" }, {}).questions;
      ctx.check(!("contradiction" in built) && !Object.keys(built.reason.criteria).some((k) => /contradiction/i.test(k)), `triage builds no contradiction question: ${Object.keys(built)} ${Object.keys(built.reason.criteria)}`);
      const seen = (await (await fetch(`${ctx.MODELS}/__decisions`)).json()).decisions;
      for (const d of seen) ctx.check(!d.questions.includes("contradiction") && !d.reasons.some((k) => /contradiction/i.test(k)), `a decision request asked about a contradiction: ${JSON.stringify(d)}`);
      ctx.check(!(await ctx.sql(`SELECT id FROM PendingWrite WHERE payload LIKE '%${a}%'`)).length, "nothing proposed for a conflict");
    },
  },
  {
    name: "a data entry by a worker acting for a floor position is proposed and audited",
    run: async (ctx) => {
      const { job4471 } = await setup(ctx);
      fake.rows.dbo_Job[0].Quantity = 500;
      const s = await section(ctx, `${PREFIX} s3 quantity`, { person: "bob", position: ctx.POS.floor, text: "Job 4471 is now 600 pieces." });
      // quantity on orders: Operations holds the authority (fixture policy); bob reports to it
      const c = await claim(ctx, s, job4471, { cls: "orders", attribute: "quantity", value: 600, recorded_by: "bob", home: ctx.POS.floor, subject: { key: "mssql:dbo_Job:4471" } });
      const job = ctx.randomUUID();
      const r = await ctx.tool(ctx.workerToken(s, job), "enter_data", { claim_id: c, reason: "the floor says 600" });
      ctx.check(r.outcome === "proposed" && r.pendingId, `proposed: ${JSON.stringify(r).slice(0, 300)}`);
      ctx.check(/END YOUR TURN|End your turn/i.test(r.note ?? ""), "the worker is told to stop");
      ctx.check(fake.rows.dbo_Job[0].Quantity === 500, "the row is untouched");
      const pend = (await ctx.sql(`SELECT kind, status, job_id, home FROM PendingWrite WHERE id = '${r.pendingId}'`))[0];
      ctx.check(pend?.kind === "data_entry" && pend.status === "pending" && pend.job_id === job && pend.home === ctx.POS.floor, `the proposal: ${JSON.stringify(pend)}`);
      const ev = (await audit(ctx, "mssql:dbo_Job:4471")).find((e) => e.pending_id === r.pendingId);
      ctx.check(ev?.outcome === "proposed" && ev.authorized_by === "bob" && ev.position === ctx.POS.floor, `audited as proposed for bob at the floor: ${JSON.stringify(ev)}`);
      ctx.check(JSON.parse(ev.change).fields.Quantity === 600, `the change says what: ${ev.change}`);
      const listed = (await ctx.api("/api/worker/proposals")).proposals.find((p) => p.id === r.pendingId);
      ctx.check(/writes Quantity = 600 to row 4471 of dbo_Job \(mssql\), for bob at floor/.test(listed?.lands?.[0] ?? ""), `says where it lands: ${JSON.stringify(listed?.lands)}`);
      // the thread is stopped until someone decides
      const more = await ctx.tool(ctx.workerToken(s, job), "enter_data", { claim_id: c, reason: "again" });
      ctx.check(/waiting on the admin/.test(more.error ?? ""), `nothing more changes: ${JSON.stringify(more).slice(0, 200)}`);
      await ctx.api(`/api/worker/proposals/${r.pendingId}`, { method: "POST", body: JSON.stringify({ approve: false, reason: "e2e" }) });
    },
  },
  {
    name: "a data entry by a worker acting for admins-only is applied and audited",
    run: async (ctx) => {
      const { job4471 } = await setup(ctx);
      fake.rows.dbo_Job[0].Status = "running";
      const s = await section(ctx, `${PREFIX} s4 done`, { person: "admin", position: ctx.POS.org, text: "Job 4471 shipped; it is done." });
      const c = await claim(ctx, s, job4471, { cls: "jobs", attribute: "status", value: "done", recorded_by: "admin", home: ctx.POS.org, subject: { key: "mssql:dbo_Job:4471" } });
      const job = ctx.randomUUID();
      const r = await ctx.tool(ctx.workerToken(s, job), "enter_data", { claim_id: c, reason: "shipped on the 8th" });
      ctx.check(r.outcome === "applied", `applied: ${JSON.stringify(r).slice(0, 300)}`);
      ctx.check(fake.rows.dbo_Job[0].Status === "done", "the row changed");
      const write = fake.calls.filter((x) => x.name === "update_record").at(-1);
      ctx.check(write && write.url.includes("/write") && write.args.entity === "dbo_Job" && write.args.keys.Job === 4471 && write.args.fields.Status === "done" && !("item" in write.args), `through the write-capable instance, in DAB's argument shape: ${JSON.stringify(write)}`);
      ctx.check(!(await ctx.sql(`SELECT id FROM PendingWrite WHERE job_id = '${job}'`)).length, "nothing proposed");
      const ev = (await audit(ctx, "mssql:dbo_Job:4471")).find((e) => e.id === r.audit);
      ctx.check(ev?.outcome === "applied" && ev.authorized_by === "admin" && ev.position === ctx.POS.org, `audited as applied for the admin: ${JSON.stringify(ev)}`);
      const change = JSON.parse(ev.change);
      ctx.check(change.before?.Status === "running" && change.after?.Status === "done", `before and after: ${ev.change}`);
      const wrote = await ctx.sql(`SELECT count(*) AS n FROM (SELECT expand(out('WROTE')) FROM AuditEvent WHERE id = '${r.audit}') WHERE key = 'mssql:dbo_Job:4471'`);
      ctx.check(Number(wrote[0]?.n) === 1, `WROTE to the row's reference: ${JSON.stringify(wrote)}`);
      // the same value again: nothing to enter, nothing audited
      const same = await ctx.tool(ctx.workerToken(s, ctx.randomUUID()), "enter_data", { claim_id: c, reason: "again" });
      ctx.check(same.outcome === "unchanged", `unchanged: ${JSON.stringify(same).slice(0, 200)}`);
    },
  },
  {
    // B2 (authorization half): the person the section names, as they stand now
    name: "a data entry is decided on the person's current standing: a name for a position, someone gone or moved, a queued identity",
    run: async (ctx) => {
      const { job4471 } = await setup(ctx);
      const setRow = () => {
        fake.rows.dbo_Job[0].Status = "running";
      };
      setRow();
      const entry = async (name, person, position, value = "on hold") => {
        const s = await section(ctx, `${PREFIX} ${name}`, { person, position, text: `Job 4471 is ${value}.` });
        const c = await claim(ctx, s, job4471, { cls: "jobs", attribute: "status", value, recorded_by: person, home: ctx.POS.floor, subject: { key: "mssql:dbo_Job:4471" } });
        return ctx.tool(ctx.workerToken(s, ctx.randomUUID()), "enter_data", { claim_id: c, reason: "e2e standing" });
      };
      // a position's display name typed where its id belongs: not the root, not anything
      const named = await entry("s6 name for position", "bob", "Operations");
      ctx.check(named.outcome === "refused" && /not a position/.test(named.note ?? ""), `a name reaches nothing: ${JSON.stringify(named).slice(0, 300)}`);
      // a position bob doesn't hold or sit under: he moved, or never was
      const moved = await entry("s6 moved", "bob", ctx.POS.ops);
      ctx.check(moved.outcome === "refused" && /moved/.test(moved.note ?? ""), `a moved person doesn't authorize: ${JSON.stringify(moved).slice(0, 300)}`);
      // nobody in the organization by that name any more
      const gone = await entry("s6 gone", "former-employee", ctx.POS.floor);
      ctx.check(gone.outcome === "refused" && /no longer in the organization/.test(gone.note ?? ""), `someone gone doesn't authorize: ${JSON.stringify(gone).slice(0, 300)}`);
      // a provisioned person (write: queued, as every non-admin is): their entries wait, even under no rule
      const queued = await entry("s6 queued", "dana", ctx.POS.floor, "shipped");
      ctx.check(queued.outcome === "proposed" && queued.pendingId, `a queued identity never gets direct: ${JSON.stringify(queued).slice(0, 300)}`);
      ctx.check(fake.rows.dbo_Job[0].Status === "running", `nothing written for any of them: ${JSON.stringify(fake.rows.dbo_Job[0])}`);
      const ev = (await audit(ctx, "mssql:dbo_Job:4471")).filter((e) => e.outcome === "refused").at(-1);
      ctx.check(ev?.authorized_by === "former-employee" && /no longer/.test(JSON.parse(ev.change).refused ?? ""), `the refusal says why: ${JSON.stringify(ev)}`);
      if (queued.pendingId) await ctx.api(`/api/worker/proposals/${queued.pendingId}`, { method: "POST", body: JSON.stringify({ approve: false, reason: "e2e" }) });
    },
  },
  {
    // B3: the columns written, not the claim's attribute
    name: "the authority decision covers every column written, not only the claim's attribute",
    run: async (ctx) => {
      const { job4471 } = await setup(ctx);
      const price = fake.rows.dbo_Job[0].Price;
      const s = await section(ctx, `${PREFIX} s7 stage and price`, { person: "bob", position: ctx.POS.floor, text: "Job 4471 is at inspection." });
      // bob holds jobs/stage at the floor; the worker tries to write Price on the strength of it (attributes.price: org)
      const c = await claim(ctx, s, job4471, { cls: "jobs", attribute: "stage", value: "inspection", recorded_by: "bob", home: ctx.POS.floor, subject: { key: "mssql:dbo_Job:4471" } });
      const r = await ctx.tool(ctx.workerToken(s, ctx.randomUUID()), "enter_data", { claim_id: c, fields: { Price: 1 }, reason: "the note implies it" });
      ctx.check(r.outcome === "proposed", `Price is decided, not just jobs/stage: ${JSON.stringify(r).slice(0, 300)}`);
      ctx.check(fake.rows.dbo_Job[0].Price === price, "Price is untouched");
      if (r.pendingId) await ctx.api(`/api/worker/proposals/${r.pendingId}`, { method: "POST", body: JSON.stringify({ approve: false, reason: "e2e" }) });
    },
  },
  {
    // B18: an approved entry is one event, naming the person who approved it
    name: "an approved entry yields one applied event, naming the person who approved it",
    run: async (ctx) => {
      const { job4472 } = await setup(ctx);
      fake.rows.dbo_Job[1].Quantity = 20;
      const s = await section(ctx, `${PREFIX} s8 approved`, { person: "bob", position: ctx.POS.floor, text: "Job 4472 is now 30 pieces." });
      const c = await claim(ctx, s, job4472, { cls: "orders", attribute: "quantity", value: 30, recorded_by: "bob", home: ctx.POS.floor, subject: { key: "mssql:dbo_Job:4472" } });
      const job = ctx.randomUUID();
      const r = await ctx.tool(ctx.workerToken(s, job), "enter_data", { claim_id: c, reason: "the floor says 30" });
      ctx.check(r.outcome === "proposed", `proposed first: ${JSON.stringify(r).slice(0, 300)}`);
      const decided = await ctx.api(`/api/worker/proposals/${r.pendingId}`, { method: "POST", body: JSON.stringify({ approve: true, reason: "approved" }) });
      ctx.check(!decided.error, `approved: ${JSON.stringify(decided).slice(0, 300)}`);
      ctx.check(fake.rows.dbo_Job[1].Quantity === 30, `the row changed: ${JSON.stringify(fake.rows.dbo_Job[1])}`);
      const events = (await audit(ctx, "mssql:dbo_Job:4472")).filter((e) => e.pending_id === r.pendingId);
      ctx.check(events.length === 1 && events[0].outcome === "applied", `one event for one approved write: ${JSON.stringify(events)}`);
      ctx.check(events[0]?.authorized_by === "admin", `it names the approver: ${JSON.stringify(events[0])}`);
      ctx.check(JSON.parse(events[0].change).proposed_for?.person === "bob", `who it was proposed for stays on it: ${events[0]?.change}`);
    },
  },
  {
    // B18: a write whose end was never recorded isn't hidden by a retry
    name: "a retry settles an attempt left open instead of reporting nothing to do",
    run: async (ctx) => {
      const { job4472 } = await setup(ctx);
      fake.rows.dbo_Job[1].Status = "finishing";
      const id = ctx.randomUUID();
      const change = JSON.stringify({ fields: { Status: "finishing" }, class: "jobs", attribute: "status" });
      const made = await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX AuditEvent SET id = '${id}', key = 'mssql:dbo_Job:4472', authorized_by = 'admin', acted_by = 'admin/worker:e2e', position = 'org', at = '${new Date().toISOString()}', change = '${q(change)}', outcome = 'attempted'` });
      ctx.check(!made.error, `open attempt made: ${JSON.stringify(made).slice(0, 200)}`);
      const s = await section(ctx, `${PREFIX} s10 retry`, { person: "admin", position: ctx.POS.org, text: "Job 4472 is finishing." });
      const c = await claim(ctx, s, job4472, { cls: "jobs", attribute: "status", value: "finishing", recorded_by: "admin", home: ctx.POS.org, subject: { key: "mssql:dbo_Job:4472" } });
      const r = await ctx.tool(ctx.workerToken(s, ctx.randomUUID()), "enter_data", { claim_id: c, reason: "the retry" });
      ctx.check(r.outcome === "reconciled" && r.settled?.[0]?.id === id, `the retry finds it: ${JSON.stringify(r).slice(0, 300)}`);
      const ev = (await ctx.sql(`SELECT outcome FROM AuditEvent WHERE id = '${id}'`))[0];
      ctx.check(ev?.outcome === "applied", `settled by what the row holds: ${JSON.stringify(ev)}`);
      const again = await ctx.tool(ctx.workerToken(s, ctx.randomUUID()), "enter_data", { claim_id: c, reason: "once more" });
      ctx.check(again.outcome === "unchanged", `nothing left open: ${JSON.stringify(again).slice(0, 200)}`);
    },
  },
  {
    // B19: the column and the row from the schema and a verified key
    name: "the column and the row are determined from the schema and a verified key, or the entry is refused",
    run: async (ctx) => {
      const { job4471 } = await setup(ctx);
      const s = await section(ctx, `${PREFIX} s9 credit`, { person: "bob", position: ctx.POS.floor, text: "Credit is fine." });
      // `credit` is a fragment of credit_status: not this column
      const c = await claim(ctx, s, job4471, { cls: "jobs", attribute: "credit", value: "great", recorded_by: "bob", home: ctx.POS.floor, subject: { key: "mssql:dbo_Job:4471" } });
      const w = ctx.workerToken(s, ctx.randomUUID());
      const r = await ctx.tool(w, "enter_data", { claim_id: c, reason: "no such column" });
      ctx.check(/no column named for credit/.test(r.error ?? ""), `a fragment is not a column: ${JSON.stringify(r).slice(0, 300)}`);
      ctx.check(fake.rows.dbo_Job[0].credit_status === "good", "credit_status is untouched");
      // a column that isn't the row's
      const bad = await ctx.tool(w, "enter_data", { claim_id: c, fields: { Credit: "great" }, reason: "column test" });
      ctx.check(/has no column Credit/.test(bad.error ?? ""), `a column the row hasn't: ${JSON.stringify(bad).slice(0, 300)}`);
      // the key column is the table's primary key, whatever the worker says
      const wrongKey = await ctx.tool(w, "enter_data", { claim_id: c, fields: { Status: "x" }, key_column: "Status", reason: "key test" });
      ctx.check(/not the primary key/.test(wrongKey.error ?? ""), `a key_column that isn't the key: ${JSON.stringify(wrongKey).slice(0, 300)}`);
      // the key column itself isn't written
      const keyCol = await ctx.tool(w, "enter_data", { claim_id: c, fields: { Job: 9999 }, reason: "key test" });
      ctx.check(/row's key/.test(keyCol.error ?? ""), `the row's key isn't written: ${JSON.stringify(keyCol).slice(0, 300)}`);
      // a thing with two record keys, and a claim that doesn't say which row
      const twoKeys = (await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = '${PREFIX} two keys (order)', label = '${PREFIX} two keys', _kind = 'thing', _thing_type = 'order', _norm = '${PREFIX} two keys', _alias_norms = [], _keys = ['mssql:dbo_Job:4471', 'mssql:dbo_Customer:TORO'], _homes = ['floor'], _home = 'org', updated_at = '${new Date().toISOString()}'` }));
      ctx.check(!twoKeys.error, `two-key thing: ${JSON.stringify(twoKeys).slice(0, 200)}`);
      const t = String((await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE name = '${PREFIX} two keys (order)'`))[0].rid);
      const s2 = await section(ctx, `${PREFIX} s9 two keys`, { person: "admin", position: ctx.POS.org, text: "Status is done." });
      const c2 = await claim(ctx, s2, t, { cls: "e2e_no_table", attribute: "status", value: "two-key-target", recorded_by: "admin", home: ctx.POS.org, subject: {} });
      const before = fake.rows.dbo_Job[0].Status;
      const w2 = ctx.workerToken(s2, ctx.randomUUID());
      const r2 = await ctx.tool(w2, "enter_data", { claim_id: c2, reason: "which row?" });
      ctx.check(/several record keys/.test(r2.error ?? ""), `never the first key: ${JSON.stringify(r2).slice(0, 300)}`);
      ctx.check(fake.rows.dbo_Job[0].Status === before, "no write");
      // a subject resolved to a key the source has no row for: the entry is refused at the row, whatever the graph holds
      const s3 = await section(ctx, `${PREFIX} s9 resolve`, { person: "admin", position: ctx.POS.org, text: "Job 9999 is running." });
      const u = await claim(ctx, s3, s3, { cls: "jobs", attribute: "status", value: "running", recorded_by: "admin", home: ctx.POS.org, subject: { name: `${PREFIX} job 9999` } });
      const w3 = ctx.workerToken(s3, ctx.randomUUID());
      const resolved = await ctx.tool(w3, "resolve_subject", { claim_id: u, thing: { key: "mssql:dbo_Job:9999", name: `${PREFIX} job 9999`, type: "order" }, reason: "e2e" });
      ctx.check(!resolved.thing && /no such row/.test(resolved.error ?? ""), `no instance is made of a row the source doesn't hold: ${JSON.stringify(resolved).slice(0, 300)}`);
      // a thing already holding such a key (made before the check, or while no source could say): the entry is still refused at the row
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = '${PREFIX} phantom 9999', label = '${PREFIX} phantom 9999', _kind = 'thing', _norm = 'phantom 9999', _keys = ['mssql:dbo_Job:9999'], _homes = ['org'], _home = 'org', _thing_type = 'order'` });
      const phantom = String((await ctx.sql("SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND _keys CONTAINS 'mssql:dbo_Job:9999'"))[0].rid);
      const phantomClaim = await claim(ctx, s3, phantom, { cls: "jobs", attribute: "status", value: "running", recorded_by: "admin", home: ctx.POS.org, subject: { key: "mssql:dbo_Job:9999" } });
      const updates = fake.calls.filter((x) => x.name === "update_record").length;
      const noRow = await ctx.tool(w3, "enter_data", { claim_id: phantomClaim, fields: { Status: "x" }, reason: "e2e no row" });
      ctx.check(/no such row/.test(noRow.error ?? ""), `an unverified key writes nothing: ${JSON.stringify(noRow).slice(0, 300)}`);
      ctx.check(fake.calls.filter((x) => x.name === "update_record").length === updates, "no update was sent");
      const row = (await ctx.sql(`SELECT _keys FROM ${job4471}`))[0];
      ctx.check(!(row?._keys ?? []).includes("mssql:dbo_Job:9999"), `not on the job's thing: ${JSON.stringify(row)}`);
    },
  },
  {
    name: "a brief above the worker's floor is refused at brief time",
    run: async (ctx) => {
      const { job4472 } = await setup(ctx);
      const before = (await ctx.api("/api/worker")).pool;
      await ctx.api("/api/worker", { method: "PUT", body: JSON.stringify({ pool: { poolSize: Math.max(2, before.poolSize ?? 0) } }) });
      try {
        // a floor section about job 4472, and an admins-only section with a prior claim on the same attribute
        const sFloor = await section(ctx, `${PREFIX} s5 floor`, { person: "bob", position: ctx.POS.floor, text: "Job 4472 is running again." });
        const cFloor = await claim(ctx, sFloor, job4472, { cls: "jobs", attribute: "operator", value: "Diep", recorded_by: "bob", home: ctx.POS.floor, subject: { key: "mssql:dbo_Job:4472" } });
        const sTop = await section(ctx, `${PREFIX} s5 top`, { person: "admin", position: ctx.POS.org, text: "Job 4472 runs with the secret-zinnober operator." });
        await claim(ctx, sTop, job4472, { cls: "jobs", attribute: "operator", value: "secret-zinnober", valid_from: "2026-11-01T09:00:00.000Z", recorded_by: "admin", home: ctx.POS.org, subject: { key: "mssql:dbo_Job:4472" } });
        const now = new Date(Date.now() - 1000).toISOString();
        const insertJob = async (payload) => {
          const id = ctx.randomUUID();
          const r = await ctx.tool("admin", "execute_graph", { language: "sql", command: `INSERT INTO Job SET id = '${id}', kind = 'review', job_key = 'e2e:${id}', payload = '${q(JSON.stringify(payload))}', status = 'pending', attempts = 0, priority = 9, run_after = '${now}', created_at = '${now}', updated_at = '${now}'` });
          ctx.check(!r.error, `job inserted: ${JSON.stringify(r).slice(0, 200)}`);
          return id;
        };
        // one worker over sections seen from two positions: refused when its brief is composed, never started
        const mixed = await insertJob({ rid: sFloor, sections: [sFloor, sTop], parent: "master", label: "e2e mixed", level: 1 });
        // the floor section alone: its brief carries nothing from above the floor
        const alone = await insertJob({ rid: sFloor, sections: [sFloor], level: 1 });
        const got = await ctx.api("/api/worker/threads/claim", { method: "POST", body: JSON.stringify({ limit: 5 }) });
        const threads = got.threads ?? [];
        ctx.check(!threads.some((t) => t.job === mixed), `the mixed brief never reaches a worker: ${JSON.stringify(threads.map((t) => t.job))}`);
        const row = (await ctx.sql(`SELECT status, summary FROM Job WHERE id = '${mixed}'`))[0];
        ctx.check(row?.status === "failed" && /brief refused/.test(row.summary ?? ""), `refused at brief time: ${JSON.stringify(row)}`);
        ctx.check(/seen from different positions/.test(row.summary ?? ""), `says why: ${row.summary}`);
        ctx.check(!/secret-zinnober/.test(row.summary ?? ""), "the refusal quotes nothing from above");
        const signal = (await ctx.sql(`SELECT kind, data FROM Signal WHERE job_id = '${mixed}'`))[0];
        ctx.check(signal?.kind === "stopped" && /brief was refused/.test(signal.data ?? ""), `the master hears it stopped: ${JSON.stringify(signal)}`);
        const own = threads.find((t) => t.job === alone);
        ctx.check(own, `the floor section's worker starts: ${JSON.stringify(threads.map((t) => t.job))}`);
        ctx.check(own.message.includes(cFloor) && /Seen from: Production floor/.test(own.message), `its brief holds its own claim: ${own.message.slice(0, 300)}`);
        ctx.check(!own.message.includes("secret-zinnober"), "and nothing recorded above the floor");
        ctx.check(/jobs\/operator/.test(own.name) && !/running again/.test(own.name), `its label names the claim's class and attribute, not the text: ${own.name}`);
        // the brief is a read: recorded against the thread once its agent is named
        const agent = `e2e-agent-${alone.slice(0, 8)}`;
        await ctx.api(`/api/worker/threads/${alone}/agent`, { method: "POST", body: JSON.stringify({ agent_id: agent }) });
        const mark = await ctx.until("the brief recorded as a read", async () => (await ctx.sql(`SELECT who, pos FROM ReadMark WHERE who = 'admin/agent:${agent}'`))[0] ?? false, 30_000);
        ctx.check(mark.pos === ctx.POS.floor, `read at the floor: ${JSON.stringify(mark)}`);
        await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Job SET status = 'done' WHERE id IN ['${mixed}', '${alone}']` });
      } finally {
        await ctx.api("/api/worker", { method: "PUT", body: JSON.stringify({ pool: before }) });
      }
    },
  },
];
