// Filing a record (filing.js): the four outcomes (R2), decided in code from facts (the row as a fake DAB holds it,
// the class map, the recorder's standing), never taken from the model; requests (R10), the account and the
// orchestrator's check (R10, R11), approvals (R11), Kept and re-filing (R11). The fakes hand the code facts: a DAB
// over fake-dab-core.mjs (DAB 2.0.12's answers), an in-memory log, a database that answers the few reads filing
// makes. The real data-entry.js decides Filed or Proposed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dabTool } from "../e2e/fake-dab-core.mjs";
import { enterData, forgetPrimaryKeys, forgetSources } from "../src/data-entry.js";
import { accountEvidence, accountGiven, answerRequest, createInstance, makeJournal, fileToSource, giveAccount, holdPiece, keepPiece, keptPieces, readSourceRow, recordVerdict, requestOrchestrator, settleProposals } from "../src/filing.js";
import { normalizeClass } from "../src/model/classes.js";
import { parsePositionMap } from "../src/positions.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const map = parsePositionMap(read("positions.json"));
const people = {
  bob: { positions: ["floor"], caps: { read: true, write: "direct" } },
  alice: { positions: ["ops"], caps: { read: true, write: "direct" } },
  admin: { positions: ["org"], caps: { read: true, write: "direct" } },
};
// the class map: jobs and maintenance are the floor's, deliveries are seen on the floor but Operations has the authority, machines are in no entry
const policy = { classes: { jobs: { authority: "floor" }, maintenance: { authority: "floor" }, deliveries: { authority: "ops" }, orders: { authority: "ops" } } };
const classes = new Map(
  [
    ...read("classes.json").classes,
    { name: "deliveries", parents: ["commitment"], home: "floor", record_table: "mssql:dbo_Job", rows_are_nodes: false },
    { name: "people", parents: ["agent"], home: "floor", record_table: "mssql:dbo_Employee", rows_are_nodes: true },
  ].map((c) => {
    const n = normalizeClass(c, { positions: map });
    return [n.key, { ...n, rid: `#40:${n.key.length}` }];
  }),
);

/** a fake DAB over fetch: the read-only endpoint and the write-capable one, or none that answers */
function fakeDab(rows, { down = false } = {}) {
  const tables = { dbo_Job: { primaryKey: ["Job"], rows }, dbo_Employee: { primaryKey: ["Emp"], rows: [{ Emp: "E1", Name: "Diep" }, { Emp: "E2", Name: "Sam" }] } };
  const calls = [];
  const fetch = async (url, init) => {
    if (down) throw new Error("fetch failed: ECONNREFUSED");
    const body = JSON.parse(init.body);
    const reply = (result) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26" });
    const { name, arguments: args } = body.params;
    calls.push({ url, name, args });
    return reply(dabTool(tables, name, args, { write: String(url).includes("write") }));
  };
  return { fetch, calls, rows };
}

/** a fake database: the Job and document rows filing reads, OrgPolicy (sources), and every statement it saw */
function fakeDb({ writable = true, payload } = {}) {
  const db = {
    statements: [],
    payload: payload ?? { record: "doc-1", home: "floor", sections: ["#71:3", "#71:4"], rid: "#71:3" },
    questions: [],
    pending: new Map(),
    async adbCommand(sql, _lang, params = {}) {
      db.statements.push(sql);
      if (sql.startsWith("INSERT INTO WorkerQuestion")) db.questions.push(params);
      if (sql.startsWith("UPDATE Job SET payload")) db.payload = JSON.parse(params.p);
      return [{ count: 1 }];
    },
    async adbQuery(sql, params = {}) {
      if (sql.includes("FROM OrgPolicy")) return sql.includes("'sources'") ? [{ json: JSON.stringify({ mssql: { read: "http://fake/read", write: writable ? "http://fake/write" : null } }) }] : [];
      if (sql.includes("FROM Job WHERE id")) return [{ payload: JSON.stringify(db.payload) }];
      if (sql.includes("_kind = 'document'")) return [{ rid: "#70:1", _recorded_by: db.recorder ?? "bob", _record_position: db.position ?? "floor" }];
      if (sql.includes("FROM PendingWrite")) return db.pending.has(params.id) ? [db.pending.get(params.id)] : [];
      if (sql.includes("FROM #80:1 WHERE _kind = 'thing'")) return [{ rid: "#80:1", label: "forklift 2", _homes: ["floor"], _keys: [] }];
      if (sql.includes("FROM #80:9 WHERE _kind = 'thing'")) return [{ rid: "#80:9", label: "the payroll", _homes: ["org"], _keys: [] }];
      return [];
    },
  };
  return db;
}

