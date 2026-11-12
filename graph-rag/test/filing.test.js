// Filing a record (filing.js): the four outcomes (R2), decided in code from facts (the row as a fake DAB holds it,
// the class map, the recorder's standing), never taken from the model; requests (R10), the account and the
// orchestrator's check (R10, R11), approvals (R11), Kept and re-filing (R11). The fakes hand the code facts: a DAB
// over fake-dab-core.mjs (DAB 2.0.12's answers), an in-memory log, a database that answers the few reads filing
// makes. The real data-entry.js decides Filed or Proposed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dabTool } from "../e2e/fake-dab-core.mjs";
import { addData, commitRow, describeSource, describeTable, enterData, forgetPrimaryKeys, forgetSources, removeAdded, searchRows, tableRows } from "../src/data-entry.js";
import { sourceFor } from "../src/sources.js";
import { tableShape, writable as declaredWritable } from "../src/model/sources.js";
import { accountEvidence, accountGiven, answerRequest, createInstance, describeSourceFor, findText, makeJournal, fileToSource, giveAccount, undoFiled, holdPiece, floorUnsettled, keepPiece, keptPieces, kickBack, laterClassOrSource, readSourceRow, REFILE_LIMIT, refileRefusal, recordVerdict, requestOrchestrator, settleProposals } from "../src/filing.js";
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
    { name: "people", parents: ["agent"], home: "floor", record_table: "mssql:dbo_Crew", rows_are_nodes: true },
    // seen on the floor, its table the jobs table, and no entry in the map
    { name: "tools", parents: ["resource"], home: "floor", record_table: "mssql:dbo_Job", rows_are_nodes: false },
    // the reviewer's probe (F-B1): pay sits in an org-level table
    { name: "payroll", parents: ["agent"], home: "org", record_table: "mssql:dbo_Pay", rows_are_nodes: false },
  ].map((c) => {
    const n = normalizeClass(c, { positions: map });
    return [n.key, { ...n, rid: `#40:${n.key.length}` }];
  }),
);

