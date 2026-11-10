import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertBrief, scopeBrief, splitByHome } from "../src/model/brief.js";
import { parsePositionMap } from "../src/positions.js";

const positions = parsePositionMap(JSON.parse(readFileSync(new URL("./fixtures/positions.json", import.meta.url), "utf8")));
//   org > ops > floor

test("a record with sections at different homes is split by home, one brief per home (R11)", () => {
  const groups = splitByHome([{ rid: "#1:1", home: "floor" }, { rid: "#1:2", home: "org" }, { rid: "#1:3", home: "floor" }]);
  assert.deepEqual(groups.map((g) => [g.audience, g.sections.map((s) => s.rid)]), [["floor", ["#1:1", "#1:3"]], ["org", ["#1:2"]]]);
  assert.throws(() => splitByHome([{ rid: "#1:1" }]), /needs its home/);
});

test("a brief holds only what its audience sees: classes, sections and instances above it are dropped (R7)", () => {
  const { brief, dropped } = scopeBrief(
    {
      audience: "floor",
      record: { title: "Shift notes", home: "floor" },
      sections: [{ rid: "#1:1", home: "floor", text: "job moved" }],
      classes: [{ name: "jobs", home: "floor" }, { name: "hires", home: "org" }, { name: "agent", home: "everyone" }],
      instances: [{ rid: "#9:1", name: "CNC 5", homes: ["floor"] }, { rid: "#9:2", name: "Tomas", homes: ["org"] }, { rid: "#9:3", name: "Kayla", homes: ["org", "floor"] }],
      sources: [],
    },
    positions,
  );
  assert.deepEqual(brief.classes.map((c) => c.name), ["jobs", "agent"]);
  assert.deepEqual(brief.instances.map((i) => i.name), ["CNC 5", "Kayla"], "an instance is visible wherever a section about it is");
  assert.deepEqual(dropped, { sections: 0, classes: 1, instances: 1, record: 0 });
  assert.ok(!JSON.stringify(brief).includes("hires") && !JSON.stringify(brief).includes("Tomas"));
  assert.doesNotThrow(() => assertBrief(brief, positions));
});

test("a higher audience sees what is homed below it", () => {
  const { brief } = scopeBrief({ audience: "ops", sections: [{ rid: "#1:1", home: "floor" }], classes: [{ name: "jobs", home: "floor" }], instances: [] }, positions);
  assert.equal(brief.classes.length, 1);
  assert.equal(brief.sections.length, 1);
});

test("assertBrief refuses anything above the audience, and source URLs", () => {
  const brief = { audience: "floor", record: null, sections: [], classes: [{ name: "hires", home: "org" }], instances: [], sources: [] };
  assert.throws(() => assertBrief(brief, positions), /classes\[0\]: above the audience/);
  assert.throws(() => assertBrief({ ...brief, classes: [], record: { home: "org" } }, positions), /record/);
  assert.throws(() => assertBrief({ ...brief, classes: [], sources: [{ system: "mssql", commit: { url: "http://x" } }] }, positions), /never where it is/);
  assert.throws(() => scopeBrief({ audience: "nowhere" }, positions), /unknown position/);
});
