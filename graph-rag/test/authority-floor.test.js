// The Authority stream against live module state: the derived-data floor restated on claims
// (a read of a claim bounds a write as a read of an entry does), decideWrite's lift, and the
// visibility reading in scope.js. The position map is the fixture tree, loaded as the server
// loads it; the policy is the defaults (an empty map), so the rules are passed in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

process.env.POSITION_MAP_PATH = new URL("./fixtures/positions.json", import.meta.url).pathname;
process.env.ARCADEDB_URL = "http://127.0.0.1:9"; // read marks are persisted in the background; nothing listens here
const scope = await import("../src/scope.js");
const { loadPositionMap, scopeOf, coversClass, seesClaim } = scope;
const { recordReads, derivedFloor, workerWriteFloor, claimWriteFloor } = await import("../src/floor.js");
const { decideWrite } = await import("../src/write.js");
const { recipientCovers } = await import("../src/sharing.js");
const { validatePolicy } = await import("../src/model/authority.js");
loadPositionMap();
const positionMap = scope.positionMap; // the live binding, read after the load

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const rules = validatePolicy(read("policy.json"), positionMap);
const ids = read("positions.json").identities;
const alice = ids.alice;
const bob = ids.bob;
let n = 0;
/** a fresh worker identity each time: read marks are per identity */
const worker = (positions = ["org"]) => ({ user: `admin/agent:w${++n}`, key: `w${n}`, positions, caps: { write: "direct" }, role: { kind: "worker", job: `j${n}`, entry: "#1:1" } });

test("a read of a claim bounds a write the way a read of an entry does; entries are unchanged", () => {
  const w1 = worker();
  recordReads(w1, ["ops"]);
  assert.equal(derivedFloor(w1, "floor"), "ops", "today: an entry read at ops holds a floor write at ops");
  const w2 = worker();
  recordReads(w2, [{ class: "orders", attribute: "price", _home: "org" }]);
  assert.equal(derivedFloor(w2, "floor"), "org", "a claim seen from the top holds a floor write at the top");
  const w3 = worker();
  recordReads(w3, [{ class: "jobs", attribute: "machine", _home: "floor" }, "floor", { home: "floor" }]);
  assert.equal(derivedFloor(w3, "floor"), "floor", "claims read at the writer's own home hold nothing");
  const w4 = worker();
  recordReads(w4, [{ class: "x", attribute: "y" }, null, 42]);
  assert.equal(derivedFloor(w4, "floor"), "floor", "a claim with no home counts for nothing");
});

test("the worker's write floor takes a claim in place of a home", () => {
  const w = worker();
  recordReads(w, ["org"]);
  const byHome = workerWriteFloor(w, "floor");
  const byClaim = workerWriteFloor(w, { class: "jobs", attribute: "machine", _home: "floor" });
  assert.deepEqual(byClaim, byHome);
  assert.ok(byHome.lift, "what it read at the top is hidden from the floor: lifted");
  assert.equal(byHome.lift.floor, "org");
  assert.equal(workerWriteFloor(w, undefined).lift, null);
});

test("the claims' authority raises the floor along with what was read", () => {
  const w = worker();
  assert.equal(claimWriteFloor(w, "floor", [{ class: "jobs", attribute: "shift_cover" }], rules), "floor");
  assert.equal(claimWriteFloor(w, "floor", [{ class: "orders", attribute: "quantity" }], rules), "ops");
  assert.equal(claimWriteFloor(w, "floor", [{ class: "orders", attribute: "quantity" }, { class: "hires", attribute: "pay" }], rules), "org");
  recordReads(w, ["ops"]);
  assert.equal(claimWriteFloor(w, "floor", [{ class: "jobs", attribute: "shift_cover" }], rules), "ops", "the read floor still applies");
  assert.equal(claimWriteFloor(w, "floor", [], rules), "ops");
  assert.equal(claimWriteFloor(w, undefined, [{ class: "hires", attribute: "pay" }], rules), undefined, "unscoped write: nothing to floor");
});

test("decideWrite lifts a content write past the derived floor into a proposal, and says what was read", () => {
  const w = worker();
  recordReads(w, ["org"]);
  const d = decideWrite(w, { kind: "upsert", lives: "floor" }, {});
  assert.equal(d.action, "propose");
  assert.ok(d.lift, "the worker tools phrase the refusal from the lift");
  assert.equal(d.floor, "org");
  assert.match(d.reason, /reaches fewer people than Production floor/);
  assert.equal(decideWrite(w, { kind: "rehome", lives: "floor" }, { to: "ops" }).action, "direct", "a move up never widens derived data: no lift");
  const fresh = worker();
  assert.equal(decideWrite(fresh, { kind: "upsert", lives: "floor" }, {}).action, "direct");
  assert.equal(decideWrite(fresh, { kind: "upsert" }, { origin: "floor" }).floor, "floor", "a new write's floor is the derived floor");
});

test("reading 1 in scope.js: a position sees the classes its authority covers, homed where it sees, plus what is granted", () => {
  const ops = scopeOf(alice);
  const floor = scopeOf(bob);
  assert.equal(coversClass(ops, "orders", "quantity", rules), true);
  assert.equal(coversClass(ops, "orders", "price", rules), false);
  assert.equal(coversClass(floor, "jobs", "shift_cover", rules), true);
  assert.equal(coversClass(floor, "orders", "quantity", rules), false);
  assert.equal(coversClass(scopeOf(ids.admin), "hires", "pay", rules), true, "the root covers everything");
  assert.equal(coversClass(scopeOf(ids["bob/agent:floor"]), "jobs", "machine", rules), true, "seeing is by position, not by write capability");
  // a claim homed where the authority sees it: the authority sees it, those below do not
  const pay = { class: "hires", attribute: "pay", _home: "org" };
  assert.equal(seesClaim(scopeOf(ids.admin), pay, undefined, rules), true);
  assert.equal(seesClaim(ops, pay, undefined, rules), false);
  assert.equal(seesClaim(floor, pay, undefined, rules), false);
  // provenance bounds it too: an ops note about floor work is homed at ops, which the floor does not see
  const machine = { class: "jobs", attribute: "machine" };
  assert.equal(seesClaim(floor, machine, "ops", rules), false, "its authority covers the class, but the section is above it");
  assert.equal(seesClaim(ops, machine, "ops", rules), true);
  assert.equal(seesClaim(floor, machine, "floor", rules), true);
  // a grant of the section shows the claim whatever the authority
  const granted = { ...floor, granted: { homes: new Set(["org"]), entities: [] } };
  assert.equal(seesClaim(granted, pay, undefined, rules), true);
  // sharing.js asks the same question of a recipient
  assert.equal(recipientCovers({ to_pos: "floor" }, [{ class: "jobs", attribute: "machine" }], rules), true);
  assert.equal(recipientCovers({ to_pos: "floor" }, [{ class: "hires", attribute: "pay" }], rules), false);
  assert.equal(recipientCovers({ to_pos: "org" }, [{ class: "hires", attribute: "pay" }], rules), true);
});