/** an in-memory log and request store, as filing.js arcadeStore keeps them */
function memoryStore() {
  const entries = [];
  const requests = [];
  const match = (row, filter) => Object.entries(filter).every(([k, v]) => v === undefined || k === "limit" || row[k] === v);
  return {
    entries_: entries,
    requests_: requests,
    async insertEntry(e) {
      entries.push(structuredClone(e));
      return e;
    },
    async annotateEntry(id, { account, verdict }) {
      const e = entries.find((x) => x.id === id);
      if (account !== undefined) e.account = account;
      if (verdict !== undefined) e.verdict = verdict;
    },
    async entries(filter = {}) {
      return entries.filter((e) => match(e, filter)).map((e) => structuredClone(e));
    },
    async insertRequest(r) {
      requests.push({ ...r });
      return r;
    },
    async updateRequest(id, fields) {
      Object.assign(requests.find((r) => r.id === id), fields);
    },
    async requests(filter = {}) {
      return requests.filter((r) => match(r, filter)).map((r) => ({ ...r }));
    },
    attempts_: [],
    async insertAttempt(a) {
      this.attempts_.push(structuredClone(a));
      return a;
    },
    async updateAttempt(id, { status, detail }) {
      Object.assign(this.attempts_.find((a) => a.id === id), { status, detail });
    },
    async attempt(id) {
      const a = this.attempts_.find((x) => x.id === id);
      return a ? structuredClone(a) : null;
    },
  };
}

const identity = { user: "admin/agent:w1", role: { kind: "worker", job: "11111111-2222-4333-8444-555555555555", entry: "#71:3" } };

function setup({ rows = [{ Job: 4471, Status: null, Quantity: 500 }, { Job: 4472, Status: "planned", Quantity: 20 }], down = false, writable = true, rule, payload } = {}) {
  forgetSources();
  forgetPrimaryKeys();
  const dab = fakeDab(rows, { down });
  const db = fakeDb({ writable, payload });
  const store = memoryStore();
  const queued = [];
  const signals = [];
  const resumed = [];
  let n = 0;
  const env = {
    db,
    store,
    positions: map,
    classes: { get: async (k) => classes.get(String(k).toLowerCase()) ?? null },
    readRow: (key) => readSourceRow(key, { db, fetch: dab.fetch }),
    findRows: async () => ({ status: "ok", rows: [] }),
    // the real decision: data-entry.js over the class map, the recorder as the token map holds them, and the fake DAB
    entered: [],
    enter: (args, opts = {}) => (env.entered.push(args), enterData(args, { ...opts, db, fetch: dab.fetch, positions: map, policy, people: (name) => people[name], queue: async (e) => (queued.push(e), { queued: true, pendingId: `pend-${queued.length}` }) })),
    signal: async (kind, payload) => signals.push({ kind, ...payload }),
    resume: async (job, message) => resumed.push({ job, message }),
    now: () => `2026-11-10T00:00:${String(n++).padStart(2, "0")}.000Z`,
    rule,
  };
  return { env, dab, db, store, queued, signals, resumed };
}

const piece = (over = {}) => ({ section: "#71:3", piece: "job 4471 is complete", said: "writing Status complete to job 4471", class: "jobs", key: "mssql:dbo_Job:4471", fields: { Status: "complete" }, ...over });

test("Filed: the recorder holds the authority the map names and the source takes writes, so the row is written and the entry names it", async () => {
  const h = setup();
  const r = await fileToSource(piece(), identity, h.env);
  assert.equal(r.outcome, "filed");
  assert.equal(h.dab.rows[0].Status, "complete", "written through the write endpoint");
  assert.ok(h.dab.calls.some((c) => c.name === "update_record" && c.url === "http://fake/write"));
  const [e] = h.store.entries_;
  assert.deepEqual([e.outcome, e.target.key, e.target.fields, e.recorder, e.worker, e.home, e.record], ["filed", "mssql:dbo_Job:4471", { Status: "complete" }, "bob", identity.role.job, "floor", "doc-1"]);
  assert.equal(h.queued.length, 0);
});

