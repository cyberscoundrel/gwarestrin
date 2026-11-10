// The record path's pure parts (documents.js): a condensed document laid out as a stored text with one span
// per section, read back as the same sections; what the ingest tool receives recognized as a record or a
// manual; and the document made ready with the identity's defaults and the contract's validation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, parseRecordText, prepareRecord, renderRecord, sectionChunks } from "../src/documents.js";

const NOW = "2026-11-08T09:00:00.000Z";

/** what a chat agent condenses from an on-record thread: three sections */
const handover = () => ({
  title: "Thursday handover, 8 Nov",
  description: "Bob's shift, condensed from the on-record thread",
  recorded_by: "bob",
  position: "floor",
  reason: "end-of-shift handover",
  recorded_at: NOW,
  sections: [
    {
      heading: "Job 4471",
      text: "Job 4471 for Toro is running on CNC 2. Quantity went up to 120.",
    },
    {
      heading: "Toro quote",
      text: "The Toro reorder is quoted at 48 a piece.",
    },
    {
      text: "Tomas was late twice this week; nothing to record about it yet.",
    },
  ],
});

test("a condensed document renders to one text with a span per section, and the spans read back as the sections", () => {
  const doc = prepareRecord(handover(), {});
  const { text, spans } = renderRecord(doc);
  assert.equal(spans.length, 3);
  assert.deepEqual(spans.map((s) => s.index), [0, 1, 2]);
  const back = sectionChunks(text, spans);
  assert.equal(back.length, 3);
  assert.equal(back[0].heading, "Job 4471");
  assert.match(back[0].text, /^Job 4471 for Toro/, "a section's stored text is the section text alone, as a manual's is: the heading is its own property");
  assert.equal(back[0].text, doc.sections[0].text);
  assert.match(back[0].embedText, /^Job 4471\nJob 4471 for Toro/, "the heading leads the embedding");
  assert.match(text, /^## Job 4471\n\nJob 4471 for Toro/, "the document's own text keeps the heading line for a reader");
  assert.equal(back[2].heading, "");
  assert.match(back[2].text, /^Tomas was late/);
  assert.match(back[1].embedText, /^Toro quote\n…Job 4471 for Toro/, "a section's embedding leads with its heading, then the tail of the one before");
  for (let i = 1; i < back.length; i++) assert.ok(back[i].start >= back[i - 1].end, "spans don't overlap");
  // the chunker would not have kept three short sections apart: the spans are what makes a section a section
  assert.notEqual(chunk(text).length, 3);
});

test("the ingest tool's text is a record when it is the document as JSON, else a manual", () => {
  assert.equal(parseRecordText("# Mill 1 manual\n\nGrease every 500 hours."), null);
  assert.equal(parseRecordText('{"title": "not a document"}'), null, "an object without sections isn't a record");
  assert.equal(parseRecordText("{not json"), null);
  assert.equal(parseRecordText(JSON.stringify(handover())).sections.length, 3);
});

test("the tool call's title and the identity fill what the condenser left out; the result is the contract's shape", () => {
  const raw = handover();
  delete raw.title;
  delete raw.recorded_by;
  delete raw.position;
  const doc = prepareRecord(raw, { title: "Handover (from the tool call)", recorded_by: "bob", position: "floor", now: NOW });
  assert.equal(doc.title, "Handover (from the tool call)");
  assert.equal(doc.recorded_by, "bob");
  assert.equal(doc.position, "floor");
  assert.equal(doc.on_record, true);
  assert.equal(doc.recorded_at, NOW);
  assert.deepEqual(Object.keys(doc.sections[0]).sort(), ["heading", "index", "text"], "a section is text (R2)");
  // the document's own values win over the call's
  assert.equal(prepareRecord(handover(), { title: "ignored", recorded_by: "alice" }).recorded_by, "bob");
});

test("what the contract refuses names its field: a record needs its reason, and a section is text", () => {
  const noReason = handover();
  delete noReason.reason;
  assert.throws(() => prepareRecord(noReason, {}), /reason: needs why it is on record/);
  const withClaims = handover();
  withClaims.sections[0].claims = [];
  assert.throws(() => prepareRecord(withClaims, {}), /sections\[0\]\.claims/);
});
