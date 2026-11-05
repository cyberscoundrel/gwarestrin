import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ClaimError,
  claimsOf,
  closeIntervals,
  inForce,
  isoDate,
  normalizeAttribute,
  normalizeClaim,
  normalizeDocument,
  overlaps,
  stateOf,
  subjectId,
  validateDocument,
} from "../src/model/claims.js";

const classes = JSON.parse(readFileSync(new URL("./fixtures/classes.json", import.meta.url), "utf8"));
const NOW = "2026-11-04T14:00:00.000Z";

/** a shift handover the floor agent condensed and bob put on record */
const handover = () => ({
  title: "Shift handover, 4 Nov",
  description: "Bob's afternoon shift, condensed from the on-record thread",
  recorded_by: "bob",
  position: "floor",
  reason: "end-of-shift handover",
  recorded_at: NOW,
  sections: [
    {
      heading: "Job 4471",
      text: "Job 4471 for Toro is running on CNC 2; Tomas covers the night shift. Quantity went up to 120.",
      claims: [
        { kind: "state", subject: { key: "mssql:dbo_Job:4471", class: "jobs" }, attribute: "stage", value: "running" },
        { kind: "state", subject: { key: "mssql:dbo_Job:4471", class: "jobs" }, attribute: "Machine", value: "CNC 2" },
        { kind: "commitment", subject: { key: "mssql:dbo_Job:4471", class: "jobs" }, attribute: "shift_cover", value: "Tomas, night shift", valid_from: "2026-11-04", valid_until: "2026-11-05" },
        { kind: "state", subject: { key: "mssql:dbo_Job:4471", class: "jobs" }, attribute: "quantity", value: 120 },
      ],
    },
    {
      heading: "Blades",
      text: "The saw blades from Hallen arrived at 10:40.",
      claims: [{ kind: "event", subject: { name: "Hallen", actor: "supplier" }, class: "maintenance", attribute: "parts", value: "saw blades arrived", at: "2026-11-04T10:40:00Z" }],
    },
  ],
});

test("a condensed document normalizes: on record, sections indexed, claims carrying the document's record", () => {
  const doc = normalizeDocument(handover(), { classes });
  assert.equal(doc.on_record, true);
  assert.equal(doc.recorded_by, "bob");
  assert.equal(doc.position, "floor");
  assert.equal(doc.sections.length, 2);
  assert.deepEqual(doc.sections.map((s) => s.index), [0, 1]);
  const claims = claimsOf(doc);
  assert.equal(claims.length, 5);
  assert.deepEqual(claims[0].subject, { key: "mssql:dbo_Job:4471", name: null, class: "jobs", actor: null });
  assert.equal(claims[0].class, "jobs");
  assert.equal(claims[0].recorded_by, "bob");
  assert.equal(claims[0].recorded_at, NOW);
  assert.equal(claims[1].attribute, "machine", "attributes are snake_case");
  assert.equal(claims[3].value, "120");
  assert.equal(claims[3].value_num, 120);
  assert.equal(claims[4].section, 1);
  assert.deepEqual(claims[4].subject, { key: null, name: "Hallen", class: null, actor: "supplier" });
});

test("decision 3: no dates means valid from recorded_at, open-ended; an event is a point", () => {
  const [stage, , cover, , arrived] = claimsOf(normalizeDocument(handover(), { classes }));
  assert.equal(stage.valid_from, NOW);
  assert.equal(stage.valid_until, null);
  assert.equal(cover.valid_from, "2026-11-04T00:00:00.000Z");
  assert.equal(cover.valid_until, "2026-11-05T00:00:00.000Z");
  assert.equal(arrived.valid_from, "2026-11-04T10:40:00.000Z");
  assert.equal(arrived.valid_until, arrived.valid_from);
});

