import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertBrief, RECORD_FIELDS, scopeBrief, splitByHome } from "../src/model/brief.js";
import { normalizeDocument } from "../src/model/record.js";
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

// the reviewer's probe on ba583bc (B1): a brief built from the record as record.js normalizes it, with no home
test("B1: a record with no home counts as the root, so the floor gets neither its title nor its sections (R7, R11)", () => {
  const doc = normalizeDocument({ title: "Admin notes", recorded_by: "admin", position: "org", reason: "the week", sections: [{ text: "Job 4471 moved to mill 3" }, { text: "SECRET: Bob's pay rises to 41/h" }] });
  const { brief, dropped } = scopeBrief({ audience: "floor", record: doc, sections: [{ rid: "#1:1", home: "floor", text: "Job 4471 moved to mill 3" }] }, positions);
  assert.equal(brief.record, null);
  assert.equal(dropped.record, 1);
  assert.doesNotMatch(JSON.stringify(brief), /SECRET|41\/h/);
  assert.doesNotThrow(() => assertBrief(brief, positions));
});

test("B1: a brief holds the record's title and description only; a record carrying sections is refused, whatever its home", () => {
  const record = { id: "doc-1", title: "Shift notes", description: "the handover", home: "floor", recorded_by: "bob", sections: [{ home: "org", text: "SECRET: Bob's pay rises to 41/h" }] };
  const { brief } = scopeBrief({ audience: "floor", record, sections: [] }, positions);
  assert.deepEqual(Object.keys(brief.record), RECORD_FIELDS);
  assert.deepEqual(brief.record, { id: "doc-1", title: "Shift notes", description: "the handover", home: "floor", recorded_at: null }, "and the day it was put on record (I-57), here none");
  assert.doesNotMatch(JSON.stringify(brief), /SECRET/);
  // the sender's last check refuses one built by hand
  const bare = { audience: "floor", record, sections: [], classes: [], instances: [], sources: [] };
  assert.throws(() => assertBrief(bare, positions), /record\.sections: a brief holds the record's title and description only/);
  assert.throws(() => assertBrief({ ...bare, record: { title: "No home" } }, positions), /record: the record's title is above the audience/, "no home is the root");
});
