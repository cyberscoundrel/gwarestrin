// The fake models (e2e/fake-models.mjs): the grader kept off sections with
// claims, the decision model's closed questions from a lookup, the built-in
// condenser and the fake-condenser.mjs hook, and the control routes.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerChoice, CLAIMED_TAG, condense, createFakeModels, decide, grade, isCondenseRequest, loadCondenser, mentions, RESOLUTION, vector } from "../e2e/fake-models.mjs";

const graderUser = (items) => [
  { role: "system", content: "You decide who in an organization may see a piece of information in its knowledge base." },
  { role: "user", content: `Writer's position and those above it:\nP1: Production floor (jobs)\nP2: Operations (orders)\nP3: org (the top)\n\nInformation to grade:\n${items.map((t, i) => `#${i + 1} name: item ${i + 1}\nidentity: ${t}`).join("\n")}` },
];

test("the grader: [admins] to the top, routine at the writer's; a [claimed] section stays at the writer's and is counted", () => {
  const counts = {};
  const out = JSON.parse(grade(graderUser(["Diep starts at 21.50 an hour. [admins]", "The fridge is cleaned Fridays.", `Rack C1 holds titanium. ${CLAIMED_TAG}`, `Pay goes up. [admins] ${CLAIMED_TAG}`]), counts));
  assert.deepEqual(
    out.items.map((i) => [i.visible_from, i.topic ?? null]),
    [
      ["P3", "personnel and health"],
      ["P1", null],
      ["P1", null],
      ["P1", null],
    ],
  );
  assert.match(out.items[2].reason, /has claims/);
  assert.equal(counts.claimed, 2, "every claimed item the grader was asked about is counted");
  assert.equal(JSON.parse(grade(graderUser(["plain"]))).items[0].visible_from, "P1", "no counter given: still answers");
});

test("the linker and the vectors are unchanged: mentions from the tag, deterministic unit vectors", () => {
  const m = JSON.parse(mentions([{ role: "user", content: "HILL shipped pins. [things: HILL/supplier, gage pins]" }]));
  assert.deepEqual(m.things, [
    { name: "HILL", type: "supplier", role: "mentions" },
    { name: "gage pins", type: "other", role: "mentions" },
  ]);
  const v = vector("coolant on CNC 1");
  assert.equal(v.length, 384);
  assert.deepEqual(v, vector("coolant on CNC 1"));
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
});

test("the decision model: triage as before, and a who_<n> answered from the tags, the run-time lookup, or the built-in table", () => {
  const candidates = "c0: Diep Tran (person), inactive employee NGDT\nc1: Diep Nguyen (person), active employee NGUD";
  const who = { type: "choice", criteria: { c0: "Diep Tran (person)", c1: "Diep Nguyen (person)", none: "None of them" } };
  const ask = (entry, lookup) => decide({ state: { entry, candidates_0: candidates }, questions: { level: { type: "score" }, reason: { type: "choice" }, who_0: who } }, lookup).answers;
  const plain = ask("x: Diep is running CNC 5 this afternoon");
  assert.equal(plain.level.score, 0);
  assert.equal(plain.reason.choice, "plain_fact");
  assert.equal(plain.who_0.choice, "c1", "the built-in table: Diep is the active NGUD");
  assert.equal(plain.who_0.probabilities.c1, 0.9);
  assert.equal(ask("x: Diep is on CNC 5 [who_0: c0]").who_0.choice, "c0", "a tag names the choice");
  assert.equal(ask("x: Diep is on CNC 5 [resolve: Diep=NGDT]").who_0.choice, "c0", "a resolve tag picks by the candidate line");
  assert.equal(ask("x: Someone is on CNC 5").who_0.choice, "none", "nothing to go on: none");
  assert.equal(ask("x: Tomas is on CNC 5", { Tomas: "NGDT" }).who_0.choice, "c0", "the run-time lookup");
  assert.equal(ask("x: Ask John F. about fixtures [L2]").level.score, 2);
  assert.equal(RESOLUTION.Diep, "NGUD");
  const contra = decide({ state: { entry: "x: Rack C1 holds aluminum [contradicts]", related: "y: C1 titanium" }, questions: { contradiction: { type: "noul" } } }).answers;
  assert.equal(contra.contradiction.noul, 0.9);
  const noCriteria = answerChoice("which_attribute", { criteria: { price: "p", margin: "m" }, entry: "the margin [which_attribute: margin]" });
  assert.equal(noCriteria.choice, "margin", "any closed choice question, by its tag");
  const unsure = answerChoice("which_attribute", { criteria: { price: "p", margin: "m" }, entry: "nothing" });
  assert.equal(unsure.choice, "price");
  assert.equal(unsure.probabilities.price, 0.5, "no none, nothing to go on: spread");
});

test("the built-in condenser: a document in the contract's shape from the text's tags; a lookup answers first", () => {
  const text = "[title: Rack C split] [on record: bob|floor|rack change]\nRack C is now two racks. [claim: state|Rack C1|material rack|contents|titanium] [claim: state|Rack C2|material rack|contents|aluminum]\n\nThe Brightline bar moved to C1.";
  const doc = JSON.parse(condense([{ role: "user", content: text }]));
  assert.equal(doc.title, "Rack C split");
  assert.deepEqual([doc.recorded_by, doc.position, doc.reason], ["bob", "floor", "rack change"]);
  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[0].text, "Rack C is now two racks.");
  assert.deepEqual(doc.sections[0].claims, [
    { kind: "state", subject: "Rack C1", class: "material rack", attribute: "contents", value: "titanium" },
    { kind: "state", subject: "Rack C2", class: "material rack", attribute: "contents", value: "aluminum" },
  ]);
  assert.deepEqual(doc.sections[1].claims, []);
  const bare = JSON.parse(condense([{ role: "user", content: "Just a line." }]));
  assert.equal(bare.title, "Just a line.");
  assert.equal(bare.recorded_by, "unknown");
  const canned = JSON.parse(condense([{ role: "user", content: "the Corvane thread" }], [{ match: "Corvane", document: { title: "canned" } }]));
  assert.equal(canned.title, "canned");
  assert.equal(isCondenseRequest({ model: "condenser-1" }), true);
  assert.equal(isCondenseRequest({ model: "ds-flash", messages: [{ role: "system", content: "You condense an on-record thread" }] }), true);
  assert.equal(isCondenseRequest({ model: "grader", messages: [{ role: "system", content: "who may see" }] }), false);
});