test("the next claim on the same attribute of the same subject closes the open one", () => {
  const j = { key: "mssql:dbo_Job:4471", class: "jobs" };
  const c = (over) => normalizeClaim({ kind: "state", subject: j, attribute: "stage", value: "planned", ...over }, "c", { classes: new Map(classes.classes.map((x) => [x.name, x])), recordedBy: "bob" });
  const planned = c({ id: "a", recorded_at: "2026-11-01" });
  const running = c({ id: "b", value: "running", recorded_at: "2026-11-04" });
  const other = c({ id: "x", subject: { key: "mssql:dbo_Job:9", class: "jobs" }, recorded_at: "2026-11-02" });
  const machine = c({ id: "m", attribute: "machine", value: "CNC 2", recorded_at: "2026-11-02" });
  const event = normalizeClaim({ kind: "event", subject: j, attribute: "stage", value: "paused", at: "2026-11-03" }, "e", { recordedBy: "bob", recordedAt: NOW });
  // given out of order: closing goes by valid_from, not by position
  const closed = closeIntervals([running, event, other, planned, machine]);
  const by = Object.fromEntries(closed.filter((x) => x.id).map((x) => [x.id, x]));
  assert.equal(by.a.valid_until, "2026-11-04T00:00:00.000Z");
  assert.equal(by.a.closed_by, "b");
  assert.equal(by.b.valid_until, null, "the latest stays open");
  assert.equal(by.x.valid_until, null, "another job's stage is another attribute line");
  assert.equal(by.m.valid_until, null, "another attribute of the same job is untouched");
  assert.equal(closed[1].valid_until, closed[1].valid_from, "an event neither closes nor is closed");
  assert.equal(planned.valid_until, null, "inputs are not mutated");
  // two claims starting at the same instant both stay open until a later one closes them
  const twin = closeIntervals([c({ id: "p", recorded_at: "2026-11-02" }), c({ id: "q", value: "paused", recorded_at: "2026-11-02" }), running]);
  assert.deepEqual(twin.map((x) => [x.id, x.valid_until]), [["p", "2026-11-04T00:00:00.000Z"], ["q", "2026-11-04T00:00:00.000Z"], ["b", null]]);
  // an explicit end is kept even when a later claim arrives earlier than it
  const dated = c({ id: "d", recorded_at: "2026-10-01", valid_until: "2026-12-31" });
  assert.equal(closeIntervals([dated, running]).find((x) => x.id === "d").valid_until, "2026-12-31T00:00:00.000Z");
});

test("state as of a date comes from the claims in force; overlaps with different values are contradictions", () => {
  const j = { key: "mssql:dbo_Job:4471", class: "jobs" };
  const idx = new Map(classes.classes.map((x) => [x.name, x]));
  const c = (over) => normalizeClaim({ kind: "state", subject: j, attribute: "stage", value: "planned", ...over }, "c", { classes: idx, recordedBy: "bob" });
  const all = closeIntervals([c({ id: "a", recorded_at: "2026-11-01" }), c({ id: "b", value: "running", recorded_at: "2026-11-04" }), c({ id: "m", attribute: "machine", value: "CNC 2", recorded_at: "2026-11-02" })]);
  assert.deepEqual(Object.fromEntries(Object.entries(stateOf(all, j, "2026-11-02T12:00:00Z")).map(([k, v]) => [k, v.value])), { stage: "planned", machine: "CNC 2" });
  assert.equal(stateOf(all, j, "2026-11-05").stage.value, "running");
  assert.deepEqual(stateOf(all, j, "2026-10-01"), {});
  assert.equal(inForce(all, "2026-11-04T00:00:00Z").find((x) => x.id === "a"), undefined, "closed at the instant the next one starts");
  assert.deepEqual(overlaps(all), [], "superseded is not contradicted");
  // two people record different machines for the same job on the same day: a contradiction
  const clash = [c({ id: "p", attribute: "machine", value: "CNC 2", recorded_at: "2026-11-02" }), c({ id: "q", attribute: "machine", value: "CNC 3", recorded_at: "2026-11-02", recorded_by: "alice" })];
  assert.deepEqual(overlaps(closeIntervals(clash)).map(([a, b]) => [a.id, b.id]), [["p", "q"]]);
  assert.deepEqual(overlaps(closeIntervals([clash[0], { ...clash[1], value: "CNC 2" }])), [], "the same value twice is agreement");
});

