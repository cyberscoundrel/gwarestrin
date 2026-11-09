import assert from "node:assert/strict";
import { test } from "node:test";
import { LEVELS, REASONS, triageRequest, triageVerdict } from "../src/decisions.js";

test("the request: a level and a reason over the section and the queries' facts; no contradiction, no candidate questions", () => {
  const { state, questions } = triageRequest({ name: "ux-note 21", text: "Ask John F. before changing the assembly schedule." }, { claims: 2, unresolved: 1, conflicts: 0, keyed: 1 });
  assert.match(state.entry, /Ask John F\./);
  assert.match(state.facts, /2 claim\(s\); 1 subject\(s\) with a record key; 1 unresolved subject\(s\); 0 conflict\(s\)/);
  assert.deepEqual(Object.keys(questions).sort(), ["level", "reason"]);
  assert.equal(questions.level.type, "score");
  assert.deepEqual(questions.level.criteria, LEVELS);
  assert.equal(questions.reason.type, "choice");
  assert.deepEqual(questions.reason.criteria, REASONS);
  assert.ok(!("contradiction" in questions), "contradiction is a query over claims, not a question");
  assert.ok(!Object.keys(questions).some((k) => k.startsWith("who_")), "which instance a subject means is the resolver's");
  assert.ok(!("contradiction" in REASONS) && !("ambiguous_name" in REASONS));
});

test("the queries' facts rule: an unresolved subject or a conflict is work whatever the model says", () => {
  const sure = { level: { score: 0.2, probabilities: { 0: 0.8, 1: 0.2 } }, reason: { choice: "plain_fact", probabilities: { plain_fact: 0.9 } } };
  const plain = triageVerdict(sure, { claims: 1, unresolved: 0, conflicts: 0, keyed: 1 }, { random: () => 0.5 });
  assert.equal(plain.level, 0);
  assert.equal(plain.reason, "plain_fact");
  assert.equal(plain.toMaster, false);
  const open = triageVerdict(sure, { claims: 1, unresolved: 1, conflicts: 0, keyed: 0 }, { random: () => 0.5 });
  assert.equal(open.level, 1, "an unresolved subject is never level 0");
  assert.equal(open.reason, "unresolved_subject");
  assert.equal(open.toMaster, true);
  const conflict = triageVerdict(sure, { claims: 1, unresolved: 0, conflicts: 1, keyed: 1 }, { random: () => 0.5 });
  assert.equal(conflict.reason, "conflict");
  assert.equal(conflict.toMaster, true);
  const big = triageVerdict({ level: { score: 2.7, probabilities: { 3: 0.7 } }, reason: { choice: "judgement" } }, { claims: 4 });
  assert.deepEqual([big.level, big.reason], [3, "judgement"]);
  const lookup = triageVerdict({ level: { score: 1.1, probabilities: { 1: 0.7 } }, reason: { choice: "plain_fact", probabilities: { plain_fact: 0.4 } } }, { claims: 1, keyed: 1 });
  assert.deepEqual([lookup.level, lookup.reason], [1, "record_lookup"], "a keyed subject the model has no reason for is a record lookup");
});

test("a small sample of no-work sections still goes to the master", () => {
  const v = triageVerdict({ level: { score: 0.1, probabilities: { 0: 0.9 } } }, { claims: 1 }, { random: () => 0.01 });
  assert.equal(v.level, 0);
  assert.equal(v.sample, true);
  assert.equal(v.toMaster, true);
});

test("a plain section scored under a quick check needs nothing, even when P(level 0) is spread out", () => {
  // what Jev answered for "The break room fridge gets cleaned out every Friday at 3pm."
  const fridge = triageVerdict({ level: { score: 0.76, probabilities: { 0: 0.46, 1: 0.5, 2: 0.04 } }, reason: { choice: "plain_fact", probabilities: { plain_fact: 0.7 } } }, { claims: 1 }, { random: () => 0.5 });
  assert.equal(fridge.level, 0);
  assert.equal(fridge.toMaster, false);
  // "Michael is training on cnc 2 this week." scored over a quick check: still goes
  const michael = triageVerdict({ level: { score: 1.16, probabilities: { 0: 0.09 } }, reason: { choice: "plain_fact", probabilities: { plain_fact: 0.6 } } }, { claims: 1 }, { random: () => 0.5 });
  assert.equal(michael.toMaster, true);
});