test("Proposed: the recorder lacks the authority, the class is missing from the map, or the source isn't writable; nothing is written (R2, R11)", async () => {
  // deliveries: seen on the floor, but the map gives Operations the authority, and bob is on the floor
  let h = setup();
  let r = await fileToSource(piece({ class: "deliveries" }), identity, h.env);
  assert.equal(r.outcome, "proposed");
  assert.equal(h.dab.rows[0].Status, null, "nothing written");
  assert.equal(h.queued.length, 1);
  assert.equal(h.store.entries_[0].pending_id, "pend-1");
  assert.equal(JSON.parse(h.queued[0].payload).acts_for.person, "bob", "the recorder's authority, never the agent's");
  assert.equal(h.queued[0].job, undefined, "a Proposed piece is an outcome, not a wait: the proposal names no thread");
  // machines: no map entry (R11: a class missing from the map means Proposed)
  h = setup();
  r = await fileToSource(piece({ class: "machines" }), identity, h.env);
  assert.equal(r.outcome, "proposed");
  assert.match(h.store.entries_[0].reason, /names no position/);
  // the source has no write endpoint (R2)
  h = setup({ writable: false });
  r = await fileToSource(piece(), identity, h.env);
  assert.equal(r.outcome, "proposed");
  assert.match(h.store.entries_[0].reason, /not writable/);
});