/** a fake DAB over fetch: the read-only endpoint and the write-capable one, or none that answers */
function fakeDab(rows, { down = false } = {}) {
  const tables = {
    dbo_Job: { primaryKey: ["Job"], rows },
    dbo_Crew: { primaryKey: ["Emp"], rows: [{ Emp: "E1", Name: "Diep" }, { Emp: "E2", Name: "Sam" }] },
    // R19: a table that takes new rows, its key made by the source, deletable only to undo an add
    dbo_Equipment: { primaryKey: ["Equipment"], rows: [{ Equipment: "FL-HYSTER", Description: "Hyster forklift" }, { Equipment: "FL-TOYOTA", Description: "Toyota forklift" }] },
    dbo_Maintenance: { primaryKey: ["Maintenance"], identity: true, deletes: true, rows: [{ Maintenance: 1, Work_Center: "CNC 2", Opened: "2026-10-27", Description: "Warm-up runs long", Status: "Open" }, { Maintenance: 2, Work_Center: null, Opened: "2026-09-14", Description: "Annual inspection", Status: "Closed" }] },
  };
  const calls = [];
  const fetch = async (url, init) => {
    if (down) throw new Error("fetch failed: ECONNREFUSED");
    const body = JSON.parse(init.body);
    const reply = (result) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26" });
    const { name, arguments: args } = body.params;
    calls.push({ url, name, args });
    const write = String(url).includes("write");
    // the write side's identity view: the guard asks it which server and database the write connection holds
    return reply(dabTool(write ? { ...tables, dbo_GwConnectionIdentity: { primaryKey: ["id"], rows: [{ id: 1, server_name: "gwsynth-sql", database_name: "GwSynthMfg", login_name: "gwsynth_write" }] } } : tables, name, args, { write }));
  };
  return { fetch, calls, rows, tables };
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
      // the declaration (model/sources.js): read at the floor's home, written to dbo_Job behind the guard
      if (sql.includes("FROM OrgPolicy")) return sql.includes("'sources'") ? [{ json: JSON.stringify([{ system: "mssql", read: { via: "dab-mcp", url: "http://fake/read", home: db.readHome ?? "floor" }, commit: writable ? { via: "dab-mcp", url: "http://fake/write", tables: [{ name: "dbo_Job", columns: db.jobColumns ?? {} }, { name: "dbo_Maintenance", adds: true, columns: { Status: { values: ["Open", "Closed"] }, Equipment: { references: "dbo_Equipment" } }, required: ["Opened", "Description", "Status"] }], actions: ["create", "update", "delete"], guard: { server: "gwsynth-sql", database: "GwSynthMfg" } } : { via: "none" } }]) }] : [];
      if (sql.includes("FROM Job WHERE id")) return [{ payload: JSON.stringify(db.payload) }];
      if (sql.includes("_kind = 'document'")) return [{ rid: "#70:1", _recorded_by: db.recorder ?? "bob", _record_position: db.position ?? "floor", _recorded_at: "2026-11-09T08:00:00.000Z" }];
      if (sql.includes("FROM PendingWrite")) return db.pending.has(params.id) ? [db.pending.get(params.id)] : [];
      // R15: a section's own text, and the instances the worker related to it (ABOUT edges)
      if (/FROM #71:\d+ WHERE _kind = 'section'/.test(sql)) return [{ rid: sql.match(/#71:\d+/)[0], _doc_id: "doc-1", _home: "floor", text_identity: `the text of ${sql.match(/#71:\d+/)[0]}` }];
      if (sql.includes("expand(outE('ABOUT'))")) return (db.about ?? {})[sql.match(/FROM (#\d+:\d+)\)/)?.[1]] ?? [];
      if (sql.includes("FROM #80:1 WHERE _kind = 'thing'")) return [{ rid: "#80:1", label: "forklift 2", _homes: ["floor"], _keys: [] }];
      if (sql.includes("FROM #80:9 WHERE _kind = 'thing'")) return [{ rid: "#80:9", label: "the payroll", _homes: ["org"], _keys: [] }];
      // instances by name (resolve_name, and a name where an id is wanted, I-42): db.things [{ rid, norm, _homes }]
      if (sql.includes("_norm = :n")) return (db.things ?? []).filter((t) => t.norm === params.n).map((t) => ({ rid: t.rid, label: t.norm, _homes: t._homes, _keys: [] }));
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
    async annotateEntry(id, { account, verdict, undone }) {
      const e = entries.find((x) => x.id === id);
      if (account !== undefined) e.account = account;
      if (verdict !== undefined) e.verdict = verdict;
      if (undone !== undefined) e.undone = undone;
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
    async createAttempts({ system, table }) {
      return this.attempts_.filter((a) => a.action === "create" && a.system === system && a.table === table).map((a) => structuredClone(a));
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
  const h = { found: [], related: [], depended: [] };
  const env = {
    db,
    store,
    positions: map,
    classes: { get: async (k) => classes.get(String(k).toLowerCase()) ?? null },
    readRow: (key, o = {}) => readSourceRow(key, { db, fetch: dab.fetch, positions: map, ...o }),
    findRows: async (...a) => (h.found.push(a), { status: "ok", rows: [{ Name: "Bob", Pay: 41 }] }),
    // R16: the section's own text (env.texts by rid), and the table's rows from the fake DAB, as the audience reads them
    // R16's undo: the write adapter over the fake DAB; who holds the authority for the class, as an approver must
    commit: (args, o = {}) => commitRow(args, { db, fetch: dab.fetch, journal: makeJournal(env), ...o }),
    removeAdded: (args, o = {}) => removeAdded(args, { db, fetch: dab.fetch, journal: makeJournal(env), ...o }),
    tableShape: async (system, table) => {
      const d = await sourceFor(system, db);
      return { ...tableShape(d, table), adds: declaredWritable(d, table, "create") };
    },
    approverHolds: async (p, person) => {
      if (person !== "bob") throw new Error(`not applied: ${person} doesn't hold the authority the map names for ${p.class}`);
    },
    sectionText: async (rid) => env.texts?.[rid] ?? "Job 4471 is complete.",
    tableRows: (system, table, o = {}) => tableRows({ system, table }, { db, fetch: dab.fetch, positions: map, ...o }),
    classesForTable: async (table) => [...classes.values()].filter((c) => c.record_table === table).map((c) => ({ key: c.key, home: c.home })),
    connectionHome: () => undefined,
    instances: {
      relate: async (args, scope, actor, opts) => (h.related.push({ args, scope, actor, opts }), h.relateAnswer ?? { instance: "#80:1", name: args.name, class: args.class, created: true, related: true }),
      depend: async (args, scope, actor, opts) => (h.depended.push({ args, scope, actor, opts }), { dependency: { from: args.from.startsWith("#") ? args.from : "#80:5", to: args.to.startsWith("#") ? args.to : "#80:6", stated_as: args.stated_as } }),
    },
    // the real decision: data-entry.js over the class map, the recorder as the token map holds them, and the fake DAB
    entered: [],
    enter: (args, opts = {}) => (env.entered.push(args), enterData(args, { journal: makeJournal(env), index: null, ...opts, db, fetch: dab.fetch, positions: map, policy, people: (name) => people[name], queue: async (e) => (queued.push(e), { queued: true, pendingId: `pend-${queued.length}` }) })),
    add: (args, opts = {}) => (env.entered.push(args), addData(args, { journal: makeJournal(env), index: null, ...opts, db, fetch: dab.fetch, positions: map, policy, people: (name) => people[name], queue: async (e) => (queued.push(e), { queued: true, pendingId: `pend-${queued.length}` }) })),
    signal: async (kind, payload) => signals.push({ kind, ...payload }),
    resume: async (job, message) => resumed.push({ job, message }),
    now: () => `2026-11-10T00:00:${String(n++).padStart(2, "0")}.000Z`,
    rule,
  };
  return { env, dab, db, store, queued, signals, resumed, found: h.found, related: h.related, depended: h.depended, h };
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
  r = await fileToSource(piece({ class: "tools" }), identity, h.env);
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

test("R16: a write lands when the record names the row and gives every value, whatever was there before; the old value is kept", async () => {
  const rows = () => [{ Job: 4471, Status: "open", Quantity: 500 }, { Job: 4472, Status: "planned", Quantity: 20 }];
  // a value over another: no state-versus-change test, and nothing the worker says about it counts
  let h = setup({ rows: rows() });
  const f = await fileToSource(piece({ says_change: false }), identity, h.env);
  assert.equal(f.outcome, "filed");
  assert.equal(h.dab.rows[0].Status, "complete");
  assert.equal(h.store.entries_[0].reason, 'before: {"Status":"open"}', "logged with the value it replaced");
  // a number given with separators, and a row named only by what it holds (the one Quantity 20 job)
  h = setup({ rows: rows() });
  h.env.texts = { "#71:3": "The planned job is now 1,200 pieces." };
  assert.equal((await fileToSource(piece({ key: "mssql:dbo_Job:4472", fields: { Quantity: 1200 } }), identity, h.env)).outcome, "filed");
  assert.equal(h.dab.rows[1].Quantity, 1200);
  // the orchestrator's check reads the write afterwards, and decides nothing about whether it lands
  h = setup({ rows: rows() });
  const g = await fileToSource(piece({ said: "updated job 4471 from open to complete" }), identity, h.env);
  const ev0 = (await accountEvidence(identity.role.job, h.env)).entries.find((e) => e.entry === g.entry);
  assert.equal(ev0.suggested.result, undefined, "the verdict is the orchestrator's, from the section");
  assert.match(ev0.suggested.checked, /holds what was filed/);
});

test("R16: one condition failing holds the piece, nothing written, and the recorder is asked in one sentence which", async () => {
  const rows = () => [{ Job: 4471, Status: "open", Quantity: 500 }, { Job: 4472, Status: "open", Quantity: 500 }];
  // 3: a value the record doesn't give (a reworded one)
  let h = setup({ rows: rows() });
  h.env.texts = { "#71:3": "Job 4471 is done." };
  // I-50: the worker is told once, with nothing filed; the same piece again is decided
  let r = await fileToSource(piece(), identity, h.env);
  assert.deepEqual([r.outcome, r.fields.map((x) => x.column), h.store.entries_.length], ["not_filed", ["Status"], 0]);
  r = await fileToSource(piece(), identity, h.env);
  assert.equal(r.outcome, "held");
  assert.match(r.note, /R16 condition 3/);
  assert.equal(h.dab.rows[0].Status, "open", "nothing written");
  assert.equal(h.queued.length, 0, "nothing queued: no person decides it");
  assert.equal(h.db.questions[0]?.of, "bob", "the recorder is asked");
  assert.match(h.store.entries_[0].question, /wasn't written to mssql:dbo_Job:4471\. Not every value is in your words: Status would read "complete"/);
  assert.match(h.store.entries_[0].reason, /^R16 condition 3/);
  // 2: the row isn't named, and two rows match the record alike
  h = setup({ rows: rows() });
  h.env.texts = { "#71:3": "The open job is complete." };
  r = await fileToSource(piece(), identity, h.env);
  assert.equal(r.outcome, "held");
  assert.match(h.store.entries_[0].question, /It isn't clear which row/);
  // 1: without the authority it is Proposed, as before, and a person with it decides
  h = setup({ rows: rows() });
  assert.equal((await fileToSource(piece({ class: "deliveries" }), identity, h.env)).outcome, "proposed");
  // 4: the row changed since it was read: Held (commitRow), nothing written over it
  h = setup({ rows: rows() });
  const real = h.env.enter;
  h.env.enter = async (args, opts) => ((h.dab.rows[0].Status = "moved"), real(args, opts));
  assert.equal((await fileToSource(piece(), identity, h.env)).outcome, "held");
  assert.equal(h.dab.rows[0].Status, "moved");
});

test("the orchestrator's update answer to a request resumes the worker to file again; graph-rag decides whether it lands", async () => {
  const h = setup();
  const req = await requestOrchestrator({ kind: "conflict", section: "#71:3", question: "The row says open; is the record an update?" }, identity, h.env);
  await answerRequest(req.request ?? h.store.requests_[0].id, { decision: "update" }, "admin/agent:orch", h.env);
  assert.equal(h.resumed[0].message.decision, "update");
  const { resumeBrief } = await import("../src/pool.js");
  assert.match(resumeBrief(h.resumed[0].message), /graph-rag decides whether it lands/);
  assert.equal((await fileToSource(piece(), identity, h.env)).outcome, "filed");
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
  h.env.laterClassOrSource = async () => true; // a class made since (R14)
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
  assert.deepEqual([ev.entries[0].suggested.result, ev.entries[0].source_now], [undefined, { Status: "complete" }]);
  assert.equal(ev.entries[0].section_text, "the text of #71:3", "the section's own text, to judge the entry by");
  assert.deepEqual(ev.entries[0].row_before, { Status: null }, "the row before the write, as the entry recorded it");
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

/** ---- briefs, claim gates and the orchestrator's split by home (worker-pool.js, orchestrator.js) ---- */

const { composeFilingBrief, filingJob, logBrief } = await import("../src/worker-pool.js");
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
    { rid: "#80:3", label: "the dock", _homes: ["floor"], _keys: [] },
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
      if (sql.includes("outE('INSTANCE_OF')")) return sql.includes("#80:1") ? [{ cls: "#40:1", home: "floor" }, { cls: "#40:2", home: "org" }, { cls: "#40:1", home: null }] : [{ cls: "#40:2", home: "org" }];
      if (sql.includes("outE('DEPENDS_ON')")) return [{ src: "#80:1", dst: "#80:2", note: "ZEBRA-EDGE", home: "org" }, { src: "#80:1", dst: "#80:3", note: "ZEBRA-LINK-ABOVE", home: "ops" }, { src: "#80:3", dst: "#80:1", note: "a link with no home", home: null }, { src: "#80:3", dst: "#80:1", note: "floor-link", home: "floor" }];
      if (sql.includes("FROM Job WHERE kind = 'review'")) return jobs.filter((j) => !params.k || j.job_key === params.k || (params.k.endsWith("%") && j.job_key.startsWith(params.k.slice(0, -1))));
      if (sql.includes("FROM WorkBatch")) return [{ id: "b1", entries: JSON.stringify(["doc-1"]) }];
      return [];
    },
  };
}

test("a brief holds only what its audience sees (R7, R11): marked items above the floor never reach a floor worker's brief", async () => {
  const db = graphDb({ docHome: "ops" });
  // the declarations (model/sources.js): one read at the floor's home, one read at the top (above a floor worker)
  const sources = {
    mssql: { system: "mssql", description: null, read: { via: "dab-mcp", url: "http://r", home: "floor" }, commit: { via: "dab-mcp", url: "http://w", tables: ["dbo_Job"], actions: ["update"] } },
    zebra: { system: "zebra", description: "ZEBRA-PAYROLL-SOURCE", read: { via: "dab-mcp", url: "http://z", home: "org" }, commit: { via: "none" } },
  };
  const composed = await composeFilingBrief({ record: "doc-1", home: "floor", sections: ["#71:3"] }, { db, positions: map, sources, entries: async () => [] });
  assert.deepEqual(composed.brief.sources, [{ system: "mssql", description: null, commits: true, actions: ["update"], tables: ["dbo_Job"] }], "each source as declared, only those read within the audience");
  const text = taskBrief(composed);
  assert.doesNotMatch(text, /ZEBRA/, "no class, instance, edge, title or section text above the audience");
  assert.match(text, /Job 4471 is done/);
  assert.match(text, /CNC 5 \(jobs\)/, "its classes by links the audience sees: the org link and the homeless one are left out");
  assert.doesNotMatch(text, /zebra_pay_class/);
  assert.match(text, /Classes \(1; 1 more above your audience\)/);
  assert.match(text, /Record: its title is above your audience/, "the title takes the strictest home among the sections (R11)");
  assert.deepEqual(composed.dependencies.map((d) => d.note), ["floor-link"], "a dependency is seen by someone who sees both ends (R11) and its link's home; none counts as the root");
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

// the reviewer's probe on b0e8ca7 (F-B1): a floor worker reading the pay row of an org-level table
test("F-B1: a worker reads no table above its audience: resolve_name, file_to_source and a dependency's row are refused before anything is read (R7, R11.6, R11.9)", async () => {
  const { resolveName, stateDependency } = await import("../src/filing.js");
  const h = setup();
  await assert.rejects(resolveName({ name: "Bob", table: "mssql:dbo_Pay", column: "Name" }, identity, h.env), /mssql:dbo_Pay is above your audience/);
  assert.deepEqual(h.found, [], "the source was never asked");
  await assert.rejects(resolveName({ name: "Bob", table: "mssql:dbo_Secret", column: "Name" }, identity, h.env), /no class you can see records mssql:dbo_Secret/, "a table no class vouches for counts as the root's");
  // a key outside its class's own table is refused, so a visible class can't vouch for another table
  await assert.rejects(fileToSource(piece({ key: "mssql:dbo_Pay:E1", fields: { Pay: 50 } }), identity, h.env), /isn't a row of jobs's table/);
  await assert.rejects(stateDependency({ section: "#71:3", from: "mssql:dbo_Pay:E1", to: "#80:1", stated_as: "record" }, identity, h.env), /above your audience/);
  assert.equal(h.dab.calls.filter((c) => c.args?.entity === "dbo_Pay").length, 0, "no pay row was read");
  assert.equal(h.store.entries_.length, 0);
  // a connection whose home is above the audience refuses even a table a floor class vouches for (once sources declare homes)
  h.env.connectionHome = (system) => (system === "mssql" ? "ops" : undefined);
  await assert.rejects(resolveName({ name: "Bob", table: "mssql:dbo_Job", column: "Name" }, identity, h.env), /connection above your audience/);
  h.env.connectionHome = () => "floor";
  assert.equal((await resolveName({ name: "Bob", table: "mssql:dbo_Job", column: "Name" }, identity, h.env)).source.status, "ok");
});

test("every brief is logged as sent (BriefLog, for the leak gate), and one that can't be logged is refused", async () => {
  const composed = await composeFilingBrief({ record: "doc-1", home: "floor", sections: ["#71:3"] }, { db: graphDb({ docHome: "ops" }), positions: map, sources: {}, entries: async () => [] });
  const seen = [];
  const message = taskBrief({ ...composed, why: "re-filing: a class may fit now" });
  const row = await logBrief({ record: "doc-1", worker: "job-1", composed, why: "re-filing: a class may fit now", message }, { adbCommand: async (sql, _l, params) => (seen.push([sql, params]), [{ count: 1 }]) });
  assert.match(seen[0][0], /^INSERT INTO BriefLog SET id = :id, record = :record, audience = :audience, worker = :worker, brief = :brief, dropped = :dropped, at = :at$/);
  assert.deepEqual([row.record, row.audience, row.worker], ["doc-1", "floor", "job-1"]);
  const logged = JSON.parse(row.brief);
  assert.deepEqual(Object.keys(logged).sort(), ["audience", "classes", "dependencies", "instances", "message", "record", "refile", "sections", "sources", "why"]);
  assert.equal(logged.message, message, "the message exactly as the worker gets it");
  assert.match(row.brief, /re-filing: a class may fit now/, "the why it carries is logged too");
  assert.equal(logged.sections[0].rid, "#71:3");
  assert.doesNotMatch(row.brief, /ZEBRA/, "the log holds what the worker got, nothing above it");
  assert.deepEqual(JSON.parse(row.dropped), composed.dropped);
  await assert.rejects(logBrief({ record: "doc-1", worker: "job-1", composed }, { adbCommand: async () => { throw new Error("no such type BriefLog"); } }), /couldn't be logged, so it isn't sent/);
});

test("F-B1, the connection's home: a worker's reads go through the read adapter with its audience, and a connection above it refuses them (R11.6, R11.9)", async () => {
  const h = setup();
  h.db.readHome = "ops";
  await assert.rejects(fileToSource(piece(), identity, h.env), /above this audience/);
  assert.equal(h.dab.calls.filter((c) => c.name === "read_records" && c.args?.entity === "dbo_Job").length, 0, "nothing was read");
  assert.equal(h.store.entries_.length, 0);
  // the orchestrator, the most privileged agent, reads with no audience: the same row is there for its check
  const { readSourceRow: read } = await import("../src/filing.js");
  assert.equal((await read("mssql:dbo_Job:4471", { db: h.db, fetch: h.dab.fetch, positions: map })).status, "ok");
});

test("the journal's store names no column ArcadeDB reads as a keyword (before, table and key are stored renamed)", async () => {
  const { arcadeStore } = await import("../src/filing.js");
  const seen = [];
  const store = arcadeStore({ adbCommand: async (sql, _l, params) => (seen.push([sql, params]), [{ count: 1 }]), adbQuery: async () => [{ id: "a1", source_table: "dbo_Job", row_key: "mssql:dbo_Job:1", row_before: '{"Status":null}', fields: "{}", piece: "{}" }] });
  await store.insertAttempt({ id: "a1", system: "mssql", table: "dbo_Job", key: "mssql:dbo_Job:1", action: "update", fields: { Status: "x" }, before: { Status: null }, piece: null, status: "begun", detail: null, at: "t", settled_at: null });
  const [sql, params] = seen[0];
  const columns = sql.replace(/^INSERT INTO FilingAttempt SET /, "").split(", ").map((x) => x.split(" = ")[0]);
  for (const kw of ["before", "table", "key"]) assert.ok(!columns.includes(kw), `${kw} is not a column`);
  assert.equal(params.row_before, '{"Status":null}');
  assert.deepEqual((await store.attempt("a1")).before, { Status: null });
});

test("create_instance goes through the classes stream's relateInstance (C-B7): the row is read first, the audience and the section's home are handed over, and the section relates to it after", async () => {
  const h = setup();
  await assert.rejects(createInstance({ section: "#71:3", name: "Nobody", class: "people", key: "mssql:dbo_Crew:E9" }, identity, h.env), /no such row/);
  assert.equal(h.related.length, 0, "no node without its row (R3)");
  const r = await createInstance({ section: "#71:3", name: "Diep", class: "people", key: "mssql:dbo_Crew:E1" }, identity, h.env);
  assert.deepEqual([r.instance, r.created], ["#80:1", true]);
  const [call] = h.related;
  assert.deepEqual(call.args, { class: "people", key: "mssql:dbo_Crew:E1", name: "Diep" });
  assert.deepEqual([...call.scope.homes].sort(), ["everyone", "floor"], "the worker's audience, never wider");
  assert.deepEqual(call.opts, { home: "floor" }, "a new node is homed at the section's home (R11.8)");
  assert.equal(call.actor.identity, identity, "the write floor is the worker's (R11.13)");
  assert.ok(h.db.statements.some((st) => st.startsWith("CREATE EDGE ABOUT FROM #71:3 TO #80:1")), "the section relates to it");
  // a refusal of the classes stream's reaches the worker, and the section relates to nothing
  h.env.instances.relate = async () => { throw new Error("mssql:dbo_Crew:E2 is held where you can't see it: ask the orchestrator"); };
  const before = h.db.statements.length;
  await assert.rejects(createInstance({ section: "#71:3", name: "Sam", class: "people", key: "mssql:dbo_Crew:E2" }, identity, h.env), /held where you can't see it/);
  assert.equal(h.db.statements.slice(before).filter((st) => st.startsWith("CREATE EDGE ABOUT")).length, 0);
  // filing makes no node itself any more
  assert.ok(!h.db.statements.some((st) => st.startsWith("CREATE VERTEX") || st.startsWith("CREATE EDGE INSTANCE_OF") || st.startsWith("CREATE EDGE DEPENDS_ON")));
});

test("state_dependency goes through the classes stream's addDependency (C-B7): a key's row is read first, stated by the record, both ends related to the section", async () => {
  const { stateDependency } = await import("../src/filing.js");
  const h = setup();
  const r = await stateDependency({ section: "#71:3", from: "mssql:dbo_Job:4471", to: "#80:1", stated_as: "record", note: "waits on the plating" }, identity, h.env);
  assert.deepEqual([r.from, r.to], ["#80:5", "#80:1"]);
  const [call] = h.depended;
  assert.deepEqual([call.args.from, call.args.to, call.args.stated_as, call.args.stated_by, call.args.source], ["mssql:dbo_Job:4471", "#80:1", "record", "doc-1", "#71:3"]);
  assert.deepEqual(call.opts, { home: "floor" });
  for (const rid of ["#80:5", "#80:1"]) assert.ok(h.db.statements.some((st) => st.startsWith(`CREATE EDGE ABOUT FROM #71:3 TO ${rid}`)));
  await assert.rejects(stateDependency({ section: "#71:3", from: "mssql:dbo_Job:9999", to: "#80:1", stated_as: "agent" }, identity, h.env), /no such row/);
  assert.equal(h.depended.length, 1, "no dependency on a row the source doesn't hold");
});

test("R14: a Kept piece is offered for re-filing only when a class was created or a source table declared since it was Kept", async () => {
  const h = setup();
  const k = await keepPiece({ section: "#71:4", piece: "the forklift is booked Thursday", instances: ["#80:1"] }, identity, h.env);
  const seen = [];
  h.env.laterClassOrSource = async (at) => (seen.push(at), false);
  assert.deepEqual(await keptPieces(h.env), [], "nothing new since it was Kept: not offered");
  assert.equal(seen[0], h.store.entries_[0].at, "asked about what came after the entry's own time");
  assert.match(await refileRefusal(h.env, h.store.entries_[0]), /no class was created and no source table declared/);
  h.env.laterClassOrSource = async () => true;
  assert.deepEqual((await keptPieces(h.env)).map((p) => p.entry), [k.entry]);
  assert.equal(await refileRefusal(h.env, h.store.entries_[0]), null);
});

test("R14: after REFILE_LIMIT re-filings a piece is never offered again and refile refuses it, whatever is new", async () => {
  const { refileKept } = await import("../src/orchestrator.js");
  const h = setup();
  h.env.laterClassOrSource = async () => true;
  const started = [];
  h.env.startRecordWorkers = async (record, o) => (started.push({ record, refile: o.refile }), [{ job: "j-" + started.length, home: "floor" }]);
  // a piece Kept, then Kept again by each re-filing: a chain of refiled_from links
  let prev = (await keepPiece({ section: "#71:4", piece: "the forklift is booked Thursday", instances: ["#80:1"] }, identity, h.env)).entry;
  const chain = [prev];
  for (let i = 1; i <= REFILE_LIMIT; i++) {
    const r = await refileKept([prev], "orchestrator", h.env);
    assert.equal(r.started.length, 1, `re-filing ${i} goes ahead`);
    assert.equal(r.refused, undefined);
    prev = (await keepPiece({ section: "#71:4", piece: "the forklift is booked Thursday", instances: ["#80:1"], refiles: prev }, identity, h.env)).entry;
    chain.push(prev);
  }
  assert.equal(h.store.entries_.at(-1).refiled_from, chain.at(-2), "each Kept entry points back at the one it re-filed");
  assert.deepEqual(await keptPieces(h.env), [], `re-filed ${REFILE_LIMIT} times: never offered again`);
  const r = await refileKept([prev], "orchestrator", h.env);
  assert.deepEqual(r.started, []);
  assert.equal(r.refused?.[0]?.entry, prev);
  assert.match(r.refused[0].reason, new RegExp(`re-filed ${REFILE_LIMIT} times already`));
  assert.equal(started.length, REFILE_LIMIT, "no worker started for the refused one");
  // nothing new: refused for that reason, and the others in the same call still go ahead
  const fresh = (await keepPiece({ section: "#71:3", piece: "the crate is in bay 2", instances: ["#80:1"] }, identity, h.env)).entry;
  h.env.laterClassOrSource = async (at) => at === h.store.entries_.find((e) => e.id === fresh).at;
  const other = (await keepPiece({ section: "#71:3", piece: "the pallet is wrapped", instances: ["#80:1"] }, identity, h.env)).entry;
  const mixed = await refileKept([chain[0], other, fresh], "orchestrator", h.env);
  assert.equal(mixed.started.length, 1, "only the fresh one goes ahead");
  assert.deepEqual(mixed.refused.map((x) => x.entry), [chain[0], other]);
  assert.match(mixed.refused[0].reason, /re-filed already/, "an entry re-filed once is never re-filed again");
  assert.match(mixed.refused[1].reason, /no class was created and no source table declared/);
});

test("R14: the limit counts the piece's whole refile tree: sibling re-filings of one entry count as much as a chain", async () => {
  const { refileKept } = await import("../src/orchestrator.js");
  const h = setup();
  h.env.laterClassOrSource = async () => true;
  h.env.startRecordWorkers = async () => [{ job: "j", home: "floor" }];
  const keep = async (refiles) => (await keepPiece({ section: "#71:4", piece: "the forklift is booked Thursday", instances: ["#80:1"], ...(refiles ? { refiles } : {}) }, identity, h.env)).entry;
  const k0 = await keep();
  // two re-filings went from the same entry (as two workers may), and one more from one of them
  const a = await keep(k0);
  const b = await keep(k0);
  assert.equal((await refileKept([k0], "orchestrator", h.env)).refused?.[0]?.reason.match(/re-filed already/)?.[0], "re-filed already", "the entry they went from is refused");
  assert.deepEqual((await keptPieces(h.env)).map((p) => p.entry).sort(), [a, b].sort(), "two re-filings so far: the leaves are still offered");
  const c = await keep(a);
  assert.deepEqual(await keptPieces(h.env), [], "three re-filings over the tree: nothing of this piece is offered");
  const r = await refileKept([b, c], "orchestrator", h.env);
  assert.deepEqual(r.started, []);
  assert.deepEqual(r.refused.map((x) => x.entry), [b, c]);
  for (const x of r.refused) assert.match(x.reason, new RegExp(`re-filed 3 times already`));
  // a piece of its own, from the same record, keeps its own count
  const other = await keep();
  assert.equal(await refileRefusal(h.env, h.store.entries_.find((e) => e.id === other)), null);
});

test("R14: what counts as new: a class created or given its table after the entry, or the stored sources changed after it", async () => {
  const at = "2026-11-10T12:00:00.000Z";
  const db = (classes, sourcesAt) => ({
    async adbQuery(sql, params) {
      if (sql.includes("_kind = 'class'")) return [{ n: classes.filter((c) => (c.created ?? "") > params.at || (c.table ?? "") > params.at).length }];
      if (sql.includes("OrgPolicy")) return sourcesAt ? [{ updated_at: sourcesAt }] : [];
      return [];
    },
  });
  assert.equal(await laterClassOrSource(at, db([{ created: "2026-11-10T11:00:00.000Z" }])), false, "an older class");
  assert.equal(await laterClassOrSource(at, db([{}])), false, "a class with no creation time counts as older");
  assert.equal(await laterClassOrSource(at, db([{ created: "2026-11-10T12:00:01.000Z" }])), true, "a class created since");
  assert.equal(await laterClassOrSource(at, db([{ created: "2026-11-10T11:00:00.000Z", table: "2026-11-10T13:00:00.000Z" }])), true, "a table declared since");
  assert.equal(await laterClassOrSource(at, db([], "2026-11-10T12:30:00.000Z")), true, "the stored sources changed since");
  assert.equal(await laterClassOrSource(at, db([], "2026-11-10T11:30:00.000Z")), false);
});

/** ---- R15: a worker that ends without filing ---- */

const ended = { record: "doc-1", home: "floor", rid: "#71:3", sections: ["#71:3", "#71:4"] };

test("R15: a worker that ends with a section unfiled: graph-rag itself sends that section back, once, with its text and the worker's last reply", async () => {
  const h = setup();
  await keepPiece({ section: "#71:4", piece: "the forklift is booked Thursday", instances: ["#80:1"] }, identity, h.env);
  const raised = await kickBack(identity.role.job, ended, "I read the maintenance table and found nothing to file.", h.env);
  assert.deepEqual(raised.map((r) => r.section), ["#71:3"], "only the section with no entry");
  const [r] = h.store.requests_;
  assert.deepEqual([r.kind, r.raised_by, r.worker, r.home, r.status], ["other", "graph-rag", identity.role.job, "floor", "open"]);
  assert.match(r.question, /the text of #71:3/);
  assert.match(r.question, /found nothing to file/);
  const sig = h.signals.find((x) => x.kind === "request");
  assert.deepEqual([sig.data.request, sig.data.raised_by, sig.data.section], [r.id, "graph-rag", "#71:3"]);
  assert.deepEqual(await kickBack(identity.role.job, ended, "again", h.env), [], "an open kick-back for the section isn't raised twice");
  assert.deepEqual(await kickBack(identity.role.job, { sections: ["#71:3"] }, "", h.env), [], "a job with no record isn't a filing worker");
});

test("R15: left open past the orchestrator's turn, the section is Kept as it stands: its whole text, its home, the instances related to it, no source written", async () => {
  const h = setup();
  h.db.about = { "#71:3": [{ dst: "#80:1" }] };
  const [r] = await kickBack(identity.role.job, ended, "", h.env);
  const worker = await answerRequest(r.id, { decision: "keep" }, "orchestrator", h.env).catch((e) => e);
  assert.ok(!(worker instanceof Error));
  const h2 = setup();
  h2.db.about = { "#71:3": [{ dst: "#80:1" }] };
  const [open] = await kickBack(identity.role.job, ended, "", h2.env);
  await openRequestFor(h2);
  const floored = await floorUnsettled([open.id, h2.store.requests_.at(-1).id], h2.env);
  assert.equal(floored.length, 1, "only graph-rag's open request is floored, not a worker's own");
  const e = h2.store.entries_.find((x) => x.id === floored[0].entry);
  assert.deepEqual([e.outcome, e.section, e.home, e.piece, e.target, e.reason, e.recorder, e.worker], ["kept", "#71:3", "floor", "the text of #71:3", null, "worker ended without filing", "bob", identity.role.job]);
  assert.deepEqual(e.instances, ["#80:1"]);
  assert.equal(h2.store.requests_.find((x) => x.id === open.id).status, "answered");
  assert.deepEqual(await floorUnsettled([open.id], h2.env), [], "settled once");
  assert.equal(h2.dab.calls.filter((c) => c.name === "update_record").length, 0, "no source written");
  h2.env.laterClassOrSource = async () => true;
  assert.ok((await keptPieces(h2.env)).some((p) => p.entry === e.id), "re-fileable under R14");
  // with no instance related, the floor's piece is still Kept
  const h3 = setup();
  const [bare] = await kickBack(identity.role.job, ended, "", h3.env);
  const [f] = await floorUnsettled([bare.id], h3.env);
  assert.deepEqual(h3.store.entries_.find((x) => x.id === f.entry).instances, []);
});
async function openRequestFor(h) {
  await h.store.insertRequest({ id: "worker-own-1", kind: "other", record: "doc-1", section: "#71:4", home: "floor", worker: identity.role.job, question: "q", suggestion: null, status: "open", answer: null, answered_by: null, raised_by: null, at: "2026-11-10T00:00:00.000Z" });
}

test("R15: the orchestrator settles a kick-back: keep files it Kept now, hold asks the recorder, nothing resumes the ended worker, and other answers are refused", async () => {
  const h = setup();
  const [a] = await kickBack(identity.role.job, ended, "", h.env);
  const k = await answerRequest(a.id, { decision: "keep" }, "orchestrator", h.env);
  const e = h.store.entries_.find((x) => x.id === k.entry);
  assert.equal(e.outcome, "kept");
  assert.match(e.reason, /^worker ended without filing; kept by the orchestrator/);
  assert.equal(h.resumed.length, 0, "the ended worker isn't woken");
  const h2 = setup();
  const [b] = await kickBack(identity.role.job, ended, "", h2.env);
  await assert.rejects(answerRequest(b.id, { decision: "use_class", class: "jobs" }, "orchestrator", h2.env), /start a fresh worker/);
  const held = await answerRequest(b.id, { decision: "hold" }, "orchestrator", h2.env);
  assert.equal(held.asked_of, "bob", "the person who put it on record");
  assert.ok(h2.db.statements.some((x) => x.startsWith("INSERT INTO WorkerQuestion")));
  assert.equal(h2.store.entries_.length, 0, "no entry until the person answers");
  assert.equal(h2.resumed.length, 0);
});

test("R15: one fresh worker per kick-back, only for a section whose jobs have all ended", async () => {
  const { startKickbackWorker } = await import("../src/orchestrator.js");
  const h = setup();
  const jobs = [{ id: "j-old", status: "running", payload: JSON.stringify({ sections: ["#71:3", "#71:4"] }) }];
  const db = { adbQuery: async (sql) => (sql.includes("FROM Job") ? jobs : []) };
  const queued = [];
  const enqueue = async (kind, payload, opts) => (queued.push({ kind, payload, opts }), "j-new");
  const pool = { threadMinutes: 20 };
  await assert.rejects(startKickbackWorker("doc-1", "#71:3", { by: "o" }, { env: h.env, db, enqueue, pool }), /no open kick-back/);
  const [r] = await kickBack(identity.role.job, ended, "", h.env);
  await assert.rejects(startKickbackWorker("doc-1", "#71:3", { by: "o" }, { env: h.env, db, enqueue, pool }), /still has a worker/);
  jobs[0].status = "failed";
  const started = await startKickbackWorker("doc-1", "#71:3", { by: "o" }, { env: h.env, db, enqueue, pool });
  assert.deepEqual(started, [{ home: "floor", job: "j-new", kickback: r.id }]);
  assert.deepEqual([queued[0].payload.sections, queued[0].payload.rid, queued[0].payload.record, queued[0].payload.kickback, queued[0].opts.key], [["#71:3"], "#71:3", "doc-1", r.id, `kickback:doc-1:floor:${r.id}`]);
  assert.equal(JSON.parse(h.store.requests_[0].answer).decision, "fresh_worker");
  await assert.rejects(startKickbackWorker("doc-1", "#71:3", { by: "o" }, { env: h.env, db, enqueue, pool }), /no open kick-back/, "one per kick-back");
});

test("handles: a request by r1, 2 or its id; its question as the id is refused with the open ones; with one open, any value means it", async () => {
  const { resolveRequestRef } = await import("../src/filing.js");
  const h = setup();
  const req = (id, at, question, status = "open") => h.store.insertRequest({ id, kind: "other", record: "doc-1", section: "#71:3", home: "floor", worker: identity.role.job, question, suggestion: null, status, answer: status === "open" ? null : "{}", answered_by: status === "open" ? null : "o", raised_by: null, at });
  const a = "aaaaaaaa-1111-4111-8111-111111111111";
  const b = "bbbbbbbb-2222-4222-8222-222222222222";
  await req(b, "2026-11-10T00:00:02.000Z", "File piece under acquisition_talk or keep?");
  await req(a, "2026-11-10T00:00:01.000Z", "Is the Toro job 4471 or 4472?");
  assert.equal(await resolveRequestRef("r1", h.env), a, "handles follow the order requests were raised");
  assert.equal(await resolveRequestRef("2", h.env), b);
  assert.equal(await resolveRequestRef(b, h.env), b);
  assert.equal(await resolveRequestRef("File piece under acquisition_talk or keep?", h.env), null, "two open: a question is no id");
  await assert.rejects(answerRequest("File piece under acquisition_talk or keep?", { decision: "keep" }, "o", h.env), (e) => /never its question/.test(e.message) && e.message.includes("r1 (other") && e.message.includes("r2 (other"));
  assert.equal(await resolveRequestRef("r3", h.env), null, "a handle past the list");
  const done = await answerRequest("r1", { decision: "keep" }, "o", h.env);
  assert.equal(done.answered, a);
  assert.equal(await resolveRequestRef("whatever the model wrote", h.env), b, "one open: any value means it");
  assert.equal(await resolveRequestRef("cccccccc-3333-4333-8333-333333333333", h.env), null, "an id that matches none never does");
});

test("handles: a fresh worker for a kick-back by its request handle, or with one open for the record any section value; a record id that matches none is refused", async () => {
  const { startKickbackWorker } = await import("../src/orchestrator.js");
  const h = setup();
  const db = { adbQuery: async () => [] };
  const queued = [];
  const enqueue = async (kind, payload) => (queued.push(payload), `j-${queued.length}`);
  const pool = { threadMinutes: 20 };
  const one = { ...ended, rid: "#71:3", sections: ["#71:3"] };
  const [r] = await kickBack(identity.role.job, one, "", h.env);
  await assert.rejects(startKickbackWorker("doc-1", "#71:9", { by: "o" }, { env: h.env, db, enqueue, pool }), /no open kick-back for section #71:9[\s\S]*Open kick-backs: r1 \(other, raised by graph-rag/);
  const s = await startKickbackWorker("doc-1", "sec", { by: "o" }, { env: h.env, db, enqueue, pool });
  assert.equal(s[0].kickback, r.id, "one open for the record: 'sec' means it");
  const h2 = setup();
  const [r2] = await kickBack(identity.role.job, one, "", h2.env);
  const s2 = await startKickbackWorker(null, undefined, { by: "o", request: "r1" }, { env: h2.env, db, enqueue, pool });
  assert.equal(s2[0].kickback, r2.id, "by its request handle, record not needed");
  assert.equal(queued.at(-1).sections[0], "#71:3");
});

/** ---- R11.13 on source writes (I-39) ---- */

test("R11.13 on source writes: readers of the source must all see the section; a source read wider than the section misses it", async () => {
  const { readersMissSection } = await import("../src/filing.js");
  const { EVERYONE } = await import("../src/positions.js");
  const m = parsePositionMap({ root: "org", positions: { org: { name: "Top" }, ops: { name: "Operations", parent: "org" }, floor: { name: "Floor", parent: "ops" } } });
  assert.equal(readersMissSection(m, "ops", EVERYONE), true, "A-4: an ops section into a table everyone reads");
  assert.equal(readersMissSection(m, "ops", "floor"), true, "floor readers can't see ops");
  assert.equal(readersMissSection(m, "floor", "floor"), false);
  assert.equal(readersMissSection(m, "floor", "ops"), false, "ops readers see the floor");
  assert.equal(readersMissSection(m, "ops", "org"), false);
  assert.equal(readersMissSection(m, EVERYONE, EVERYONE), false);
  assert.equal(readersMissSection(m, "ops", undefined), false, "no declared home: nothing to compare");
});

test("R17 narrows I-39: a section at its recorder's own level updates a source read wider, by authority; one the check raised above them is Proposed", async () => {
  const { EVERYONE } = await import("../src/positions.js");
  const { raisedAboveRecorder } = await import("../src/filing.js");
  // bob's floor section, a source read at everyone: his authority over jobs decides (R17)
  const h = setup();
  h.env.connectionHome = async () => EVERYONE;
  const r = await fileToSource(piece(), identity, h.env);
  assert.equal(r.outcome, "filed");
  assert.equal(h.dab.rows[0].Status, "complete");
  // the check raised bob's section to Operations: an agent doesn't write it to a source read at everyone
  const h2 = setup({ payload: { record: "doc-1", home: "ops", sections: ["#71:3"], rid: "#71:3" } });
  h2.env.connectionHome = async () => EVERYONE;
  h2.env.classesForTable = async () => [];
  const r2 = await fileToSource(piece({ class: "jobs" }), identity, h2.env).catch((e) => ({ threw: e.message }));
  assert.equal(r2.outcome, "proposed", JSON.stringify(r2));
  assert.match(r2.note, /raised to Operations, above where its recorder stands[\s\S]*R17, I-39 as narrowed/);
  assert.equal(h2.dab.calls.filter((c) => c.name === "update_record").length, 0, "nothing lands in the row");
  assert.equal(h2.queued[0].home, "ops", "the pending write waits where the section is seen");
  assert.equal(raisedAboveRecorder(map, "ops", "floor"), true);
  assert.equal(raisedAboveRecorder(map, "floor", "floor"), false);
  assert.equal(raisedAboveRecorder(map, "floor", "ops"), false, "a section below its recorder isn't raised");
  assert.equal(raisedAboveRecorder(map, "ops", null), true, "a recorder of no known position: the section's home alone decides, as before");
});

// ---- I-40, I-41, I-42: the two largest sources of tool errors in C-1, and names where an id is wanted ----

test("I-40: find_rows finds rows by words the source's filter can't take, refuses an unknown table or column with the real ones, and reads only what the worker's audience may", async () => {
  const { findText } = await import("../src/filing.js");
  const { searchRows } = await import("../src/data-entry.js");
  const h = setup();
  h.env.searchRows = (args, o = {}) => searchRows(args, { db: h.db, fetch: h.dab.fetch, positions: map, ...o });
  h.env.systems = async () => ["mssql"];
  const diep = await findText({ table: "mssql:dbo_Crew", text: "diep" }, identity, h.env);
  assert.deepEqual([diep.status, diep.rows.map((r) => r.key)], ["found", ["mssql:dbo_Crew:E1"]]);
  assert.equal(diep.filing, undefined, "a read decides no outcome");
  const filters = h.dab.calls.map((c) => String(c.args?.filter ?? ""));
  assert.ok(filters.every((f) => !/contains|startswith|endswith/.test(f)), "no string function reaches the source");
  // a number column takes a number given as text; anything else is explained
  const job = await findText({ table: "mssql:dbo_Job", where: { Job: "4471" } }, identity, h.env);
  assert.deepEqual([job.status, job.rows[0].key], ["found", "mssql:dbo_Job:4471"]);
  await assert.rejects(findText({ table: "mssql:dbo_Job", where: { Job: "job 4471" } }, identity, h.env), /Job is a number column: compare it with a number/);
  await assert.rejects(findText({ table: "mssql:dbo_Crew", text: "x", columns: ["First_Name"] }, identity, h.env), /has no column First_Name: it has Emp, Name/);
  await assert.rejects(findText({ table: "erp:dbo_Job", text: "x" }, identity, h.env), /no connected source called erp: the sources are mssql/);
  // the audience rules: a table above the worker's audience is refused before anything is read
  const before = h.dab.calls.length;
  await assert.rejects(findText({ table: "mssql:dbo_Pay", text: "Bob" }, identity, h.env), /above your audience/);
  assert.equal(h.dab.calls.length, before, "the source was never asked");
  // a table the source doesn't have, once the connection vouches for the system: refused with the real ones
  h.env.connectionHome = () => "floor";
  await assert.rejects(findText({ table: "mssql:dbo_Nope", text: "x" }, identity, h.env), /mssql has no table dbo_Nope: it has dbo_Job, dbo_Crew/);
  h.env.connectionHome = () => "ops";
  await assert.rejects(findText({ table: "mssql:dbo_Crew", text: "diep" }, identity, h.env), /connection above your audience/);
});

test("I-42: a name where an instance id is wanted is taken when exactly one instance the worker sees has it; otherwise refused as before", async () => {
  const h = setup();
  h.db.things = [{ rid: "#80:1", norm: "forklift 2", _homes: ["floor"] }];
  const k = await keepPiece({ section: "#71:4", piece: "the forklift is booked Thursday", instances: ["Forklift 2"] }, identity, h.env);
  assert.deepEqual([k.outcome, h.store.entries_[0].instances], ["kept", ["#80:1"]]);
  // an id without its #
  await keepPiece({ section: "#71:4", piece: "the forklift is booked Friday", instances: ["80:1"] }, identity, h.env);
  assert.deepEqual(h.store.entries_[1].instances, ["#80:1"]);
  // two by that name, or one the worker can't see: refused, nothing written
  h.db.things = [{ rid: "#80:1", norm: "forklift 2", _homes: ["floor"] }, { rid: "#80:2", norm: "forklift 2", _homes: ["floor"] }];
  await assert.rejects(keepPiece({ section: "#71:4", piece: "the forklift again", instances: ["Forklift 2"] }, identity, h.env), /no one instance you can see is called that/);
  h.db.things = [{ rid: "#80:9", norm: "the payroll", _homes: ["org"] }];
  await assert.rejects(keepPiece({ section: "#71:4", piece: "the payroll again", instances: ["the payroll"] }, identity, h.env), /no one instance you can see is called that/);
  assert.equal(h.store.entries_.length, 2);
});

test("I-41: refiles is offered only to a worker with something to re-file, and a wrong one is refused with the ones it may", async () => {
  const { refileOffered } = await import("../src/filing.js");
  const h = setup();
  assert.equal(await refileOffered(identity, h.env), false, "a first-time filing: no argument to fill");
  assert.equal(await refileOffered({ user: "admin", role: { kind: "master" } }, h.env), false);
  const held = await holdPiece({ section: "#71:3", piece: "the Toro job", question: "Which Toro job did you mean?", class: "jobs" }, identity, h.env);
  assert.equal(await refileOffered(identity, h.env), true, "resumed with the recorder's answer to a Held piece");
  await assert.rejects(keepPiece({ section: "#71:3", piece: "the Toro job", instances: ["#80:1"], refiles: "hold-1" }, identity, h.env), new RegExp(`The ones you may re-file: ${held.entry}`));
  const k = await keepPiece({ section: "#71:3", piece: "the Toro job", instances: ["#80:1"], refiles: held.entry }, identity, h.env);
  assert.equal(h.store.entries_.find((e) => e.id === k.entry).refiled_from, held.entry);
  // a re-filing job is offered it from the start
  const r = setup({ payload: { record: "doc-1", home: "floor", sections: ["#71:3"], rid: "#71:3", refile: ["kept-1"] } });
  assert.equal(await refileOffered(identity, r.env), true);
});

test("I-41: the refiles argument is in the filing tools' schemas only when the identity is offered it", async () => {
  const { registerWorkerTools } = await import("../src/worker-tools.js");
  const schemas = (id) => {
    const tools = new Map();
    registerWorkerTools({ tool: (name, _d, schema) => tools.set(name, schema) }, { identity: id, need: () => {} });
    return tools;
  };
  const first = schemas(identity);
  for (const t of ["file_to_source", "hold_piece", "keep_piece"]) assert.ok(!("refiles" in first.get(t)), `${t}: no refiles on a first-time filing`);
  assert.ok(first.has("find_rows"));
  const again = schemas({ ...identity, refiling: true });
  for (const t of ["file_to_source", "hold_piece", "keep_piece"]) assert.ok("refiles" in again.get(t), `${t}: refiles when re-filing`);
});

test("R16: a Filed write can be undone by a person with authority for its class: the old value back, the entry marked; never by an agent, never over a row that moved", async () => {
  const { undoFiled } = await import("../src/filing.js");
  const h = setup({ rows: [{ Job: 4471, Status: "open", Quantity: 500 }, { Job: 4472, Status: "planned", Quantity: 20 }] });
  const f = await fileToSource(piece(), identity, h.env);
  assert.equal(h.dab.rows[0].Status, "complete");
  await assert.rejects(undoFiled(f.entry, "bob/agent:w9", h.env), /never an agent/);
  await assert.rejects(undoFiled(f.entry, "alice", h.env), /doesn't hold the authority/);
  const u = await undoFiled(f.entry, "bob", h.env);
  assert.deepEqual([u.restored, h.dab.rows[0].Status], [{ Status: "open" }, "open"]);
  assert.equal(h.store.entries_.find((e) => e.id === f.entry).undone.by, "bob", "the entry stays, marked undone");
  assert.ok(h.dab.calls.filter((c) => c.name === "update_record").length === 2, "the undo went through the write adapter");
  await assert.rejects(undoFiled(f.entry, "bob", h.env), /undone already/);
  // the row changed after the write: the undo doesn't write over it
  const g = await fileToSource(piece(), identity, h.env);
  h.dab.rows[0].Status = "shipped";
  await assert.rejects(undoFiled(g.entry, "bob", h.env), /changed since entry .* wrote it: nothing is undone/);
  assert.equal(h.dab.rows[0].Status, "shipped");
  // a piece that wrote nothing, or wasn't Filed, has nothing to undo
  const k = await keepPiece({ section: "#71:4", piece: "the forklift is booked", instances: ["#80:1"] }, identity, h.env);
  await assert.rejects(undoFiled(k.entry, "bob", h.env), /not a Filed write/);
});

test("R18: a fixed-choice column takes the model's reading when the declaration allows it; one it doesn't allow is told once, then held", async () => {
  const h = setup();
  h.db.jobColumns = { Status: { values: ["Open", "Complete", "Closed"] } };
  h.env.texts = { "#71:3": "Job 4471 shipped Thursday." };
  const r = await fileToSource(piece({ fields: { Status: "COMPLETE" } }), identity, h.env);
  assert.equal(r.outcome, "filed");
  assert.equal(h.dab.rows[0].Status, "Complete", "written in its declared spelling, though the record never says complete");
  const h2 = setup();
  h2.db.jobColumns = { Status: { values: ["Open", "Complete", "Closed"] } };
  const told = await fileToSource(piece({ fields: { Status: "Shipped" } }), identity, h2.env);
  assert.equal(told.outcome, "not_filed");
  assert.match(told.fields[0].why, /takes one of Open, Complete, Closed/);
});

test("I-50, per field: Status lands and an 800 the record doesn't give is held on its own; told once, never twice", async () => {
  const h = setup();
  h.env.texts = { "#71:3": "Job 4471 is complete." };
  const p = piece({ fields: { Status: "complete", Quantity: 800 } });
  const first = await fileToSource(p, identity, h.env);
  assert.deepEqual([first.outcome, first.fields.map((x) => x.column)], ["not_filed", ["Quantity"]]);
  assert.match(first.note, /Send file_to_source again for this piece, once/);
  assert.equal(h.dab.rows[0].Status, null, "nothing written while the worker is told");
  const second = await fileToSource(p, identity, h.env);
  assert.equal(second.outcome, "filed");
  assert.deepEqual([h.dab.rows[0].Status, h.dab.rows[0].Quantity], ["complete", 500], "Status written, the 800 not");
  const [filed, held] = [h.store.entries_.find((e) => e.outcome === "filed"), h.store.entries_.find((e) => e.outcome === "held")];
  assert.deepEqual(filed.target.fields, { Status: "complete" });
  assert.deepEqual([held.target.fields, second.held.fields], [{ Quantity: 800 }, ["Quantity"]]);
  assert.match(held.question, /Quantity wasn't written to mssql:dbo_Job:4471\. Not every value is in your words: Quantity would be 800/);
  assert.equal(h.db.questions.length, 1, "the recorder is asked about the 800 alone");
  // the worker left it out the second time: it is held all the same, never dropped silently
  const h2 = setup();
  h2.env.texts = { "#71:3": "Job 4471 is complete." };
  await fileToSource(p, identity, h2.env);
  const dropped = await fileToSource(piece({ fields: { Status: "complete" } }), identity, h2.env);
  assert.deepEqual([dropped.outcome, dropped.held?.fields], ["filed", ["Quantity"]]);
  assert.match(h2.store.entries_.find((e) => e.outcome === "held").question, /was left out after the record's words didn't give it/);
  // a reworded value sent again in the record's own words lands whole, with nothing held
  const h3 = setup();
  h3.env.texts = { "#71:3": "Job 4471 is complete." };
  await fileToSource(piece({ fields: { Status: "done" } }), identity, h3.env);
  const fixed = await fileToSource(piece({ fields: { Status: "complete" } }), identity, h3.env);
  assert.deepEqual([fixed.outcome, fixed.held, h3.store.entries_.length], ["filed", undefined, 1]);
});

test("I-50: a correction offered and never taken is held when the worker gives its account", async () => {
  const h = setup();
  h.env.texts = { "#71:3": "Job 4471 is complete." };
  await fileToSource(piece({ fields: { Status: "done" } }), identity, h.env);
  const r = await giveAccount({ pieces: [] }, identity, h.env);
  const [e] = h.store.entries_;
  assert.deepEqual([e.outcome, e.target.key, r.missing, Boolean(e.account)], ["held", "mssql:dbo_Job:4471", [], true], "held with the worker's own account");
  assert.match(e.question, /isn't in the record's words, and it wasn't sent again/);
  assert.deepEqual(h.db.payload.corrections, {});
});

const add = (over = {}) => ({ section: "#71:3", piece: "CNC 1 coolant topped up", said: "adding a maintenance row for CNC 1", class: "maintenance", key: "mssql:dbo_Maintenance:new", fields: { Work_Center: "CNC 1", Opened: "2026-11-09", Description: "Coolant concentration on CNC 1 read 4 percent", Status: "Closed" }, ...over });
const coolant = "Coolant concentration on CNC 1 read 4 percent, below the 6 to 8 percent target. Topped up and rechecked at 7.";

test("R19: a row is added when the table takes new rows; the key is the source's; one piece adds one row however often it is filed", async () => {
  const h = setup();
  h.env.texts = { "#71:3": coolant };
  const r = await fileToSource(add({ fields: { ...add().fields, Maintenance: 7 } }), identity, h.env);
  assert.deepEqual([r.outcome, r.key], ["filed", "mssql:dbo_Maintenance:3"], "the key the worker gave is dropped; the source made 3");
  const rows = () => h.dab.tables.dbo_Maintenance.rows;
  assert.deepEqual(rows()[2], { Maintenance: 3, Work_Center: "CNC 1", Opened: "2026-11-09", Description: "Coolant concentration on CNC 1 read 4 percent", Status: "Closed" });
  const e = h.store.entries_[0];
  assert.deepEqual([e.outcome, e.target.key, e.target.added, e.reason], ["filed", "mssql:dbo_Maintenance:3", true, "added: mssql:dbo_Maintenance:3"]);
  // filed again, retried with another made-up key, and re-filed with reworded values: still one row
  for (const again of [add(), add({ key: "mssql:dbo_Maintenance" }), add({ key: "mssql:dbo_Maintenance:99", fields: { ...add().fields, Description: "Topped up and rechecked at 7" } })]) {
    const x = await fileToSource(again, identity, h.env);
    assert.deepEqual([x.outcome, x.key], ["filed", "mssql:dbo_Maintenance:3"], JSON.stringify(again.key));
  }
  // the row it added is a row now: naming it is an update, and it already holds the values
  assert.equal((await fileToSource(add({ key: "mssql:dbo_Maintenance:3" }), identity, h.env)).outcome, "filed");
  assert.equal(rows().length, 3, "one row added, however often the piece is filed");
  assert.equal(h.dab.calls.filter((c) => c.name === "create_record").length, 1);
  assert.equal(h.store.attempts_.filter((a) => a.action === "create").length, 1);
  // a different section of the same record adds its own row
  h.env.texts["#71:4"] = coolant;
  const other = await fileToSource(add({ section: "#71:4", piece: "the beeper", fields: { Work_Center: "CNC 1", Opened: "2026-11-09", Description: "Topped up and rechecked at 7", Status: "Open" } }), identity, h.env);
  assert.deepEqual([other.outcome, other.key, rows().length], ["filed", "mssql:dbo_Maintenance:4", 4]);
});

test("R19: concurrent and retried adds of one piece make one row; an add whose end isn't known holds the next attempt", async () => {
  const h = setup();
  h.env.texts = { "#71:3": coolant };
  const all = await Promise.all([1, 2, 3].map(() => fileToSource(add(), identity, h.env)));
  assert.deepEqual(all.map((x) => x.key), ["mssql:dbo_Maintenance:3", "mssql:dbo_Maintenance:3", "mssql:dbo_Maintenance:3"]);
  assert.equal(h.dab.tables.dbo_Maintenance.rows.length, 3);
  const u = setup();
  u.env.texts = { "#71:3": coolant };
  u.store.attempts_.push({ id: "a-1", system: "mssql", table: "dbo_Maintenance", action: "create", status: "unknown", piece: { record: "doc-1", section: "#71:3" } });
  const r = await fileToSource(add(), identity, u.env);
  assert.equal(r.outcome, "held");
  assert.match(u.store.entries_[0].question, /may have landed/);
  assert.equal(u.dab.tables.dbo_Maintenance.rows.length, 2, "no second row risked");
});

test("R19: an add's conditions: told once of a missing or reworded value, then held; a row already holding it is Filed with nothing added; no authority is Proposed once", async () => {
  let h = setup();
  h.env.texts = { "#71:3": coolant };
  const short = add({ fields: { Work_Center: "CNC 1", Status: "Closed" } });
  const told = await fileToSource(short, identity, h.env);
  assert.deepEqual([told.outcome, told.missing], ["not_filed", ["Opened", "Description"]]);
  const held = await fileToSource(short, identity, h.env);
  assert.equal(held.outcome, "held");
  assert.match(h.store.entries_[0].question, /wasn't added to mssql:dbo_Maintenance\. A new row to mssql:dbo_Maintenance needs Opened, Description/);
  assert.equal(h.dab.tables.dbo_Maintenance.rows.length, 2);
  // a row already holds these values: the piece is in the source
  h = setup();
  h.env.texts = { "#71:3": "CNC 2: warm-up runs long, opened 10/27." };
  const there = await fileToSource(add({ fields: { Work_Center: "CNC 2", Opened: "2026-10-27", Description: "Warm-up runs long", Status: "Open" } }), identity, h.env);
  assert.deepEqual([there.outcome, there.key, h.dab.tables.dbo_Maintenance.rows.length], ["filed", "mssql:dbo_Maintenance:1", 2]);
  // the recorder lacks the authority (alice's class map says ops for orders; here the floor recorder files under a class above it)
  h = setup();
  h.env.texts = { "#71:3": coolant };
  h.db.recorder = "carol";
  const p1 = await fileToSource(add(), identity, h.env);
  const p2 = await fileToSource(add(), identity, h.env);
  if (p1.outcome === "proposed") {
    assert.equal(p2.outcome, "proposed");
    assert.equal(h.queued.length, 1, "proposed once, however often filed");
  }
});

test("R19: undo removes an added row while it holds what was added; a row changed since is never removed", async () => {
  const h = setup();
  h.env.texts = { "#71:3": coolant };
  const r = await fileToSource(add(), identity, h.env);
  const u = await undoFiled(r.entry, "bob", h.env);
  assert.deepEqual([u.removed, h.dab.tables.dbo_Maintenance.rows.length], [true, 2]);
  assert.ok(h.dab.calls.some((c) => c.name === "delete_record" && c.url === "http://fake/write"));
  assert.ok(h.store.entries_[0].undone.removed);
  const del = h.store.attempts_.find((a) => a.action === "delete");
  assert.deepEqual([del.status, del.key], ["written", "mssql:dbo_Maintenance:3"]);
  // added again after the undo (the undone add doesn't count), then changed behind graph-rag's back: not removed
  const again = await fileToSource(add(), identity, h.env);
  assert.equal(again.key, "mssql:dbo_Maintenance:4");
  h.dab.tables.dbo_Maintenance.rows.at(-1).Status = "Open";
  await assert.rejects(undoFiled(again.entry, "bob", h.env), /changed since entry .* added it: it isn't removed/);
  assert.equal(h.dab.tables.dbo_Maintenance.rows.length, 3);
  await assert.rejects(undoFiled(again.entry, "admin/agent:w1", h.env), /never an agent/);
});

test("I-50 keeps R16's order: without the authority a piece is Proposed whole, and no correction is offered", async () => {
  const h = setup();
  h.env.texts = { "#71:3": "Job 4471 ships Friday." };
  const r = await fileToSource(piece({ class: "deliveries", fields: { Status: "shipping" } }), identity, h.env);
  assert.deepEqual([r.outcome, h.queued.length, h.db.payload.corrections ?? {}], ["proposed", 1, {}]);
  const a = setup();
  a.env.texts = { "#71:3": "Three saw blades ordered." };
  a.db.recorder = "bob";
  const p = await fileToSource(add({ class: "maintenance", fields: { Opened: "2026-11-09", Description: "blades for the Hyd-Mech", Status: "Open" } }), identity, a.env);
  assert.equal(p.outcome, "not_filed", "with the authority (the floor's maintenance), the add's reworded value is told once");
});

test("I-57: a needed date the worker left out: the answer names the record's own day, which counts", async () => {
  const h = setup();
  h.env.texts = { "#71:3": coolant };
  const told = await fileToSource(add({ fields: { Work_Center: "CNC 1", Description: "Coolant concentration on CNC 1 read 4 percent", Status: "Closed" } }), identity, h.env);
  assert.deepEqual([told.outcome, told.missing, told.record_day], ["not_filed", ["Opened"], "2026-11-09"]);
  assert.match(told.note, /put on record 2026-11-09, and that day counts as a date \(Opened may take it/);
  const r = await fileToSource(add(), identity, h.env);
  assert.deepEqual([r.outcome, r.key], ["filed", "mssql:dbo_Maintenance:3"], "given the record's day, the row is added");
  // no date involved: no hint
  const h2 = setup();
  h2.env.texts = { "#71:3": "Job 4471 is complete." };
  assert.equal((await fileToSource(piece({ fields: { Status: "done" } }), identity, h2.env)).record_day, undefined);
});

test("I-58: a reference column in a new row takes a key the record names; free words are told once, then left out and held", async () => {
  const h = setup();
  h.env.texts = { "#71:3": "Near miss at the dock: the Toyota forklift backed up without the beeper working. Beeper tagged out until maintenance replaces it." };
  const fields = { Equipment: "FL-TOYOTA", Opened: "2026-11-09", Description: "Beeper tagged out until maintenance replaces it", Status: "Open" };
  const ok = await fileToSource(add({ fields }), identity, h.env);
  assert.deepEqual([ok.outcome, h.dab.tables.dbo_Maintenance.rows.at(-1).Equipment], ["filed", "FL-TOYOTA"]);
  const b = setup();
  b.env.texts = { "#71:3": "Swapped the Hyd-Mech blade; the old one goes back to Breskund for resharpening." };
  const blade = { Equipment: "the Hyd-Mech blade", Opened: "2026-11-09", Description: "Swapped the Hyd-Mech blade", Status: "Closed" };
  const told = await fileToSource(add({ fields: blade }), identity, b.env);
  assert.deepEqual([told.outcome, told.fields.map((x) => x.column)], ["not_filed", ["Equipment"]]);
  const again = await fileToSource(add({ fields: blade }), identity, b.env);
  assert.deepEqual([again.outcome, again.held?.fields], ["filed", ["Equipment"]], "the row is added without it, and Equipment is held");
  assert.equal(b.dab.tables.dbo_Maintenance.rows.at(-1).Equipment, undefined, "never the note's free words");
});

test("I-59: describe_source and find_rows read a source as the agent's audience: a worker its record's, a discovery part its part's, the orchestrator none", async () => {
  const h = setup();
  Object.assign(h.env, {
    systems: async () => ["mssql"],
    describeSource: (system, o = {}) => describeSource(system, { db: h.db, fetch: h.dab.fetch, positions: map, ...o }),
    describeTable: (args, o = {}) => describeTable(args, { db: h.db, fetch: h.dab.fetch, positions: map, ...o }),
    searchRows: (args, o = {}) => searchRows(args, { db: h.db, fetch: h.dab.fetch, positions: map, ...o }),
    discoveryPart: async (rid) => (rid === "#90:1" ? { run: "run-1", home: "floor" } : null),
  });
  const all = await describeSourceFor({}, identity, h.env);
  assert.ok(all.sources[0].tables.includes("dbo_Job"), JSON.stringify(all).slice(0, 200));
  const job = await describeSourceFor({ table: "mssql:dbo_Job" }, identity, h.env);
  assert.deepEqual([job.primary_key, Object.keys(job.columns), job.rows, job.values], [["Job"], ["Job", "Status", "Quantity"], 2, { Status: ["planned"] }], "a column with fewer values than rows lists them; one unique per row doesn't");
  const m = await describeSourceFor({ table: "mssql:dbo_Maintenance", sample: 1 }, identity, h.env);
  assert.equal(m.sample.length, 1);
  // read above the audience: refused before anything is read
  h.db.readHome = "ops";
  forgetSources();
  await assert.rejects(describeSourceFor({ table: "mssql:dbo_Job" }, identity, h.env), /above/);
  await assert.rejects(findText({ table: "mssql:dbo_Job", where: { Job: 4471 } }, identity, h.env), /above/);
  // the orchestrator reads with no audience; a discovery part reads as its part's home (floor, below ops: refused)
  assert.equal((await describeSourceFor({ table: "mssql:dbo_Job" }, { user: "admin/agent:o", role: { kind: "master" } }, h.env, { orchestrator: true })).rows, 2);
  const part = { user: "admin/agent:p", role: { kind: "worker", discovery: true, entry: "#90:1" } };
  await assert.rejects(describeSourceFor({ table: "mssql:dbo_Job" }, part, h.env), /above/);
  h.db.readHome = "floor";
  forgetSources();
  assert.equal((await findText({ table: "mssql:dbo_Job", where: { Job: 4471 } }, part, h.env)).rows[0].key, "mssql:dbo_Job:4471");
});
