// Placement: the check's verdict (check.js), restrict-only, the derived-data floor, and no answer meaning
// admin-only until checked (R4, R11.11, R11.13). Verdicts here are fixed inputs: the tests assert what code does
// with them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFloor, floorLifts, place } from "../src/placement.js";
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

test("an update with no answer leaves the entry where it is", () => {
  assert.equal(place(map, { origin: "floor", verdict: undefined, existing: "floor", floor: "floor" }).home, "floor");
});

test("an update never widens, and only a sure verdict restricts it further", () => {
  assert.equal(place(map, { origin: "floor", verdict: sure("floor"), existing: "ops", floor: "floor" }).home, "ops");
  assert.equal(place(map, { origin: "floor", verdict: sure("org"), existing: "ops", floor: "floor" }).home, "org");
  assert.equal(place(map, { origin: "floor", verdict: unsure("org"), existing: "ops", floor: "floor" }).home, "ops");
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
