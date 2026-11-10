import assert from "node:assert/strict";
import { test } from "node:test";
import { awaitingVerdict, normalizeEntry, normalizeRequest, normalizeVerdict, OUTCOMES } from "../src/model/filing.js";

const base = { id: "f1", record: "#20:1", section: "#20:2", home: "floor", recorder: "bob", worker: "admin/agent:w1", piece: "Job 4471 moved to CNC 5" };

test("four outcomes (R2)", () => {
  assert.deepEqual(OUTCOMES, ["filed", "proposed", "held", "kept"]);
  assert.throws(() => normalizeEntry({ ...base, outcome: "linked" }), /must be one of/);
});

test("a Filed piece names the row it wrote", () => {
  assert.throws(() => normalizeEntry({ ...base, outcome: "filed", target: { table: "mssql:dbo_Job" } }), /names the row it wrote/);
  const e = normalizeEntry({ ...base, outcome: "filed", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:4471", fields: { Work_Center: "CNC5" } } });
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
  const e = normalizeEntry({ ...base, outcome: "filed", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:4471" }, account: "updated Work_Center to CNC5" });
  assert.equal(e.account.said, "updated Work_Center to CNC5");
  assert.equal(awaitingVerdict(e), true);
  const checked = normalizeEntry({ ...e, verdict: { result: "differs", checked: "mssql:dbo_Job:4471", by: "orchestrator", note: "Work_Center is CNC2" } });
  assert.equal(awaitingVerdict(checked), false);
  assert.throws(() => normalizeVerdict({ result: "fine", by: "o" }), /must be one of/);
  assert.throws(() => normalizeVerdict({ result: "matches" }), /who checked/);
});

test("a Kept piece re-filed later points back to the first entry (R11)", () => {
  const again = normalizeEntry({ ...base, id: "f2", outcome: "filed", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:4471" }, refiled_from: "f1" });
  assert.equal(again.refiled_from, "f1");
});

test("requests: a class request, answered by the orchestrator", () => {
  const r = normalizeRequest({ id: "r1", kind: "class", record: "#20:1", worker: "w1", home: "floor", question: "no class fits forklifts", suggestion: "forklift under machines" });
  assert.equal(r.status, "open");
  assert.throws(() => normalizeRequest({ ...r, status: "answered" }), /the answer and who gave it/);
  assert.throws(() => normalizeRequest({ ...r, kind: "chat" }), /must be one of/);
  assert.equal(normalizeRequest({ ...r, status: "answered", answer: "made forklift", answered_by: "orchestrator" }).answered_by, "orchestrator");
});