test("errors name the field", () => {
  const bad = (patch, field, re) => {
    const raw = handover();
    patch(raw);
    assert.throws(() => normalizeDocument(raw, { classes }), (e) => e instanceof ClaimError && e.field === field && re.test(e.reason), `${field}: ${re}`);
  };
  bad((d) => delete d.recorded_by, "recorded_by", /person/);
  bad((d) => (d.reason = ""), "reason", /why/);
  bad((d) => (d.recorded_at = "yesterday"), "recorded_at", /not a date/);
  bad((d) => (d.sections = []), "sections", /at least one/);
  bad((d) => (d.sections[1].text = " "), "sections[1].text", /text/);
  bad((d) => (d.sections[0].claims[0].kind = "decision"), "sections[0].claims[0].kind", /commitment, event, state, observation/);
  bad((d) => (d.sections[0].claims[0].subject = { key: "Job 4471", class: "jobs" }), "sections[0].claims[0].subject.key", /system:table:row/);
  bad((d) => (d.sections[0].claims[0].subject = { class: "jobs" }), "sections[0].claims[0].subject", /key or a name/);
  bad((d) => (d.sections[0].claims[0].subject = { name: "Job 4471" }), "sections[0].claims[0].subject", /class .* or actor/);
  bad((d) => (d.sections[0].claims[0].subject = { name: "Job 4471", class: "jobs", actor: "person" }), "sections[0].claims[0].subject", /exactly one/);
  bad((d) => (d.sections[0].claims[0].subject.class = "schedules"), "sections[0].claims[0].subject.class", /not a confirmed class/);
  bad((d) => (d.sections[0].claims[0].class = "orders"), "sections[0].claims[0].class", /differs from the subject/);
  bad((d) => delete d.sections[1].claims[0].class, "sections[1].claims[0].class", /actor must name the commitment class/);
  bad((d) => (d.sections[1].claims[0].subject.actor = "robot"), "sections[1].claims[0].subject.actor", /person, position/);
  bad((d) => (d.sections[0].claims[0].attribute = "??"), "sections[0].claims[0].attribute", /attribute/);
  bad((d) => (d.sections[0].claims[0].value = "shipped"), "sections[0].claims[0].value", /not a stage of jobs/);
  bad((d) => (d.sections[0].claims[3].value = {}), "sections[0].claims[3].value", /string, number or boolean/);
  bad((d) => (d.sections[0].claims[2].valid_until = "2026-11-03"), "sections[0].claims[2].valid_until", /ends .* before it starts/);
  bad((d) => (d.sections[0].claims[2].valid_from = "next week"), "sections[0].claims[2].valid_from", /not a date/);
  bad((d) => (d.sections[1].claims[0].valid_until = "2026-11-06"), "sections[1].claims[0].valid_until", /point in time/);
});

test("validateDocument reports every claim's problem at once; a sound document has none", () => {
  const raw = handover();
  raw.sections[0].claims[0].value = "shipped";
  raw.sections[0].claims[3].value = null;
  raw.sections[1].claims[0].subject = { actor: "supplier" };
  const { document, errors } = validateDocument(raw, { classes });
  assert.equal(document, null);
  assert.deepEqual(errors.map((e) => e.field), ["sections[0].claims[0].value", "sections[0].claims[3].value", "sections[1].claims[0].subject"]);
  assert.deepEqual(validateDocument(handover(), { classes }).errors, []);
  assert.equal(validateDocument({ title: "x" }, { classes }).errors[0].field, "recorded_by");
});

test("without a class set any class name passes (a stream that has not loaded them); stages are then unchecked", () => {
  const raw = handover();
  raw.sections[0].claims[0].subject.class = "schedules";
  raw.sections[0].claims[0].value = "whatever";
  assert.equal(claimsOf(normalizeDocument(raw)).length, 5);
});

test("small helpers: dates, attribute names, subject identity", () => {
  assert.equal(isoDate("2026-11-04"), "2026-11-04T00:00:00.000Z");
  assert.equal(isoDate("2026-11-04T10:40:00Z"), "2026-11-04T10:40:00.000Z");
  assert.equal(isoDate("2026-11-04 10:40"), "2026-11-04T10:40:00.000Z");
  assert.equal(isoDate("4 Nov"), null);
  assert.equal(isoDate(""), null);
  assert.equal(normalizeAttribute("Credit limit"), "credit_limit");
  assert.equal(normalizeAttribute("dueDate"), "due_date");
  assert.equal(normalizeAttribute("shift-cover "), "shift_cover");
  assert.equal(subjectId({ key: "mssql:dbo_Job:4471", name: "Job 4471", class: "jobs" }), "key|mssql:dbo_Job:4471");
  assert.equal(subjectId({ key: null, name: "Toro Co.", actor: "customer" }), "customer|toro co");
  assert.equal(subjectId({ key: null, name: "TORO CO", actor: "customer" }), "customer|toro co", "a key beats a name; names match loosely");
});
