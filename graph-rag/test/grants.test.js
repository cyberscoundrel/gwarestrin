import assert from "node:assert/strict";
import { test } from "node:test";
import { grantedView, isActive, MAX_GRANT_DAYS, resolveExpiry, subtree } from "../src/grants.js";
import { parsePositionMap } from "../src/positions.js";

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
const NOW = Date.parse("2026-10-07T12:00:00Z");
const g = (over) => ({ id: "g", kind: "subtree", target: "eng", to: "sales", status: "active", expires_at: "2026-10-10T00:00:00Z", ...over });

test("the sales manager sees engineering for the deal; reps under the grant see it too", () => {
  const grants = [g({})];
  assert.deepEqual([...grantedView(map, ["sales"], grants, NOW).homes], ["eng"]);
  assert.deepEqual([...grantedView(map, ["reps"], grants, NOW).homes], [], "a grant to Sales manager doesn't reach the reps below it");
  assert.deepEqual([...grantedView(map, ["reps"], [g({ to: "reps" })], NOW).homes], ["eng"]);
  assert.deepEqual([...grantedView(map, ["sales"], [g({ to: "reps" })], NOW).homes], ["eng"], "managers see what their reps were granted");
  assert.deepEqual([...grantedView(map, ["floor"], grants, NOW).homes], [], "other positions get nothing");
});

test("subtree grants cover everything below the target; entity grants single records", () => {
  assert.deepEqual([...subtree(map, "ops")].sort(), ["eng", "floor", "ops"]);
  const v = grantedView(map, ["floor"], [g({ kind: "subtree", target: "ops", to: "floor" }), g({ kind: "entity", target: "#12:3", to: "floor" })], NOW);
  assert.deepEqual([...v.homes].sort(), ["eng", "floor", "ops"]);
  assert.deepEqual([...v.rids], ["#12:3"]);
});

test("expired and revoked grants count for nothing; the root needs none", () => {
  assert.equal(isActive(g({}), NOW), true);
  assert.equal(isActive(g({ expires_at: "2026-10-07T11:59:59Z" }), NOW), false);
  assert.equal(isActive(g({ status: "revoked" }), NOW), false);
  assert.equal(isActive(g({ expires_at: null }), NOW), true, "standing grant");
  assert.deepEqual([...grantedView(map, ["sales"], [g({ expires_at: "2026-10-01T00:00:00Z" })], NOW).homes], []);
  const root = grantedView(map, ["org"], [g({})], NOW);
  assert.equal(root.homes.size + root.rids.size, 0);
});

test("expiries: required and bounded below the root, optional for it", () => {
  assert.throws(() => resolveExpiry(undefined, { root: false }, NOW), /needs an expiry/);
  assert.equal(resolveExpiry(undefined, { root: true }, NOW), null);
  assert.equal(resolveExpiry("2026-10-08", { root: false }, NOW), "2026-10-08T00:00:00.000Z");
  assert.throws(() => resolveExpiry("2026-10-01", { root: false }, NOW), /future/);
  assert.throws(() => resolveExpiry(new Date(NOW + (MAX_GRANT_DAYS + 1) * 86_400_000).toISOString(), { root: false }, NOW), /within 90 days/);
  assert.ok(resolveExpiry(new Date(NOW + 400 * 86_400_000).toISOString(), { root: true }, NOW));
  assert.throws(() => resolveExpiry("next tuesday", { root: false }, NOW), /invalid/);
  assert.equal(resolveExpiry("14d", { root: false }, NOW), new Date(NOW + 14 * 86_400_000).toISOString());
  assert.equal(resolveExpiry("3 days", { root: false }, NOW), new Date(NOW + 3 * 86_400_000).toISOString());
  assert.throws(() => resolveExpiry("120d", { root: false }, NOW), /within 90 days/);
});
