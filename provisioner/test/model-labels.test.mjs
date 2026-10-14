import assert from "node:assert/strict";
import { test } from "node:test";
import { applyLabelUpdate, normalizeLabels } from "../model-labels.mjs";

const now = "2026-10-13T12:00:00.000Z";

test("labels: tier and hosting are required and checked; notes optional", () => {
  const out = applyLabelUpdate({}, { "local-inference/qwen2.5-14b": { tier: "standard", hosting: "on-prem" } }, "admin", now);
  assert.deepEqual(out, { "local-inference/qwen2.5-14b": { tier: "standard", hosting: "on-prem", by: "admin", at: now } });
  assert.throws(() => applyLabelUpdate({}, { "x/y": { tier: "huge", hosting: "on-prem" } }), /tier is one of/);
  assert.throws(() => applyLabelUpdate({}, { "x/y": { tier: "basic" } }), /hosting is one of/);
  assert.throws(() => applyLabelUpdate({}, { "no-slash": { tier: "basic", hosting: "on-prem" } }), /expected provider\/model/);
  assert.throws(() => applyLabelUpdate({}, { "x/y": { tier: "basic", hosting: "on-prem", notes: "n".repeat(501) } }), /500/);
});

test("model ids may contain slashes; null removes; unchanged labels keep their author", () => {
  const key = "openrouter/nvidia/nemotron-3-super-120b-a12b:free";
  const first = applyLabelUpdate({}, { [key]: { tier: "standard", hosting: "public-api", notes: " ignores call limits " } }, "alice", now);
  assert.equal(first[key].notes, "ignores call limits");
  const again = applyLabelUpdate(first, { [key]: { tier: "standard", hosting: "public-api", notes: "ignores call limits" } }, "bob", "later");
  assert.equal(again[key].by, "alice", "same label, same author");
  const changed = applyLabelUpdate(first, { [key]: { tier: "basic", hosting: "public-api" } }, "bob", "later");
  assert.equal(changed[key].by, "bob");
  assert.deepEqual(applyLabelUpdate(first, { [key]: null }), {});
});

test("stored labels: invalid ones are dropped", () => {
  assert.deepEqual(
    Object.keys(normalizeLabels({ "a/b": { tier: "basic", hosting: "on-prem", by: "x", at: now }, "a/c": { tier: "nope", hosting: "on-prem" }, bad: {} })),
    ["a/b"],
  );
  assert.deepEqual(normalizeLabels(undefined), {});
});
