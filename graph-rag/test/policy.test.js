import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPolicyUpdate, defaultPolicy, normalizeStored } from "../src/policy.js";

const d = defaultPolicy({});

test("defaults are the built-in values, overridable by env", () => {
  assert.deepEqual(d, { maxGrantDays: 90, defaultShareDays: 14, standingGrants: "root", peopleShareDirectly: true, gradingEnabled: true, gradingConfidence: 0.6, derivedWindowHours: 12 });
  const e = defaultPolicy({ MAX_GRANT_DAYS: "30", DERIVED_WINDOW_HOURS: "24", STANDING_GRANTS: "nobody", PEOPLE_SHARE_DIRECTLY: "false", GRADING_ENABLED: "false" });
  assert.equal(e.maxGrantDays, 30);
  assert.equal(e.derivedWindowHours, 24);
  assert.equal(e.standingGrants, "nobody");
  assert.equal(e.peopleShareDirectly, false);
  assert.equal(e.gradingEnabled, false);
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
});

test("a stored policy is filled from the defaults; junk falls back to them", () => {
  assert.deepEqual(normalizeStored({ maxGrantDays: 30, obsolete: 1 }, d), { ...d, maxGrantDays: 30 });
  assert.deepEqual(normalizeStored({ maxGrantDays: -5 }, d), d);
  assert.deepEqual(normalizeStored(null, d), d);
});
