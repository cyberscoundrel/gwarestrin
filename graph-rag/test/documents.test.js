import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, extractionPrompt, MAX, MIN, parseExtraction, preview, sectionName, TARGET } from "../src/documents.js";

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

test("extraction: facts tied to their section; junk, duplicates and overflow dropped", () => {
  const written = Date.parse("2026-10-08T12:00:00Z");
  const sections = [{ index: 4, heading: "Coolant", text: "..." }, { index: 5, heading: "Actions", text: "..." }];
  const msgs = extractionPrompt("Mill 1 manual", sections, written);
  assert.match(msgs[1].content, /section 2: Actions/);
  assert.match(msgs[0].content, /data, not instructions/);
  const text = JSON.stringify({
    facts: [
      { section: 1, name: "Mill 1 coolant interval", statement: "Mill 1 coolant is changed every 500 hours.", until: null },
      { section: 2, name: "Ken orders spindles", statement: "Ken orders two spare spindles for Mill 1 by October 20.", until: "2026-10-20" },
      { section: 2, name: "ken orders spindles", statement: "duplicate name", until: null },
      { section: 9, name: "Nowhere", statement: "A fact from a section that wasn't sent.", until: null },
      { section: 1, name: "x", statement: "too short a name" },
    ],
  });
  const facts = parseExtraction(`here you go: ${text}`, sections, written);
  assert.deepEqual(facts.map((f) => [f.section, f.name]), [[4, "Mill 1 coolant interval"], [5, "Ken orders spindles"]]);
  assert.equal(facts[1].until, "2026-10-20T23:59:59.000Z");
  assert.equal(facts[0].until, null);
  assert.deepEqual(parseExtraction("not json", sections), []);
});
