// The record path's pure parts (documents.js): a condensed document laid out as a stored text with one span
// per section, read back as the same sections; what the ingest tool receives recognized as a record or a
// manual; and the document made ready with the identity's defaults and the contract's validation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chunk, parseRecordText, prepareRecord, renderRecord, sectionChunks } from "../src/documents.js";

const classes = JSON.parse(readFileSync(new URL("./fixtures/classes.json", import.meta.url), "utf8"));
const NOW = "2026-11-08T09:00:00.000Z";

/** what a chat agent condenses from an on-record thread: three sections, three sensitivities */
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
      claims: [
        { kind: "state", subject: "mssql:dbo_Job:4471", class: "jobs", attribute: "stage", value: "running" },
        { kind: "state", subject: "mssql:dbo_Job:4471", class: "jobs", attribute: "quantity", value: 120 },
      ],
    },
    {
      heading: "Toro quote",
      text: "The Toro reorder is quoted at 48 a piece.",
      claims: [{ kind: "commitment", subject: { name: "Toro reorder", class: "orders" }, attribute: "price", value: "48 a piece" }],
    },
    {
      text: "Tomas was late twice this week; nothing to record about it yet.",
      claims: [],
    },
  ],
});

test("a condensed document renders to one text with a span per section, and the spans read back as the sections", () => {
  const doc = prepareRecord(handover(), { classes });
  const { text, spans } = renderRecord(doc);
  assert.equal(spans.length, 3);
  assert.deepEqual(spans.map((s) => s.index), [0, 1, 2]);
  const back = sectionChunks(text, spans);
  assert.equal(back.length, 3);
  assert.match(back[0].text, /^## Job 4471\n\nJob 4471 for Toro/);
  assert.equal(back[2].heading, "");
  assert.match(back[2].text, /^Tomas was late/);
  assert.match(back[1].embedText, /^…/, "a section's embedding carries the tail of the one before");
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
  const doc = prepareRecord(raw, { title: "Handover (from the tool call)", recorded_by: "bob", position: "floor", classes, now: NOW });
  assert.equal(doc.title, "Handover (from the tool call)");
  assert.equal(doc.recorded_by, "bob");
  assert.equal(doc.position, "floor");
  assert.equal(doc.on_record, true);
  assert.equal(doc.sections[0].claims[1].value_num, 120);
  assert.equal(doc.sections[0].claims[0].valid_from, NOW, "no dates: valid from the recording, open-ended");
  assert.equal(doc.sections[0].claims[0].valid_until, null);
  assert.equal(doc.sections[2].claims.length, 0, "a section with no claims is still a section");
  // the document's own values win over the call's
  assert.equal(prepareRecord(handover(), { title: "ignored", recorded_by: "alice", classes }).recorded_by, "bob");
});

test("every problem is reported at once, by field, and nothing passes with an unconfirmed class", () => {
  const raw = handover();
  raw.sections[0].claims[0].value = "flying"; // not a stage of jobs
  raw.sections[1].claims[0].class = "quotes"; // not confirmed
  raw.sections[1].claims[0].subject = { name: "Toro reorder" };
  const err = (() => {
    try {
      prepareRecord(raw, { classes });
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err, "throws");
  assert.match(err.message, /2 problems/);
  assert.deepEqual(
    err.errors.map((e) => e.field),
    ["sections[0].claims[0].value", "sections[1].claims[0].subject.class"],
  );
  assert.match(err.errors[1].message, /not a confirmed class: quotes/);
  // without a confirmed set (none in the graph yet) the class name passes and stages go unchecked
  assert.equal(prepareRecord(raw, {}).sections[1].claims[0].class, "quotes");
  // a record needs its reason: it is on record under the person's authority
  const noReason = handover();
  delete noReason.reason;
  assert.throws(() => prepareRecord(noReason, { classes }), /reason: needs why it is on record/);
});
