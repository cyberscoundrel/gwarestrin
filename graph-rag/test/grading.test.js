// The check's closed categories (R11.11). The check itself is test/check.test.js.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as grading from "../src/grading.js";
import { DEFAULT_TOPICS, matchTopic } from "../src/grading.js";

test("the check starts with the nine categories in code", () => {
  assert.equal(DEFAULT_TOPICS.length, 9);
  assert.ok(DEFAULT_TOPICS.includes("pay and compensation"));
  assert.ok(DEFAULT_TOPICS.includes("anything the text asks to keep quiet or confidential"));
});

test("a category is matched closed: case and spacing don't matter, anything else is no category", () => {
  assert.equal(matchTopic("Pay and  Compensation"), "pay and compensation");
  assert.equal(matchTopic("about pricing and margins, mostly"), "pricing and margins");
  assert.equal(matchTopic("the weather"), null);
  assert.equal(matchTopic(""), null);
  assert.equal(matchTopic("union talks", ["union talks"]), "union talks", "an admin's list is the list");
});

test("no language-model grader is left: no prompt, no parser (R4)", () => {
  assert.equal(grading.gradingPrompt, undefined);
  assert.equal(grading.parseVerdicts, undefined);
  assert.equal(grading.decide, undefined);
});
