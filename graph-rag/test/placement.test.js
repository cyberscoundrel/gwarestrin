// Placement: the check's verdict (check.js), restrict-only, the derived-data floor, and no answer meaning
// admin-only until checked (R4, R11.11, R11.13). Verdicts here are fixed inputs: the tests assert what code does
// with them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFloor, floorLifts, place, placeOverWaiting } from "../src/placement.js";
import { UNCHECKED } from "../src/check.js";
import { EVERYONE, parsePositionMap } from "../src/positions.js";

//        org
//         └ ops (Operations)
//            └ floor (Production floor)
const map = parsePositionMap({
  root: "org",
  positions: {
    org: { name: "org", description: "The whole organization" },
    ops: { name: "Operations", parent: "org", description: "orders, suppliers, staffing" },
    floor: { name: "Production floor", parent: "ops", description: "work orders, machines" },
  },
});
const sure = (home) => ({ home, sure: true, confidence: 0.9, category: home === "floor" ? null : "pay and compensation", reason: "r" });
const unsure = (home) => ({ home, sure: false, confidence: 0.4, category: null, reason: "r" });

test("a checked entry lands where the check put it, at or above its origin", () => {
  assert.deepEqual(place(map, { origin: "floor", verdict: sure("floor"), floor: "floor" }), { home: "floor", note: "checked: r" });
  assert.equal(place(map, { origin: "floor", verdict: sure("org"), floor: "floor" }).home, "org");
});

test("no answer holds a new entry admin-only, marked to be checked again, with no proposal", () => {
  const p = place(map, { origin: "floor", verdict: undefined, floor: "floor" });
  assert.deepEqual(p, { home: "org", note: UNCHECKED, ungraded: true });
  assert.equal(p.review, undefined, "nobody is asked to move it back: the recheck does");
});

test("an unsure answer is held one level higher and flagged for a person", () => {
  const p = place(map, { origin: "floor", verdict: unsure("ops"), floor: "floor" });
  assert.equal(p.home, "ops");
  assert.equal(p.ungraded, undefined);
  assert.equal(p.review.to, "floor");
});

test("an update with no answer is admin-only until checked, and its recheck never goes below where it was (R11.11)", () => {
  const p = place(map, { origin: "floor", verdict: undefined, existing: "ops", floor: "floor" });
  assert.equal(p.home, "org");
  assert.equal(p.ungraded, true);
  assert.equal(p.keep, "ops");
});

test("an update never widens; a sure verdict restricts it further, an unsure one holds it higher and flags it", () => {
  assert.equal(place(map, { origin: "floor", verdict: sure("floor"), existing: "ops", floor: "floor" }).home, "ops");
  assert.equal(place(map, { origin: "floor", verdict: sure("org"), existing: "ops", floor: "floor" }).home, "org");
  const p = place(map, { origin: "floor", verdict: unsure("ops"), existing: "floor", floor: "floor" });
  assert.equal(p.home, "ops");
  assert.equal(p.review.to, "floor");
});

test("the derived-data floor bounds every placement, the unchecked one included", () => {
  const p = place(map, { origin: "floor", verdict: sure("floor"), floor: "ops" });
  assert.equal(p.home, "ops");
  assert.match(p.note, /built from what its writer read/);
  const held = place(map, { origin: "floor", verdict: undefined, floor: "ops" });
  assert.equal(held.home, "org", "admin-only is above any floor");
  assert.equal(held.ungraded, true);
  // nothing proposed below the floor
  assert.equal(applyFloor(map, { home: "ops", note: "n", review: { to: "floor" } }, "floor", "ops").review, undefined);
  assert.equal(place(map, { origin: "floor", verdict: unsure("ops"), floor: "ops" }).review, undefined);
});

test("a floor lifts a write only when it's above where the entry lives", () => {
  assert.equal(floorLifts(map, "floor", "ops"), true);
  assert.equal(floorLifts(map, "ops", "ops"), false);
  assert.equal(floorLifts(map, "ops", "floor"), false);
  assert.equal(floorLifts(map, EVERYONE, "org"), false);
  assert.equal(floorLifts(map, "floor", undefined), false);
});

test("new text over an entry still waiting for its check: with no answer it waits on, its marker carrying what bounded it", () => {
  const p = placeOverWaiting(map, { origin: "floor", verdict: undefined, held: "org", marker: { keep: "ops", rule: "ops", raised: "raised by e2e_k" }, floor: "floor" });
  assert.equal(p.home, "org");
  assert.equal(p.ungraded, true, "a fresh marker is written, with this write's text");
  assert.equal(p.keep, "ops");
  assert.deepEqual(p.carry, { rule: "ops", raised: "raised by e2e_k" });
});

test("new text over a waiting entry with an answer: placed from where it was before it waited, never below the rule", () => {
  assert.equal(placeOverWaiting(map, { origin: "floor", verdict: sure("org"), held: "org", marker: { keep: "floor" }, floor: "floor" }).home, "org", "a sure category raises it");
  assert.equal(placeOverWaiting(map, { origin: "floor", verdict: sure("floor"), held: "org", marker: { keep: "ops" }, floor: "floor" }).home, "ops", "never below where it was before it waited");
  assert.equal(placeOverWaiting(map, { origin: "floor", verdict: sure("floor"), held: "org", marker: {}, floor: "floor" }).home, "floor", "new from its first write: placed like a new one");
  const ruled = placeOverWaiting(map, { origin: "floor", verdict: sure("floor"), held: "org", marker: { rule: "ops", raised: "raised by e2e_k" }, floor: "floor" });
  assert.equal(ruled.home, "ops", "the class map's rule holds");
  assert.equal(ruled.note, "raised by e2e_k");
  const unsure = placeOverWaiting(map, { origin: "floor", verdict: { home: "ops", sure: false, confidence: 0.4, reason: "r" }, held: "org", marker: { keep: "floor" }, floor: "floor" });
  assert.equal(unsure.home, "ops");
  assert.equal(unsure.review?.to, "floor");
});
