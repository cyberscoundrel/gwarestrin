import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, MAX, MIN, preview, sectionName, TARGET } from "../src/documents.js";

const para = (n, word = "spindle") => Array.from({ length: n }, (_, i) => `${word} ${i} needs grease every 500 hours.`).join(" ");

test("a manual splits on its headings; spans cover the text once, in order", () => {
  const text = `# Mill 1 manual\n\n## Lubrication\n\n${para(20)}\n\n## Coolant\n\n${para(20, "coolant")}\n\n## Safety\n\n${para(20, "guard")}\n`;
  const cs = chunk(text);
  assert.ok(cs.length >= 3, `${cs.length} sections`);
  assert.deepEqual(cs.map((c) => c.heading).slice(-3), ["Lubrication", "Coolant", "Safety"]);
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i].start >= cs[i - 1].end, "no overlapping spans");
  assert.equal(cs.map((c) => text.slice(c.start, c.end)).join("").replace(/\s/g, "").length, text.replace(/\s/g, "").length, "nothing lost");
  assert.ok(cs.every((c) => c.end - c.start <= MAX + 200));
});

test("long text without headings becomes page-sized chunks; embeddings carry context", () => {
  const text = Array.from({ length: 30 }, (_, i) => para(6, `part${i}`)).join("\n\n");
  const cs = chunk(text);
  assert.ok(cs.length > 3);
  assert.ok(cs.slice(0, -1).every((c) => c.end - c.start >= MIN && c.end - c.start <= TARGET + 400), cs.map((c) => c.end - c.start).join(","));
  assert.match(cs[1].embedText, /^…/, "the previous chunk's tail leads the next embedding");
  assert.ok(!cs[1].text.startsWith("…"), "but not its stored text");
});

test("a transcript keeps speaker turns together", () => {
  const turns = Array.from({ length: 40 }, (_, i) => `${i % 2 ? "Ken" : "Maria"}: We discussed item ${i} about the line 3 coolant trial and agreed to keep going.`).join("\n");
  const cs = chunk(turns);
  assert.ok(cs.length >= 2);
  assert.ok(cs.every((c) => /^(Maria|Ken): /.test(c.text)), "every section starts at a turn");
});

test("one huge paragraph is cut at sentence ends", () => {
  const cs = chunk(para(200));
  assert.ok(cs.length > 2);
  assert.ok(cs.every((c) => c.end - c.start <= MAX));
  assert.ok(cs.slice(0, -1).every((c) => /\.\s*$/.test(c.text)), "cuts land after a sentence");
});

test("names and previews", () => {
  assert.equal(sectionName("Mill 1 manual", 2, "Coolant"), "Mill 1 manual §3: Coolant");
  assert.equal(sectionName("Weekly meeting", 0, ""), "Weekly meeting §1");
  assert.equal(preview("a  b\n\nc"), "a b c");
  assert.equal(preview("x".repeat(500)).length, 400);
});
