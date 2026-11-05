// The sixty-note oracle (docs/ORGANIZATION-MODEL.md, "The contract", item 1)
// run through the claim validator: every expected claim of every note must
// normalize. The fixture is produced by its own session; until it lands at
// the path below this test is skipped, not failed.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ClaimError, classIndex, normalizeClaim } from "../src/model/claims.js";

const ORACLE = new URL("./fixtures/oracle-sixty.json", import.meta.url);
const classes = classIndex(JSON.parse(readFileSync(new URL("./fixtures/classes.json", import.meta.url), "utf8")));

/** the notes, whatever the fixture's top-level shape */
const notesOf = (doc) => (Array.isArray(doc) ? doc : doc?.notes ?? doc?.oracle ?? []);
/** a note's expected claims, under whichever name */
const claimsOf = (note) => note?.claims ?? note?.expected_claims ?? note?.expected?.claims ?? [];

test("every oracle claim validates as a claim", { skip: !existsSync(ORACLE) && `no oracle fixture yet at ${ORACLE.pathname}` }, (t) => {
  const notes = notesOf(JSON.parse(readFileSync(ORACLE, "utf8")));
  assert.ok(notes.length > 0, "the oracle holds notes");
  let total = 0;
  const failures = [];
  notes.forEach((note, n) => {
    const recordedAt = note.recorded_at ?? note.written_at ?? note.at ?? "2026-11-04T00:00:00Z";
    const recordedBy = note.recorded_by ?? note.written_by ?? note.author ?? "oracle";
    claimsOf(note).forEach((c, j) => {
      total++;
      try {
        // the oracle's classes are the confirmed set; a note the primitives don't fit has no claims
        normalizeClaim(c, `notes[${n}].claims[${j}]`, { classes, recordedAt, recordedBy, section: 0 });
      } catch (e) {
        if (!(e instanceof ClaimError)) throw e;
        failures.push(`${note.id ?? n}: ${e.message}`);
      }
    });
  });
  t.diagnostic(`oracle: ${notes.length} notes, ${total} claims, ${failures.length} fail validation`);
  for (const f of failures.slice(0, 60)) t.diagnostic(f);
  assert.ok(total > 0, "the oracle's notes carry claims under `claims`, `expected_claims` or `expected.claims`");
  assert.equal(failures.length, 0, `${failures.length} of ${total} oracle claims fail validation (see diagnostics)`);
});
