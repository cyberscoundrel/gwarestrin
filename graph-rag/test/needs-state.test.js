// Needs as commitments with the sign flipped (src/needs.js): a question that names a thing and an
// attribute is read as a state query; a met need shows as answered; an open need takes the shape of
// an open commitment claim.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { askerView, needAsCommitment, parseStateQuestion } from "../src/needs.js";

const classes = JSON.parse(readFileSync(new URL("./fixtures/classes.json", import.meta.url), "utf8")).classes;
const attributes = ["stage", "pay_rate", "pay", "due_date", "status", "machine", "holds", "ends"];
const names = (p) => p.subjects.filter((s) => s.name).map((s) => s.name);
const keys = (p) => p.subjects.filter((s) => s.key).map((s) => s.key);

test("a question naming a known attribute and a thing is a state query", () => {
  const p = parseStateQuestion("What stage is job 4471 at?", { attributes, classes });
  assert.equal(p.attribute, "stage");
  assert.ok(keys(p).includes("mssql:dbo_Job:4471"), `the row number becomes every record table's key: ${keys(p)}`);
  assert.ok(keys(p).includes("mssql:dbo_Order:4471"));
  assert.ok(names(p).includes("job 4471") && names(p).includes("4471") && names(p).includes("job"), `and stays a name: ${names(p)}`);
  assert.ok(!names(p).includes("stage") && !names(p).includes("what"), "the attribute and stop words aren't subjects");
  assert.equal(parseStateQuestion("What stage is job 4471 at?", { attributes, classes }).subjects[0].key, "mssql:dbo_Order:4471", "keys come first");
});

test("the longest attribute wins, possessives drop, record keys are read as written", () => {
  const p = parseStateQuestion("What's Diep's pay rate?", { attributes });
  assert.equal(p.attribute, "pay_rate", "not 'pay'");
  assert.ok(names(p).includes("diep"), `the possessive leaves the name: ${names(p)}`);
  const k = parseStateQuestion("current status of mssql:dbo_Work_Center:INSPECT-2", { attributes });
  assert.equal(k.attribute, "status");
  assert.deepEqual(keys(k), ["mssql:dbo_Work_Center:INSPECT-2"]);
  assert.equal(parseStateQuestion("When does Kayla's assignment end?", { attributes }), null, "'end' is not the attribute 'ends' (only a plural of the attribute's words counts)");
  assert.equal(parseStateQuestion("What are the stages of the Toro order?", { attributes }), null, "a plural asks for several values, and state gives one");
  assert.equal(parseStateQuestion("Who is the Toro guy?", { attributes }), null, "no attribute named: the embedding path");
  assert.equal(parseStateQuestion("", { attributes }), null);
  assert.equal(parseStateQuestion("what stage", { attributes }), null, "an attribute with nothing it could be about");
});

test("names are runs of up to three words, never starting or ending on a stop word", () => {
  const p = parseStateQuestion("Which machine is the Corvane Medical bracket job on?", { attributes });
  assert.equal(p.attribute, "machine");
  for (const n of ["corvane", "corvane medical", "corvane medical bracket", "medical bracket job", "bracket job", "job"]) assert.ok(names(p).includes(n), `${n} in ${names(p)}`);
  assert.ok(!names(p).some((n) => n.startsWith("the ") || n.endsWith(" on") || n.endsWith(" is")));
  assert.ok(p.subjects.length <= 40);
});

test("a met need shows the asker 'answered' and what met it, and is no longer open", () => {
  const need = { qid: "q1", question: "What stage is job 4471 at?", status: "met", open_until: "2026-11-22T12:00:00.000Z", asker: "bob", asked: 1 };
  const v = askerView(need, [{ state: "visible", name: "Shift handover §1: Job 4471" }], Date.parse("2026-11-08T12:00:00Z"));
  assert.equal(v.status, "answered");
  assert.equal(v.still_open, false);
  assert.deepEqual(v.shared, ["Shift handover §1: Job 4471"]);
  assert.equal(askerView({ ...need, status: "open" }, [], Date.parse("2026-11-08T12:00:00Z")).status, "asked", "an open one is unchanged");
});

test("an open need is a commitment claim with the sign flipped: owed to the asker, by nobody yet", () => {
  const need = { qid: "q1", question: "When does the Toro order go to plating?", status: "open", open_until: "2026-10-22T12:00:00.000Z", asker: "bob", asked: 2, home: "floor", questions: [{ text: "...", at: "2026-10-08T12:00:00.000Z" }] };
  const c = needAsCommitment(need);
  assert.equal(c.kind, "commitment");
  assert.equal(c.class, "need");
  assert.equal(c.attribute, "answer");
  assert.equal(c.value, need.question);
  assert.deepEqual(c.subject, { key: null, name: "bob", class: null, actor: "person", scope: null });
  assert.equal(c.owed_to, "bob");
  assert.equal(c.owed_by, null);
  assert.equal(c.valid_from, "2026-10-08T12:00:00.000Z");
  assert.equal(c.valid_until, need.open_until);
  assert.equal(c.recorded_by, "bob");
  assert.equal(c.section, null);
  assert.equal(c.asked, 2);
  // the keys an open commitment claim carries, so the two list in one table
  for (const k of ["kind", "class", "attribute", "value", "value_num", "subject", "valid_from", "valid_until", "recorded_at", "recorded_by", "section"]) assert.ok(k in c, k);
});
