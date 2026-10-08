import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePositionMap } from "../src/positions.js";
import { applyDismiss, applyShare, askerView, MATCH_MAX, mergeTarget, ownersFor, ownerView, routeMatches } from "../src/requests.js";

//            org (admin)
//      ┌──────┴──────┐
//     ops (alice)   sales (nobody)
//      └── floor (bob, dave)
const map = parsePositionMap({
  root: "org",
  positions: {
    org: { name: "Organization" },
    ops: { name: "Operations", parent: "org" },
    floor: { name: "Production floor", parent: "ops" },
    sales: { name: "Sales", parent: "org" },
  },
});
const holders = new Map([
  ["admin", ["org"]],
  ["alice", ["ops"]],
  ["bob", ["floor"]],
  ["dave", ["floor"]],
]);
const NOW = Date.parse("2026-10-08T12:00:00Z");
const m = (rid, home, score = 0.7) => ({ rid, name: `entry ${rid}`, home, score });

test("owners: whoever holds the entry's position, else the nearest one above that someone holds", () => {
  assert.deepEqual(ownersFor(map, "ops", holders, "bob"), ["alice"]);
  assert.deepEqual(ownersFor(map, "floor", holders, "carol"), ["bob", "dave"], "two people at one position both own it");
  assert.deepEqual(ownersFor(map, "sales", holders, "bob"), ["admin"], "nobody at Sales: it goes up to the root");
  assert.deepEqual(ownersFor(map, "floor", holders, "bob"), ["dave"], "the asker is never an owner");
});

test("routes: one per owner with only their entries, capped", () => {
  const routes = routeMatches(map, [m("#1:1", "ops"), m("#1:2", "sales"), m("#1:3", "ops")], holders, "bob");
  assert.deepEqual(routes.map((r) => [r.person, r.entries.map((e) => e.rid)]), [["alice", ["#1:1", "#1:3"]], ["admin", ["#1:2"]]]);
  assert.ok(routes.every((r) => r.status === "open"));
  const many = Array.from({ length: 20 }, (_, i) => m(`#2:${i}`, "ops"));
  assert.equal(routeMatches(map, many, holders, "bob")[0].entries.length, MATCH_MAX);
  assert.deepEqual(routeMatches(map, [], holders, "bob"), [], "nothing matched: no routes");
});

const req = (over = {}) => ({
  id: "r1",
  question: "when does the next Toro order go to plating?",
  asker: "bob",
  status: "open",
  created_at: "2026-10-08T10:00:00Z",
  expires_at: "2026-10-22T10:00:00Z",
  routes: routeMatches(map, [m("#1:1", "ops"), m("#1:2", "sales")], holders, "bob"),
  ...over,
});

test("the asker sees 'asked' whether anything matched, someone refused, or nothing did", () => {
  const none = askerView(req({ routes: [] }), NOW);
  const some = askerView(req(), NOW);
  const refused = askerView(applyDismiss(applyDismiss(req(), "alice"), "admin"), NOW);
  for (const v of [none, some, refused]) {
    assert.equal(v.status, "asked");
    assert.deepEqual(v.shared, []);
    assert.equal("routes" in v || "asker" in v, false);
  }
  assert.deepEqual(Object.keys(none).sort(), Object.keys(some).sort(), "same shape either way");
});

test("an owner shares part of their matches: their route is done; the asker sees what was shared", () => {
  const r = applyShare(req(), "alice", ["#1:1"]);
  assert.equal(r.routes.find((x) => x.person === "alice").status, "shared");
  assert.equal(r.status, "open", "admin's route is still open");
  const v = askerView(r, NOW);
  assert.equal(v.status, "shared");
  assert.deepEqual(v.shared, ["entry #1:1"]);
  assert.equal(v.still_open, true);
  applyDismiss(r, "admin");
  assert.equal(r.status, "answered");
});

test("an entry two owners hold closes for both when either shares it", () => {
  const r = req({ routes: routeMatches(map, [m("#3:1", "floor")], holders, "carol"), asker: "carol" });
  applyShare(r, "dave", ["#3:1"]);
  assert.deepEqual(r.routes.map((x) => x.status), ["shared", "shared"]);
  assert.equal(r.status, "answered");
});

test("all owners say no: closed, and the asker still just sees 'asked'", () => {
  const r = applyDismiss(applyDismiss(req(), "alice"), "admin");
  assert.equal(r.status, "closed");
  assert.equal(askerView(r, NOW).status, "asked");
});

test("expiry, drafts and withdrawals", () => {
  assert.equal(askerView(req({ expires_at: "2026-10-08T11:00:00Z" }), NOW).status, "expired");
  assert.equal(askerView(req({ status: "proposed" }), NOW).status, "proposed");
  assert.equal(askerView(req({ status: "withdrawn" }), NOW).status, "withdrawn");
  assert.equal(ownerView(req({ expires_at: "2026-10-08T11:00:00Z" }), "alice", NOW).status, "expired");
});

test("an owner sees only their own matches; others see nothing", () => {
  const v = ownerView(req(), "alice", NOW);
  assert.deepEqual(v.entries.map((e) => e.name), ["entry #1:1"]);
  assert.equal(v.asker, "bob");
  assert.equal(ownerView(req(), "dave", NOW), null);
});

test("asking again while a request is open joins it, if the matches overlap", () => {
  const open = [req()];
  assert.equal(mergeTarget(open, "bob", routeMatches(map, [m("#1:2", "sales")], holders, "bob"))?.id, "r1");
  assert.equal(mergeTarget(open, "bob", routeMatches(map, [m("#9:9", "ops")], holders, "bob")), null, "different matches: a new request");
  assert.equal(mergeTarget(open, "dave", routeMatches(map, [m("#1:2", "sales")], holders, "dave")), null, "someone else's request");
  assert.equal(mergeTarget(open, "bob", []), null, "nothing matched: nothing to join");
});
