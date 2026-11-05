// The sixty-note oracle (docs/ORGANIZATION-MODEL.md, "The contract", item 1;
// test/fixtures/ORACLE.md on branch claude/oracle-sixty-08d9a5) run through
// the claim validator: every expected claim of every note must normalize.
//
// The oracle's shape is the contract's with three notations of its own,
// mapped here and nowhere else: `writer` and `origin_position` stand for
// recorded_by and the position; a subject "X (class)" is the class itself
// (the contract's `scope: "class"`); `authority` names floor | Ops |
// admins-only (the fixture tree's floor | ops | org). Its class names are
// discovery output, not the confirmed set in classes.json, so the gate on
// confirmed classes is off here and reported instead.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { authorityOf, decide, validatePolicy } from "../src/model/authority.js";
import { ClaimError, classIndex, closeIntervals, normalizeClaim, overlaps } from "../src/model/claims.js";
import { parsePositionMap } from "../src/positions.js";

const ORACLE = new URL("./fixtures/oracle-sixty.json", import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const skip = !existsSync(ORACLE) && `no oracle fixture yet at ${ORACLE.pathname}`;

const POSITION = { floor: "floor", Ops: "ops", "admins-only": "org", org: "org" };
/** one oracle claim in the contract's shape */
function adapt(c) {
  const m = typeof c.subject === "string" ? /^(.*)\s\(class\)$/.exec(c.subject) : null;
  const { authority: _authority, ...claim } = c;
  return m ? { ...claim, subject: { scope: "class", name: m[1] } } : claim;
}
const load = () => {
  const notes = JSON.parse(readFileSync(ORACLE, "utf8"));
  return Array.isArray(notes) ? notes : notes.notes;
};

test("every oracle claim validates as a claim", { skip }, (t) => {
  const notes = load();
  assert.ok(notes.length >= 60, "the oracle holds at least the sixty");
  let total = 0;
  const byCause = new Map();
  for (const [n, note] of notes.entries()) {
    for (const [j, c] of (note.claims ?? []).entries()) {
      total++;
      try {
        normalizeClaim(adapt(c), `${note.id}.claims[${j}]`, { recordedAt: note.recorded_at ?? "2026-11-04T12:00:00Z", recordedBy: note.writer, section: n });
      } catch (e) {
        if (!(e instanceof ClaimError)) throw e;
        const cause = `${e.field.replace(/^.*?\.claims\[\d+\]\.?/, "claim.") || "claim"}: ${e.reason.replace(/:.*$/, "")}`;
        if (!byCause.has(cause)) byCause.set(cause, []);
        byCause.get(cause).push(`${note.id}[${j}]`);
      }
    }
  }
  const failed = [...byCause.values()].reduce((a, l) => a + l.length, 0);
  t.diagnostic(`oracle: ${notes.length} notes, ${total} claims, ${failed} fail validation`);
  for (const [cause, ids] of byCause) t.diagnostic(`${ids.length} ${cause}: ${ids.join(", ")}`);
  assert.ok(total >= 95, "the oracle carries at least its first 95 claims");
  assert.equal(failed, 0, `${failed} of ${total} oracle claims fail validation: ${[...byCause.keys()].join("; ")}`);
});

test("the oracle's classes are discovery output: reported against the confirmed set, never gated", { skip }, (t) => {
  const confirmed = classIndex(read("classes.json"));
  const names = new Map();
  for (const note of load()) for (const c of note.claims ?? []) names.set(c.class, (names.get(c.class) ?? 0) + 1);
  const known = [...names.keys()].filter((c) => confirmed.has(c));
  t.diagnostic(`${names.size} distinct class names over the oracle's claims; ${known.length} in classes.json (${known.join(", ") || "none"})`);
  assert.ok(names.size > 0);
});

test("the oracle's intervals close and contradict as the design says", { skip }, (t) => {
  const notes = load();
  const claims = closeIntervals(
    notes.flatMap((note, n) => (note.claims ?? []).map((c, j) => normalizeClaim({ ...adapt(c), id: `${note.id}[${j}]` }, note.id, { recordedAt: note.recorded_at ?? "2026-11-04T12:00:00Z", recordedBy: note.writer, section: n }))),
  );
  const closed = claims.filter((c) => c.closed_by);
  const clashes = overlaps(claims);
  t.diagnostic(`${closed.length} claims closed by a later one; ${clashes.length} overlapping pairs with different values`);
  for (const [a, b] of clashes) t.diagnostic(`  ${a.id} vs ${b.id} (${a.attribute}): "${a.value}" / "${b.value}"`);
  assert.ok(claims.length >= 95);
});

test("the oracle's authority column against the policy fixture, where the policy has a rule", { skip }, (t) => {
  const map = parsePositionMap(read("positions.json"));
  const policy = validatePolicy(read("policy.json"), map);
  let ruled = 0;
  let agree = 0;
  const differ = [];
  for (const note of load()) {
    for (const [j, c] of (note.claims ?? []).entries()) {
      const a = authorityOf(policy, c.class, c.attribute);
      if (!a) continue;
      ruled++;
      if (a === POSITION[c.authority]) agree++;
      else differ.push(`${note.id}[${j}] ${c.class}/${c.attribute}: oracle ${c.authority}, policy ${a}`);
      // the writer's own standing toward the claim is never "hidden": provenance never fails
      const writer = { positions: [POSITION[note.origin_position]], caps: { write: "direct" } };
      assert.notEqual(decide(writer, c.class, c.attribute, policy, map), "hidden", `${note.id}[${j}]`);
    }
  }
  t.diagnostic(`policy rules cover ${ruled} of the oracle's claims by attribute; ${agree} agree with the oracle's authority`);
  for (const d of differ) t.diagnostic(`  ${d}`);
});