test("Held: the source can't be reached (R3) or holds no such row; the recorder is asked and nothing is written", async () => {
  let h = setup({ down: true });
  let r = await fileToSource(piece(), identity, h.env);
  assert.equal(r.outcome, "held");
  assert.equal(h.db.questions.length, 1);
  assert.equal(h.db.questions[0].of, "bob", "asked of whoever put it on record");
  assert.equal(h.db.questions[0].fe, h.store.entries_[0].id);
  assert.match(h.store.entries_[0].question, /couldn't be reached/);
  h = setup();
  r = await fileToSource(piece({ key: "mssql:dbo_Job:9999" }), identity, h.env);
  assert.equal(r.outcome, "held");
  assert.match(h.store.entries_[0].question, /No row mssql:dbo_Job:9999[\s\S]*Which record/);
  assert.equal(h.queued.length, 0);
});

test("the conservative rule F4 started from, kept: a different value in the source is Held with a conflict request, nothing overwritten", async () => {
  const h = setup({ rows: [{ Job: 4471, Status: "open", Quantity: 500 }, { Job: 4472, Status: "planned", Quantity: 20 }], rule: "hold_and_request" });
  const r = await fileToSource(piece({ says_change: true }), identity, h.env);
  assert.equal(r.outcome, "held");
  assert.equal(h.dab.rows[0].Status, "open", "never overwritten");
  assert.equal(h.store.requests_.length, 1);
  assert.equal(h.store.requests_[0].kind, "conflict");
  assert.equal(h.store.entries_[0].request, h.store.requests_[0].id);
  assert.match(h.store.entries_[0].question, /Status is "open" in the source, the record says "complete"/);
  assert.equal(h.signals[0].kind, "request", "the orchestrator hears of it");
  // an empty column taking a value is no disagreement
  const h2 = setup({ rule: "hold_and_request" });
  assert.equal((await fileToSource(piece(), identity, h2.env)).outcome, "filed");
});

test("R12, in force by default: a record saying something changed is filed given authority; one describing the state that disagrees is Held, asking the recorder", async () => {
  const rows = () => [{ Job: 4471, Status: "open", Quantity: 500 }, { Job: 4472, Status: "planned", Quantity: 20 }];
  let h = setup({ rows: rows() });
  assert.equal((await fileToSource(piece({ says_change: true }), identity, h.env)).outcome, "filed");
  assert.equal(h.dab.rows[0].Status, "complete");
  h = setup({ rows: rows() });
  assert.equal((await fileToSource(piece(), identity, h.env)).outcome, "held");
  assert.equal(h.store.requests_.length, 0, "the recorder is asked, the orchestrator isn't");
  assert.equal(h.db.questions[0]?.of, "bob", "asked of whoever put it on record");
  assert.equal(h.dab.rows[0].Status, "open");
  // a stated change still needs the recorder's authority: without it, it is Proposed and nothing is written
  h = setup({ rows: rows() });
  assert.equal((await fileToSource(piece({ class: "deliveries", says_change: true }), identity, h.env)).outcome, "proposed");
  assert.equal(h.dab.rows[0].Status, "open");
  // and the orchestrator's check reads the update afterwards (R12)
  h = setup({ rows: rows() });
  const f = await fileToSource(piece({ says_change: true, said: "updated job 4471 from open to complete" }), identity, h.env);
  assert.equal((await accountEvidence(identity.role.job, h.env)).entries.find((e) => e.entry === f.entry).suggested.result, "matches");
});

test("under the conservative rule, a conflict the orchestrator answered as an update is filed, given authority (R11)", async () => {
  const h = setup({ rows: [{ Job: 4471, Status: "open", Quantity: 500 }, { Job: 4472, Status: "planned", Quantity: 20 }], rule: "hold_and_request" });
  await fileToSource(piece(), identity, h.env);
  const req = h.store.requests_[0];
  await assert.rejects(fileToSource(piece({ confirmed_update: req.id }), identity, h.env), /isn't an answered request/, "not before it's answered");
  await answerRequest(req.id, { decision: "update" }, "admin/agent:orch", h.env);
  assert.deepEqual(h.resumed[0], { job: identity.role.job, message: { request: req.id, decision: "update", class: null, answered_by: "the orchestrator" } });
  const r = await fileToSource(piece({ confirmed_update: req.id, refiles: h.store.entries_[0].id }), identity, h.env);
  assert.equal(r.outcome, "filed");
  assert.equal(h.dab.rows[0].Status, "complete");
  assert.equal(h.store.entries_.at(-1).refiled_from, h.store.entries_[0].id, "the Held entry stays; the new one points back (F2)");
  assert.equal(h.store.entries_.length, 2);
});

test("the recorder who has left can't stand behind a write: Held, asking them (BUILD.md 12)", async () => {
  const h = setup();
  h.db.recorder = "gone";
  const r = await fileToSource(piece(), identity, h.env);
  assert.equal(r.outcome, "held");
  assert.equal(h.dab.rows[0].Status, null);
});

test("a worker files only its own sections under classes its audience sees, and makes no class (R5, R7, R11)", async () => {
  const h = setup();
  await assert.rejects(fileToSource(piece({ section: "#99:1" }), identity, h.env), /no section #99:1 in your brief/);
  // orders is homed at Operations: above a floor worker's audience
  await assert.rejects(fileToSource(piece({ class: "orders" }), identity, h.env), /no class orders you can file under[\s\S]*request one/);
  await assert.rejects(fileToSource(piece({ class: "forklift_bookings" }), identity, h.env), /request one/);
  assert.equal(h.store.entries_.length, 0);
});

test("Kept: no system holds it, the document is the source; Hold asks the recorder; both write nothing to a source (R2)", async () => {
  const h = setup();
  const k = await keepPiece({ section: "#71:4", piece: "the forklift is booked Thursday", instances: ["#80:1"] }, identity, h.env);
  assert.equal(k.outcome, "kept");
  assert.equal(h.store.entries_[0].target, null);
  const held = await holdPiece({ section: "#71:3", piece: "the Toro job", question: "Which Toro job did you mean?", class: "jobs" }, identity, h.env);
  assert.equal(held.outcome, "held");
  assert.equal(h.store.entries_[1].target.table, "mssql:dbo_Job", "a Held piece goes to a source: its class's table");
  await assert.rejects(holdPiece({ section: "#71:3", piece: "x y z", question: "what is it really?" }, identity, h.env), /keep it/);
  assert.equal(h.dab.calls.filter((c) => c.name === "update_record").length, 0);
  assert.deepEqual((await keptPieces(h.env)).map((p) => p.entry), [h.store.entries_[0].id]);
});

test("re-filing a Kept piece points back at it and the Kept entry stays (R11: nothing Kept is deleted)", async () => {
  const h = setup();
  const k = await keepPiece({ section: "#71:4", piece: "job 4471 is complete", instances: ["#80:1"] }, identity, h.env);
  await fileToSource(piece({ refiles: k.entry }), identity, h.env);
  assert.equal(h.store.entries_.length, 2);
  assert.equal(h.store.entries_[1].refiled_from, k.entry);
  assert.deepEqual(await keptPieces(h.env), [], "re-filed, so no longer waiting");
  assert.equal(h.store.entries_[0].outcome, "kept", "the Kept entry is unchanged");
});

test("requests (R10): structured answers only, naming a class the worker's audience sees; at most three open", async () => {
  const h = setup();
  const r = await requestOrchestrator({ kind: "class", question: "No class fits a forklift booking", suggestion: "under event" }, identity, h.env);
  await assert.rejects(answerRequest(r.request, { decision: "use_class", class: "orders" }, "orch", h.env), /isn't a class the worker's audience can see/, "orders is above the floor");
  await assert.rejects(answerRequest(r.request, { decision: "keep", class: "jobs" }, "orch", h.env), /keep names no class/);
  await assert.rejects(answerRequest(r.request, { decision: "sure, file it however" }, "orch", h.env), /must be one of/);
  const a = await answerRequest(r.request, { decision: "use_class", class: "maintenance" }, "orch", h.env);
  assert.deepEqual([a.decision, a.class], ["use_class", "maintenance"]);
  assert.equal(h.store.requests_[0].status, "answered");
  for (let i = 0; i < 3; i++) await requestOrchestrator({ kind: "other", question: `question number ${i}` }, identity, h.env);
  await assert.rejects(requestOrchestrator({ kind: "other", question: "one more question" }, identity, h.env), /3 open requests/);
});

test("the account (R10): every entry needs one before the thread is done, and only its own entries take one", async () => {
  const h = setup();
  const f = await fileToSource(piece(), identity, h.env);
  const k = await keepPiece({ section: "#71:4", piece: "the forklift is booked", instances: ["#80:1"] }, identity, h.env);
  assert.equal(await accountGiven(identity.role.job, h.db.payload, h.env), false);
  let a = await giveAccount({ pieces: [{ entry: f.entry, said: "I wrote Status complete to job 4471" }] }, identity, h.env);
  assert.deepEqual(a.missing, [k.entry]);
  assert.equal(await accountGiven(identity.role.job, h.db.payload, h.env), false);
  await assert.rejects(giveAccount({ pieces: [{ entry: "not-mine-at-all", said: "x" }] }, identity, h.env), /isn't one of yours/);
  a = await giveAccount({ pieces: [{ entry: k.entry, said: "kept the forklift booking" }] }, identity, h.env);
  assert.deepEqual(a.missing, []);
  assert.equal(await accountGiven(identity.role.job, h.db.payload, h.env), true);
  // a thread that isn't filing a record needs none
  assert.equal(await accountGiven("x", { task: { title: "survey" } }, h.env), true);
});

test("the orchestrator checks an account against the source itself (R10, R11): a write that isn't in the row differs", async () => {
  const h = setup();
  const f = await fileToSource(piece(), identity, h.env);
  await giveAccount({ pieces: [{ entry: f.entry, said: "I wrote Status complete to job 4471" }] }, identity, h.env);
  let ev = await accountEvidence(identity.role.job, h.env);
  assert.deepEqual([ev.entries[0].suggested.result, ev.entries[0].source_now], ["matches", { Status: "complete" }]);
  // someone changes the row after: the account no longer matches the source
  h.dab.rows[0].Status = "open";
  ev = await accountEvidence(identity.role.job, h.env);
  assert.equal(ev.entries[0].suggested.result, "differs");
  const v = await recordVerdict(f.entry, { result: "differs", note: "the row says open" }, "orch", h.env);
  assert.deepEqual([v.verdict.result, v.verdict.by], ["differs", "orch"]);
  assert.equal(h.store.entries_[0].outcome, "filed", "a verdict changes no outcome (F8)");
  const k = await keepPiece({ section: "#71:4", piece: "no account yet", instances: ["#80:1"] }, identity, h.env);
  await assert.rejects(recordVerdict(k.entry, { result: "matches" }, "orch", h.env), /no account yet/);
});

test("an approved Proposed piece becomes Filed in the log, pointing back; a rejected one stays Proposed (R11, F6)", async () => {
  const h = setup();
  await fileToSource(piece({ class: "deliveries" }), identity, h.env);
  await fileToSource(piece({ class: "deliveries", key: "mssql:dbo_Job:4472", fields: { Quantity: 25 } }), identity, h.env);
  h.db.pending.set("pend-1", { status: "approved", approved_by: "alice" });
  h.db.pending.set("pend-2", { status: "rejected", approved_by: "alice" });
  assert.deepEqual(await settleProposals(h.env), { filed: 1 });
  assert.deepEqual(await settleProposals(h.env), { filed: 0 }, "idempotent");
  const filed = h.store.entries_.filter((e) => e.outcome === "filed");
  assert.equal(filed.length, 1);
  assert.equal(filed[0].refiled_from, h.store.entries_[0].id);
  assert.match(filed[0].reason, /approved by alice/);
});

test("an instance: a lasting individual under a visible class; a class whose rows stay in the source refuses (R3)", async () => {
  const h = setup();
  await assert.rejects(createInstance({ section: "#71:3", name: "job 4471", class: "jobs", key: "mssql:dbo_Job:4471" }, identity, h.env), /rows stay in the source/);
  await assert.rejects(createInstance({ section: "#71:3", name: "Nobody", class: "people", key: "mssql:dbo_Employee:E9" }, identity, h.env), /no such row/);
  const r = await createInstance({ section: "#71:3", name: "Diep", class: "people", key: "mssql:dbo_Employee:E1" }, identity, h.env);
  assert.equal(r.created, true);
  assert.ok(h.db.statements.some((s) => s.startsWith("CREATE VERTEX Entity") && s.includes("_kind = 'thing'")));
  assert.ok(h.db.statements.some((s) => s.startsWith("CREATE EDGE INSTANCE_OF")));
  assert.ok(h.db.statements.some((s) => s.startsWith("CREATE EDGE ABOUT FROM #71:3")));
});

/** ---- briefs, claim gates and the orchestrator's split by home (worker-pool.js, orchestrator.js) ---- */

const { composeFilingBrief, filingJob } = await import("../src/worker-pool.js");
const { startRecordWorkers, startUnstarted } = await import("../src/orchestrator.js");
const { taskBrief } = await import("../src/pool.js");

/** a graph as rows: sections, a document, classes, instances and edges, answering the reads a brief and a claim make */
function graphDb({ onRecord = true, ungraded = null, docHome = "floor", jobs = [] } = {}) {
  const sections = [
    { rid: "#71:3", name: "s1", heading: "Handover", text_identity: "Job 4471 is done. floor-marker", _home: "floor", _doc_id: "doc-1", _ungraded: ungraded },
    { rid: "#71:4", name: "s2", heading: "Prices", text_identity: "Toro pays 4.10 a part. ZEBRA-OPS-TEXT", _home: "ops", _doc_id: "doc-1", _ungraded: null },
  ];
  const classRows = [
    { rid: "#40:1", _class_key: "jobs", _class_name: "jobs", _home: "floor", _record_table: "mssql:dbo_Job", _rows_are_nodes: false },
    { rid: "#40:2", _class_key: "zebra_pay_class", _class_name: "ZEBRA-ORG-CLASS", _home: "org" },
  ];
  const things = [
    { rid: "#80:1", label: "CNC 5", _homes: ["floor"], _keys: [] },
    { rid: "#80:2", label: "ZEBRA-INSTANCE", _homes: ["org"], _keys: [] },
  ];
  const enq = [];
  return {
    enq,
    jobs,
    async adbCommand() {
      return [{ count: 1 }];
    },
    async adbQuery(sql, params = {}) {
      if (sql.includes("out('ABOUT')")) return things;
      if (/FROM \[#71/.test(sql)) return sections.filter((s) => sql.includes(s.rid));
      if (sql.startsWith("SELECT _doc_id, _home, _kind FROM #71")) return sections.filter((s) => sql.includes(s.rid)).map((s) => ({ ...s, _kind: "section" }));
      if (sql.includes("_kind = 'document'")) return [{ name: "ZEBRA-TITLE", _home: docHome, _on_record: onRecord, _recorded_by: "bob", _record_position: "floor" }];
      if (sql.includes("_kind = 'section' AND _doc_id")) return sections;
      if (sql.includes("_kind = 'class'")) return classRows;
      if (sql.includes("FROM SUBCLASS_OF")) return [];
      if (sql.includes("out('INSTANCE_OF')")) return sql.includes("#80:1") ? [{ key: "machines" }] : [{ key: "zebra_pay_class" }];
      if (sql.includes("outE('DEPENDS_ON')")) return [{ src: "#80:1", dst: "#80:2", note: "ZEBRA-EDGE" }];
      if (sql.includes("FROM Job WHERE kind = 'review'")) return jobs.filter((j) => !params.k || j.job_key === params.k || (params.k.endsWith("%") && j.job_key.startsWith(params.k.slice(0, -1))));
      if (sql.includes("FROM WorkBatch")) return [{ id: "b1", entries: JSON.stringify(["doc-1"]) }];
      return [];
    },
  };
}

test("a brief holds only what its audience sees (R7, R11): marked items above the floor never reach a floor worker's brief", async () => {
  const db = graphDb({ docHome: "ops" });
  const composed = await composeFilingBrief({ record: "doc-1", home: "floor", sections: ["#71:3"] }, { db, positions: map, sources: { mssql: { read: "http://r", write: "http://w" } }, entries: async () => [] });
  const text = taskBrief(composed);
  assert.doesNotMatch(text, /ZEBRA/, "no class, instance, edge, title or section text above the audience");
  assert.match(text, /Job 4471 is done/);
  assert.match(text, /CNC 5 \(machines\)/);
  assert.match(text, /Classes \(1; 1 more above your audience\)/);
  assert.match(text, /Record: its title is above your audience/, "the title takes the strictest home among the sections (R11)");
  assert.deepEqual(composed.dependencies, [], "a dependency is seen only by someone who sees both ends (R11)");
  assert.doesNotMatch(JSON.stringify(composed.brief.sources), /http/, "a brief says how a source is committed to, never where it is");
  // the Operations worker of the same record sees the title and its own section, not the floor's alone
  const ops = taskBrief(await composeFilingBrief({ record: "doc-1", home: "ops", sections: ["#71:4"] }, { db, positions: map, sources: {}, entries: async () => [] }));
  assert.match(ops, /ZEBRA-TITLE/);
  assert.match(ops, /ZEBRA-OPS-TEXT/);
  assert.doesNotMatch(ops, /ZEBRA-ORG-CLASS|ZEBRA-INSTANCE|ZEBRA-EDGE/);
});

test("a claim's gates: nothing off record reaches a worker (R11); an unchecked section waits (F11); a record is split by home (R11)", async () => {
  assert.deepEqual((await filingJob("j1", { rid: "#71:3" }, graphDb({ onRecord: false }), map)).skip, "done");
  assert.deepEqual((await filingJob("j1", { rid: "#71:3" }, graphDb({ ungraded: "{}" }), map)).skip, "later");
  const setup1 = await filingJob("j1", { rid: "#71:3" }, graphDb(), map);
  assert.deepEqual([setup1.payload.record, setup1.payload.home, setup1.payload.sections], ["doc-1", "floor", ["#71:3"]], "only the sections at its home");
  // the per-section path: a section another filing job of the record and home holds isn't filed twice
  const held = graphDb({ jobs: [{ id: "j0", job_key: "file:doc-1:floor", payload: JSON.stringify({ sections: ["#71:3"] }) }] });
  assert.equal((await filingJob("j1", { rid: "#71:3" }, held, map)).skip, "done");
});

test("the orchestrator starts one worker per home of a record (R11), keeps a home's existing job, and refuses an off-record one", async () => {
  const db = graphDb();
  const enq = [];
  const enqueue = async (kind, payload, opts) => (enq.push({ kind, payload, opts }), `job-${enq.length}`);
  const started = await startRecordWorkers("doc-1", { by: "orch" }, { db, enqueue, positions: map, pool: { threadMinutes: 20 } });
  assert.deepEqual(started.map((s) => s.home).sort(), ["floor", "ops"]);
  assert.deepEqual(enq.map((e) => [e.payload.home, e.payload.sections, e.opts.key]).sort(), [["floor", ["#71:3"], "file:doc-1:floor"], ["ops", ["#71:4"], "file:doc-1:ops"]]);
  const again = await startRecordWorkers("doc-1", { by: "orch" }, { db: graphDb({ jobs: [{ id: "j0", job_key: "file:doc-1:floor", status: "done" }] }), enqueue, positions: map, pool: { threadMinutes: 20 } });
  assert.equal(again.find((s) => s.home === "floor").already, true, "a record is filed once");
  await assert.rejects(startRecordWorkers("doc-1", {}, { db: graphDb({ onRecord: false }), enqueue, positions: map, pool: {} }), /isn't on record/);
});

test("every record gets a worker (R4): one the orchestrator left is started when its batch has waited", async () => {
  const startedFor = [];
  const n = await startUnstarted({ minutes: 15, db: graphDb(), start: async (record) => (startedFor.push(record), [{ home: "floor", job: "j" }]) });
  assert.deepEqual([n, startedFor], [1, ["doc-1"]]);
  const none = await startUnstarted({ minutes: 15, db: graphDb({ jobs: [{ id: "j0", job_key: "file:doc-1:floor" }] }), start: async () => assert.fail("already has a worker") });
  assert.equal(none, 0);
});

test("the source-write journal (the sources stream's adapter writes only through it): an approval settled written files the Proposed piece, once (R9, R11)", async () => {
  const h = setup();
  const p = await fileToSource(piece({ class: "deliveries" }), identity, h.env);
  assert.equal(p.outcome, "proposed");
  // the worker path hands the adapter what it read and which piece the write belongs to
  assert.deepEqual(h.env.entered[0].before, { Status: null });
  assert.deepEqual(h.env.entered[0].piece, { record: "doc-1", section: "#71:3", job: identity.role.job, piece: "job 4471 is complete" });
  const journal = makeJournal(h.env);
  await assert.rejects(journal.begin({ system: "mssql", key: "mssql:dbo_Job:4471" }), /names its system, table and action/, "no attempt, no write");
  const attempt = { system: "mssql", table: "dbo_Job", key: "mssql:dbo_Job:4471", action: "update", fields: { Status: "complete" }, before: { Status: null }, piece: { pending_id: "pend-1", approved_by: "alice" } };
  const refused = await journal.begin(attempt);
  await journal.settle(refused, "refused", { error: "permission denied" });
  assert.equal(h.store.entries_.filter((e) => e.outcome === "filed").length, 0, "a refused write files nothing");
  const id = await journal.begin(attempt);
  assert.equal(h.store.attempts_.find((a) => a.id === id).status, "begun", "begun before the write");
  await journal.settle(id, "written", { after: { Status: "complete" } });
  await journal.settle(id, "written", { after: { Status: "complete" } });
  const filed = h.store.entries_.filter((e) => e.outcome === "filed");
  assert.equal(filed.length, 1, "once");
  assert.deepEqual([filed[0].refiled_from, filed[0].account.said, filed[0].reason], [p.entry, "writing Status complete to job 4471", "approved by alice"]);
  assert.equal(h.store.entries_.find((e) => e.id === p.entry).outcome, "proposed", "the Proposed entry stays");
  await assert.rejects(journal.settle(id, "maybe"), /not a write's status/);
  // the loop's sweep doesn't file it twice
  h.db.pending.set("pend-1", { status: "approved", approved_by: "alice" });
  assert.deepEqual(await settleProposals(h.env), { filed: 0 });
});

test("the sources adapter's held answer (a write that didn't land) is a Held entry asking the recorder, never a refusal", async () => {
  const h = setup();
  h.env.enter = async () => ({ outcome: "held", status: "moved", why: "the row changed since it was read" });
  const r = await fileToSource(piece(), identity, h.env);
  assert.equal(r.outcome, "held");
  assert.match(h.store.entries_[0].reason, /^moved: the row changed since it was read/);
  assert.equal(h.db.questions[0].of, "bob");
});
