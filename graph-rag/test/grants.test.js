import assert from "node:assert/strict";
import { test } from "node:test";
import { danglingGrants, entityPredicate, grantedView, grantShows, isActive, MAX_GRANT_DAYS, resolveExpiry, subtree } from "../src/grants.js";
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

test("a share to a person reaches only that person (and their agents), not their position or managers", () => {
  const toBob = g({ kind: "entity", target: "#12:3", target_name: "Acme deal", to: null, to_user: "bob" });
  const rids = (v) => v.entities.map((e) => e.rid);
  assert.deepEqual(rids(grantedView(map, ["floor"], [toBob], NOW, "bob")), ["#12:3"]);
  assert.deepEqual(rids(grantedView(map, ["floor"], [toBob], NOW, "carol")), [], "someone else at bob's position gets nothing");
  assert.deepEqual(rids(grantedView(map, ["ops"], [toBob], NOW, "alice")), [], "bob's manager gets nothing either");
  assert.deepEqual(rids(grantedView(map, ["floor"], [toBob], NOW)), [], "no person: nothing");
  assert.deepEqual(rids(grantedView(map, [], [toBob], NOW, "bob")), ["#12:3"], "it doesn't depend on bob's positions");
  assert.deepEqual(rids(grantedView(map, ["floor"], [{ ...toBob, expires_at: "2026-10-01T00:00:00Z" }], NOW, "bob")), [], "expired");
});

test("subtree grants cover everything below the target; entity grants single records", () => {
  assert.deepEqual([...subtree(map, "ops")].sort(), ["eng", "floor", "ops"]);
  const v = grantedView(map, ["floor"], [g({ kind: "subtree", target: "ops", to: "floor" }), g({ kind: "entity", target: "#12:3", target_name: "Acme deal", to: "floor" })], NOW);
  assert.deepEqual([...v.homes].sort(), ["eng", "floor", "ops"]);
  assert.deepEqual(v.entities, [{ rid: "#12:3", name: "Acme deal", origin: null }]);
});

test("expired and revoked grants count for nothing; the root needs none", () => {
  assert.equal(isActive(g({}), NOW), true);
  assert.equal(isActive(g({ expires_at: "2026-10-07T11:59:59Z" }), NOW), false);
  assert.equal(isActive(g({ status: "revoked" }), NOW), false);
  assert.equal(isActive(g({ expires_at: null }), NOW), true, "standing grant");
  assert.deepEqual([...grantedView(map, ["sales"], [g({ expires_at: "2026-10-01T00:00:00Z" })], NOW).homes], []);
  const root = grantedView(map, ["org"], [g({})], NOW);
  assert.equal(root.homes.size + root.entities.length, 0);
});

test("expiries: a default length below the root, standing for a root person", () => {
  assert.equal(resolveExpiry(undefined, { root: false }, NOW), new Date(NOW + 14 * 86_400_000).toISOString());
  assert.equal(resolveExpiry(undefined, { root: false, defaultDays: 7 }, NOW), new Date(NOW + 7 * 86_400_000).toISOString());
  assert.equal(resolveExpiry(undefined, { root: true }, NOW), null);
  assert.notEqual(resolveExpiry(undefined, { root: true, agent: true }, NOW), null, "a root person's agent doesn't make standing shares");
  assert.notEqual(resolveExpiry(undefined, { root: true, standing: "nobody" }, NOW), null, "policy: nobody shares without an end date");
  assert.throws(() => resolveExpiry("200d", { root: true, standing: "nobody" }, NOW), /within 90 days/);
  assert.throws(() => resolveExpiry("40d", { root: false, maxDays: 30 }, NOW), /within 30 days/);
  assert.equal(resolveExpiry("2026-10-08", { root: false }, NOW), "2026-10-08T00:00:00.000Z");
  assert.throws(() => resolveExpiry("2026-10-01", { root: false }, NOW), /future/);
  assert.throws(() => resolveExpiry(new Date(NOW + (MAX_GRANT_DAYS + 1) * 86_400_000).toISOString(), { root: false }, NOW), /within 90 days/);
  assert.ok(resolveExpiry(new Date(NOW + 400 * 86_400_000).toISOString(), { root: true }, NOW));
  assert.throws(() => resolveExpiry("next tuesday", { root: false }, NOW), /invalid/);
  assert.equal(resolveExpiry("14d", { root: false }, NOW), new Date(NOW + 14 * 86_400_000).toISOString());
  assert.equal(resolveExpiry("3 days", { root: false }, NOW), new Date(NOW + 3 * 86_400_000).toISOString());
  assert.throws(() => resolveExpiry("120d", { root: false }, NOW), /within 90 days/);
});

