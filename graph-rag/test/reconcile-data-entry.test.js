import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeDb, storing } from "./audit.test.js";
import { applyProposedEntry, authorityMapFor, authorityPolicy, columnFor, confirmAgainstRow, DAB_CALLS, decideWrite, describeEntry, enterData, forgetAuthorityPolicy, forgetSources, keyColumnFrom, mcpToolCall, odata, rowsOf, sameValue, sourceClient, sourcesConfig } from "../src/data-entry.js";
import { parsePositionMap } from "../src/positions.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const map = parsePositionMap(read("positions.json"));
const policyJson = JSON.stringify(read("policy.json"));

/** a fake DAB: an MCP endpoint over fetch with one table, recording the tool calls it saw */
function fakeDab(rows, { failWrite = false } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const reply = (result) => ({ ok: true, status: 200, headers: { get: (h) => (h === "mcp-session-id" ? "s1" : null) }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26" });
    const { name, arguments: args } = body.params;
    calls.push({ url, name, args });
    if (name === "describe_entities") return reply({ content: [{ type: "text", text: JSON.stringify({ entities: [{ name: "dbo_Job", fields: [{ name: "Job", isPrimaryKey: true }, { name: "Status" }, { name: "Quantity" }] }] }) }] });
    if (name === "read_records") {
      const m = /^(\w+) eq (.+)$/.exec(args.filter);
      const v = m[2].replace(/^'|'$/g, "");
      return reply({ content: [{ type: "text", text: JSON.stringify({ records: rows.filter((r) => String(r[m[1]]) === v) }) }] });
    }
    if (name === "update_record") {
      if (failWrite) return reply({ isError: true, content: [{ type: "text", text: "permission denied for update" }] });
      const r = rows.find((x) => Object.entries(args.keys).every(([k, v]) => String(x[k]) === String(v)));
      Object.assign(r, args.item);
      return reply({ content: [{ type: "text", text: JSON.stringify({ updated: 1 }) }] });
    }
    return reply({ isError: true, content: [{ type: "text", text: `no tool ${name}` }] });
  };
  return { fetch, calls, rows };
}

const policyDb = (db) => {
  db.policyRows = (params, sql) => (sql.includes("'authority'") ? [{ json: policyJson }] : sql.includes("'sources'") ? [{ json: JSON.stringify({ mssql: { read: "http://fake/read", write: "http://fake/write" } }) }] : []);
  return db;
};

test.beforeEach(() => {
  forgetSources();
  forgetAuthorityPolicy();
});

test("a claim is confirmed when the row's column for its attribute holds its value", () => {
  const row = { Job: 4471, Status: "Running", Quantity: 500, Due_Date: "2026-11-20T00:00:00" };
  assert.equal(columnFor("status", row), "Status");
  assert.equal(columnFor("due_date", row), "Due_Date");
  assert.equal(columnFor("stage", row), null);
  assert.ok(sameValue("Running", "running"));
  assert.ok(sameValue(500, "500"));
  assert.ok(sameValue("2026-11-20", "2026-11-20T00:00:00"));
  assert.ok(!sameValue(500, "5000"));
  assert.ok(!sameValue(null, "x"));
  assert.deepEqual(confirmAgainstRow({ attribute: "status", value: "running" }, row), { confirmed: true, column: "Status", row_value: "Running", claim_value: "running", reason: "the row holds the claimed value" });
  assert.equal(confirmAgainstRow({ attribute: "quantity", value: "600", value_num: 600 }, row).confirmed, false);
  assert.equal(confirmAgainstRow({ attribute: "stage", value: "running" }, row).column, null, "an attribute the row doesn't record is neither confirmed nor denied");
  assert.match(confirmAgainstRow({ attribute: "status", value: "running" }, null).reason, /no such row/);
});

test("DAB's answers: rows out of any wrapper, the key column out of a description, OData literals", () => {
  assert.deepEqual(rowsOf({ records: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(rowsOf({ value: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(rowsOf([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(rowsOf("nothing"), []);
  assert.equal(keyColumnFrom({ entities: [{ name: "dbo_Job", fields: [{ name: "Job", isPrimaryKey: true }, { name: "Status" }] }] }, "dbo_Job"), "Job");
  assert.equal(keyColumnFrom({ entities: [{ name: "dbo_Job", primaryKey: ["Job"] }] }, "dbo_Job"), "Job");
  assert.equal(keyColumnFrom({ entities: [{ name: "dbo_Job", fields: [{ name: "Job" }] }] }, "dbo_Job"), null);
  assert.equal(keyColumnFrom({ entities: [] }, "dbo_Job"), null);
  assert.equal(odata(4471), "4471");
  assert.equal(odata("4471"), "4471");
  assert.equal(odata("O'Neil"), "'O''Neil'");
  assert.deepEqual(DAB_CALLS.read("dbo_Job", "Job", "4471"), { name: "read_records", args: { entity: "dbo_Job", filter: "Job eq 4471", first: 2 } });
});

test("the source client reads a row by key (learning the key column once) and writes through the write endpoint only", async () => {
  const dab = fakeDab([{ Job: 4471, Status: "running", Quantity: 500 }]);
  const c = sourceClient("mssql", { read: "http://fake/read", write: null }, { fetch: dab.fetch });
  const hit = await c.readRow("dbo_Job", "4471");
  assert.deepEqual(hit, { row: { Job: 4471, Status: "running", Quantity: 500 }, key_column: "Job" });
  assert.equal(await c.readRow("dbo_Job", "9999"), null);
  assert.deepEqual(dab.calls.map((x) => x.name), ["describe_entities", "read_records", "read_records"], "the key column is asked for once");
  await assert.rejects(c.writeRow("dbo_Job", "4471", { Status: "done" }), /no write-capable endpoint/);
  const w = sourceClient("mssql", { read: "http://fake/read", write: "http://fake/write" }, { fetch: dab.fetch });
  await w.writeRow("dbo_Job", "4471", { Status: "done" });
  const last = dab.calls.at(-1);
  assert.equal(last.url, "http://fake/write");
  assert.deepEqual(last.args, { entity: "dbo_Job", keys: { Job: "4471" }, item: { Status: "done" } });
  assert.equal(dab.rows[0].Status, "done");
  // a tool error is an error, not a row
  const bad = sourceClient("mssql", { read: "http://fake/read", write: "http://fake/write" }, { fetch: fakeDab([], { failWrite: true }).fetch });
  await assert.rejects(bad.writeRow("dbo_Job", "4471", { Status: "x" }), /permission denied/);
  await assert.rejects(mcpToolCall("http://x", "t", {}, { fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "down" }) }), /500/);
});

test("where the sources are: the environment's, with the organization's stored ones over them", async () => {
  const bare = fakeDb();
  process.env.DAB_READ_URL = "http://dab:5000/mcp";
  delete process.env.DAB_WRITE_URL;
  const env = await sourcesConfig(bare);
  assert.deepEqual(env, { mssql: { read: "http://dab:5000/mcp", write: null } });
  forgetSources();
  const stored = await sourcesConfig(policyDb(fakeDb()));
  assert.deepEqual(stored, { mssql: { read: "http://fake/read", write: "http://fake/write" } });
});

test("the authority rule, stubbed over the stored policy: direct at or above the authority, propose below, hidden beside", async () => {
  const db = policyDb(fakeDb());
  const p = await authorityPolicy(db, { positions: map });
  assert.equal(p.classes.orders.authority, "ops");
  const bob = { positions: ["floor"], caps: { write: "direct" } };
  const admin = { positions: ["org"], caps: { write: "direct" } };
  assert.equal(await decideWrite(bob, "jobs", "stage", { positions: map, db }), "direct");
  assert.equal(await decideWrite(bob, "orders", "quantity", { positions: map, db }), "propose");
  assert.equal(await decideWrite(bob, "orders", "price", { positions: map, db }), "propose");
  assert.equal(await decideWrite(admin, "orders", "price", { positions: map, db }), "direct");
  // the map the rule runs over: the one given, else the stored row (the live policy has no rule in a test)
  assert.deepEqual(await authorityMapFor({ policy: { classes: { x: { authority: "ops" } }, attributes: {} }, positions: map, db }), { classes: { x: { authority: "ops" } }, attributes: {} });
  assert.equal((await authorityMapFor({ positions: map, db })).classes.orders.authority, "ops");
  // no stored policy: no rule, the writer's own position holds it
  forgetAuthorityPolicy();
  assert.equal(await decideWrite(bob, "orders", "price", { positions: map, db: fakeDb() }), "direct");
  // no position map loaded: nothing is direct
  assert.equal(await decideWrite(bob, "orders", "price", { positions: null, db }), "propose");
});

test("data entry for a floor person on an Operations class is proposed and audited; for an admin it is applied and audited", { skip: storing }, async () => {
  const db = policyDb(fakeDb());
  const dab = fakeDab([{ Job: 4471, Status: "running", Quantity: 500 }]);
  const queued = [];
  const queue = async (entry) => (queued.push(entry), { queued: true, pendingId: "pend-1" });
  const proposal = (identity, reason) => ({ note: reason, job: identity?.role?.job ?? null });
  const floor = await enterData(
    { actsFor: { person: "bob", position: "floor" }, by: "admin/worker:aa", key: "mssql:dbo_Job:4471", fields: { Quantity: 600 }, cls: "orders", attribute: "quantity", reason: "the note says 600", identity: { role: { kind: "worker", job: "j1" } } },
    { db, fetch: dab.fetch, positions: map, queue, proposal },
  );
  assert.equal(floor.outcome, "proposed");
  assert.equal(floor.pendingId, "pend-1");
  assert.equal(queued[0].kind, "data_entry");
  assert.equal(queued[0].home, "floor");
  assert.equal(queued[0].job, "j1");
  assert.deepEqual(JSON.parse(queued[0].payload).fields, { Quantity: 600 });
  assert.equal(dab.rows[0].Quantity, 500, "nothing written to the source");
  let ev = db.events.find((e) => e.id === floor.audit);
  assert.equal(ev.outcome, "proposed");
  assert.equal(ev.pending_id, "pend-1");
  assert.equal(ev.authorized_by, "bob");
  assert.equal(ev.position, "floor");
  // the approver applies it: the row changes, the event follows
  const applied = await applyProposedEntry(queued[0].payload, "pend-1", "alice", { db, fetch: dab.fetch });
  assert.equal(applied.outcome, "applied");
  assert.equal(dab.rows[0].Quantity, 600);
  assert.equal(db.events.find((e) => e.id === floor.audit).outcome, "applied", "the proposed event is settled");
  assert.equal(db.events.find((e) => e.id === applied.audit).authorized_by, "alice");
  // an admin writes directly
  const admin = await enterData(
    { actsFor: { person: "admin", position: "org" }, by: "admin/worker:bb", key: "mssql:dbo_Job:4471", fields: { Status: "done" }, cls: "jobs", attribute: "stage", reason: "shipped" },
    { db, fetch: dab.fetch, positions: map, queue, proposal },
  );
  assert.equal(admin.outcome, "applied");
  assert.equal(dab.rows[0].Status, "done");
  ev = db.events.find((e) => e.id === admin.audit);
  assert.equal(ev.outcome, "applied");
  assert.deepEqual(JSON.parse(ev.change).before, { Status: "running" });
  assert.deepEqual(JSON.parse(ev.change).after, { Status: "done" });
  assert.equal(queued.length, 1, "nothing more proposed");
  // the source refuses: failed, and audited as such
  const refused = await enterData(
    { actsFor: { person: "admin", position: "org" }, by: "admin/worker:cc", key: "mssql:dbo_Job:4471", fields: { Status: "x" }, cls: "jobs", attribute: "stage" },
    { db, fetch: fakeDab([{ Job: 4471 }], { failWrite: true }).fetch, positions: map, queue, proposal },
  );
  assert.equal(refused.outcome, "failed");
  assert.match(refused.error, /permission denied/);
  assert.equal(db.events.find((e) => e.id === refused.audit).outcome, "failed");
  // a person on another branch: refused, audited, nothing proposed
  const wide = parsePositionMap({ ...read("positions.json"), positions: { ...read("positions.json").positions, sales: { name: "Sales", parent: "org" } } });
  forgetAuthorityPolicy();
  const hidden = await enterData(
    { actsFor: { person: "sam", position: "sales" }, by: "admin/worker:dd", key: "mssql:dbo_Job:4471", fields: { Status: "paused" }, cls: "jobs", attribute: "stage" },
    { db, fetch: dab.fetch, positions: wide, queue, proposal },
  );
  assert.equal(hidden.outcome, "refused");
  assert.match(hidden.note, /holds no authority/);
  assert.equal(db.events.find((e) => e.id === hidden.audit).outcome, "refused");
  assert.equal(queued.length, 1);
  assert.equal(dab.rows[0].Status, "done");
  // bad input never reaches the source or the trail
  await assert.rejects(enterData({ actsFor: { person: "bob", position: "floor" }, by: "w", key: "4471", fields: { a: 1 } }, { db, positions: map }), /not a record key/);
  await assert.rejects(enterData({ actsFor: { person: "bob", position: "floor" }, by: "w", key: "mssql:dbo_Job:4471", fields: {} }, { db, positions: map }), /fields/);
  assert.match(describeEntry(queued[0].payload)[0], /writes Quantity = 600 to row 4471 of dbo_Job \(mssql\), for bob at floor/);
});
