// decideWrite after R6: the single authority-over-a-class rule is dropped, so a graph write is decided by the
// site rules and the derived floor alone. Live module state for the floor: the fixture tree, loaded as the server
// loads it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

process.env.POSITION_MAP_PATH = new URL("./fixtures/positions.json", import.meta.url).pathname;
process.env.ARCADEDB_URL = "http://127.0.0.1:9"; // read marks are persisted in the background; nothing listens here
const scope = await import("../src/scope.js");
const { recordReads } = await import("../src/floor.js");
const { decideWrite } = await import("../src/write.js");
const { parsePositionMap, EVERYONE } = await import("../src/positions.js");
scope.loadPositionMap();

const tree = JSON.parse(readFileSync(new URL("./fixtures/positions.json", import.meta.url), "utf8"));
const map = parsePositionMap(tree);
const { admin, alice, bob } = tree.identities;
const floorAgent = tree.identities["bob/agent:floor"];
let n = 0;
const worker = (positions = ["org"]) => ({ user: `admin/agent:w${++n}`, key: `w${n}`, positions, caps: { write: "direct" }, role: { kind: "worker", job: `j${n}`, entry: "#1:1" } });
const pure = (extra = {}) => ({ positions: map, ...extra });

test("the site rules stay: queued writers, a worker's raw command, widening, a person's placement, asking on purpose", () => {
  const queued = decideWrite(floorAgent, { kind: "upsert" }, pure({ origin: "floor" }));
  assert.equal(queued.action, "propose");
  assert.equal(queued.home, "floor", "reviewed where it was written");
  assert.match(queued.reason, /queued/);
  assert.equal(decideWrite(admin, { kind: "command" }, pure()).action, "direct");
  assert.equal(decideWrite(worker(), { kind: "command" }, pure()).action, "propose");
  assert.equal(decideWrite(bob, { kind: "rehome", lives: "floor" }, pure({ to: "ops" })).action, "direct", "restricting applies");
  assert.equal(decideWrite(bob, { kind: "rehome", lives: "ops" }, pure({ to: "floor" })).action, "propose", "widening is a person's call");
  assert.equal(decideWrite(admin, { kind: "rehome", lives: "ops" }, pure({ to: EVERYONE })).action, "propose");
  assert.equal(decideWrite(worker(), { kind: "rehome", lives: "floor" }, pure({ to: "ops", placedBy: "alice" })).action, "propose");
  assert.equal(decideWrite(alice, { kind: "rehome", lives: "floor" }, pure({ to: "ops", placedBy: "bob" })).action, "direct");
  assert.equal(decideWrite(admin, { kind: "upsert" }, pure({ origin: "org", propose: true })).action, "propose");
});

test("no class rule decides a graph write any more (R6): a class or claims given are not read", () => {
  const d = decideWrite(bob, { kind: "rehome", lives: "floor", cls: "hires", attribute: "pay", claims: [{ class: "hires", attribute: "pay" }] }, pure({ to: "ops" }));
  assert.equal(d.action, "direct");
  assert.equal("authority" in d, false);
});

test("the derived floor lifts a content write past where the entry lives into a proposal, and says what was read", () => {
  const w = worker();
  recordReads(w, ["org"]);
  const d = decideWrite(w, { kind: "upsert", lives: "floor" }, {});
  assert.equal(d.action, "propose");
  assert.ok(d.lift);
  assert.equal(d.floor, "org");
  assert.match(d.reason, /reaches fewer people than Production floor/);
  assert.equal(decideWrite(w, { kind: "rehome", lives: "floor" }, { to: "ops" }).action, "direct", "a move up never widens derived data");
  const fresh = worker();
  assert.equal(decideWrite(fresh, { kind: "upsert", lives: "floor" }, {}).action, "direct");
  assert.equal(decideWrite(fresh, { kind: "upsert" }, { origin: "floor" }).floor, "floor", "a new write's floor is the derived floor");
});
