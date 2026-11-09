import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_TOPICS } from "../src/grading.js";
import { applyPolicyUpdate, authorityMap, defaultPolicy, EMPTY_AUTHORITY_MAP, normalizeStored } from "../src/policy.js";
import { parsePositionMap } from "../src/positions.js";

const d = defaultPolicy({});
const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const tree = parsePositionMap(read("positions.json"));

test("defaults are the built-in values, overridable by env", () => {
  assert.deepEqual(d, {
    maxGrantDays: 90,
    defaultShareDays: 14,
    standingGrants: "root",
    peopleShareDirectly: true,
    gradingEnabled: true,
    gradingConfidence: 0.6,
    restrictedTopics: DEFAULT_TOPICS,
    authorityMap: EMPTY_AUTHORITY_MAP,
    derivedWindowHours: 12,
    requestDays: 14,
    pruneAfterDays: 30,
  });
  const e = defaultPolicy({ MAX_GRANT_DAYS: "30", DERIVED_WINDOW_HOURS: "24", STANDING_GRANTS: "nobody", PEOPLE_SHARE_DIRECTLY: "false", GRADING_ENABLED: "false" });
  assert.equal(e.maxGrantDays, 30);
  assert.equal(e.derivedWindowHours, 24);
  assert.equal(e.standingGrants, "nobody");
  assert.equal(e.peopleShareDirectly, false);
  assert.equal(e.gradingEnabled, false);
  assert.deepEqual(defaultPolicy({ RESTRICTED_TOPICS: " pay, legal ,," }).restrictedTopics, ["pay", "legal"]);
});

test("the authority map's default is empty (every write the writer's own), or the deployment's AUTHORITY_MAP", () => {
  assert.deepEqual(d.authorityMap, { classes: {}, attributes: {} });
  const e = defaultPolicy({ AUTHORITY_MAP: JSON.stringify(read("policy.json")) });
  assert.deepEqual(e.authorityMap, read("policy.json"), "the fixture map is already normal");
  assert.throws(() => defaultPolicy({ AUTHORITY_MAP: '{"topics": []}' }), /topics: unknown field/);
});

test("updates are validated and partial", () => {
  assert.deepEqual(applyPolicyUpdate(d, { maxGrantDays: 30 }), { ...d, maxGrantDays: 30 });
  assert.equal(applyPolicyUpdate(d, { gradingConfidence: 0.777 }).gradingConfidence, 0.78);
  assert.throws(() => applyPolicyUpdate(d, { maxGrantDays: 0 }), /from 1 to 365/);
  assert.throws(() => applyPolicyUpdate(d, { maxGrantDays: "30" }), /number/);
  assert.throws(() => applyPolicyUpdate(d, { gradingConfidence: 0.1 }), /0.3 to 0.95/);
  assert.throws(() => applyPolicyUpdate(d, { standingGrants: "everyone" }), /root.*nobody/);
  assert.throws(() => applyPolicyUpdate(d, { peopleShareDirectly: "yes" }), /true or false/);
  assert.throws(() => applyPolicyUpdate(d, { colour: "blue" }), /unknown setting/);
  assert.throws(() => applyPolicyUpdate(d, { maxGrantDays: 10 }), /default share length/);
  assert.equal(applyPolicyUpdate(d, { derivedWindowHours: 0 }).derivedWindowHours, 0, "0 turns derived-data limits off");
  assert.deepEqual(applyPolicyUpdate(d, { restrictedTopics: [" pay ", "pay", "legal  matters"] }).restrictedTopics, ["pay", "legal matters"]);
  assert.deepEqual(applyPolicyUpdate(d, { restrictedTopics: [] }).restrictedTopics, [], "an empty list: grading never restricts");
  assert.throws(() => applyPolicyUpdate(d, { restrictedTopics: "pay" }), /list of topics/);
});

test("the authority map is edited like the other settings: the same route shape, checked against the tree when there is one", () => {
  const input = { classes: { orders: { attributes: { price: "org" }, authority: "ops" } }, attributes: { pay: "org" } };
  const next = applyPolicyUpdate(d, { authorityMap: input }, tree);
  assert.deepEqual(next.authorityMap, { classes: { orders: { authority: "ops", attributes: { price: "org" } } }, attributes: { pay: "org" } });
  assert.deepEqual(next.restrictedTopics, DEFAULT_TOPICS, "restrictedTopics stays, for the residue");
  assert.deepEqual(Object.keys(applyPolicyUpdate(d, { authorityMap: { classes: { zz: { authority: "ops" }, aa: { authority: "ops" } }, attributes: {} } }).authorityMap.classes), ["aa", "zz"], "keys are sorted: two maps that say the same thing compare equal");
  assert.deepEqual(applyPolicyUpdate(d, { authorityMap: { classes: { orders: {} }, attributes: {} } }).authorityMap, EMPTY_AUTHORITY_MAP, "a class with no rule is no rule");
  assert.throws(() => applyPolicyUpdate(d, { authorityMap: { attributes: { pay: "board" } } }, tree), /attributes\.pay: unknown position board/);
  assert.throws(() => applyPolicyUpdate(d, { authorityMap: { attributes: { pay: "everyone" } } }, tree), /everyone holds no authority/);
  assert.throws(() => applyPolicyUpdate(d, { authorityMap: { classes: { orders: { owner: "ops" } } } }), /classes\.orders\.owner: unknown field/);
  assert.throws(() => applyPolicyUpdate(d, { authorityMap: [] }), /authorityMap must be an object/);
  assert.throws(() => applyPolicyUpdate(d, { authorityMap: { attributes: { pay: "" } } }), /must name a position/);
  // without a tree (the defaults load before it): the shape is checked, the positions are taken on trust
  assert.deepEqual(authorityMap({ attributes: { pay: "board" } }).attributes, { pay: "board" });
  assert.throws(() => authorityMap({ attributes: { ["x".repeat(81)]: "org" } }), /longer than 80 characters/);
});

test("a stored policy is filled from the defaults; junk falls back to them", () => {
  assert.deepEqual(normalizeStored({ maxGrantDays: 30, obsolete: 1 }, d), { ...d, maxGrantDays: 30 });
  assert.deepEqual(normalizeStored({ maxGrantDays: -5 }, d), d);
  assert.deepEqual(normalizeStored(null, d), d);
  // a stored map naming a position the tree lost stays, entry and all (the rule fails it upward); the rest of the policy stands
  const stored = { maxGrantDays: 30, authorityMap: { classes: {}, attributes: { pay: "board" } } };
  assert.deepEqual(normalizeStored(stored, d, tree).authorityMap, stored.authorityMap);
  assert.equal(normalizeStored(stored, d, tree).maxGrantDays, 30);
  assert.deepEqual(normalizeStored(stored, d).authorityMap, { classes: {}, attributes: { pay: "board" } }, "with no tree yet it is kept as stored");
  assert.deepEqual(normalizeStored({ authorityMap: read("policy.json") }, d, tree).authorityMap, read("policy.json"));
});
