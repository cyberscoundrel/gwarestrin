// Data entry (data-entry.js), the sources stream's: DAB as it is (2.0.12), the source client, the sources' config,
// a person's standing, and Filed or Proposed by the class map (R2, R6, R11). No audit nodes (R9).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dabTool } from "../e2e/fake-dab-core.mjs";
import { applyProposedEntry, approvingPerson, assertWritable, columnFor, DAB_CALLS, describeEntry, enterData, forgetAuthorityPolicy, forgetPrimaryKeys, forgetSources, mcpToolCall, odata, primaryKeyFrom, rowsOf, sameValue, sourceClient, sourcesConfig, standingOf } from "../src/data-entry.js";
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
  return { queued, dab, opts: { db: extra.db ?? policyDb(fakeDb()), fetch: dab.fetch, positions: map, queue, proposal, people: lookup } };
};
const entry = (over = {}) => ({ actsFor: { person: "bob", position: "floor" }, by: "admin/agent:w1", key: "mssql:dbo_Job:4471", fields: { Status: "done" }, cls: "jobs", reason: "the note says so", ...over });

test("Filed: the recorder holds the position the map names for the class, so the row is written through the write endpoint", async () => {
  const h = harness();
  const r = await enterData(entry(), h.opts);
  assert.equal(r.outcome, "filed");
  assert.deepEqual([r.before, r.after], [{ Status: "running" }, { Status: "done" }]);
  assert.equal(h.dab.rows[0].Status, "done");
  assert.equal(h.dab.calls.at(-1).url, "http://fake/write");
  assert.equal(h.queued.length, 0);
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
  db.policyRows = (params, sql) => (sql.includes("'authority'") ? [{ json: policyJson }] : sql.includes("'sources'") ? [{ json: JSON.stringify({ mssql: { read: "http://fake/read" } }) }] : []);
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

test("a transport error is settled by reading the row back: filed when it landed, failed when not", async () => {
  const landed = harness({ dab: fakeDab([{ Job: 4471, Status: "running" }, { Job: 4472, Status: "x" }], { breakWrite: "after-apply" }) });
  const a = await enterData(entry(), landed.opts);
  assert.equal(a.outcome, "filed");
  assert.match(a.note, /holds the new values/);
  const lost = harness({ dab: fakeDab([{ Job: 4471, Status: "running" }, { Job: 4472, Status: "x" }], { breakWrite: true }) });
  assert.equal((await enterData(entry(), lost.opts)).outcome, "failed");
  const refused = harness({ dab: fakeDab([{ Job: 4471, Status: "a" }, { Job: 4472, Status: "b" }], { failWrite: true }) });
  const r = await enterData(entry(), refused.opts);
  assert.equal(r.outcome, "failed");
  assert.match(r.error, /permission denied/);
});

test("approving a proposal: only a person holding the map's position for the class, as they stand now; a class missing from the map, a person at the root", async () => {
  const payload = { kind: "data_entry", key: "mssql:dbo_Job:4471", fields: { Quantity: 700 }, class: "orders", by: "w", acts_for: { person: "bob", position: "floor" }, reason: "r" };
  const attempt = async (approver, over = {}) => {
    forgetPrimaryKeys();
    forgetAuthorityPolicy();
    const dab = fakeDab([{ Job: 4471, Quantity: 1 }, { Job: 4472, Quantity: 2 }]);
    const r = await applyProposedEntry({ ...payload, ...over }, "p1", approver, { db: over.db ?? policyDb(fakeDb()), fetch: dab.fetch, people: lookup, positions: map }).catch((e) => ({ threw: e.message }));
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
