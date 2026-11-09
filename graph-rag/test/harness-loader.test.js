// The scenario loader (e2e/scenarios.mjs): discovery, the export shape a
// stream's file must have, the ONLY filter, skips, and the summary line.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverScenarioFiles, loadScenarioFiles, scenariosOf, selected, skipReason, streamOf, summaryLine } from "../e2e/scenarios.mjs";

const dir = mkdtempSync(join(tmpdir(), "harness-loader-"));
const write = (name, text) => writeFileSync(join(dir, name), text);
write("scenarios-condenser.mjs", 'export default [{ name: "condenses a thread", run: async (ctx) => ctx.hit("c") }];');
write("scenarios-authority.mjs", 'export const scenarios = [{ name: "one rule", run: async () => {}, skip: "the rule is stubbed" }, { name: "second", run: async () => {} }];');
write("scenarios-broken.mjs", "export default 42;");
write("scenarios-syntax.mjs", "export default [ { name: ");
write("run.mjs", "export default [];"); // not a scenario file
write("scenarios-Bad Name.mjs", "export default [];"); // not a scenario file either
write("notes-scenarios-x.mjs", "export default [];");
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

test("discovery: scenarios-<stream>.mjs only, sorted", () => {
  const files = discoverScenarioFiles(dir).map((f) => f.split("/").pop());
  assert.deepEqual(files, ["scenarios-authority.mjs", "scenarios-broken.mjs", "scenarios-condenser.mjs", "scenarios-syntax.mjs"]);
  assert.equal(streamOf("/x/scenarios-condenser.mjs"), "condenser");
});

test("the export shape: default or `scenarios`, each { name, run }, skip optional; mistakes name the file and item", () => {
  const ok = scenariosOf({ default: [{ name: "a", run: () => {} }] }, "/x/scenarios-a.mjs");
  assert.equal(ok[0].stream, "a");
  assert.equal(ok[0].file, "scenarios-a.mjs");
  assert.throws(() => scenariosOf({ default: {} }, "/x/scenarios-a.mjs"), /must export an array/);
  assert.throws(() => scenariosOf({ scenarios: [] }, "/x/scenarios-a.mjs"), /exports no scenarios/);
  assert.throws(() => scenariosOf({ default: [{ run: () => {} }] }, "/x/scenarios-a.mjs"), /\[0\]: needs a name/);
  assert.throws(() => scenariosOf({ default: [{ name: "n" }] }, "/x/scenarios-a.mjs"), /"n": needs a run/);
  assert.throws(() => scenariosOf({ default: [{ name: "n", run() {}, skip: 3 }] }, "/x/scenarios-a.mjs"), /skip must be/);
});

test("loading: a good file's scenarios run with the context; a broken file is one failed scenario, and the rest still load", async () => {
  const list = await loadScenarioFiles(discoverScenarioFiles(dir));
  const names = list.map((s) => s.name);
  assert.deepEqual(names, ["one rule", "second", "load scenarios-broken.mjs", "condenses a thread", "load scenarios-syntax.mjs"]);
  const hits = [];
  await list.find((s) => s.name === "condenses a thread").run({ hit: (x) => hits.push(x) });
  assert.deepEqual(hits, ["c"]);
  await assert.rejects(list.find((s) => s.name === "load scenarios-broken.mjs").run(), /must export an array/);
  await assert.rejects(list.find((s) => s.name === "load scenarios-syntax.mjs").run(), /SyntaxError|Unexpected/);
});

test("ONLY: a term matches the name, file or stream; unset runs everything", () => {
  const s = { name: "a graded note lands", file: "scenarios-authority.mjs", stream: "authority" };
  assert.equal(selected(s, undefined), true);
  assert.equal(selected(s, ""), true);
  assert.equal(selected(s, "authority"), true);
  assert.equal(selected(s, "GRADED"), true);
  assert.equal(selected(s, "condenser"), false);
  assert.equal(selected(s, "condenser, graded"), true);
});

test("skip: a reason, true, or a function of the context; nothing skips when it is absent or returns null", async () => {
  assert.equal(await skipReason({ skip: undefined }, {}), null);
  assert.equal(await skipReason({ skip: false }, {}), null);
  assert.equal(await skipReason({ skip: "later" }, {}), "later");
  assert.equal(await skipReason({ skip: true }, {}), "skipped");
  assert.equal(await skipReason({ skip: async (ctx) => (ctx.ready ? null : "not ready") }, { ready: false }), "not ready");
  assert.equal(await skipReason({ skip: async (ctx) => (ctx.ready ? null : "not ready") }, { ready: true }), null);
});

test("the summary line: passed over run, skipped set apart", () => {
  assert.equal(summaryLine([{ ok: true }, { ok: true }]), "2/2 scenarios passed");
  assert.equal(summaryLine([{ ok: true }, { ok: false }, { ok: true, skipped: true }]), "1/2 scenarios passed (1 skipped)");
  assert.equal(summaryLine([]), "0/0 scenarios passed");
});
