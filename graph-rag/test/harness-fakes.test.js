// The fake models (e2e/fake-models.mjs): the grader kept off sections with
// claims, the decision model's closed questions from a lookup, the built-in
// condenser and the fake-condenser.mjs hook, and the control routes.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerChoice, CLAIMED_TAG, condense, createFakeModels, decide, grade, isCondenseRequest, loadCondenser, vector } from "../e2e/fake-models.mjs";
import { fakeSource } from "../e2e/fake-source.mjs";
import { connectionIdentity, dumpSource, guardTestSource, keyFromCursor } from "../eval/dump.mjs";
import { dataset } from "../eval/s0.mjs";

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

test("the vectors are unchanged: deterministic unit vectors from the words", () => {
  const v = vector("coolant on CNC 1");
  assert.equal(v.length, 384);
  assert.deepEqual(v, vector("coolant on CNC 1"));
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
});

test("the decision model: a closed question answered only from its tag, else none; no built-in names, nothing about Diep", () => {
  const who = { type: "choice", criteria: { c0: "Diep Ngo (person)", c1: "Diep Nguyen (person)", none: "None of them" } };
  const ask = (entry) => decide({ state: { entry }, questions: { who_0: who } }).answers;
  assert.equal(ask("x: Diep is running CNC 5 this afternoon").who_0.choice, "none", "no table resolves Diep for the test");
  assert.equal(ask("x: Diep is on CNC 5 [who_0: c1]").who_0.choice, "c1", "a tag names the choice");
  assert.equal(ask("x: Diep is on CNC 5 [who_0: c1]").who_0.probabilities.c1, 0.9);
  const contra = decide({ state: { entry: "x: Rack C1 holds aluminum [contradicts]", related: "y: C1 titanium" }, questions: { contradiction: { type: "noul" } } }).answers;
  assert.equal(contra.contradiction.noul, 0.9);
  assert.equal(answerChoice("pick.one(a)", { criteria: { x: "x", none: "n" }, entry: "[pick.one(a): x]" }).choice, "x", "a question name with regex metacharacters matches its tag");
  const unsure = answerChoice("which_attribute", { criteria: { price: "p", margin: "m" }, entry: "nothing" });
  assert.equal(unsure.choice, "price");
  assert.equal(unsure.probabilities.price, 0.5, "no none, nothing to go on: spread");
});

test("the fake source: the synthetic database's rows through DAB's tools; the read endpoint refuses writes, the write endpoint takes them; dump, plant and reset", async () => {
  const src = fakeSource();
  const call = (write) => async (name, args) => {
    const r = src.rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, write, write ? 5001 : 5000);
    const text = r.result.content[0].text;
    if (r.result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const read = call(false);
  const found = await read("read_records", { entity: "dbo_Employee", filter: "Employee eq 'NGDT'" });
  assert.equal(found.result.value[0].Status, "Inactive");
  await assert.rejects(read("update_record", { entity: "dbo_Job", keys: { Job: 4471 }, fields: { Status: "Rush" } }), /Permission denied/);
  await call(true)("update_record", { entity: "dbo_Job", keys: { Job: 4471 }, fields: { Status: "Rush" } });
  const dumped = await dumpSource(read, { keys: { dbo_Vendor: ["Vendor"], dbo_Material: ["Material"] } });
  assert.deepEqual(Object.keys(dumped).sort(), Object.keys(dataset()).sort(), "the identity view is left out of a dump");
  assert.deepEqual(await connectionIdentity(read), { server: "gr-e2e-fake", database: "S0Fake", login: "s0_write" });
  await guardTestSource(() => connectionIdentity(read), { server: "GR-E2E-FAKE", database: "s0fake" });
  await assert.rejects(guardTestSource(() => connectionIdentity(read), { server: "gwsynth-sql", database: "GwSynthMfg" }), /refusing to run/);
  assert.deepEqual(dumped.dbo_Job.primaryKey, ["Job"], "the key from the first page's cursor");
  assert.equal(dumped.dbo_Job.rows.find((r) => r.Job === 4471).Status, "Rush");
  assert.deepEqual(src.control("GET", "/__dump").dbo_Job, dumped.dbo_Job);
  assert.equal(src.control("POST", "/__plant", { table: "dbo_Work_Center", keys: { Work_Center: "CNC 1" }, fields: { Status: "Down" } }).ok, true);
  assert.equal(src.control("GET", "/__calls").filter((c) => c.error).length, 1);
  src.control("POST", "/__reset");
  const reset = src.control("GET", "/__dump");
  delete reset.dbo_GwConnectionIdentity;
  assert.deepEqual(reset, dataset());
  assert.equal(keyFromCursor(null), null);
});

test("the guard: a write connection that holds anything but the test server and database stops the run", async () => {
  const want = { server: "gr-test-sql", database: "gwtest" };
  assert.deepEqual(await guardTestSource(async () => want, want), want);
  await assert.rejects(guardTestSource(async () => ({ server: "mssql-server", database: "ERP" }), want), /refusing to run/);
  await assert.rejects(guardTestSource(async () => want, {}), /needs the test server/);
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
    await assert.rejects(loadCondenser(bad), /must export complete\(body\) or condense/);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
  // the Condenser stream's shape: complete(body) answering as chat completions
  const cc = mkdtempSync(join(tmpdir(), "fake-condenser-cc-"));
  try {
    writeFileSync(join(cc, "fake-condenser.mjs"), 'export function complete(body) { return { choices: [{ message: { role: "assistant", content: JSON.stringify({ title: "via complete", n: body.messages.length }) } }] }; }');
    const c = await loadCondenser(cc);
    assert.deepEqual(JSON.parse(await c.condense([{ role: "user", content: "x" }], { model: "condenser" })), { title: "via complete", n: 1 });
  } finally {
    rmSync(cc, { recursive: true, force: true });
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
    const d = await post("/decisions", { state: { entry: "x: Tomas [who_0: c0]" }, questions: { who_0: { type: "choice", criteria: { c0: "T", none: "n" } } } });
    assert.equal(d.answers.who_0.choice, "c0", "from the entry's tag");
    assert.equal((await fetch(`${base}/__resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404, "no lookup route: names aren't resolved for a test");
    const reset = await post("/__reset", {});
    assert.deepEqual(reset, { reset: true });
    const ok = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "grader", messages: graderUser(["plain"]) }) });
    assert.equal(ok.status, 200, "the failure is cleared");
    const info = await (await fetch(`${base}/__condenser`)).json();
    assert.deepEqual(info, { loaded: true, file: "x" });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
