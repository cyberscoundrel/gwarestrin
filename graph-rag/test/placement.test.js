import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFloor, AWAITING, floorLifts, place } from "../src/placement.js";
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
const sure = (home, extra = {}) => ({ home, confidence: 0.9, reason: "r", until: null, ...extra });

test("a graded entry lands where the grader put it, at or above its origin", () => {
  assert.deepEqual(place(map, { origin: "floor", verdict: sure("floor"), floor: "floor" }), { home: "floor", note: "graded: r" });
  assert.equal(place(map, { origin: "floor", verdict: sure("ops"), floor: "floor" }).home, "ops");
});

test("an unreached grader holds a new entry one level up, marked to be graded again, with no proposal", () => {
  const p = place(map, { origin: "floor", graded: false, floor: "floor" });
  assert.deepEqual(p, { home: "ops", note: AWAITING, ungraded: true });
  assert.equal(p.review, undefined, "nobody is asked to move it back: the regrade does");
});

test("an unusable answer is still a person's review (unsure, not unreached)", () => {
  const p = place(map, { origin: "floor", verdict: null, floor: "floor" });
  assert.equal(p.home, "ops");
  assert.equal(p.ungraded, undefined);
  assert.equal(p.review.to, "floor");
});

test("an update while the grader is out leaves the entry where it is", () => {
  assert.equal(place(map, { origin: "floor", graded: false, existing: "floor", floor: "floor" }).home, "floor");
});

test("an entry still awaiting grading is graded like a new one when the grader answers", () => {
  // held at ops; a later write is graded: back to its origin
  assert.equal(place(map, { origin: "floor", verdict: sure("floor"), existing: "ops", awaiting: true, floor: "floor" }).home, "floor");
  // not awaiting: an update never widens
  assert.equal(place(map, { origin: "floor", verdict: sure("floor"), existing: "ops", floor: "floor" }).home, "ops");
});

test("the derived-data floor bounds every placement, the held one included", () => {
  const p = place(map, { origin: "floor", verdict: sure("floor", { release: undefined }), floor: "org" });
  assert.equal(p.home, "org");
  assert.match(p.note, /built from what its writer read/);
  const held = place(map, { origin: "floor", graded: false, floor: "org" });
  assert.equal(held.home, "org");
  assert.equal(held.ungraded, true, "still graded again later (the floor still bounds it then)");
  // nothing proposed below the floor
  assert.equal(applyFloor(map, { home: "ops", note: "n", review: { to: "floor" } }, "floor", "ops").review, undefined);
});

test("a floor lifts a write only when it's above where the entry lives", () => {
  assert.equal(floorLifts(map, "floor", "ops"), true);
  assert.equal(floorLifts(map, "ops", "ops"), false);
  assert.equal(floorLifts(map, "ops", "floor"), false);
  assert.equal(floorLifts(map, EVERYONE, "org"), false);
  assert.equal(floorLifts(map, "floor", undefined), false);
});
