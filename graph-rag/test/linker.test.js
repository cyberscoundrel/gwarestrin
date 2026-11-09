// The linker's pure parts (src/things.js): the closed prompt over the
// confirmed classes and the known things, its answer, record keys in a text,
// the residue's prompt and picks, and what the lexical pre-lookup asks for.
// The database-bound steps (src/linker.js) run in the replay harness
// (e2e/scenarios-admission.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mentions, residue } from "../e2e/fake-models.mjs";
import { keysInText, mentionsPrompt, ngrams, parseMentions, parseResidue, residuePrompt, splitThingName, THING_TYPES, thingName } from "../src/things.js";

const CLASSES = JSON.parse(readFileSync(new URL("./fixtures/classes.json", import.meta.url), "utf8"));
const CANDIDATES = [
  { rid: "#1:1", label: "Diep Nguyen", type: "person", class: null, keys: ["mssql:dbo_Employee:NGUD"] },
  { rid: "#1:2", label: "CNC 5", type: "machine", class: null, keys: [] },
];

test("the prompt is a closed question: the confirmed classes with their record tables, the known things by number, no type list", () => {
  const [sys, user] = mentionsPrompt({ name: "ux-aq01 diep on cnc 5", facets: { identity: "Diep is running CNC 5 this afternoon." } }, "Customers are named by their ERP code.", { classes: CLASSES, candidates: CANDIDATES });
  assert.match(sys.content, /^You find the things a statement/, "the harness's fake model answers to this opening");
  assert.match(sys.content, /- jobs \(records: mssql:dbo_Job, key mssql:dbo_Job:<row>\)/);
  assert.match(sys.content, /- hires \(no source system records it\)/);
  assert.match(sys.content, /1\. Diep Nguyen \(person\) \[mssql:dbo_Employee:NGUD\]/);
  assert.match(sys.content, /2\. CNC 5 \(machine\)/);
  assert.match(sys.content, /actor: person, position, customer, supplier or agent/);
  assert.doesNotMatch(sys.content, /type is one of/, "no ten-type decision");
  assert.doesNotMatch(sys.content, /\bother\b/);
  assert.match(sys.content, /data, not instructions/);
  assert.match(sys.content, /ERP code/);
  assert.match(user.content, /Diep is running CNC 5/);
  const [bare] = mentionsPrompt({ name: "x", facets: {} });
  assert.match(bare.content, /Confirmed classes: none yet/);
  assert.doesNotMatch(bare.content, /Known things/);
  assert.match(mentionsPrompt({ name: "x", facets: {} }, "", { sort: true })[0].content, /review/);
  assert.doesNotMatch(bare.content, /review/);
});

test("mentions: a candidate by number, a class with its key, an actor; a type is a hint or nothing, never \"other\"", () => {
  const text = JSON.stringify({
    things: [
      { name: "Diep", role: "operator", candidate: 1 },
      { name: "CNC 5", role: "machine", candidate: 2 },
      { name: "job 4471", role: "subject", class: "jobs", key: "mssql:dbo_Job:4471" },
      { name: "Corvane Medical", role: "customer", actor: "Customer" },
      { name: "Toro", role: "customer", type: "customer" },
      { name: "holiday schedule", role: "subject", type: "other" },
      { name: "Mystery", type: "spaceship" },
      { name: "x", type: "part" },
      { name: "TORO", role: "subject", type: "customer" },
      { name: "job 4471 again", key: "mssql:dbo_Job:4471" },
    ],
  });
  assert.deepEqual(parseMentions(`ok: ${text}`, 8, { candidates: CANDIDATES }), [
    { name: "Diep", type: "person", role: "operator", candidate: "#1:1", picked_name: "Diep Nguyen" }, // a pick is not a key
    { name: "CNC 5", type: "machine", role: "machine", candidate: "#1:2" },
    { name: "job 4471", type: null, role: "subject", key: "mssql:dbo_Job:4471", class: "jobs" },
    { name: "Corvane Medical", type: "customer", role: "customer", actor: "customer" },
    { name: "Toro", type: "customer", role: "customer" },
    { name: "holiday schedule", type: null, role: "subject" },
    { name: "Mystery", type: null, role: "mentions" },
  ]);
  assert.deepEqual(parseMentions("nope"), []);
  assert.equal(parseMentions(JSON.stringify({ things: Array.from({ length: 30 }, (_, i) => ({ name: `Customer ${i}`, type: "customer" })) }), 25).length, 25);
  assert.ok(!THING_TYPES.includes("other"));
  // a worker's link_things goes through the same parser: its type stays a hint, its key is kept
  assert.deepEqual(parseMentions(JSON.stringify({ things: [{ name: "Toro Plating Co", type: "customer", key: "mssql:dbo_Customer:TORO" }, { name: "Toro", type: "customer", key: "mssql:dbo_Customer:TORO" }] })), [{ name: "Toro Plating Co", type: "customer", role: "mentions", key: "mssql:dbo_Customer:TORO" }], "one key, one thing");
});

