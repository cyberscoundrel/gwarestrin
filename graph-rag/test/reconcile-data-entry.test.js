import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeDb, storing } from "./audit.test.js";
import { dabTool } from "../e2e/fake-dab-core.mjs";
import { applyProposedEntry, approvingPerson, assertWritable, authorityMapFor, authorityPolicy, columnFor, confirmAgainstRow, DAB_CALLS, decideWrite, decisionKeys, describeEntry, enterData, fieldsForClaim, forgetAuthorityPolicy, forgetPrimaryKeys, forgetSources, mcpToolCall, odata, primaryKeyFrom, rowKeyFor, rowsOf, sameValue, settleOpenAttempts, sourceClient, sourcesConfig, standingOf } from "../src/data-entry.js";
import { parseKey } from "../src/model/schema.js";
import { parsePositionMap } from "../src/positions.js";
import { decide } from "../src/model/authority.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const map = parsePositionMap(read("positions.json"));
const policyJson = JSON.stringify(read("policy.json"));

/** a fake DAB: an MCP endpoint over fetch over fake-dab-core.mjs (DAB 2.0.12's tools), recording the tool calls it saw */
function fakeDab(rows, { failWrite = false, breakWrite = false, table = "dbo_Job", primaryKey = ["Job"] } = {}) {
  const calls = [];
  const tables = { [table]: { primaryKey, rows } };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const reply = (result) => ({ ok: true, status: 200, headers: { get: (h) => (h === "mcp-session-id" ? "s1" : null) }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26" });
    const { name, arguments: args } = body.params;
    calls.push({ url, name, args });
    const write = String(url).includes("write");
    if (name === "update_record" && failWrite) return reply({ isError: true, content: [{ type: "text", text: JSON.stringify({ toolName: name, status: "error", error: { type: "Error", message: "permission denied for update" } }) }] });
    if (name === "update_record" && breakWrite) {
      // the transport breaks after the source acted (or didn't)
      if (breakWrite === "after-apply") dabTool(tables, name, args, { write });
      throw new Error("socket hang up");
    }
    return reply(dabTool(tables, name, args, { write }));
  };
  return { fetch, calls, rows };
}

const policyDb = (db) => {
  db.policyRows = (params, sql) => (sql.includes("'authority'") ? [{ json: policyJson }] : sql.includes("'sources'") ? [{ json: JSON.stringify({ mssql: { read: "http://fake/read", write: "http://fake/write" } }) }] : []);
  return db;
};

// who the token map says each person is now (the provisioner's: every non-admin writes queued; bob and sam here write direct so the rule's answer shows)
const people = {
  bob: { positions: ["floor"], caps: { read: true, write: "direct" } },
  admin: { positions: ["org"], caps: { read: true, write: "direct", approve: true } },
  alice: { positions: ["ops"], caps: { read: true, write: "direct", approve: true } },
  dana: { positions: ["floor"], caps: { read: true, write: "queued" } },
  gone: { positions: ["floor"], caps: { read: false, write: "deny" } },
  hana: { positions: ["hr"], caps: { read: true, write: "direct" } },
};
const lookup = (name) => people[name];

test.beforeEach(() => {
  forgetSources();
  forgetAuthorityPolicy();
  forgetPrimaryKeys();
});

test("a claim is confirmed when the row's column named for its attribute holds its value", () => {
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

test("B19: a column is never guessed by name fragment", () => {
  const row = { Job: 4471, credit_status: "good", job_status: "open", created_date: "2026-01-02" };
  assert.equal(columnFor("status", row), null, "status is neither credit_status nor job_status");
  assert.equal(columnFor("date", row), null, "date is not created_date");
  assert.equal(columnFor("status", { Status: 1, status: 2 }), null, "two columns alike: no determination");
  assert.equal(confirmAgainstRow({ attribute: "status", value: "good" }, row).column, null);
  assert.throws(() => assertWritable({ Nope: 1 }, { row, key_column: "Job" }), /has no column Nope/);
  assert.throws(() => assertWritable({ Job: 1 }, { row, key_column: "Job" }), /row's key/);
});

test("B19: the row is the key the claim's subject names, the one in its class's table, or the thing's only key; never the first", () => {
  const keys = ["mssql:dbo_Job:4471", "mssql:dbo_Customer:TORO"].map(parseKey);
  assert.equal(rowKeyFor({ subjectKey: "mssql:dbo_Customer:TORO", keys, recordTable: null }).key.key, "mssql:dbo_Customer:TORO");
  assert.equal(rowKeyFor({ subjectKey: null, keys, recordTable: "mssql:dbo_Job" }).key.key, "mssql:dbo_Job:4471");
  assert.equal(rowKeyFor({ subjectKey: null, keys: [keys[1]], recordTable: null }).key.key, "mssql:dbo_Customer:TORO");
  const several = rowKeyFor({ subjectKey: null, keys, recordTable: null });
  assert.equal(several.key, null);
  assert.match(several.why, /several record keys/);
  assert.equal(rowKeyFor({ subjectKey: null, keys: ["mssql:dbo_Job:1", "mssql:dbo_Job:2"].map(parseKey), recordTable: "mssql:dbo_Job" }).key, null, "several rows of its table: refused");
  assert.equal(rowKeyFor({ subjectKey: null, keys: [keys[1]], recordTable: "mssql:dbo_Job" }).key, null, "no key in its table: refused");
});

test("B20: DAB's answers as they are: rows under result.value, the primary key out of the cursor, literals by column type", () => {
  assert.deepEqual(rowsOf({ entity: "dbo_Job", result: { value: [{ a: 1 }] }, status: "success" }), [{ a: 1 }]);
  assert.deepEqual(rowsOf({ value: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(rowsOf([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(rowsOf("nothing"), []);
  const after = (cols) => Buffer.from(JSON.stringify(cols)).toString("base64");
  assert.deepEqual(primaryKeyFrom({ result: { value: [], after: after([{ EntityName: "dbo_Job", FieldName: "Job", FieldValue: 4471, Direction: 0 }]) } }, "dbo_Job"), [{ name: "Job", type: "number" }]);
  assert.deepEqual(primaryKeyFrom({ result: { after: after([{ EntityName: "dbo_Line", FieldName: "Order", FieldValue: 7, Direction: 0 }, { EntityName: "dbo_Line", FieldName: "Line", FieldValue: 1, Direction: 0 }]) } }, "dbo_Line"), [{ name: "Order", type: "number" }, { name: "Line", type: "number" }]);
  assert.deepEqual(primaryKeyFrom({ result: { after: after([{ EntityName: "dbo_Customer", FieldName: "Customer", FieldValue: "00123", Direction: 0 }]) } }, "dbo_Customer"), [{ name: "Customer", type: "string" }]);
  assert.equal(primaryKeyFrom({ result: { value: [{ Job: 1 }] } }, "dbo_Job"), null, "no cursor: not known");
  assert.equal(primaryKeyFrom({ result: { after: "not-base64-json" } }, "dbo_Job"), null);
  assert.equal(primaryKeyFrom({ result: { after: after([{ EntityName: "dbo_Other", FieldName: "X" }]) } }, "dbo_Job"), null, "another entity's cursor");
  assert.equal(odata("4471", "number"), "4471");
  assert.equal(odata("abc", "number"), null, "a non-number can't be a number column's key");
  assert.equal(odata("1234", "string"), "'1234'", "a numeric-looking key in a text column stays text");
  assert.equal(odata("O'Neil", "string"), "'O''Neil'");
  assert.deepEqual(DAB_CALLS.read("dbo_Job", "Job", "4471"), { name: "read_records", args: { entity: "dbo_Job", filter: "Job eq 4471", first: 2 } });
  assert.deepEqual(DAB_CALLS.update("dbo_Job", { Job: 1 }, { Status: "x" }), { name: "update_record", args: { entity: "dbo_Job", keys: { Job: 1 }, fields: { Status: "x" } } });
  assert.deepEqual(DAB_CALLS.create("dbo_Job", { Job: 1 }), { name: "create_record", args: { entity: "dbo_Job", data: { Job: 1 } } });
});

test("B20: the fake DAB refuses what DAB 2.0.12 refuses", () => {
  const tables = { dbo_Job: { primaryKey: ["Job"], rows: [{ Job: 4471, Status: "running" }, { Job: 4472, Status: "x" }] } };
  const text = (r) => JSON.parse(r.content[0].text);
  assert.match(text(dabTool(tables, "update_record", { entity: "dbo_Job", keys: { Job: 4471 }, item: { Status: "x" } }, { write: true })).error.message, /Missing required argument 'fields'/);
  assert.match(text(dabTool(tables, "create_record", { entity: "dbo_Job", item: { Job: 1 } }, { write: true })).error.message, /Missing required argument 'data'/);
  assert.match(text(dabTool(tables, "update_record", { entity: "dbo_Job", keys: { Status: "x" }, fields: { Status: "y" } }, { write: true })).error.message, /Primary key column\(s\) provided do not match/);
  assert.match(text(dabTool(tables, "update_record", { entity: "dbo_Job", keys: { Job: 1 }, fields: { Status: "y" } }, { write: true })).error.message, /No record found/);
  assert.match(text(dabTool(tables, "update_record", { entity: "dbo_Job", keys: { Job: 4471 }, fields: { Job: 9 } }, { write: true })).error.message, /Invalid request body/);
  assert.match(text(dabTool(tables, "update_record", { entity: "dbo_Job", keys: { Job: 4471 }, fields: { Status: "y" } })).error.message, /Permission denied/, "the read-only instance");
  assert.match(text(dabTool(tables, "read_records", { entity: "dbo_Job", filter: "Job eq '4471'" })).error.message, /incompatible types/);
  assert.match(text(dabTool(tables, "read_records", { entity: "dbo_Job", filter: "Status eq 1" })).error.message, /incompatible types/);
  assert.deepEqual(text(dabTool(tables, "describe_entities", {})).entities[0].fields, [], "describe_entities names no fields, so no key");
  assert.equal(text(dabTool(tables, "update_record", { entity: "dbo_Job", keys: { Job: 4471 }, fields: { Status: "done" } }, { write: true })).result.Status, "done");
  const made = text(dabTool(tables, "create_record", { entity: "dbo_Job", data: { Job: 9, Status: "new" } }, { write: true }));
  assert.deepEqual(made.result.value, [{ Job: 9, Status: "new" }]);
  assert.equal(tables.dbo_Job.rows.length, 3);
});

test("B20: the source client finds the row by its learned primary key and writes through the write endpoint, in DAB's argument shape", async () => {
  const dab = fakeDab([{ Job: 4471, Status: "running", Quantity: 500 }, { Job: 4472, Status: "planned", Quantity: 20 }]);
  const c = sourceClient("mssql", { read: "http://fake/read", write: null }, { fetch: dab.fetch });
  const hit = await c.readRow("dbo_Job", "4471");
  assert.deepEqual(hit, { row: { Job: 4471, Status: "running", Quantity: 500 }, key_column: "Job", key_value: 4471 });
  assert.equal(await c.readRow("dbo_Job", "9999"), null);
  assert.deepEqual(dab.calls.map((x) => x.name), ["read_records", "read_records", "read_records"], "the first page once, then the rows");
  assert.deepEqual(dab.calls[0].args, { entity: "dbo_Job", first: 1 });
  await assert.rejects(c.writeRow("dbo_Job", hit, { Status: "done" }), /no write-capable endpoint/);
  await assert.rejects(c.readRow("dbo_Job", "4471", { key_column: "Status" }), /not the primary key/, "a worker's key_column is checked");
  assert.deepEqual((await c.readRow("dbo_Job", "4471", { key_column: "Job" })).key_value, 4471);
  const w = sourceClient("mssql", { read: "http://fake/read", write: "http://fake/write" }, { fetch: dab.fetch });
  await w.writeRow("dbo_Job", hit, { Status: "done" });
  const last = dab.calls.at(-1);
  assert.equal(last.url, "http://fake/write");
  assert.deepEqual(last.args, { entity: "dbo_Job", keys: { Job: 4471 }, fields: { Status: "done" } }, "the write carries the verified key as the row holds it");
  assert.equal(dab.rows[0].Status, "done");
  // a tool error is an error, not a row
  const bad = sourceClient("mssql", { read: "http://fake/read", write: "http://fake/write" }, { fetch: fakeDab([{ Job: 4471, Status: "a" }, { Job: 4472, Status: "b" }], { failWrite: true }).fetch });
  const badHit = await bad.readRow("dbo_Job", "4471");
  await assert.rejects(bad.writeRow("dbo_Job", badHit, { Status: "x" }), /permission denied/);
  await assert.rejects(mcpToolCall("http://x", "t", {}, { fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "down" }) }), /500/);
});

test("B20: a key the source can't confirm, or that spans columns, refuses the read", async () => {
  // a table of one row: no second page, so no cursor naming the key
  const one = sourceClient("mssql", { read: "http://fake/one", write: "http://fake/w" }, { fetch: fakeDab([{ Job: 1, Status: "x" }]).fetch });
  await assert.rejects(one.readRow("dbo_Job", "1"), /can't be learned/);
  const comp = sourceClient("mssql", { read: "http://fake/two", write: "http://fake/w2" }, { fetch: fakeDab([{ Order: 7, Line: 1, Qty: 1 }, { Order: 7, Line: 2, Qty: 2 }], { table: "dbo_Line", primaryKey: ["Order", "Line"] }).fetch });
  await assert.rejects(comp.readRow("dbo_Line", "7"), /composite primary key/);
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

test("B2: a person's standing is who they are now, from the token map and the tree; a name or a stale position reaches nothing", () => {
  // a position's display name where its id belongs: not the root, not anything
  assert.deepEqual(standingOf({ person: "bob", position: "Operations" }, people.bob, map).ok, false);
  assert.match(standingOf({ person: "bob", position: "Operations" }, people.bob, map).why, /not a position/);
  // the recorded position decides nothing: bob, recording at the root, still stands at the floor
  assert.match(standingOf({ person: "bob", position: "org" }, people.bob, map).why, /moved/);
  // a person moved up or sideways: the record is not theirs any more
  assert.match(standingOf({ person: "bob", position: "floor" }, { positions: ["ops"], caps: { read: true, write: "direct" } }, map).why, /moved/);
  // gone: no entry, or locked out by the provisioner, or holding no position
  assert.match(standingOf({ person: "x", position: "floor" }, undefined, map).why, /no longer in the organization/);
  assert.match(standingOf({ person: "gone", position: "floor" }, people.gone, map).why, /no longer in the organization/);
  assert.match(standingOf({ person: "y", position: "floor" }, { positions: [], caps: { read: true, write: "direct" } }, map).why, /no position/);
  assert.match(standingOf({ person: "y", position: "floor" }, { positions: ["unknown"], caps: { read: true, write: "direct" } }, map).why, /no position/, "a position the tree doesn't have is none");
  // an agent's record counts as its person; the rest of the identity is what the rule reads
  const ok = standingOf({ person: "bob/agent:abcd", position: "floor" }, people.bob, map);
  assert.deepEqual([ok.ok, ok.person, ok.position, ok.identity.positions], [true, "bob", "floor", ["floor"]]);
  assert.deepEqual(standingOf({ person: "dana", position: "floor" }, people.dana, map).identity.caps, { write: "queued" }, "the real write capability");
  // no recorded position: nothing to check, the person's own default stands in
  assert.equal(standingOf({ person: "bob", position: null }, people.bob, map).position, "floor");
  assert.equal(approvingPerson("admin/liaison:abcd1234"), "admin");
  assert.equal(approvingPerson("admin (on the operator's word)"), "admin");
  assert.equal(approvingPerson("alice"), "alice");
});

test("B2: a data entry decides on the person's current standing, never a name or a stale position", { skip: storing }, async () => {
  const db = policyDb(fakeDb());
  const dab = fakeDab([{ Job: 4471, Status: "running", Price: 12 }, { Job: 4472, Status: "planned", Price: 3 }]);
  const queued = [];
  const queue = async (entry) => (queued.push(entry), { queued: true, pendingId: `p${queued.length}` });
  const proposal = () => ({});
  const go = (actsFor, more = {}) => enterData({ actsFor, by: "admin/worker:aa", key: "mssql:dbo_Job:4471", fields: { Status: "x" }, cls: "jobs", attribute: "status", reason: "r", ...more }, { db, fetch: dab.fetch, positions: map, queue, proposal, people: lookup });
  // a name typed for a position gets no root, and no write
  const named = await go({ person: "bob", position: "Operations" });
  assert.equal(named.outcome, "refused");
  assert.match(named.note, /not a position/);
  assert.equal(db.events.find((e) => e.id === named.audit).outcome, "refused");
  // a stale recorded position that once outranked them, and the person who has left
  assert.equal((await go({ person: "bob", position: "org" })).outcome, "refused");
  assert.equal((await go({ person: "gone", position: "floor" })).outcome, "refused");
  assert.equal((await go({ person: "unknown-person", position: "floor" })).outcome, "refused");
  // a queued identity never gets direct: dana holds the class at the floor and is still only proposing
  const q = await go({ person: "dana", position: "floor" });
  assert.equal(q.outcome, "proposed");
  assert.match(q.note, /queued/);
  assert.equal(dab.rows[0].Status, "running", "nothing written for any of them");
  // the same person, standing right: decided by the rule, not by where the record said they were
  const bob = await go({ person: "bob", position: "floor" });
  assert.equal(bob.outcome, "applied");
  assert.equal(dab.rows[0].Status, "x");
});

test("B3: the decision covers every column written, under the claim's class and the table's", { skip: storing }, async () => {
  assert.deepEqual(decisionKeys("jobs", "stage", ["Price"], []), [{ cls: "jobs", attribute: "stage" }, { cls: "jobs", attribute: "price" }]);
  assert.deepEqual(decisionKeys("jobs", "stage", ["Stage"], []), [{ cls: "jobs", attribute: "stage" }], "the claim's own column isn't decided twice");
  assert.deepEqual(decisionKeys("jobs", "status", ["Margin"], ["orders"]), [{ cls: "jobs", attribute: "status" }, { cls: "orders", attribute: "status" }, { cls: "jobs", attribute: "margin" }, { cls: "orders", attribute: "margin" }]);
  const db = policyDb(fakeDb());
  const dab = fakeDab([{ Job: 4471, Status: "run", Price: 12, Stage: "a" }, { Job: 4472, Status: "x", Price: 3, Stage: "b" }]);
  const queued = [];
  const queue = async (entry) => (queued.push(entry), { queued: true, pendingId: `p${queued.length}` });
  const proposal = () => ({});
  // jobs/stage is bob's to commit; a Price written under it is not (policy attributes.price: org)
  const r = await enterData({ actsFor: { person: "bob", position: "floor" }, by: "w", key: "mssql:dbo_Job:4471", fields: { Stage: "b", Price: 1 }, cls: "jobs", attribute: "stage", reason: "r" }, { db, fetch: dab.fetch, positions: map, queue, proposal, people: lookup });
  assert.equal(r.outcome, "proposed", "the strictest column decides");
  assert.equal(dab.rows[0].Price, 12);
  assert.equal(queued.length, 1);
  // a column a confirmed class of the table's governs, whatever the claim's class
  db.policyRows = (params, sql) => (sql.includes("'authority'") ? [{ json: JSON.stringify({ classes: { orders: { attributes: { quantity: "ops" } } }, attributes: {} }) }] : sql.includes("'sources'") ? [{ json: JSON.stringify({ mssql: { read: "http://fake/read", write: "http://fake/write" } }) }] : []);
  forgetAuthorityPolicy();
  const dbT = { ...db, adbQuery: (sql, params) => (sql.includes("FROM CommitmentClass") ? Promise.resolve([{ name: "orders" }]) : db.adbQuery(sql, params)) };
  const viaTable = await enterData({ actsFor: { person: "bob", position: "floor" }, by: "w", key: "mssql:dbo_Job:4471", fields: { Quantity: 9 }, cls: "jobs", attribute: "quantity", reason: "r" }, { db: dbT, fetch: dab.fetch, positions: map, queue, proposal, people: lookup });
  assert.equal(viaTable.outcome, "proposed", "the table's class governs the column too");
});

test("B18: a write and its event can't diverge; no event means no write, and a retry finds what a lost settle left", { skip: storing }, async () => {
  const dab = fakeDab([{ Job: 4471, Status: "running" }, { Job: 4472, Status: "planned" }]);
  // no event could be recorded: nothing is written
  const down = policyDb(fakeDb());
  down.failCreate = () => true;
  const r1 = await enterData({ actsFor: { person: "admin", position: "org" }, by: "w", key: "mssql:dbo_Job:4471", fields: { Status: "done" }, cls: "jobs", attribute: "stage", reason: "r" }, { db: down, fetch: dab.fetch, positions: map, people: lookup });
  assert.equal(r1.outcome, "failed");
  assert.match(r1.error, /nothing was written/);
  assert.equal(dab.rows[0].Status, "running", "no event, no write");
  assert.equal(dab.calls.some((c) => c.name === "update_record"), false);
  // the row changes and the settling fails: the event stays open, attempted, and says what it was about
  const db = policyDb(fakeDb());
  db.failSettle = () => true;
  const r2 = await enterData({ actsFor: { person: "admin", position: "org" }, by: "w", key: "mssql:dbo_Job:4471", fields: { Status: "done" }, cls: "jobs", attribute: "stage", reason: "r" }, { db, fetch: dab.fetch, positions: map, people: lookup });
  assert.equal(r2.outcome, "applied");
  assert.equal(r2.audit_unsettled, true);
  assert.equal(dab.rows[0].Status, "done");
  const open = db.events.find((e) => e.id === r2.audit);
  assert.equal(open.outcome, "attempted");
  assert.deepEqual(JSON.parse(open.change).fields, { Status: "done" });
  // the retry reads the row, and settles the open event by what the row holds: it does not say "unchanged" and hide it
  db.failSettle = null;
  const settled = await settleOpenAttempts("mssql:dbo_Job:4471", dab.rows[0], db);
  assert.deepEqual(settled, [{ id: r2.audit, outcome: "applied" }]);
  assert.equal(db.events.find((e) => e.id === r2.audit).outcome, "applied");
  assert.deepEqual(await settleOpenAttempts("mssql:dbo_Job:4471", dab.rows[0], db), [], "nothing left open");
  assert.equal(db.events.length, 1, "one write, one event");
  // a row back at what it held before the attempt: the write didn't land
  const db2 = policyDb(fakeDb());
  db2.failSettle = () => true;
  const dab2 = fakeDab([{ Job: 4471, Status: "x" }, { Job: 4472, Status: "y" }]);
  await enterData({ actsFor: { person: "admin", position: "org" }, by: "w", key: "mssql:dbo_Job:4471", fields: { Status: "done" }, cls: "jobs", attribute: "stage", reason: "r" }, { db: db2, fetch: dab2.fetch, positions: map, people: lookup });
  db2.failSettle = null;
  dab2.rows[0].Status = "x";
  assert.deepEqual(await settleOpenAttempts("mssql:dbo_Job:4471", dab2.rows[0], db2).then((s) => s.map((x) => x.outcome)), ["failed"]);
});

test("B18: a lost settle, then someone else's change: the landed write isn't called failed", { skip: storing }, async () => {
  const db = policyDb(fakeDb());
  db.failSettle = () => true;
  const dab = fakeDab([{ Job: 4471, Status: "x" }, { Job: 4472, Status: "y" }]);
  const r = await enterData({ actsFor: { person: "admin", position: "org" }, by: "w", key: "mssql:dbo_Job:4471", fields: { Status: "done" }, cls: "jobs", attribute: "stage", reason: "r" }, { db, fetch: dab.fetch, positions: map, people: lookup });
  assert.equal(r.audit_unsettled, true);
  db.failSettle = null;
  dab.rows[0].Status = "a person changed it";
  assert.deepEqual(await settleOpenAttempts("mssql:dbo_Job:4471", dab.rows[0], db), [], "nothing can be said of it");
  const ev = db.events.find((e) => e.id === r.audit);
  assert.equal(ev.outcome, "attempted", "neither applied nor failed");
  assert.equal(JSON.parse(ev.change).row_moved_on, true, "and it says why");
  // and it stays that way: a later row can't turn it into either
  dab.rows[0].Status = "x";
  assert.deepEqual(await settleOpenAttempts("mssql:dbo_Job:4471", dab.rows[0], db), []);
  assert.equal(db.events.find((e) => e.id === r.audit).outcome, "attempted");
  // an attempt with no record of what was there before can't be called failed either
  const bare = policyDb(fakeDb());
  bare.events.push({ rid: "#11:900", id: "ev-bare", key: "mssql:dbo_Job:4471", change: JSON.stringify({ fields: { Status: "done" } }), outcome: "attempted", at: "2026-11-08T10:00:00.000Z" });
  assert.deepEqual(await settleOpenAttempts("mssql:dbo_Job:4471", dab.rows[0], bare), []);
  assert.equal(bare.events[0].outcome, "attempted");
});

test("B3: a rule can't be missed by how a name is written, or by which entity the column is on", () => {
  const rules = { classes: { orders: { authority: "ops", attributes: { price: "org" } }, jobs: { authority: "floor" }, quotes: { attributes: { price: "ops" } } }, attributes: { credit_limit: "ops" } };
  const of = (...args) => decisionKeys(...args, rules).map((k) => `${k.cls}/${k.attribute}`);
  assert.ok(of("jobs", "stage", ["CREDITLIMIT"], []).includes("jobs/credit_limit"), "CREDITLIMIT is credit_limit");
  assert.ok(of("jobs", "stage", ["Credit Limit"], []).includes("jobs/credit_limit"));
  assert.ok(of("jobs", "creditlimit", [], []).includes("jobs/credit_limit"), "so is an attribute spelled that way");
  assert.ok(of("Orders", "quantity", ["Quantity"], []).includes("orders/quantity"), "a class spelled otherwise is the rule's class");
  assert.ok(of("jobs", "stage", ["Price"], []).includes("orders/price"), "a rule on orders covers a Price column on another entity");
  assert.ok(of("jobs", "stage", ["PRICE"], []).includes("quotes/price"), "every rule on that attribute");
  // a class here with its own rule on the attribute: that rule is the one
  assert.deepEqual(of("quotes", "price", ["Price"], []).filter((k) => k.endsWith("price")), ["quotes/price"]);
  assert.deepEqual(of("jobs", "status", ["Status"], []), ["jobs/status"], "no rule anywhere on it: nothing added");
  // the decision itself
  const bob = { positions: ["floor"], caps: { write: "direct" } };
  assert.ok(decisionKeys("jobs", "stage", ["PRICE"], [], rules).some((k) => decide(bob, k.cls, k.attribute, rules, map) !== "direct"), "and it reaches the answer");
});

test("B3: an entry writes what the claim says, in the one column its attribute names, or nothing", () => {
  const hit = { row: { Job: 4471, Status: "running", CREDITLIMIT: 100, Note: "n", Price: 3 }, key_column: "Job", key_value: 4471 };
  const claim = { attribute: "status", value: "done", value_num: null };
  assert.deepEqual(fieldsForClaim(claim, null, hit), { Status: "done" });
  assert.deepEqual(fieldsForClaim(claim, {}, hit), { Status: "done" });
  assert.deepEqual(fieldsForClaim(claim, { Status: "DONE" }, hit), { Status: "done" }, "the claim's own value, not the worker's spelling of it");
  assert.deepEqual(fieldsForClaim({ attribute: "credit_limit", value: "900", value_num: 900 }, { CREDITLIMIT: "900" }, hit), { CREDITLIMIT: 900 });
  assert.throws(() => fieldsForClaim(claim, { Note: "Diep bonus is 99999" }, hit), /says nothing about Note/, "free text into a column the claim doesn't name");
  assert.throws(() => fieldsForClaim(claim, { Note: "done" }, hit), /says nothing about Note/, "even the claim's value, in another column");
  assert.throws(() => fieldsForClaim(claim, { Status: "done", Price: 1 }, hit), /says nothing about Price/, "a second column");
  assert.throws(() => fieldsForClaim(claim, { Status: "paused" }, hit), /writes what the claim says/, "another value");
  assert.throws(() => fieldsForClaim(claim, { Status: null }, hit), /writes what the claim says/, "or none");
  assert.throws(() => fieldsForClaim({ attribute: "stage", value: "x" }, { Status: "x" }, hit), /no column named for stage/, "an attribute no column is named for: not the worker's to map");
  assert.throws(() => fieldsForClaim({ attribute: "job", value: "9" }, null, hit), /row's key/);
  assert.throws(() => fieldsForClaim(claim, { Nope: "done" }, hit), /has no column Nope/);
});

test("B3: a column spelled unlike its rule, and a rule on another class, hold the entry", { skip: storing }, async () => {
  const propose = async (policy, row, fields, cls, attribute) => {
    forgetPrimaryKeys();
    forgetSources();
    const dab = fakeDab([{ Job: 4471, ...row }, { Job: 4472, ...row }]);
    const queued = [];
    const r = await enterData({ actsFor: { person: "bob", position: "floor" }, by: "w", key: "mssql:dbo_Job:4471", fields, cls, attribute, reason: "r" }, { db: policyDb(fakeDb()), fetch: dab.fetch, positions: map, people: lookup, policy, queue: async (e) => (queued.push(e), { pendingId: "p1" }), proposal: () => ({}) });
    return { r, wrote: dab.calls.some((c) => c.name === "update_record"), home: queued[0]?.home };
  };
  const spelling = await propose({ classes: {}, attributes: { credit_limit: "ops" } }, { CREDITLIMIT: 1 }, { CREDITLIMIT: 9 }, "jobs", "credit_limit");
  assert.equal(spelling.r.outcome, "proposed");
  assert.equal(spelling.wrote, false);
  assert.equal(spelling.home, "ops", "waits where the authority is");
  const across = await propose({ classes: { orders: { attributes: { price: "org" } } }, attributes: {} }, { Price: 1 }, { Price: 9 }, "jobs", "price");
  assert.equal(across.r.outcome, "proposed", "a rule only on orders.price still covers Price on dbo_Job");
  assert.equal(across.wrote, false);
  assert.equal(across.home, "org");
  const free = await propose({ classes: { orders: { attributes: { price: "org" } } }, attributes: {} }, { Status: "a" }, { Status: "b" }, "jobs", "status");
  assert.equal(free.r.outcome, "applied", "a column no rule anywhere names is still bob's");
});

test("an authority map that can't be read or doesn't validate decides nothing direct", { skip: storing }, async () => {
  const bob = { positions: ["floor"], caps: { write: "direct" } };
  const stored = (scope, json) => {
    const db = policyDb(fakeDb());
    const orig = db.policyRows;
    db.policyRows = (params, sql) => (sql.includes(`'${scope}'`) ? json : orig(params, sql));
    return db;
  };
  const invalid = [
    ["an invalid stored policy", stored("authority", [{ json: '{"classes":"not-an-object"}' }])],
    ["stored policy that isn't JSON", stored("authority", [{ json: "{oops" }])],
    ["an invalid authority map in the organization's settings", stored("org", [{ json: '{"authorityMap":{"classes":[1]}}' }])],
    ["organization settings that aren't JSON", stored("org", [{ json: "{oops" }])],
  ];
  const broken = (scope) => {
    const db = policyDb(fakeDb());
    const orig = db.policyRows;
    db.policyRows = (params, sql) => {
      if (sql.includes(`'${scope}'`)) throw new Error("db down");
      return orig(params, sql);
    };
    return db;
  };
  for (const [what, db] of [...invalid, ["an unreadable stored policy", broken("authority")], ["unreadable organization settings", broken("org")]]) {
    forgetAuthorityPolicy();
    await assert.rejects(authorityMapFor({ positions: map, db }), undefined, `${what}: the map says so`);
    assert.equal(await decideWrite(bob, "jobs", "stage", { positions: map, db }), "propose", `${what}: proposed, never direct`);
    assert.equal(await decideWrite(bob, "nothing", "ruled", { positions: map, db }), "propose", `${what}: and not only where a rule might be`);
    forgetPrimaryKeys();
    const dab = fakeDab([{ Job: 4471, Status: "a" }, { Job: 4472, Status: "b" }]);
    const queued = [];
    const r = await enterData({ actsFor: { person: "bob", position: "floor" }, by: "w", key: "mssql:dbo_Job:4471", fields: { Status: "c" }, cls: "jobs", attribute: "status", reason: "r" }, { db, fetch: dab.fetch, positions: map, people: lookup, queue: async (e) => (queued.push(e), { pendingId: "p1" }), proposal: () => ({}) });
    assert.equal(r.outcome, "proposed", what);
    assert.match(r.note, /authority map can't be read/);
    assert.equal(queued[0].home, "org", `${what}: for the root to decide`);
    assert.equal(dab.calls.some((c) => c.name === "update_record"), false, what);
    forgetAuthorityPolicy();
  }
  // a failure isn't remembered: once it reads, it decides
  const db = stored("authority", [{ json: "{oops" }]);
  assert.equal(await decideWrite(bob, "jobs", "stage", { positions: map, db }), "propose");
  db.policyRows = policyDb(fakeDb()).policyRows;
  assert.equal(await decideWrite(bob, "jobs", "stage", { positions: map, db }), "direct");
  // nothing stored at all is no rule, which is the writer's own: not a failure
  forgetAuthorityPolicy();
  assert.equal(await decideWrite(bob, "orders", "price", { positions: map, db: fakeDb() }), "direct");
});

test("B2: a proposal waits where the authority is, and only someone holding it can approve it", { skip: storing }, async () => {
  const payload = { kind: "data_entry", key: "mssql:dbo_Job:4471", fields: { Quantity: 700 }, class: "orders", attribute: "quantity", by: "w", acts_for: { person: "bob", position: "floor" }, reason: "r" };
  const attempt = async (approver, extra = {}) => {
    forgetPrimaryKeys();
    forgetAuthorityPolicy();
    const db = extra.db ?? policyDb(fakeDb());
    db.events.push({ rid: "#11:1", id: "ev", key: payload.key, pending_id: "p1", outcome: "proposed", at: "2026-11-08T10:00:00.000Z", change: "{}" });
    const dab = fakeDab([{ Job: 4471, Quantity: 1 }, { Job: 4472, Quantity: 2 }]);
    const r = await applyProposedEntry(extra.payload ?? payload, "p1", approver, { db, fetch: dab.fetch, people: lookup, positions: map }).catch((e) => ({ threw: e.message }));
    return { r, wrote: dab.calls.some((c) => c.name === "update_record"), ev: db.events[0], row: dab.rows[0] };
  };
  // bob (floor) can see a proposal homed at the floor; authority over orders lies with ops
  const below = await attempt("bob");
  assert.match(below.r.threw, /doesn't hold the authority/);
  assert.equal(below.wrote, false);
  assert.equal(below.ev.outcome, "refused", "the proposal's event says so");
  // a person on the column's rule, not just the claim's: the column decides too
  const column = await attempt("alice", { payload: { ...payload, fields: { Price: 1 } } });
  assert.match(column.r.threw, /doesn't hold the authority/, "ops holds orders, but price is the org's");
  assert.equal(column.wrote, false);
  // no name to hang it on, someone gone, a queued person
  assert.match((await attempt(undefined)).r.threw, /needs the person who approved/);
  assert.match((await attempt("nobody")).r.threw, /no longer in the organization/);
  assert.match((await attempt("gone")).r.threw, /no longer in the organization/);
  assert.match((await attempt("dana")).r.threw, /doesn't hold the authority/);
  // whoever holds it can: at the authority, above it, through an agent of theirs
  for (const who of ["alice", "admin", "admin/liaison:abcd1234", "admin (on the operator's word)"]) {
    const ok = await attempt(who);
    assert.equal(ok.r.outcome, "applied", who);
    assert.equal(ok.row.Quantity, 700, who);
  }
  // a map that can't be read: only the root
  const unreadable = () => {
    const db = policyDb(fakeDb());
    const orig = db.policyRows;
    db.policyRows = (params, sql) => (sql.includes("'authority'") ? [{ json: "{oops" }] : orig(params, sql));
    return db;
  };
  assert.match((await attempt("alice", { db: unreadable() })).r.threw, /can't be read/);
  assert.equal((await attempt("admin", { db: unreadable() })).r.outcome, "applied");
});

test("B2: a person whose write capability isn't stated can't authorize one", () => {
  assert.equal(standingOf({ person: "x", position: "floor" }, { positions: ["floor"], caps: { read: true } }, map).ok, false);
  assert.equal(standingOf({ person: "x", position: "floor" }, { positions: ["floor"], caps: { read: true, write: "maybe" } }, map).ok, false);
  assert.equal(standingOf({ person: "x", position: "floor" }, { positions: ["floor"] }, map).ok, false);
  assert.equal(standingOf({ person: "x", position: "floor" }, { positions: ["floor"], caps: { read: true, write: "queued" } }, map).ok, true);
});

test("NB5: what the agent read holds the entry, whoever it acts for", { skip: storing }, async () => {
  // a tree with a branch beside Operations, for someone the authority can't be reached from
  const branched = parsePositionMap({ root: "org", positions: { org: { name: "org" }, ops: { name: "ops", parent: "org" }, floor: { name: "floor", parent: "ops" }, hr: { name: "hr", parent: "org" } } });
  const run = async (who, extra = {}) => {
    forgetPrimaryKeys();
    forgetSources();
    forgetAuthorityPolicy();
    const db = policyDb(fakeDb());
    const dab = fakeDab([{ Job: 4471, Status: "a" }, { Job: 4472, Status: "b" }]);
    const queued = [];
    const r = await enterData({ actsFor: who, by: "admin/worker:1", key: "mssql:dbo_Job:4471", fields: { Status: "c" }, cls: "jobs", attribute: "status", reason: "r", ...extra }, { db, fetch: dab.fetch, positions: branched, people: lookup, queue: async (e) => (queued.push(e), { pendingId: "p1" }), proposal: () => ({}) });
    return { r, wrote: dab.calls.some((c) => c.name === "update_record"), home: queued[0]?.home, event: db.events.at(-1) };
  };
  const bob = { person: "bob", position: "floor" };
  assert.equal((await run(bob)).r.outcome, "applied", "control: bob holds jobs");
  const held = { home: "org", why: "this worker read entries people at the floor can't see" };
  const h = await run(bob, { held });
  assert.equal(h.r.outcome, "proposed");
  assert.equal(h.wrote, false);
  assert.equal(h.home, "org", "someone who can see what it read decides");
  assert.match(h.r.note, /can't see/);
  assert.deepEqual(JSON.parse(h.event.change).held, held, "the trail says why");
  // a person who could commit it alone is held all the same: the limit is the agent's
  assert.equal((await run({ person: "admin", position: "org" }, { held })).r.outcome, "proposed");
  // and a stricter answer stays stricter: on another branch from the authority, it is refused, not proposed
  const beside = await run({ person: "hana", position: "hr" }, { held, cls: "orders", attribute: "quantity" });
  assert.equal(beside.r.outcome, "refused");
  assert.equal(beside.r.decision, "hidden", "by the rule, not for holding no position");
  assert.equal(beside.wrote, false);
});

test("B18: a transport error during the write is settled by what the row holds", { skip: storing }, async () => {
  const run = async (breakWrite) => {
    const db = policyDb(fakeDb());
    forgetSources();
    forgetPrimaryKeys();
    const dab = fakeDab([{ Job: 4471, Status: "running" }, { Job: 4472, Status: "planned" }], { breakWrite });
    const r = await enterData({ actsFor: { person: "admin", position: "org" }, by: "w", key: "mssql:dbo_Job:4471", fields: { Status: "done" }, cls: "jobs", attribute: "stage", reason: "r" }, { db, fetch: dab.fetch, positions: map, people: lookup });
    return { r, ev: db.events.find((e) => e.id === r.audit), dab };
  };
  // the source applied it and the answer was lost
  const a = await run("after-apply");
  assert.equal(a.r.outcome, "applied");
  assert.equal(a.ev.outcome, "applied");
  assert.equal(a.dab.rows[0].Status, "done");
  // the source never saw it
  const b = await run("before");
  assert.equal(b.r.outcome, "failed");
  assert.equal(b.ev.outcome, "failed");
  assert.equal(b.dab.rows[0].Status, "running");
});

test("B18: one approved entry is one event, naming the person who approved it", { skip: storing }, async () => {
  const db = policyDb(fakeDb());
  const dab = fakeDab([{ Job: 4471, Status: "running", Quantity: 500 }, { Job: 4472, Status: "planned", Quantity: 20 }]);
  const queued = [];
  const queue = async (entry) => (queued.push(entry), { queued: true, pendingId: "pend-1" });
  const proposal = (identity, reason) => ({ note: reason, job: identity?.role?.job ?? null });
  const floor = await enterData(
    { actsFor: { person: "bob", position: "floor" }, by: "admin/worker:aa", key: "mssql:dbo_Job:4471", fields: { Quantity: 600 }, cls: "orders", attribute: "quantity", reason: "the note says 600", identity: { role: { kind: "worker", job: "j1" } } },
    { db, fetch: dab.fetch, positions: map, queue, proposal, people: lookup },
  );
  assert.equal(floor.outcome, "proposed");
  const applied = await applyProposedEntry(queued[0].payload, "pend-1", "admin/liaison:abcd1234", { db, fetch: dab.fetch, people: lookup, positions: map });
  assert.equal(applied.outcome, "applied");
  assert.equal(dab.rows[0].Quantity, 600);
  const onRow = db.events.filter((e) => e.key === "mssql:dbo_Job:4471");
  assert.equal(onRow.length, 1, `one event for one approved write: ${JSON.stringify(onRow)}`);
  assert.equal(onRow[0].id, floor.audit);
  assert.equal(onRow[0].outcome, "applied");
  assert.equal(onRow[0].authorized_by, "admin", "the person behind the approving identity");
  assert.equal(onRow[0].position, "org", "the approver's position");
  assert.equal(JSON.parse(onRow[0].change).proposed_for.person, "bob");
  // an approval whose write fails: one event, failed
  const db2 = policyDb(fakeDb());
  const q2 = async () => ({ queued: true, pendingId: "pend-2" });
  const f = await enterData({ actsFor: { person: "bob", position: "floor" }, by: "w", key: "mssql:dbo_Job:4471", fields: { Quantity: 700 }, cls: "orders", attribute: "quantity", reason: "r" }, { db: db2, fetch: dab.fetch, positions: map, queue: q2, proposal, people: lookup });
  await assert.rejects(applyProposedEntry({ key: "mssql:dbo_Job:4471", fields: { Quantity: 700 }, class: "orders", attribute: "quantity", by: "w", acts_for: { person: "bob", position: "floor" } }, "pend-2", "alice", { db: db2, fetch: fakeDab([{ Job: 4471, Quantity: 1 }, { Job: 4472, Quantity: 2 }], { failWrite: true }).fetch, people: lookup, positions: map }), /permission denied/);
  assert.equal(db2.events.length, 1);
  assert.equal(db2.events[0].id, f.audit);
  assert.equal(db2.events[0].outcome, "failed");
  assert.equal(db2.events[0].authorized_by, "alice");
  // a proposal the trail couldn't hold never waits for an approver
  const db3 = policyDb(fakeDb());
  db3.failCreate = () => true;
  await assert.rejects(enterData({ actsFor: { person: "bob", position: "floor" }, by: "w", key: "mssql:dbo_Job:4471", fields: { Quantity: 1 }, cls: "orders", attribute: "quantity", reason: "r" }, { db: db3, fetch: dab.fetch, positions: map, queue: async () => ({ queued: true, pendingId: "pend-3" }), proposal, people: lookup }), /withdrawn/);
  assert.ok(db3.statements.some((s) => s.startsWith("UPDATE PendingWrite")));
});

test("data entry for a floor person on an Operations class is proposed and audited; for an admin it is applied and audited", { skip: storing }, async () => {
  const db = policyDb(fakeDb());
  const dab = fakeDab([{ Job: 4471, Status: "running", Quantity: 500 }, { Job: 4472, Status: "planned", Quantity: 20 }]);
  const queued = [];
  const queue = async (entry) => (queued.push(entry), { queued: true, pendingId: "pend-1" });
  const proposal = (identity, reason) => ({ note: reason, job: identity?.role?.job ?? null });
  const opts = { db, fetch: dab.fetch, positions: map, queue, proposal, people: lookup };
  const floor = await enterData(
    { actsFor: { person: "bob", position: "floor" }, by: "admin/worker:aa", key: "mssql:dbo_Job:4471", fields: { Quantity: 600 }, cls: "orders", attribute: "quantity", reason: "the note says 600", identity: { role: { kind: "worker", job: "j1" } } },
    opts,
  );
  assert.equal(floor.outcome, "proposed");
  assert.equal(floor.pendingId, "pend-1");
  assert.equal(queued[0].kind, "data_entry");
  assert.equal(queued[0].home, "ops", "the proposal waits where the authority is");
  assert.equal(queued[0].job, "j1");
  assert.deepEqual(JSON.parse(queued[0].payload).fields, { Quantity: 600 });
  assert.equal(dab.rows[0].Quantity, 500, "nothing written to the source");
  let ev = db.events.find((e) => e.id === floor.audit);
  assert.equal(ev.outcome, "proposed");
  assert.equal(ev.pending_id, "pend-1");
  assert.equal(ev.authorized_by, "bob");
  assert.equal(ev.position, "floor");
  // the approver applies it: the row changes, the one event follows
  const applied = await applyProposedEntry(queued[0].payload, "pend-1", "alice", { db, fetch: dab.fetch, people: lookup, positions: map });
  assert.equal(applied.outcome, "applied");
  assert.equal(dab.rows[0].Quantity, 600);
  assert.equal(applied.audit, floor.audit);
  assert.equal(db.events.find((e) => e.id === floor.audit).outcome, "applied");
  assert.equal(db.events.find((e) => e.id === applied.audit).authorized_by, "alice");
  // an admin writes directly
  const admin = await enterData({ actsFor: { person: "admin", position: "org" }, by: "admin/worker:bb", key: "mssql:dbo_Job:4471", fields: { Status: "done" }, cls: "jobs", attribute: "stage", reason: "shipped" }, opts);
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
    { ...opts, fetch: fakeDab([{ Job: 4471, Status: "a" }, { Job: 4472, Status: "b" }], { failWrite: true }).fetch },
  );
  assert.equal(refused.outcome, "failed");
  assert.match(refused.error, /permission denied/);
  assert.equal(db.events.find((e) => e.id === refused.audit).outcome, "failed");
  // a person on another branch: refused, audited, nothing proposed
  const wide = parsePositionMap({ ...read("positions.json"), positions: { ...read("positions.json").positions, sales: { name: "Sales", parent: "org" } } });
  forgetAuthorityPolicy();
  const hidden = await enterData(
    { actsFor: { person: "sam", position: "sales" }, by: "admin/worker:dd", key: "mssql:dbo_Job:4471", fields: { Status: "paused" }, cls: "jobs", attribute: "stage" },
    { ...opts, positions: wide, people: (n) => (n === "sam" ? { positions: ["sales"], caps: { read: true, write: "direct" } } : undefined) },
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
