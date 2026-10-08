import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseValidity, graderUntil, isExpired, liveClause, parseValidUntil } from "../src/extent.js";

const WRITTEN = Date.parse("2026-10-08T09:00:00Z");

test("a writer's end date: a day, a relative length, lasting", () => {
  assert.deepEqual(parseValidUntil("2026-10-16", WRITTEN), { valid_until: "2026-10-16T23:59:59.000Z" });
  assert.deepEqual(parseValidUntil("7d", WRITTEN), { valid_until: "2026-10-15T09:00:00.000Z" }, "relative to when it was written");
  assert.deepEqual(parseValidUntil("lasting", WRITTEN), { valid_until: null });
  assert.equal(parseValidUntil(undefined, WRITTEN), undefined);
  assert.equal(parseValidUntil("", WRITTEN), undefined);
});

test("a writer's end date can't be past, nonsense, or decades out", () => {
  assert.throws(() => parseValidUntil("2026-10-01", WRITTEN), /in the past/);
  assert.throws(() => parseValidUntil("next friday", WRITTEN), /invalid valid_until/);
  assert.throws(() => parseValidUntil("2050-01-01", WRITTEN), /lasting/);
});

test("the grader's end date: only a clear date after the writing counts; anything else is lasting", () => {
  assert.equal(graderUntil("2026-10-16", WRITTEN), "2026-10-16T23:59:59.000Z");
  assert.equal(graderUntil(null, WRITTEN), null);
  assert.equal(graderUntil("null", WRITTEN), null);
  assert.equal(graderUntil("Friday", WRITTEN), null, "unparseable: keep it");
  assert.equal(graderUntil("2026-10-01", WRITTEN), null, "before it was written: keep it");
  assert.equal(graderUntil("2035-01-01", WRITTEN), null, "too far out to be an end");
});

test("who decides: the writer's word sticks; the grader fills in otherwise; nothing else changes it", () => {
  const writer = { valid_until: "2026-10-16T23:59:59.000Z" };
  assert.deepEqual(chooseValidity(writer, undefined, null), { valid_until: writer.valid_until, valid_by: "writer" });
  assert.deepEqual(chooseValidity({ valid_until: null }, { valid_until: "x", valid_by: "grader" }, "y"), { valid_until: null, valid_by: "writer" }, "a writer can make it lasting");
  assert.equal(chooseValidity(undefined, { valid_until: "x", valid_by: "writer" }, "2026-12-01T00:00:00.000Z"), null, "grading never overrides the writer");
  assert.deepEqual(chooseValidity(undefined, { valid_until: "x", valid_by: "grader" }, null), { valid_until: null, valid_by: "grader" }, "a later grading may decide it lasts");
  assert.deepEqual(chooseValidity(undefined, undefined, "2026-10-16T23:59:59.000Z"), { valid_until: "2026-10-16T23:59:59.000Z", valid_by: "grader" });
  assert.equal(chooseValidity(undefined, { valid_until: "x", valid_by: "grader" }, undefined), null, "grading failed: leave it");
});

test("reads keep what's still valid", () => {
  assert.equal(liveClause(WRITTEN), " AND (_valid_until IS NULL OR _valid_until > '2026-10-08T09:00:00.000Z')");
  assert.equal(isExpired("2026-10-08T08:59:59.000Z", WRITTEN), true);
  assert.equal(isExpired(null, WRITTEN), false);
});