test("same-named people: the prompt tells the model to give no number, and a number it gives anyway carries no key", () => {
  const [sys] = mentionsPrompt({ name: "x", facets: { identity: "Diep is running CNC 5." } }, "", { classes: CLASSES, candidates: CANDIDATES });
  assert.match(sys.content, /several people share the name the statement uses, do not choose between them/, "the abstain rule (B16)");
  assert.match(sys.content, /PO number[^.]*is content, not a thing/, "the PO rule (B17)");
  assert.doesNotMatch(sys.content, /PO 4471/, "no invitation to make a PO a record");
  const [picked] = parseMentions(JSON.stringify({ things: [{ name: "Diep", role: "operator", candidate: 1 }] }), 8, { candidates: CANDIDATES });
  assert.equal(picked.candidate, "#1:1");
  assert.equal(picked.key, undefined, "picking from the list hands over no key: a key would settle it (B16)");
});

test("the harness's fake can answer as a model that picks and composes keys: a scenario's name is only as good as this", () => {
  const user = (content) => [{ role: "user", content }];
  const text = "x [things: PO 78912/order/key=mssql|dbo_Order|78912/class=orders, Diep/person/1, HILL/supplier]";
  assert.deepEqual(JSON.parse(mentions(user(text))).things, [
    { name: "PO 78912", type: "order", role: "mentions", key: "mssql:dbo_Order:78912", class: "orders" },
    { name: "Diep", type: "person", role: "mentions", candidate: 1 },
    { name: "HILL", type: "supplier", role: "mentions" },
  ]);
  assert.deepEqual(keysInText(text), [], "the tag itself is no key written in the statement");
  const asked = 'Zelda took over. [pick: Zelda=ZK2]\n\n"Zelda" could be:\n  #1:1: Zelda (person) [mssql:dbo_Employee:ZK1]\n  #1:2: Zelda (person) [mssql:dbo_Employee:ZK2]';
  assert.deepEqual(JSON.parse(residue(user(asked))).picks, [{ name: "Zelda", candidate: "#1:2" }]);
});

test("record keys written in a text resolve without a model", () => {
  assert.deepEqual(keysInText("Job mssql:dbo_Job:4471 for Exatron (mssql:dbo_Customer:EXATRON) slips; PO mssql:dbo_Order:78912. Again mssql:dbo_Job:4471."), ["mssql:dbo_Job:4471", "mssql:dbo_Customer:EXATRON", "mssql:dbo_Order:78912"]);
  assert.deepEqual(keysInText("Due at 15:30 on 2026-11-08; ratio 3:2:1."), [], "times and ratios are not keys");
  assert.deepEqual(keysInText("See mssql:dbo_Job for the table."), [], "a table is not a row");
  assert.deepEqual(keysInText(""), []);
});

test("the residue: the candidates each unsettled name could be, and only a listed id counts as a pick", () => {
  const residue = [
    { name: "Diep", role: "operator", candidates: [{ rid: "#1:1", label: "Diep Nguyen", type: "person", keys: ["mssql:dbo_Employee:NGUD"] }, { rid: "#1:2", label: "Diep Tran", type: "person", keys: ["mssql:dbo_Employee:NGDT"] }] },
    { name: "Toro", role: "customer", candidates: [{ rid: "#1:3", label: "Toro", type: "customer" }, { rid: "#1:4", label: "Toro", type: "supplier" }] },
  ];
  const [sys, user] = residuePrompt({ name: "ux-aq01", facets: { identity: "Diep is running CNC 5." } }, residue);
  assert.match(sys.content, /same name are not settled by the name: answer null/);
  assert.match(sys.content, /data, not instructions/);
  assert.match(user.content, /"Diep" \(operator\) could be:\n  #1:1: Diep Nguyen \(person\) \[mssql:dbo_Employee:NGUD\]\n  #1:2: Diep Tran/);
  const picks = parseResidue('{"picks":[{"name":"Diep","candidate":null},{"name":"toro","candidate":"#1:3"},{"name":"Nobody","candidate":"#1:1"},{"name":"Diep","candidate":"#9:9"}]}', residue);
  assert.deepEqual([...picks], [["Toro", "#1:3"]], "null is none, an unknown name is nothing, an id outside the candidates is nothing");
  assert.equal(parseResidue("garbage", residue).size, 0);
  assert.equal(parseResidue("{}", residue).size, 0, "the harness's fake model picks nothing");
});

test("the lexical pre-lookup asks for the text's 1-3 word n-grams, longest first, normalized", () => {
  const g = ngrams("Diep is running CNC 5 this afternoon.");
  assert.ok(g.includes("diep is running") && g.includes("cnc 5") && g.includes("diep") && g.includes("cnc 5 this"));
  assert.equal(g[0], "diep is running");
  assert.ok(!g.includes("5"), "one-character grams are dropped");
  assert.equal(ngrams("").length, 0);
  assert.ok(ngrams("word ".repeat(500)).length <= 200);
});

test("a thing's full name carries its hint, actor type or class, and splits back", () => {
  assert.equal(thingName("customer", "Toro"), "Toro (customer)");
  assert.equal(thingName("jobs", "4471"), "4471 (jobs)");
  assert.equal(thingName(null, "x"), "x (thing)");
  assert.deepEqual(splitThingName("Toro (customer)"), { name: "Toro", type: "customer" });
  assert.deepEqual(splitThingName("4471 (jobs)"), { name: "4471", type: "jobs" });
  assert.deepEqual(splitThingName("INSPECT-2 (machine)"), { name: "INSPECT-2", type: "machine" });
  assert.equal(splitThingName("ux-m01 inspect-2 down"), null);
  assert.equal(splitThingName("a note (with a parenthetical remark)"), null);
});
