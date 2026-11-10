import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { authorityOf, filedOrProposed, mapPositionOf, staleAuthorities, tightens, validatePolicy } from "../src/model/class-map.js";
import { classIndex, normalizeClass } from "../src/model/classes.js";
import { parsePositionMap } from "../src/positions.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const tree = read("positions.json");
//   org (admins only) > ops (Operations) > floor (Production floor)
const positions = parsePositionMap(tree);
const map = validatePolicy(read("policy.json"), positions);
const { admin, alice, bob } = tree.identities;
const index = classIndex(read("classes.json").classes.map((c) => normalizeClass(c, { positions })));

test("the stored map still loads and resolves most specific first", () => {
  assert.equal(authorityOf(map, "orders", "price"), "org");
  assert.equal(authorityOf(map, "orders", "quantity"), "ops");
  assert.equal(authorityOf(map, "Jobs", null), "floor", "a class name is matched as a key");
});

test("Filed when the recorder holds the mapped position or one above it", () => {
  assert.equal(filedOrProposed({ recorder: bob, cls: "jobs", map, positions }).outcome, "filed");
  assert.equal(filedOrProposed({ recorder: alice, cls: "jobs", map, positions }).outcome, "filed");
  assert.equal(filedOrProposed({ recorder: admin, cls: "hires", map, positions }).outcome, "filed");
});

test("Proposed when the recorder doesn't hold it, the class is missing from the map, or the source isn't writable (R2, R11)", () => {
  assert.equal(filedOrProposed({ recorder: bob, cls: "orders", map, positions }).outcome, "proposed");
  const missing = filedOrProposed({ recorder: admin, cls: "invoices", map, positions });
  assert.equal(missing.outcome, "proposed", "a class missing from the map means Proposed, even for the root");
  assert.match(missing.reason, /names no position/);
  assert.equal(filedOrProposed({ recorder: admin, cls: "hires", map, positions, writable: false }).outcome, "proposed");
});

test("the map's global attribute entries and default don't decide Filed or Proposed", () => {
  const m = validatePolicy({ attributes: { pay: "org" }, default: "floor" }, positions);
  assert.equal(filedOrProposed({ recorder: bob, cls: "jobs", columns: ["pay"], map: m, positions }).outcome, "proposed", "jobs has no class entry");
});

test("a class's own per-column entries count, strictest of what is written", () => {
  assert.equal(filedOrProposed({ recorder: alice, cls: "orders", columns: ["quantity"], map, positions }).outcome, "filed");
  assert.equal(filedOrProposed({ recorder: alice, cls: "orders", columns: ["quantity", "price"], map, positions }).outcome, "proposed");
});

test("a subclass with no entry takes its parents', the strictest where they conflict (R9)", () => {
  const idx = classIndex([...index.values(), normalizeClass({ name: "rush jobs", parents: ["jobs", "orders"], home: "ops" })]);
  assert.equal(mapPositionOf(map, "rush jobs", positions, { index: idx }), "ops", "jobs says floor, orders says ops: ops is stricter");
  assert.equal(mapPositionOf(map, "rush jobs", positions), null, "without the class index only its own entry counts");
  const own = validatePolicy({ classes: { ...map.classes, rush_jobs: { authority: "floor" } } }, positions);
  assert.equal(mapPositionOf(own, "rush jobs", positions, { index: idx }), "floor", "its own entry wins");
});

test("tightening: an entry where there was none, or one moved up or across", () => {
  const next = validatePolicy({ classes: { ...map.classes, jobs: { authority: "ops" } } }, positions);
  assert.equal(tightens(map, next, "jobs", null, positions), true);
  assert.equal(tightens(next, map, "jobs", null, positions), false, "moving down loosens");
});

test("validation names the field; stale entries count as the root", () => {
  assert.throws(() => validatePolicy({ classes: { jobs: { authority: "nowhere" } } }, positions), /classes.jobs.authority: unknown position/);
  assert.throws(() => validatePolicy({ classes: { jobs: { authority: "everyone" } } }, positions), /holds no authority/);
  const stale = validatePolicy({ classes: { jobs: { authority: "gone" } } }, positions, { stored: true });
  assert.deepEqual(staleAuthorities(stale, positions), [{ field: "classes.jobs.authority", position: "gone" }]);
  assert.equal(filedOrProposed({ recorder: alice, cls: "jobs", map: stale, positions }).outcome, "proposed", "a stale entry counts as the root");
});
