// Data entry (data-entry.js), the sources stream's: DAB as it is (2.0.12), the source client, the sources' config,
// a person's standing, and Filed or Proposed by the class map (R2, R6, R11). No audit nodes (R9).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dabTool } from "../e2e/fake-dab-core.mjs";
import { applyProposedEntry, approvingPerson, assertWritable, checkGuard, clientFor, columnFor, commitRow, createRow, DAB_CALLS, describeEntry, describeSource, enterData, findRows, forgetAuthorityPolicy, forgetPrimaryKeys, forgetSources, getRow, mcpToolCall, odata, primaryKeyFrom, rowsOf, sameValue, sourceClient, standingOf } from "../src/data-entry.js";
import { normalizeSource } from "../src/model/sources.js";
import { classIndex } from "../src/model/classes.js";
import { parsePositionMap } from "../src/positions.js";

/** a fake ArcadeDB: the OrgPolicy rows a test gives (policyRows), every statement it saw */
function fakeDb() {
  const db = {
    statements: [],
    async adbCommand(sql) {
      db.statements.push(sql);
      return [{ count: 1 }];
    },
    async adbQuery(sql, params = {}) {
      if (sql.includes("FROM OrgPolicy")) return db.policyRows?.(params, sql) ?? [];
      return [];
    },
  };
  return db;
}

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const map = parsePositionMap(read("positions.json"));
const policyJson = JSON.stringify(read("policy.json"));

