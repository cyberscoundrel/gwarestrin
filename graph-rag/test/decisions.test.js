import assert from "node:assert/strict";
import { test } from "node:test";
import { LEVELS, triageRequest, triageVerdict } from "../src/decisions.js";

const unsure = [
  { name: "John", type: "person", candidates: [{ rid: "#1:1", label: "John Francis", type: "person", detail: "mssql:dbo_Employee:FRAJ" }, { rid: "#1:2", label: "JOHN", type: "person", detail: "contact at WALTER R. HAMMOND CO" }] },
];

test("the request: a level, a reason, a choice per unsettled name, a contradiction check against related entries", () => {
  const { state, questions } = triageRequest({ name: "ux-note 21", text: "Ask John F. before changing the assembly schedule." }, unsure, [{ name: "ux-note 01", text: "John said the assembly is backed up." }]);
  assert.match(state.entry, /Ask John F\./);
  assert.match(state.candidates_0, /c0: John Francis \(person\), mssql:dbo_Employee:FRAJ/);
  assert.equal(questions.level.type, "score");
  assert.deepEqual(questions.level.criteria, LEVELS);
  assert.equal(questions.who_0.type, "choice");
  assert.ok("none" in questions.who_0.criteria);
  assert.equal(questions.contradiction.type, "noul");
  assert.equal(triageRequest({ name: "x", text: "y" }).questions.contradiction, undefined, "no related entries: no contradiction question");
});

test("a confident name choice settles it; the entry needs nothing only when everything is settled and sure", () => {
  const sure = triageVerdict(
    { who_0: { choice: "c0", probabilities: { c0: 0.84, c1: 0.13, none: 0.03 } }, level: { score: 0.2, probabilities: { 0: 0.8, 1: 0.2 } }, contradiction: { noul: 0.1 } },
    unsure,
    { random: () => 0.5 },
  );
  assert.deepEqual(sure.settled, [{ name: "John", rid: "#1:1", label: "John Francis", p: 0.84 }]);
  assert.equal(sure.level, 0);
  assert.equal(sure.toMaster, false);
  const unsureName = triageVerdict({ who_0: { choice: "c0", probabilities: { c0: 0.6 } }, level: { score: 0.2, probabilities: { 0: 0.8 } } }, unsure, { random: () => 0.5 });
  assert.equal(unsureName.settled.length, 0);
  assert.equal(unsureName.level, 1, "an open name is never level 0");
  assert.equal(unsureName.reason, "ambiguous_name");
  assert.equal(unsureName.toMaster, true);
  const contra = triageVerdict({ level: { score: 0.3, probabilities: { 0: 0.7 } }, contradiction: { noul: 0.8 } }, [], { random: () => 0.5 });
  assert.equal(contra.reason, "contradiction");
  assert.equal(contra.toMaster, true);
  const big = triageVerdict({ level: { score: 2.7, probabilities: { 3: 0.7 } }, reason: { choice: "judgement" } }, []);
  assert.deepEqual([big.level, big.reason], [3, "judgement"]);
});

test("a small sample of no-work entries still goes to the master", () => {
  const v = triageVerdict({ level: { score: 0.1, probabilities: { 0: 0.9 } } }, [], { random: () => 0.01 });
  assert.equal(v.level, 0);
  assert.equal(v.sample, true);
  assert.equal(v.toMaster, true);
});
