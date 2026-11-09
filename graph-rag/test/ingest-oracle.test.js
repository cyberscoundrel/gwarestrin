// The sixty-note oracle through the ingest path's validation (prepareRecord, what recordDocument runs
// before storing anything): every note's expected claims, as a condensed document of one section, must be
// accepted. The oracle's notations are mapped as oracle.test.js maps them (writer and origin_position stand
// for recorded_by and position; "X (class)" is the class itself; `authority` is the oracle's column, not a
// claim field). Its class names are discovery output, so the gate on confirmed classes is run twice: off
// (as the graph is before Discovery lands), and on against a class set derived from the oracle itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { prepareRecord, renderRecord, sectionChunks } from "../src/documents.js";
import { STAGE_ATTRIBUTE } from "../src/model/schema.js";

const ORACLE = new URL("./fixtures/oracle-sixty.json", import.meta.url);
const notes = (() => {
  const o = JSON.parse(readFileSync(ORACLE, "utf8"));
  return Array.isArray(o) ? o : o.notes;
})();
const RECORDED_AT = "2026-11-04T12:00:00Z";

/** one oracle claim in the contract's shape */
function adapt(c) {
  const m = typeof c.subject === "string" ? /^(.*)\s\(class\)$/.exec(c.subject) : null;
  const { authority: _authority, ...claim } = c;
  return m ? { ...claim, subject: { scope: "class", name: m[1] } } : claim;
}

/** the note as its writer's agent would have condensed it: one section, the note's text, its claims */
const documentOf = (note) => ({
  title: note.title,
  description: `${note.id} from batch ${note.batch}`,
  recorded_by: note.writer,
  position: note.origin_position,
  reason: "oracle note put on record",
  recorded_at: note.recorded_at ?? RECORDED_AT,
  sections: [{ heading: note.title, text: note.text, claims: (note.claims ?? []).map(adapt) }],
});

/** the oracle's own classes as a confirmed set: every class named, with the stages its stage claims use */
function oracleClasses() {
  const byName = new Map();
  for (const note of notes)
    for (const c of note.claims ?? []) {
      const cls = byName.get(c.class) ?? { name: c.class, stages: [], record_table: null, status: "confirmed" };
      if (c.attribute === STAGE_ATTRIBUTE && typeof c.value === "string" && !cls.stages.includes(c.value)) cls.stages.push(c.value);
      byName.set(c.class, cls);
    }
  return [...byName.values()];
}

test("every oracle note's claims are accepted by the ingest path's validation (no confirmed set yet)", (t) => {
  assert.ok(notes.length >= 60, "the oracle holds at least the sixty");
  const failed = [];
  let claims = 0;
  for (const note of notes) {
    try {
      const doc = prepareRecord(documentOf(note), {});
      claims += doc.sections[0].claims.length;
      assert.equal(doc.on_record, true);
      assert.equal(doc.recorded_by, note.writer);
      assert.equal(doc.position, note.origin_position);
    } catch (e) {
      failed.push(`${note.id}: ${e.message.slice(0, 160)}`);
    }
  }
  t.diagnostic(`oracle: ${notes.length} notes, ${claims} claims accepted`);
  assert.ok(claims >= 95, "the oracle carries at least its first 95 claims");
  assert.deepEqual(failed, [], `${failed.length} notes refused:\n${failed.join("\n")}`);
});

test("...and with the gate on, against the oracle's own classes as the confirmed set", (t) => {
  const classes = oracleClasses();
  const failed = [];
  for (const note of notes) {
    try {
      prepareRecord(documentOf(note), { classes });
    } catch (e) {
      failed.push(`${note.id}: ${e.message.slice(0, 160)}`);
    }
  }
  t.diagnostic(`${classes.length} classes derived from the oracle`);
  assert.deepEqual(failed, [], `${failed.length} notes refused with the gate on:\n${failed.join("\n")}`);
});

test("every oracle note stores as one section whose text reads back whole", () => {
  for (const note of notes) {
    const doc = prepareRecord(documentOf(note), {});
    const { text, spans } = renderRecord(doc);
    const back = sectionChunks(text, spans);
    assert.equal(back.length, 1, note.id);
    assert.ok(back[0].text.endsWith(note.text.trim()), `${note.id}: the note's text is the section's`);
  }
});
