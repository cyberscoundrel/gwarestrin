import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDocument, RecordError, validateDocument } from "../src/model/record.js";

const doc = { title: "Shift notes", recorded_by: "bob", position: "floor", reason: "handover", recorded_at: "2026-11-09T07:00:00Z", sections: [{ heading: "CNC", text: "Job 4471 moved to CNC 5." }] };

test("a record is a document and its sections, as text (R2)", () => {
  const d = normalizeDocument(doc);
  assert.equal(d.on_record, true);
  assert.equal(d.position, "floor", "where its sections start (R11)");
  assert.deepEqual(d.sections, [{ index: 0, heading: "CNC", text: "Job 4471 moved to CNC 5." }]);
});

test("claims are gone: a section carrying them is refused, naming the field", () => {
  assert.throws(() => normalizeDocument({ ...doc, sections: [{ text: "x", claims: [] }] }), (e) => e instanceof RecordError && e.field === "sections[0].claims");
});

test("errors name their field", () => {
  for (const [k, field] of [["title", "title"], ["recorded_by", "recorded_by"], ["position", "position"], ["reason", "reason"]]) {
    const { [k]: _gone, ...rest } = doc;
    assert.deepEqual(validateDocument(rest).errors.map((e) => e.field), [field]);
  }
  assert.deepEqual(validateDocument({ ...doc, sections: [{ text: " " }] }).errors.map((e) => e.field), ["sections[0].text"]);
  assert.equal(validateDocument(doc).document.title, "Shift notes");
});
