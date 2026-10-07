import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ancestors,
  canSee,
  defaultHome,
  effectiveHome,
  moveKind,
  parsePositionMap,
  visibleHomes,
  writableHomes,
} from "../src/positions.js";

//            org
//      ┌──────┴──────┐
//     ops          sales
//   ┌──┴───┐         └── reps
//  floor  eng
const map = parsePositionMap({
  root: "org",
  positions: {
    org: { name: "Organization" },
    ops: { name: "Ops manager", parent: "org" },
    floor: { name: "Production floor", parent: "ops" },
    eng: { name: "Engineering", parent: "ops" },
    sales: { name: "Sales manager", parent: "org" },
    reps: { name: "Sales reps", parent: "sales" },
  },
});

test("root sees everything, positions see themselves and below", () => {
  assert.equal(visibleHomes(map, ["org"]), null);
  assert.deepEqual([...visibleHomes(map, ["ops"])].sort(), ["eng", "floor", "ops"]);
  assert.deepEqual([...visibleHomes(map, ["floor"])], ["floor"]);
  assert.deepEqual([...visibleHomes(map, ["floor", "reps"])].sort(), ["floor", "reps"]);
  assert.deepEqual([...visibleHomes(map, [])], []);
  assert.deepEqual([...visibleHomes(map, ["ghost"])], [], "unknown positions grant nothing");
});

test("the manager's email stays above the floor; siblings don't see each other", () => {
  assert.equal(canSee(map, ["ops"], "ops"), true);
  assert.equal(canSee(map, ["floor"], "ops"), false);
  assert.equal(canSee(map, ["ops"], "floor"), true);
  assert.equal(canSee(map, ["sales"], "eng"), false);
  assert.equal(canSee(map, ["eng"], "floor"), false);
});

test("unhomed and unknown homes count as root (fail upward)", () => {
  assert.equal(effectiveHome(map, undefined), "org");
  assert.equal(effectiveHome(map, "deleted-position"), "org");
  assert.equal(canSee(map, ["ops"], undefined), false);
  assert.equal(canSee(map, ["org"], undefined), true);
});

test("writes default to the deepest held position and may only restrict", () => {
  assert.equal(defaultHome(map, ["ops", "floor"]), "floor");
  assert.equal(defaultHome(map, ["sales", "eng"]), "eng");
  assert.equal(defaultHome(map, []), null);
  assert.deepEqual([...writableHomes(map, ["floor"])].sort(), ["floor", "ops", "org"]);
  assert.equal(writableHomes(map, ["floor"]).has("eng"), false);
});

test("moving up restricts, anything else widens", () => {
  assert.equal(moveKind(map, "floor", "ops"), "restrict");
  assert.equal(moveKind(map, "floor", "org"), "restrict");
  assert.equal(moveKind(map, "ops", "floor"), "widen");
  assert.equal(moveKind(map, "eng", "sales"), "widen");
  assert.equal(moveKind(map, undefined, "ops"), "widen", "releasing legacy root data is a widening");
});

test("ancestors and a broken tree", () => {
  assert.deepEqual(ancestors(map, "floor"), ["ops", "org"]);
  assert.throws(() => parsePositionMap({ root: "org", positions: { a: { name: "a" } } }), /root/);
  assert.throws(
    () => parsePositionMap({ root: "org", positions: { org: { name: "o" }, a: { name: "a", parent: "b" }, b: { name: "b", parent: "a" } } }),
    /cycle/,
  );
  // a parent that isn't a position hangs the node off the root
  assert.equal(parsePositionMap({ root: "org", positions: { org: { name: "o" }, a: { name: "a", parent: "nope" } } }).positions.a.parent, "org");
});

test("commonAncestor: the lowest point that sees every source", async () => {
  const { commonAncestor } = await import("../src/positions.js");
  assert.equal(commonAncestor(map, ["floor", "eng"]), "ops");
  assert.equal(commonAncestor(map, ["floor", "floor"]), "floor");
  assert.equal(commonAncestor(map, ["floor", "ops"]), "ops");
  assert.equal(commonAncestor(map, ["floor", "reps"]), "org", "across branches only the root sees both");
  assert.equal(commonAncestor(map, ["floor", undefined]), "org", "an unhomed source counts as root");
  assert.equal(commonAncestor(map, []), "org");
});