// ArcadeDB reuses record ids after a delete: a grant names the entity, not just the id
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const deal = g({ kind: "entity", target: "#12:3", target_name: "Acme deal", target_origin: "sales", to: null, to_user: "bob" });

test("an entity grant shows its record only while that record is still the entity", () => {
  const v = grantedView(map, ["floor"], [deal], NOW, "bob");
  assert.deepEqual(v.entities, [{ rid: "#12:3", name: "Acme deal", origin: "sales" }]);
  assert.equal(grantShows(v, { rid: "#12:3", name: "Acme deal", origin: "sales" }), true);
  assert.equal(grantShows(v, { rid: "#12:3", name: "Payroll", origin: "sales" }), false, "another entity took the id");
  assert.equal(grantShows(v, { rid: "#12:3", name: "Acme deal", origin: "eng" }), false, "a same-named entity from elsewhere took the id");
  assert.equal(grantShows(v, { rid: "#12:4", name: "Acme deal", origin: "sales" }), false);
  const legacy = grantedView(map, ["floor"], [{ ...deal, target_origin: undefined }], NOW, "bob");
  assert.equal(grantShows(legacy, { rid: "#12:3", name: "Acme deal", origin: "eng" }), true, "grants from before origins were stored match by name");
  assert.equal(grantShows(legacy, { rid: "#12:3", name: "Payroll", origin: "eng" }), false);
  assert.deepEqual(grantedView(map, ["floor"], [{ ...deal, target_name: null }], NOW, "bob").entities, [], "no name: shows nothing");
  assert.equal(grantedView(map, ["floor"], [deal, { ...deal, id: "g2" }], NOW, "bob").entities.length, 1, "duplicates collapse");
});

test("the read predicate pairs each record id with the entity's name (and origin)", () => {
  assert.equal(
    entityPredicate([{ rid: "#12:3", name: "Acme deal", origin: "sales" }], esc),
    "(@rid = #12:3 AND name = 'Acme deal' AND _origin = 'sales')",
  );
  assert.equal(
    entityPredicate([{ rid: "#12:3", name: "O'Brien's\\notes", origin: null }, { rid: "#12:4", name: "B", origin: "o'x" }], esc),
    "(@rid = #12:3 AND name = 'O\\'Brien\\'s\\\\notes') OR (@rid = #12:4 AND name = 'B' AND _origin = 'o\\'x')",
  );
  assert.equal(entityPredicate([{ rid: "#12:3) OR (1 = 1", name: "x", origin: null }], esc), "", "invalid rids are dropped");
  assert.equal(entityPredicate([], esc), "");
});

test("grants on deleted entries, or on ids that now hold another entity, are dangling", () => {
  const subtreeGrant = g({});
  const legacy = { ...deal, id: "legacy", target: "#12:5", target_origin: undefined };
  const grants = [deal, { ...deal, id: "gone", target: "#12:9" }, subtreeGrant, legacy];
  const ids = (rows) => danglingGrants(grants, rows).map((x) => x.id);
  const here = [
    { rid: "#12:3", name: "Acme deal", _origin: "sales" },
    { rid: "#12:5", name: "Acme deal", _origin: "eng" },
  ];
  assert.deepEqual(ids(here), ["gone"], "missing record; subtree grants never dangle");
  assert.deepEqual(ids([{ ...here[0], name: "Payroll" }, here[1]]), ["g", "gone"], "renamed or replaced");
  assert.deepEqual(ids([{ ...here[0], _origin: "eng" }, here[1]]), ["g", "gone"], "a same-named entity from elsewhere");
  assert.deepEqual(ids([]), ["g", "gone", "legacy"]);
});