test("the fake-condenser.mjs hook: absent -> null; present -> its condense; the wrong shape is an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-condenser-"));
  try {
    assert.equal(await loadCondenser(dir), null);
    writeFileSync(join(dir, "fake-condenser.mjs"), 'export function condense(messages) { return { title: "from the stream", echo: messages.length }; }\nexport const matches = (body) => body.model === "my-condenser";');
    const c = await loadCondenser(dir);
    assert.ok(c.file.endsWith("fake-condenser.mjs"));
    assert.deepEqual(await c.condense([{ role: "user", content: "x" }]), { title: "from the stream", echo: 1 });
    assert.equal(c.matches({ model: "my-condenser" }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const bad = mkdtempSync(join(tmpdir(), "fake-condenser-bad-"));
  try {
    writeFileSync(join(bad, "fake-condenser.mjs"), "export const nothing = 1;");
    await assert.rejects(loadCondenser(bad), /must export condense/);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
});

test("the server: routes a condenser request to the hook, counts claimed grader items, and /__reset clears every override", async () => {
  const condenser = { file: "x", condense: (messages) => ({ title: "hooked", n: messages.length }), matches: null };
  const server = createFakeModels({ condenser });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const c = await post("/v1/chat/completions", { model: "condenser", messages: [{ role: "user", content: "a thread" }] });
    assert.deepEqual(JSON.parse(c.choices[0].message.content), { title: "hooked", n: 1 });
    const g = await post("/v1/chat/completions", { model: "grader", messages: graderUser([`claims here ${CLAIMED_TAG}`, "plain"]) });
    assert.equal(JSON.parse(g.choices[0].message.content).items.length, 2);
    const calls = await (await fetch(`${base}/__calls`)).json();
    assert.equal(calls["grader:claimed"], 1);
    assert.equal(calls.condenser, 1);
    assert.equal(calls.grader, 1);
    await post("/__fail", { model: "grader", status: 402 });
    const failing = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "grader", messages: [] }) });
    assert.equal(failing.status, 402);
    await post("/__resolve", { name: "Tomas", pick: "NGDT" });
    const d = await post("/decisions", { state: { entry: "x: Tomas", candidates_0: "c0: T (person), NGDT" }, questions: { who_0: { type: "choice", criteria: { c0: "T", none: "n" } } } });
    assert.equal(d.answers.who_0.choice, "c0");
    const reset = await post("/__reset", {});
    assert.deepEqual(reset, { reset: true });
    const ok = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "grader", messages: graderUser(["plain"]) }) });
    assert.equal(ok.status, 200, "the failure is cleared");
    const d2 = await post("/decisions", { state: { entry: "x: Tomas", candidates_0: "c0: T (person), NGDT" }, questions: { who_0: { type: "choice", criteria: { c0: "T", none: "n" } } } });
    assert.equal(d2.answers.who_0.choice, "none", "the lookup is cleared");
    const info = await (await fetch(`${base}/__condenser`)).json();
    assert.deepEqual(info, { loaded: true, file: "x" });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
