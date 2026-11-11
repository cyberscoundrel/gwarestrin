import assert from "node:assert/strict";
import { test } from "node:test";
import { awaitingVerdict, DISAGREEMENT_RULE, disagreeingColumns, normalizeAnswer, normalizeEntry, normalizeRequest, normalizeVerdict, onDisagreement, OUTCOMES, suggestVerdict } from "../src/model/filing.js";

const base = { id: "f1", record: "#20:1", section: "#20:2", home: "floor", recorder: "bob", worker: "admin/agent:w1", piece: "Job 4471 moved to CNC 5" };

test("four outcomes (R2)", () => {
  assert.deepEqual(OUTCOMES, ["filed", "proposed", "held", "kept"]);
  assert.throws(() => normalizeEntry({ ...base, outcome: "linked" }), /must be one of/);
});

test("a Filed piece names the row it wrote", () => {
  assert.throws(() => normalizeEntry({ ...base, outcome: "filed", class: "jobs", account: "wrote it", target: { table: "mssql:dbo_Job" } }), /names the row it wrote/);
  const e = normalizeEntry({ ...base, outcome: "filed", class: "jobs", account: "moved it to CNC5", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:4471", fields: { Work_Center: "CNC5" } } });
  assert.equal(e.target.key, "mssql:dbo_Job:4471");
});

test("a Proposed piece says why, a Held piece asks the recorder, a Kept piece has no target", () => {
  assert.throws(() => normalizeEntry({ ...base, outcome: "proposed", target: { table: "mssql:dbo_Job" } }), /says why/);
  assert.throws(() => normalizeEntry({ ...base, outcome: "held", target: { table: "mssql:dbo_Job" } }), /asks whoever put it on record/);
  const kept = normalizeEntry({ ...base, outcome: "kept", target: { table: "mssql:dbo_Job" }, instances: ["#12:1"] });
  assert.equal(kept.target, null, "no system holds it: the document is the source");
  assert.deepEqual(kept.instances, ["#12:1"]);
});

test("one entry is one piece; the entry carries its section's home", () => {
  for (const k of ["record", "section", "home", "recorder", "worker", "piece"]) {
    const { [k]: _gone, ...rest } = base;
    assert.throws(() => normalizeEntry({ ...rest, outcome: "kept" }), new RegExp(k));
  }
});

test("a worker's account and the orchestrator's verdict (R10)", () => {
  const e = normalizeEntry({ ...base, outcome: "filed", class: "jobs", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:4471" }, account: "updated Work_Center to CNC5" });
  assert.equal(e.account.said, "updated Work_Center to CNC5");
  assert.equal(awaitingVerdict(e), true);
  const checked = normalizeEntry({ ...e, verdict: { result: "differs", checked: "mssql:dbo_Job:4471", by: "orchestrator", note: "Work_Center is CNC2" } });
  assert.equal(awaitingVerdict(checked), false);
  assert.throws(() => normalizeVerdict({ result: "fine", by: "o" }), /must be one of/);
  assert.throws(() => normalizeVerdict({ result: "matches" }), /who checked/);
});

test("a Kept piece re-filed later points back to the first entry (R11)", () => {
  const again = normalizeEntry({ ...base, id: "f2", outcome: "filed", class: "jobs", account: "re-filed it", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:4471" }, refiled_from: "f1" });
  assert.equal(again.refiled_from, "f1");
});

test("requests: a class request, answered by the orchestrator", () => {
  const r = normalizeRequest({ id: "r1", kind: "class", record: "#20:1", worker: "w1", home: "floor", question: "no class fits forklifts", suggestion: "forklift under machines" });
  assert.equal(r.status, "open");
  assert.throws(() => normalizeRequest({ ...r, status: "answered" }), /the answer and who gave it/);
  assert.throws(() => normalizeRequest({ ...r, kind: "chat" }), /must be one of/);
  assert.equal(normalizeRequest({ ...r, status: "answered", answer: "made forklift", answered_by: "orchestrator" }).answered_by, "orchestrator");
});

test("R12 (F4) lives in one function: a stated change is filed, a disagreeing state is Held; the conservative rule is kept", () => {
  assert.equal(DISAGREEMENT_RULE, "update_when_changed", "R12: stated changes are written");
  assert.deepEqual(onDisagreement({ says_change: true }), { file: true, outcome: null, request: null });
  assert.deepEqual(onDisagreement({ says_change: false }), { file: false, outcome: "held", request: null });
  assert.deepEqual(onDisagreement({ says_change: true }, "hold_and_request"), { file: false, outcome: "held", request: "conflict" });
  assert.deepEqual(onDisagreement({ says_change: false }, "hold_and_request"), { file: false, outcome: "held", request: "conflict" });
  assert.deepEqual(onDisagreement({ says_change: true }, "update_when_changed"), { file: true, outcome: null, request: null });
  assert.deepEqual(onDisagreement({ says_change: false }, "update_when_changed"), { file: false, outcome: "held", request: null });
  assert.deepEqual(onDisagreement({ says_change: "yes" }, "update_when_changed").file, false, "only a stated true counts");
  assert.throws(() => onDisagreement({}, "overwrite"), /must be one of/);
});

test("a disagreement is a different, non-empty value in a written column; an empty column taking a value is none", () => {
  const row = { Status: "open", Note: "", Qty: 500, Owner: null };
  assert.deepEqual(disagreeingColumns(row, { Status: "done", Note: "x", Qty: 500, Owner: "bob" }), [{ column: "Status", source: "open", record: "done" }]);
  assert.deepEqual(disagreeingColumns(row, { Status: "OPEN" }, (a, b) => String(a).toLowerCase() === String(b).toLowerCase()), []);
  assert.deepEqual(disagreeingColumns(null, { Status: "done" }), []);
});

test("an answer to a request is structured: a decision, and a class only where it names one (F7)", () => {
  assert.deepEqual(normalizeAnswer({ decision: "use_class", class: "Leased building" }), { decision: "use_class", class: "leased_building" });
  assert.deepEqual(normalizeAnswer({ decision: "keep" }), { decision: "keep", class: null });
  assert.throws(() => normalizeAnswer({ decision: "class_created" }), /names the class/);
  assert.throws(() => normalizeAnswer({ decision: "hold", class: "jobs" }), /names no class/);
  assert.throws(() => normalizeAnswer({ decision: "whatever you think" }), /must be one of/);
});

test("the suggested verdict reads the source: Filed must be in the row, Proposed and Held must not have changed it", () => {
  const filed = { outcome: "filed", target: { key: "mssql:dbo_Job:4471", fields: { Status: "done" } } };
  assert.equal(suggestVerdict(filed, { status: "ok", row: { Status: "done" } }).result, undefined, "a write that landed: the facts only, the orchestrator judges it from the section");
  assert.match(suggestVerdict(filed, { status: "ok", row: { Status: "done" } }).checked, /holds what was filed/);
  assert.equal(suggestVerdict(filed, { status: "ok", row: { Status: "open" } }).result, "differs");
  assert.equal(suggestVerdict(filed, { status: "not_found" }).result, "differs");
  assert.equal(suggestVerdict(filed, { status: "unreachable" }).result, "unverifiable");
  const held = { ...filed, outcome: "held" };
  assert.equal(suggestVerdict(held, { status: "ok", row: { Status: "open" } }).result, undefined);
  assert.match(suggestVerdict(held, { status: "ok", row: { Status: "open" } }).checked, /unchanged/);
  assert.match(suggestVerdict(held, { status: "ok", row: { Status: "done" } }).checked, /though it was held/, "a Held piece's values in the row: the fact, for the orchestrator to judge");
  assert.equal(suggestVerdict({ outcome: "kept", target: null }, null).result, "unverifiable");
});

// the reviewer's probe3 on ba583bc (non-blocking 4): shapes the rulings rule out
test("a Filed piece names its class and carries its account; a Kept piece is linked to instances (R2, R10, R11)", () => {
  const filed = { ...base, outcome: "filed", class: "jobs", account: { said: "wrote Status complete" }, target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:4471", fields: { Status: "complete" } } };
  assert.equal(normalizeEntry(filed).class, "jobs");
  assert.throws(() => normalizeEntry({ ...filed, class: null }), /class: a Filed piece names the class/);
  assert.throws(() => normalizeEntry({ ...filed, account: null }), /account: a Filed piece carries the account/);
  assert.throws(() => normalizeEntry({ ...base, outcome: "kept" }), /instances: a Kept piece is linked to the instances/);
  assert.deepEqual(normalizeEntry({ ...base, outcome: "kept", instances: ["#80:1"] }).instances, ["#80:1"]);
});

test("R15: a Kept piece needs instances, except the floor's for a worker that ended without filing", () => {
  const kept = { id: "k1", outcome: "kept", record: "doc-1", section: "#71:3", home: "floor", piece: "the whole section", recorder: "bob", worker: "j1", at: "2026-11-10T00:00:00.000Z" };
  assert.throws(() => normalizeEntry(kept), /linked to the instances/);
  assert.deepEqual(normalizeEntry({ ...kept, reason: "worker ended without filing" }).instances, []);
  assert.throws(() => normalizeEntry({ ...kept, reason: "no system holds it" }), /linked to the instances/);
  assert.equal(normalizeRequest({ id: "r1", kind: "other", record: "doc-1", worker: "j1", home: "floor", question: "q", raised_by: "graph-rag" }).raised_by, "graph-rag");
  assert.equal(normalizeRequest({ id: "r1", kind: "other", record: "doc-1", worker: "j1", home: "floor", question: "q" }).raised_by, null);
});