/** a fake DAB: an MCP endpoint over fetch over fake-dab-core.mjs (DAB 2.0.12's tools), recording the tool calls it saw */
function fakeDab(rows, { failWrite = false, breakWrite = false, table = "dbo_Job", primaryKey = ["Job"], tables: more = {}, identity = IDENTITY, down = false } = {}) {
  const calls = [];
  const tables = { [table]: { primaryKey, rows }, ...more };
  // the identity view the guard reads, as the write connection computes it (test-sql/seed.mjs)
  const view = { dbo_GwConnectionIdentity: { primaryKey: ["id"], rows: identity ? [{ id: 1, ...identity }] : [] } };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const reply = (result) => ({ ok: true, status: 200, headers: { get: (h) => (h === "mcp-session-id" ? "s1" : null) }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26" });
    const { name, arguments: args } = body.params;
    calls.push({ url, name, args });
    if (down === true || (down && String(url).includes(down))) throw new TypeError("fetch failed");
    const write = String(url).includes("write");
    if (name === "update_record" && failWrite) return reply({ isError: true, content: [{ type: "text", text: JSON.stringify({ toolName: name, status: "error", error: { type: "Error", message: "permission denied for update" } }) }] });
    if (name === "update_record" && breakWrite) {
      // the transport breaks after the source acted (or didn't)
      if (breakWrite === "after-apply") dabTool(tables, name, args, { write });
      throw new Error("socket hang up");
    }
    return reply(dabTool(write && identity !== false ? { ...tables, ...view } : tables, name, args, { write }));
  };
  return { fetch, calls, rows, tables };
}

/** the declaration the fakes answer for: the synthetic test database's guard names */
const IDENTITY = { server_name: "gwsynth-sql", database_name: "GwSynthMfg", login_name: "gwsynth_write" };
const DECL = { system: "mssql", read: { via: "dab-mcp", url: "http://fake/read" }, commit: { via: "dab-mcp", url: "http://fake/write", tables: ["dbo_Job", "dbo_Maintenance"], guard: { server: "gwsynth-sql", database: "GwSynthMfg" } } };
const declared = (over = {}) => ({ mssql: normalizeSource({ ...DECL, ...over, commit: over.commit === undefined ? DECL.commit : over.commit }) });
/** a filing log in memory: every attempt begun, and how it was settled */
function journal({ failBegin = false } = {}) {
  const entries = [];
  return {
    entries,
    async begin(attempt) {
      if (failBegin) throw new Error("log down");
      entries.push({ ...attempt, status: "begun" });
      return `log-${entries.length}`;
    },
    async settle(id, status, detail) {
      Object.assign(entries[Number(id.slice(4)) - 1], { status, ...detail });
    },
  };
}

const policyDb = (db) => {
  db.policyRows = (params, sql) => (sql.includes("'authority'") ? [{ json: policyJson }] : sql.includes("'sources'") ? [{ json: JSON.stringify([DECL]) }] : []);
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

test("a column is the one with the same name however it is spelled, never a fragment; values compare as facts", () => {
  const row = { Job: 4471, Status: "Running", Quantity: 500, Due_Date: "2026-11-20T00:00:00", credit_status: "good" };
  assert.equal(columnFor("status", row), "Status");
  assert.equal(columnFor("due_date", row), "Due_Date");
  assert.equal(columnFor("stage", row), null);
  assert.equal(columnFor("status", { Status: 1, status: 2 }), null, "two columns alike: no determination");
  assert.equal(columnFor("date", { created_date: 1 }), null, "date is not created_date");
  assert.ok(sameValue("Running", "running"));
  assert.ok(sameValue(500, "500"));
  assert.ok(sameValue("2026-11-20", "2026-11-20T00:00:00"));
  assert.ok(!sameValue(500, "5000"));
  assert.ok(!sameValue(null, "x"));
  assert.throws(() => assertWritable({ Nope: 1 }, { row, key_column: "Job" }), /has no column Nope/);
  assert.throws(() => assertWritable({ Job: 1 }, { row, key_column: "Job" }), /row's key/);
});

test("B19: the row answered is the row asked for, and its key can name it exactly", async () => {
  // a source that answers with another row than the filter asked for
  const dab = fakeDab([{ Job: 4471, Status: "a" }, { Job: 4472, Status: "b" }]);
  const lying = async (url, init) => {
    const res = await dab.fetch(url, init);
    if (JSON.parse(init.body).params?.arguments?.first !== 2) return res;
    const text = await res.text();
    return { ...res, text: async () => text.replaceAll("4471", "4472") };
  };
  forgetPrimaryKeys();
  const c = sourceClient("mssql", { read: "http://fake/lying", write: "http://fake/write" }, { fetch: lying });
  await assert.rejects(() => c.readRow("dbo_Job", "4471"), /not the row asked for/);
  // past 2^53 the JSON number is its neighbour: the update would name another row
  assert.throws(() => assertWritable({ Status: "x" }, { row: { Job: 9007199254740992, Status: "a" }, key_column: "Job", key_value: 9007199254740992 }), /too large to name one row/);
  assert.doesNotThrow(() => assertWritable({ Status: "x" }, { row: { Job: 9007199254740991, Status: "a" }, key_column: "Job", key_value: 9007199254740991 }));
  assert.doesNotThrow(() => assertWritable({ Status: "x" }, { row: { Code: "9007199254740993", Status: "a" }, key_column: "Code", key_value: "9007199254740993" }), "a text key is exact");
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

test("the fake DAB answers filters as DAB 2.0.12 did against the synthetic SQL Server (test-sql)", () => {
  const tables = { dbo_Employee: { primaryKey: ["Employee"], rows: [{ Employee: "NGDT", First_Name: "Diep", Status: "Inactive" }, { Employee: "NGUD", First_Name: "Diep", Status: "Active" }, { Employee: "FRAJ", First_Name: "John", Status: "Active" }] } };
  const text = (r) => JSON.parse(r.content[0].text);
  const rows = (filter, extra = {}) => text(dabTool(tables, "read_records", { entity: "dbo_Employee", filter, ...extra })).result.value.map((r) => r.Employee);
  assert.deepEqual(rows("First_Name eq 'diep'"), ["NGDT", "NGUD"], "eq is case-insensitive, as the server's collation compares");
  assert.deepEqual(rows("First_Name eq 'Diep' and Status eq 'Active'"), ["NGUD"]);
  assert.deepEqual(rows("Employee eq 'FRAJ' or Employee eq 'NGUD'"), ["FRAJ", "NGUD"]);
  assert.deepEqual(rows("First_Name ge 'di' and First_Name lt 'dj'"), ["NGDT", "NGUD"], "a prefix as a range");
  assert.deepEqual(rows("Status ne 'Active'"), ["NGDT"]);
  assert.deepEqual(rows("First_Name ge 'd'", { orderby: ["First_Name asc"], first: 1 }), ["NGDT"]);
  assert.deepEqual(Object.keys(text(dabTool(tables, "read_records", { entity: "dbo_Employee", select: "Employee,Status", first: 1 })).result.value[0]), ["Employee", "Status"]);
  for (const f of ["contains(First_Name,'Diep')", "startswith(First_Name,'Di')"]) assert.match(text(dabTool(tables, "read_records", { entity: "dbo_Employee", filter: f })).error.message, /not well formed/, f);
  assert.match(text(dabTool(tables, "read_records", { entity: "dbo_Employee", filter: "Nope eq 'x'" })).error.message, /Could not find a property named 'Nope'/);
  assert.match(text(dabTool(tables, "delete_record", { entity: "dbo_Employee", keys: { Employee: "FRAJ" } }, { write: true })).error.message, /Permission denied for delete/, "no instance here deletes");
  // a table whose key the server makes: the key can't be given, and the made row comes back under result.value
  const t2 = { dbo_Maintenance: { primaryKey: ["Maintenance"], identity: true, rows: [{ Maintenance: 1, Status: "Open" }, { Maintenance: 2, Status: "Closed" }] } };
  assert.match(text(dabTool(t2, "create_record", { entity: "dbo_Maintenance", data: { Maintenance: 9, Status: "Open" } }, { write: true })).error.message, /Field 'Maintenance' cannot be included in the request body/);
  assert.deepEqual(text(dabTool(t2, "create_record", { entity: "dbo_Maintenance", data: { Status: "Open" } }, { write: true })).result.value, [{ Maintenance: 3, Status: "Open" }]);
  // a write to a table the instance doesn't expose
  assert.match(text(dabTool({}, "read_records", { entity: "dbo_Customer" }, { write: true })).error.message, /Entity 'dbo_Customer' is not defined/);
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

test("B2: a person whose write capability isn't stated can't authorize one", () => {
  assert.equal(standingOf({ person: "x", position: "floor" }, { positions: ["floor"], caps: { read: true } }, map).ok, false);
  assert.equal(standingOf({ person: "x", position: "floor" }, { positions: ["floor"], caps: { read: true, write: "maybe" } }, map).ok, false);
  assert.equal(standingOf({ person: "x", position: "floor" }, { positions: ["floor"] }, map).ok, false);
  assert.equal(standingOf({ person: "x", position: "floor" }, { positions: ["floor"], caps: { read: true, write: "queued" } }, map).ok, true);
});

const jobs = () => fakeDab([{ Job: 4471, Status: "running", Quantity: 500 }, { Job: 4472, Status: "planned", Quantity: 20 }]);
const harness = (extra = {}) => {
  const queued = [];
  const queue = async (entry) => (queued.push(entry), { queued: true, pendingId: `pend-${queued.length}` });
  const proposal = (identity, reason) => ({ note: reason, job: identity?.role?.job ?? null });
  const dab = extra.dab ?? jobs();
  const log = journal();
  return { queued, dab, log, opts: { db: extra.db ?? policyDb(fakeDb()), fetch: dab.fetch, positions: map, queue, proposal, people: lookup, journal: log } };
};
const entry = (over = {}) => ({ actsFor: { person: "bob", position: "floor" }, by: "admin/agent:w1", key: "mssql:dbo_Job:4471", fields: { Status: "done" }, before: { Status: "running" }, cls: "jobs", reason: "the note says so", ...over });

test("Filed: the recorder holds the position the map names for the class, so the row is written through the write endpoint", async () => {
  const h = harness();
  const r = await enterData(entry(), h.opts);
  assert.equal(r.outcome, "filed");
  assert.deepEqual([r.before, r.after], [{ Status: "running" }, { Status: "done" }]);
  assert.equal(h.dab.rows[0].Status, "done");
  assert.equal(h.dab.calls.at(-1).url, "http://fake/write");
  assert.equal(h.queued.length, 0);
  assert.deepEqual(h.log.entries.map((e) => [e.key, e.status]), [["mssql:dbo_Job:4471", "written"]], "begun in the filing log before the write, settled after");
});

test("Proposed: the recorder doesn't hold it; it waits where the map's position sees it, nothing written", async () => {
  const h = harness();
  const r = await enterData(entry({ cls: "orders", fields: { Quantity: 600 } }), h.opts);
  assert.equal(r.outcome, "proposed");
  assert.equal(r.pendingId, "pend-1");
  assert.equal(h.queued[0].kind, "data_entry");
  assert.equal(h.queued[0].home, "ops");
  assert.equal(h.dab.rows[0].Quantity, 500);
  assert.match(describeEntry(h.queued[0].payload)[0], /writes Quantity = 600 to row 4471 of dbo_Job \(mssql\), for bob at floor/);
});

test("Proposed: a class missing from the map, even for the root (R11)", async () => {
  const h = harness();
  const r = await enterData(entry({ actsFor: { person: "admin", position: "org" }, cls: "invoices" }), h.opts);
  assert.equal(r.outcome, "proposed");
  assert.match(r.reason, /names no position/);
  assert.equal(h.queued[0].home, "org");
});

test("Proposed: a source that isn't writable (R2)", async () => {
  const db = fakeDb();
  db.policyRows = (params, sql) => (sql.includes("'authority'") ? [{ json: policyJson }] : sql.includes("'sources'") ? [{ json: JSON.stringify([{ ...DECL, commit: { via: "none" } }]) }] : []);
  delete process.env.DAB_WRITE_URL;
  const h = harness({ db });
  const r = await enterData(entry({ actsFor: { person: "admin", position: "org" } }), h.opts);
  assert.equal(r.outcome, "proposed");
  assert.match(r.reason, /not writable/);
});

test("the recorder's authority counts, never the agent's: an admin's agent acting for bob proposes; a queued recorder proposes; the agent's own limit proposes", async () => {
  const h = harness();
  assert.equal((await enterData(entry({ by: "admin/agent:root", cls: "orders", fields: { Quantity: 1 } }), h.opts)).outcome, "proposed");
  assert.equal((await enterData(entry({ actsFor: { person: "dana", position: "floor" } }), h.opts)).outcome, "proposed");
  const held = await enterData(entry({ held: { home: "ops", why: "the agent read above the floor" } }), h.opts);
  assert.equal(held.outcome, "proposed");
  assert.equal(held.reason, "the agent read above the floor");
  assert.equal(h.dab.rows[0].Status, "running");
});

test("a recorder who left or moved: nothing written or proposed", async () => {
  const h = harness();
  const r = await enterData(entry({ actsFor: { person: "gone", position: "floor" } }), h.opts);
  assert.equal(r.outcome, "refused");
  assert.match(r.reason, /no longer in the organization/);
  assert.equal(h.queued.length, 0);
  await assert.rejects(enterData(entry({ key: "4471" }), h.opts), /not a record key/);
  await assert.rejects(enterData(entry({ fields: {} }), h.opts), /fields/);
});

test("a transport error is settled by reading the row back: filed when it landed, held when not; a refusal is held", async () => {
  const landed = harness({ dab: fakeDab([{ Job: 4471, Status: "running" }, { Job: 4472, Status: "x" }], { breakWrite: "after-apply" }) });
  const a = await enterData(entry(), landed.opts);
  assert.equal(a.outcome, "filed");
  assert.match(a.note, /holds the new values/);
  assert.equal(landed.log.entries[0].status, "written");
  const lost = harness({ dab: fakeDab([{ Job: 4471, Status: "running" }, { Job: 4472, Status: "x" }], { breakWrite: true }) });
  const l = await enterData(entry(), lost.opts);
  assert.deepEqual([l.outcome, l.status], ["held", "unreachable"]);
  assert.equal(lost.log.entries[0].status, "unreachable");
  const refused = harness({ dab: fakeDab([{ Job: 4471, Status: "a" }, { Job: 4472, Status: "b" }], { failWrite: true }) });
  const r = await enterData(entry({ before: { Status: "a" } }), refused.opts);
  assert.deepEqual([r.outcome, r.status], ["held", "refused"]);
  assert.match(r.why, /permission denied/);
  assert.equal(refused.log.entries[0].status, "refused");
});

test("approving a proposal: only a person holding the map's position for the class, as they stand now; a class missing from the map, a person at the root", async () => {
  const payload = { kind: "data_entry", key: "mssql:dbo_Job:4471", fields: { Quantity: 700 }, before: { Quantity: 1 }, class: "orders", by: "w", acts_for: { person: "bob", position: "floor" }, reason: "r" };
  const attempt = async (approver, over = {}) => {
    forgetPrimaryKeys();
    forgetAuthorityPolicy();
    const dab = fakeDab([{ Job: 4471, Quantity: 1 }, { Job: 4472, Quantity: 2 }]);
    const r = await applyProposedEntry({ ...payload, ...over }, "p1", approver, { db: over.db ?? policyDb(fakeDb()), fetch: dab.fetch, people: lookup, positions: map, journal: journal() }).catch((e) => ({ threw: e.message }));
    return { r, row: dab.rows[0] };
  };
  assert.match((await attempt("bob")).r.threw, /doesn't hold the authority/);
  assert.match((await attempt("alice", { fields: { Price: 1 } })).r.threw, /doesn't hold the authority/, "ops holds orders, but its price column is the root's");
  assert.match((await attempt(undefined)).r.threw, /needs the person who approved/);
  assert.match((await attempt("gone")).r.threw, /no longer in the organization/);
  for (const who of ["alice", "admin", "admin/liaison:abcd1234"]) {
    const ok = await attempt(who);
    assert.equal(ok.r.outcome, "filed", who);
    assert.equal(ok.row.Quantity, 700, who);
  }
  assert.match((await attempt("alice", { class: "invoices" })).r.threw, /doesn't hold the authority/);
  assert.equal((await attempt("admin", { class: "invoices" })).r.outcome, "filed", "a class missing from the map: a person at the root");
  assert.equal(approvingPerson("admin (on the operator's word)"), "admin");
});

// ---- the read adapter, the guard and the write adapter (R2, R3), against the fake DAB ----

const people2 = [
  { Employee: "FRAJ", First_Name: "John", Last_Name: "Fraley", Status: "Active" },
  { Employee: "NGDT", First_Name: "Diep", Last_Name: "Nguyen", Status: "Inactive" },
  { Employee: "NGUD", First_Name: "Diep", Last_Name: "Nguyen", Status: "Active" },
];
const centers = ["CNC 1", "CNC 2", "CNC 3", "CNC 4", "CNC 5", "INSPECT-2", "SAW"].map((w) => ({ Work_Center: w, Status: "Up" }));
const shop = (over = {}) =>
  fakeDab([{ Job: 4471, Status: "Active", Priority: 5 }, { Job: 3260410, Status: "Active", Priority: 4 }], {
    tables: {
      dbo_Employee: { primaryKey: ["Employee"], rows: people2.map((r) => ({ ...r })) },
      dbo_Customer: { primaryKey: ["Customer"], rows: [{ Customer: "EXATRON", Name: "Exatron" }, { Customer: "TORO", Name: "Toro" }] },
      dbo_Work_Center: { primaryKey: ["Work_Center"], rows: centers.map((r) => ({ ...r })) },
      dbo_Maintenance: { primaryKey: ["Maintenance"], identity: true, rows: [{ Maintenance: 1, Description: "a", Status: "Open" }, { Maintenance: 2, Description: "b", Status: "Closed" }] },
    },
    ...over,
  });
const on = (dab, extra = {}) => ({ fetch: dab.fetch, sources: declared(), ...extra });

test("a row by its key: found, none, or why not (a bad key, an undeclared source, a table the caller doesn't allow)", async () => {
  const dab = shop();
  const hit = await getRow("mssql:dbo_Employee:NGUD", on(dab));
  assert.deepEqual([hit.status, hit.key, hit.row.Status], ["found", "mssql:dbo_Employee:NGUD", "Active"]);
  assert.equal((await getRow("mssql:dbo_Employee:NOBODY", on(dab))).status, "none");
  assert.equal((await getRow("NGUD", on(dab))).status, "refused");
  assert.match((await getRow("erp:dbo_Job:1", on(dab))).why, /no connected source called erp/);
  const narrowed = await getRow("mssql:dbo_Employee:NGUD", on(dab, { tables: ["dbo_Job"] }));
  assert.deepEqual([narrowed.status, narrowed.filing], ["refused", "held"]);
  assert.match(narrowed.why, /not among the tables this read may see/);
});

test("R3: a source that can't be reached is unreachable, which points to Held; a refusal is not unreachable", async () => {
  forgetPrimaryKeys();
  const down = await getRow("mssql:dbo_Job:4471", on(shop({ down: true })));
  assert.deepEqual([down.status, down.filing], ["unreachable", "held"]);
  const err500 = { ok: false, status: 503, headers: { get: () => null }, text: async () => "unavailable" };
  await assert.rejects(mcpToolCall("http://x/503", "read_records", {}, { fetch: async () => err500 }), (e) => e.transport === true);
  const bad = await findRows({ system: "mssql", table: "dbo_Employee", column: "Nope", value: "x" }, on(shop()));
  assert.equal(bad.status, "refused");
  assert.match(bad.why, /has no column Nope: it has Employee, First_Name/);
});

test("names resolve against the source: two Dieps are ambiguous until the worker narrows by another column; a prefix is a range", async () => {
  forgetPrimaryKeys();
  const dab = shop();
  const both = await findRows({ system: "mssql", table: "dbo_Employee", column: "First_Name", value: "diep" }, on(dab));
  assert.deepEqual([both.status, both.rows.map((r) => r.key)], ["ambiguous", ["mssql:dbo_Employee:NGDT", "mssql:dbo_Employee:NGUD"]]);
  assert.equal(both.filing, null, "a read decides no outcome");
  const active = await findRows({ system: "mssql", table: "dbo_Employee", column: "First_Name", value: "Diep", also: { Status: "Active" } }, on(dab));
  assert.deepEqual([active.status, active.rows[0].key], ["found", "mssql:dbo_Employee:NGUD"]);
  const exa = await findRows({ system: "mssql", table: "dbo_Customer", column: "Name", value: "exa", mode: "prefix" }, on(dab));
  assert.deepEqual([exa.status, exa.rows[0].key], ["found", "mssql:dbo_Customer:EXATRON"]);
  const cnc = await findRows({ system: "mssql", table: "dbo_Work_Center", column: "Work_Center", value: "CNC", mode: "prefix", first: 3 }, on(dab));
  assert.deepEqual([cnc.status, cnc.rows.length, cnc.more], ["ambiguous", 3, true]);
  assert.equal((await findRows({ system: "mssql", table: "dbo_Customer", column: "Name", value: "Corvane Medical" }, on(dab))).status, "none");
  assert.match((await findRows({ system: "mssql", table: "dbo_Job", column: "Job", value: "44", mode: "prefix" }, on(dab))).why, /number column/);
  assert.match((await findRows({ system: "mssql", table: "dbo_Job", column: "Job", value: "x", mode: "contains" }, on(dab))).why, /eq or prefix/);
  const filters = dab.calls.filter((c) => c.args.filter).map((c) => c.args.filter);
  assert.ok(filters.every((f) => !/contains|startswith/.test(f)), "only what DAB 2.0.12 parses");
  assert.ok(filters.includes("First_Name eq 'Diep' and Status eq 'Active'"));
});

test("a source's tables, within what the caller allows", async () => {
  const all = await describeSource("mssql", on(shop()));
  assert.ok(all.tables.includes("dbo_Employee") && all.tables.includes("dbo_Job"));
  assert.deepEqual((await describeSource("mssql", on(shop(), { tables: ["dbo_Job"] }))).tables, ["dbo_Job"]);
});

test("the guard: the write connection must say it holds the declared server and database, through its own identity view", async () => {
  const decl = declared().mssql;
  assert.equal((await checkGuard(decl, { fetch: shop().fetch })).ok, true);
  const wrongDb = await checkGuard(decl, { fetch: shop({ identity: { ...IDENTITY, database_name: "ErpLive" } }).fetch });
  assert.deepEqual([wrongDb.ok, wrongDb.status], [false, "refused"]);
  assert.match(wrongDb.why, /holds gwsynth-sql\/ErpLive, not the declared gwsynth-sql\/GwSynthMfg/);
  assert.equal((await checkGuard(decl, { fetch: shop({ identity: { ...IDENTITY, server_name: "mssql-server" } }).fetch })).ok, false);
  const noView = await checkGuard(decl, { fetch: shop({ identity: false }).fetch });
  assert.deepEqual([noView.ok, noView.status], [false, "refused"], "a database without the view can't pass");
  const unguarded = await checkGuard(normalizeSource({ ...DECL, commit: { ...DECL.commit, guard: undefined } }), { fetch: shop().fetch });
  assert.match(unguarded.why, /no guard is declared/);
  assert.equal((await checkGuard(decl, { fetch: shop({ down: "write" }).fetch })).status, "unreachable");
  assert.equal((await checkGuard(normalizeSource({ ...DECL, commit: { via: "none" } }))).status, "not_writable");
  assert.ok((await checkGuard(decl, { fetch: shop({ identity: { ...IDENTITY, database_name: "gwsynthmfg" } }).fetch })).ok, "SQL Server names compare without case");
});

test("a write: guarded, begun in the filing log first, written through the write connection, settled", async () => {
  forgetPrimaryKeys();
  const dab = shop();
  const log = journal();
  const r = await commitRow({ key: "mssql:dbo_Job:3260410", fields: { Priority: 2 }, before: { Priority: 4 } }, on(dab, { journal: log }));
  assert.deepEqual([r.status, r.filing, r.before, r.after], ["written", "filed", { Priority: 4 }, { Priority: 2 }]);
  assert.equal(dab.rows[1].Priority, 2);
  assert.deepEqual(log.entries, [{ system: "mssql", table: "dbo_Job", key: "mssql:dbo_Job:3260410", action: "update", fields: { Priority: 2 }, before: { Priority: 4 }, piece: null, status: "written", after: { Priority: 2 } }]);
  const order = dab.calls.map((c) => `${c.url.endsWith("write") ? "w" : "r"}:${c.args.entity}:${c.name}`);
  assert.ok(order.indexOf("w:dbo_GwConnectionIdentity:read_records") < order.indexOf("w:dbo_Job:update_record"), "the guard before the write");
  assert.ok(dab.calls.every((c) => c.name !== "update_record" || c.url === "http://fake/write"));
});

test("nothing is written without a filing log, when the log can't begin, when the guard fails, or where the declaration takes no write", async () => {
  for (const [what, extra, status] of [
    ["no journal", { journal: null }, "refused"],
    ["the log can't begin", { journal: journal({ failBegin: true }) }, "refused"],
    ["a wrong database", { journal: journal(), dab: shop({ identity: { ...IDENTITY, database_name: "ErpLive" } }) }, "refused"],
    ["a table not declared writable", { journal: journal(), key: "mssql:dbo_Employee:NGUD", fields: { Status: "Inactive" } }, "not_writable"],
    ["a source with no write side", { journal: journal(), sources: declared({ commit: { via: "none" } }) }, "not_writable"],
  ]) {
    forgetPrimaryKeys();
    const dab = extra.dab ?? shop();
    const r = await commitRow({ key: extra.key ?? "mssql:dbo_Job:4471", fields: extra.fields ?? { Priority: 1 } }, { fetch: dab.fetch, sources: extra.sources ?? declared(), journal: extra.journal });
    assert.equal(r.status, status, what);
    assert.equal(r.filing, status === "not_writable" ? "proposed" : "held", what);
    assert.ok(!dab.calls.some((c) => c.name === "update_record"), `${what}: no write was sent`);
  }
});

test("R2 Held, never overwrite: a row that moved since the worker read it is not written; a row already holding the value needs no write", async () => {
  forgetPrimaryKeys();
  const dab = shop();
  const log = journal();
  const moved = await commitRow({ key: "mssql:dbo_Job:4471", fields: { Priority: 1 }, before: { Priority: 3 } }, on(dab, { journal: log }));
  assert.deepEqual([moved.status, moved.filing, moved.row.Priority], ["moved", "held", 5]);
  assert.match((await commitRow({ key: "mssql:dbo_Job:4471", fields: { Priority: 1, Status: "x" }, before: { Priority: 5 } }, on(dab, { journal: log }))).why, /doesn't name Status/);
  const already = await commitRow({ key: "mssql:dbo_Job:4471", fields: { Priority: 5 }, before: { Priority: 5 } }, on(dab, { journal: log }));
  assert.deepEqual([already.status, already.filing], ["already", "filed"]);
  assert.equal((await commitRow({ key: "mssql:dbo_Job:1", fields: { Priority: 1 }, before: { Priority: 5 } }, on(dab, { journal: log }))).status, "not_found");
  assert.deepEqual(log.entries.map((e) => e.status), ["written"], "only the row already holding it is logged (as written, with nothing sent); the moved and missing ones were never attempted");
  assert.ok(!dab.calls.some((c) => c.name === "update_record"));
});

test("a create: the source makes the key, which comes back for the Filed piece; a refusal is held, and logged", async () => {
  forgetPrimaryKeys();
  const dab = shop();
  const log = journal();
  const made = await createRow({ system: "mssql", table: "dbo_Maintenance", data: { Description: "forklift beeper", Status: "Open" } }, on(dab, { journal: log }));
  assert.deepEqual([made.status, made.key, made.row.Maintenance], ["written", "mssql:dbo_Maintenance:3", 3]);
  assert.deepEqual([log.entries[0].action, log.entries[0].status, log.entries[0].key], ["create", "written", "mssql:dbo_Maintenance:3"]);
  const keyed = await createRow({ system: "mssql", table: "dbo_Maintenance", data: { Maintenance: 9, Status: "Open" } }, on(dab, { journal: log }));
  assert.deepEqual([keyed.status, keyed.filing], ["refused", "held"]);
  assert.equal(log.entries[1].status, "refused");
  assert.equal((await createRow({ system: "mssql", table: "dbo_Customer", data: { Customer: "CORVANE" } }, on(dab, { journal: log }))).status, "not_writable");
});

test("a restarted DAB forgets its session: the call is made again after a fresh handshake", async () => {
  let session = "old";
  const seen = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    const sent = init.headers["mcp-session-id"] ?? null;
    seen.push([body.method, sent]);
    const reply = (status, result) => ({ ok: status === 200, status, headers: { get: (h) => (h === "mcp-session-id" ? session : null) }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    if (body.method === "initialize") return reply(200, {});
    if (sent === "old") {
      session = "new";
      return reply(404, null);
    }
    return reply(200, { content: [{ type: "text", text: '{"ok":true}' }] });
  };
  assert.deepEqual(await mcpToolCall("http://restarted/mcp", "t", {}, { fetch: f }), { ok: true });
  assert.deepEqual(seen.map((s) => s.join(" ")), ["initialize ", "tools/call old", "initialize ", "tools/call new"]);
});

test("R9: a subclass with no map entry of its own takes its parent's, on the live path too: Filed for a recorder holding the parent's position, and approvable by one", async () => {
  const index = classIndex([{ key: "jobs", name: "jobs", parents: ["commitment"] }, { key: "rush_jobs", name: "rush jobs", parents: ["jobs"] }]);
  const h = harness();
  const filed = await enterData(entry({ cls: "rush jobs" }), { ...h.opts, index });
  assert.equal(filed.outcome, "filed", "jobs is the floor's, so bob may file a rush job");
  assert.equal(h.dab.rows[0].Status, "done");
  const without = harness();
  assert.equal((await enterData(entry({ cls: "rush jobs" }), { ...without.opts, index: null })).outcome, "proposed", "without the tree, a class with no entry of its own is Proposed");
  forgetPrimaryKeys();
  const dab = fakeDab([{ Job: 4471, Quantity: 1 }, { Job: 4472, Quantity: 2 }]);
  const payload = { kind: "data_entry", key: "mssql:dbo_Job:4471", fields: { Quantity: 700 }, before: { Quantity: 1 }, class: "rush jobs", by: "w", acts_for: { person: "dana", position: "floor" }, reason: "r" };
  const approved = await applyProposedEntry(payload, "p9", "bob", { db: policyDb(fakeDb()), fetch: dab.fetch, people: lookup, positions: map, journal: journal(), index });
  assert.equal(approved.outcome, "filed");
  assert.equal(dab.rows[0].Quantity, 700);
});

test("an approved proposal is written only with a filing-log entry, which names the approval for the Filed entry; with no log, nothing is written", async () => {
  const payload = { kind: "data_entry", key: "mssql:dbo_Job:4471", fields: { Quantity: 700 }, before: { Quantity: 1 }, class: "jobs", by: "w", acts_for: { person: "dana", position: "floor" }, reason: "r", piece: { document: "d1", section: 2 } };
  forgetPrimaryKeys();
  const dab = fakeDab([{ Job: 4471, Quantity: 1 }, { Job: 4472, Quantity: 2 }]);
  const log = journal();
  await applyProposedEntry(payload, "p7", "bob/liaison:ab12", { db: policyDb(fakeDb()), fetch: dab.fetch, people: lookup, positions: map, journal: log, index: null });
  assert.deepEqual(log.entries.map((e) => [e.status, e.piece]), [["written", { document: "d1", section: 2, pending_id: "p7", approved_by: "bob" }]]);
  forgetPrimaryKeys();
  const dab2 = fakeDab([{ Job: 4471, Quantity: 1 }, { Job: 4472, Quantity: 2 }]);
  await assert.rejects(applyProposedEntry(payload, "p8", "bob", { db: policyDb(fakeDb()), fetch: dab2.fetch, people: lookup, positions: map, journal: null, index: null }), /no filing log/);
  assert.equal(dab2.rows[0].Quantity, 1);
  assert.ok(!dab2.calls.some((c) => c.name === "update_record"));
});

test("the write path reads the declaration (model/sources.js writable): a table outside its tables is Proposed, nothing written", async () => {
  const db = fakeDb();
  db.policyRows = (params, sql) => (sql.includes("'authority'") ? [{ json: policyJson }] : sql.includes("'sources'") ? [{ json: JSON.stringify([{ ...DECL, commit: { ...DECL.commit, tables: ["dbo_Maintenance"] } }]) }] : []);
  const h = harness({ db });
  const r = await enterData(entry(), h.opts);
  assert.equal(r.outcome, "proposed");
  assert.match(r.reason, /not writable/);
  assert.equal(h.dab.rows[0].Status, "running");
  assert.ok(!h.dab.calls.some((c) => c.name === "update_record"));
});

// ---- the review of c1eaf39 ----

test("S-B1: the names filing imports load, and sourcesConfig answers { [system]: { read, write } } from the declarations", async () => {
  const m = await import("../src/data-entry.js");
  for (const name of ["clientFor", "DAB_CALLS", "enterData", "mcpToolCall", "rowsOf", "sameValue", "sourcesConfig"]) assert.ok(m[name] !== undefined, name);
  forgetSources();
  assert.deepEqual(await m.sourcesConfig(policyDb(fakeDb()), { ttlMs: 0 }), { mssql: { read: "http://fake/read", write: "http://fake/write" } });
  forgetSources();
  const ro = fakeDb();
  ro.policyRows = (params, sql) => (sql.includes("'sources'") ? [{ json: JSON.stringify([{ ...DECL, commit: { via: "none" } }]) }] : []);
  assert.deepEqual(await m.sourcesConfig(ro, { ttlMs: 0 }), { mssql: { read: "http://fake/read", write: null } });
});

test("S-B2: a write tool is never sent twice: a 5xx after a session exists is unreachable, and the write is settled by reading the row back", async () => {
  const sent = [];
  let session = null;
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "tools/call") sent.push(body.params.name);
    const reply = (status, result) => ({ ok: status === 200, status, headers: { get: (h) => (h === "mcp-session-id" ? (session ??= "s") : null) }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    if (body.method === "initialize") return reply(200, {});
    return reply(502, null);
  };
  for (const tool of ["create_record", "update_record"]) {
    sent.length = 0;
    await assert.rejects(mcpToolCall("http://proxy/mcp", tool, { entity: "dbo_Job" }, { fetch: f }), (e) => e.transport === true);
    assert.deepEqual(sent, [tool], `${tool} sent once`);
  }
  sent.length = 0;
  await assert.rejects(mcpToolCall("http://proxy/mcp", "read_records", { entity: "dbo_Job" }, { fetch: f }), (e) => e.transport === true);
  assert.deepEqual(sent, ["read_records"], "a 5xx is not a lost session: a read is not repeated either");
  // a create the source made but whose answer was lost: one row, one attempt, the attempt left unknown (Held)
  forgetPrimaryKeys();
  const dab = shop();
  const lossy = async (url, init) => {
    const body = JSON.parse(init.body);
    const res = await dab.fetch(url, init);
    if (body.params?.name === "create_record") return { ok: false, status: 502, headers: { get: () => null }, text: async () => "bad gateway" };
    return res;
  };
  const log = journal();
  const r = await createRow({ system: "mssql", table: "dbo_Maintenance", data: { Description: "x", Status: "Open" } }, { fetch: lossy, sources: declared(), journal: log });
  assert.deepEqual([r.status, r.filing], ["unknown", "held"]);
  assert.equal(dab.calls.filter((c) => c.name === "create_record").length, 1);
  assert.equal(dab.tables.dbo_Maintenance.rows.length, 3, "one row made, not two");
  assert.deepEqual(log.entries.map((e) => e.status), ["unknown"]);
});

test("R11.6, R11.9: a source read is for an audience, and the connection's home must be one it sees; the root's connection is the root's alone", async () => {
  forgetPrimaryKeys();
  const dab = shop();
  const rootHomed = declared(); // no home declared: the root
  const opsHomed = declared({ read: { ...DECL.read, home: "ops" } });
  const everyone = declared({ read: { ...DECL.read, home: "everyone" } });
  const as = (sources, audience) => ({ fetch: dab.fetch, sources, audience, positions: map });
  assert.equal((await getRow("mssql:dbo_Job:4471", as(rootHomed, "org"))).status, "found");
  const above = await getRow("mssql:dbo_Job:4471", as(rootHomed, "floor"));
  assert.deepEqual([above.status, above.filing, above.row], ["refused", "held", undefined]);
  assert.match(above.why, /above this audience/);
  assert.equal((await getRow("mssql:dbo_Job:4471", as(opsHomed, "ops"))).status, "found");
  assert.equal((await getRow("mssql:dbo_Job:4471", as(opsHomed, "floor"))).status, "refused", "floor doesn't see what ops does");
  assert.equal((await findRows({ system: "mssql", table: "dbo_Employee", column: "First_Name", value: "Diep" }, as(opsHomed, "floor"))).status, "refused");
  assert.equal((await describeSource("mssql", as(opsHomed, "everyone"))).status, "refused");
  assert.equal((await findRows({ system: "mssql", table: "dbo_Employee", column: "First_Name", value: "Diep" }, as(everyone, "floor"))).status, "ambiguous");
  assert.equal((await describeSource("mssql", as(everyone, "everyone"))).status, "found");
  const sent = dab.calls.length;
  await getRow("mssql:dbo_Job:4471", as(rootHomed, "floor"));
  assert.equal(dab.calls.length, sent, "nothing is read from a source above the audience");
  assert.equal((await getRow("mssql:dbo_Job:4471", as(rootHomed, "nobody"))).status, "refused", "an audience that is no position sees nothing");
});

test("review: clientFor is read only; the guard's view is pinned and its login checked; a guarded write names its tables", async () => {
  const { client } = await clientFor("mssql:dbo_Job:4471", { sources: declared(), fetch: shop().fetch });
  assert.equal(client.canWrite, false);
  const pinned = normalizeSource({ ...DECL, commit: { ...DECL.commit, guard: { ...DECL.commit.guard, entity: "dbo_Job" } } });
  assert.match((await checkGuard(pinned, { fetch: shop().fetch })).why, /must be read through dbo_GwConnectionIdentity/);
  const withLogin = (login) => normalizeSource({ ...DECL, commit: { ...DECL.commit, guard: { ...DECL.commit.guard, login } } });
  assert.equal((await checkGuard(withLogin("gwsynth_write"), { fetch: shop().fetch })).ok, true);
  assert.match((await checkGuard(withLogin("gw_admin"), { fetch: shop().fetch })).why, /as gwsynth_write, not the declared gw_admin/);
  forgetPrimaryKeys();
  const any = await commitRow({ key: "mssql:dbo_Job:4471", fields: { Priority: 1 }, before: { Priority: 5 } }, { fetch: shop().fetch, sources: declared({ commit: { ...DECL.commit, tables: null } }), journal: journal() });
  assert.equal(any.status, "refused");
  assert.match(any.why, /names no tables/);
});

test("review: an update must say what the worker read; a row already holding the value is still logged, so an approval gets its Filed entry", async () => {
  forgetPrimaryKeys();
  const dab = shop();
  const log = journal();
  const blind = await commitRow({ key: "mssql:dbo_Job:4471", fields: { Priority: 1 } }, on(dab, { journal: log }));
  assert.equal(blind.status, "refused");
  assert.match(blind.why, /before/);
  const already = await commitRow({ key: "mssql:dbo_Job:4471", fields: { Priority: 5 }, before: { Priority: 5 }, piece: { pending_id: "p1" } }, on(dab, { journal: log }));
  assert.equal(already.status, "already");
  assert.deepEqual(log.entries.map((e) => [e.status, e.piece?.pending_id, e.note]), [["written", "p1", "the row already held it: nothing was sent"]]);
  assert.ok(!dab.calls.some((c) => c.name === "update_record"));
});

test("review: approving needs a position map, and a person, never an agent", async () => {
  const payload = { kind: "data_entry", key: "mssql:dbo_Job:4471", fields: { Quantity: 700 }, before: { Quantity: 1 }, class: "jobs", by: "w", acts_for: { person: "dana", position: "floor" }, reason: "r" };
  const run = (approver, positions = map) => {
    forgetPrimaryKeys();
    const dab = fakeDab([{ Job: 4471, Quantity: 1 }, { Job: 4472, Quantity: 2 }]);
    return applyProposedEntry(payload, "p1", approver, { db: policyDb(fakeDb()), fetch: dab.fetch, people: lookup, positions, journal: journal(), index: null }).then((r) => ({ r, dab }), (e) => ({ threw: e.message, dab }));
  };
  const noMap = await run("admin", null);
  assert.match(noMap.threw, /no position map/);
  assert.equal(noMap.dab.rows[0].Quantity, 1);
  assert.match((await run("admin/agent:orchestrator")).threw, /an agent can't approve/);
  assert.equal((await run("bob")).r.outcome, "filed");
});

test("I-40: searchRows matches words in any column (DAB has no contains), pages by primary key with no cursor, and says when it stopped short", async () => {
  const { searchRows, SEARCH_PAGE } = await import("../src/data-entry.js");
  forgetPrimaryKeys();
  const many = Array.from({ length: 2 * SEARCH_PAGE + 50 }, (_, i) => ({ Part: 1000 + i, Description: i % 100 === 7 ? `floater bar ${i}` : `blank ${i}`, Status: i % 2 ? "Open" : "Closed" }));
  const dab = shop({ tables: { dbo_Part: { primaryKey: ["Part"], rows: many }, dbo_Employee: { primaryKey: ["Employee"], rows: people2.map((r) => ({ ...r })) } } });
  const all = await searchRows({ system: "mssql", table: "dbo_Part", text: "FLOATER" }, on(dab));
  assert.deepEqual([all.status, all.matched, all.complete], ["ambiguous", 5, true], "found on every page, not just the first");
  assert.deepEqual(all.rows.map((r) => r.key), [1007, 1107, 1207, 1307, 1407].map((p) => `mssql:dbo_Part:${p}`));
  const reads = dab.calls.filter((c) => c.name === "read_records" && c.args.entity === "dbo_Part" && c.args.first !== 1);
  assert.ok(reads.length >= 3, "several pages");
  assert.ok(reads.every((c) => c.args.after === undefined), "never a cursor");
  assert.ok(reads.slice(1).every((c) => /^Part gt \d+$/.test(c.args.filter)), "the next page by key");
  // words must all appear; where narrows at the source; offset pages through the matches
  const two = await searchRows({ system: "mssql", table: "dbo_Part", text: "floater 107", where: { Status: "open" } }, on(dab));
  assert.deepEqual(two.rows.map((r) => r.key), ["mssql:dbo_Part:1107"]);
  const p1 = await searchRows({ system: "mssql", table: "dbo_Part", text: "floater", first: 2 }, on(dab));
  assert.deepEqual([p1.rows.length, p1.next_offset, p1.more], [2, 2, true]);
  const p3 = await searchRows({ system: "mssql", table: "dbo_Part", text: "floater", first: 2, offset: 4 }, on(dab));
  assert.deepEqual([p3.rows.map((r) => r.key), p3.next_offset, p3.more], [["mssql:dbo_Part:1407"], undefined, false]);
  // select narrows the row shown, the key stays
  const sel = await searchRows({ system: "mssql", table: "dbo_Employee", text: "diep", where: { Status: "Active" }, select: ["Last_Name"] }, on(dab));
  assert.deepEqual([sel.status, sel.rows[0].row], ["found", { Employee: "NGUD", Last_Name: "Nguyen" }]);
  // a scan stopped short says so
  const short = await searchRows({ system: "mssql", table: "dbo_Part", text: "floater" }, on(dab, { scanLimit: SEARCH_PAGE }));
  assert.deepEqual([short.complete, short.matched, short.more], [false, 2, true]);
  assert.match(short.note, /searched the first 200 rows/);
  // refusals name what is there
  assert.match((await searchRows({ system: "mssql", table: "dbo_Nope", text: "x" }, on(dab))).why, /mssql has no table dbo_Nope: it has dbo_Job, dbo_Part, dbo_Employee/);
  assert.match((await searchRows({ system: "mssql", table: "dbo_Part", where: { Part: "abc" } }, on(dab))).why, /Part is a number column/);
  assert.match((await searchRows({ system: "mssql", table: "dbo_Part" }, on(dab))).why, /give text to find, or where/);
  const coerced = await searchRows({ system: "mssql", table: "dbo_Part", where: { Part: "1107" } }, on(dab));
  assert.deepEqual([coerced.status, coerced.rows[0].key], ["found", "mssql:dbo_Part:1107"]);
  // the audience: a connection read above it reads nothing
  const before = dab.calls.length;
  const opsHomed = { fetch: dab.fetch, sources: declared({ read: { via: "dab-mcp", url: "http://fake/read", home: "ops" } }), positions: map, audience: "floor" };
  assert.equal((await searchRows({ system: "mssql", table: "dbo_Part", text: "floater" }, opsHomed)).status, "refused");
  assert.equal(dab.calls.length, before);
});
