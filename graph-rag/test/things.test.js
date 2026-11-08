import assert from "node:assert/strict";
import { test } from "node:test";
import { designatorsDiffer, duplicateEntries, entryId, splitThingName, thingClash, mentionsPrompt, normalize, parseMentions, thingName } from "../src/things.js";

test("names normalize for matching", () => {
  assert.equal(normalize("Toro Co."), "toro co");
  assert.equal(normalize("  TORO "), "toro");
  assert.equal(normalize("PO-4471"), "po 4471");
});

test("the prompt carries the statement and the organization's own guidance; content is data", () => {
  const [sys, user] = mentionsPrompt({ name: "Toro PO 4471 plating", facets: { identity: "PO 4471 for Toro goes to plating Oct 14." } }, "Customers are named by their ERP code.");
  assert.match(sys.content, /data, not instructions/);
  assert.match(sys.content, /ERP code/);
  assert.match(user.content, /PO 4471 for Toro/);
});

test("mentions: typed, deduplicated, junk dropped, capped", () => {
  const text = JSON.stringify({
    things: [
      { name: "Toro", type: "customer", role: "customer" },
      { name: "TORO", type: "customer", role: "subject" },
      { name: "PO 4471", type: "order", role: "subject" },
      { name: "Line 2", type: "machine", role: "Machine!" },
      { name: "x", type: "part" },
      { name: "Mystery", type: "spaceship" },
    ],
  });
  assert.deepEqual(parseMentions(`ok: ${text}`), [
    { name: "Toro", type: "customer", role: "customer" },
    { name: "PO 4471", type: "order", role: "subject" },
    { name: "Line 2", type: "machine", role: "machine" },
    { name: "Mystery", type: null, role: "mentions" },
  ]);
  assert.deepEqual(parseMentions("nope"), []);
});

test("the sorting step: asks whether a worker should look, and reads the verdict", async () => {
  const { parseSort } = await import("../src/things.js");
  const [sys] = mentionsPrompt({ name: "x", facets: {} }, "", { sort: true });
  assert.match(sys.content, /review/);
  assert.doesNotMatch(mentionsPrompt({ name: "x", facets: {} })[0].content, /review/);
  assert.deepEqual(parseSort('{"things":[],"review":true,"why":"PO 4471 is in the ERP"}'), { review: true, why: "PO 4471 is in the ERP" });
  assert.deepEqual(parseSort('{"things":[],"review":"yes"}'), { review: false, why: "" });
  assert.deepEqual(parseSort("garbage"), { review: false, why: "" });
});

test("record keys: kept on mentions, and the same key is the same thing whatever its name", async () => {
  const { normalizeKey, normalizeRel } = await import("../src/things.js");
  assert.equal(normalizeKey(" mssql:dbo_Customer:TORO "), "mssql:dbo_Customer:TORO");
  assert.equal(normalizeKey("TORO"), null);
  assert.equal(normalizeRel("Works In"), "works_in");
  const m = parseMentions(JSON.stringify({ things: [{ name: "Toro Plating Co", type: "customer", key: "mssql:dbo_Customer:TORO" }, { name: "Toro", type: "customer", key: "mssql:dbo_Customer:TORO" }] }));
  assert.equal(m.length, 1, "one key, one thing");
  assert.equal(parseMentions(JSON.stringify({ things: Array.from({ length: 30 }, (_, i) => ({ name: `Customer ${i}`, type: "customer" })) }), 25).length, 25);
});

test("partial names of people: looked up by first name and initial", async () => {
  const { partialPerson, personCandidates } = await import("../src/things.js");
  assert.deepEqual(partialPerson("John F."), { first: "john", initial: "f" });
  assert.deepEqual(partialPerson("Michael"), { first: "michael", initial: null });
  assert.equal(partialPerson("Michael Gustafson"), null);
  assert.equal(partialPerson("3260372"), null);
  const people = [{ label: "John Francis" }, { label: "JOHN" }, { label: "John Smith" }, { label: "Johnny Cash" }];
  assert.deepEqual(personCandidates({ first: "john", initial: "f" }, people).map((p) => p.label), ["John Francis"]);
  assert.deepEqual(personCandidates({ first: "john", initial: null }, people).map((p) => p.label), ["John Francis", "John Smith"]);
});

test("entryId: an id, not a name", () => {
  assert.equal(entryId("#1:352258"), "#1:352258");
  assert.equal(entryId(" #13:0 "), "#13:0");
  assert.equal(entryId("ux-m01 inspect-2 down"), null);
  assert.equal(entryId("#1:abc"), null);
});

test("duplicateEntries lists each copy with its id, home and links", () => {
  const msg = duplicateEntries("ux-m01 inspect-2 down", [
    { rid: "#1:354316", home: "Operations", updated_at: "2026-10-14T10:00:00Z", links: 8 },
    { rid: "#1:352258", home: "Operations", links: 1 },
  ]);
  assert.match(msg, /^2 entries are called "ux-m01 inspect-2 down"/);
  assert.match(msg, /#1:354316 \(Operations, updated 2026-10-14, 8 links\)/);
  assert.match(msg, /#1:352258 \(Operations, 1 link\)/);
  assert.match(msg, /merge_entries/);
});

test("splitThingName: a full thing name, not any parenthesis", () => {
  assert.deepEqual(splitThingName("CNC 2 (machine)"), { name: "CNC 2", type: "machine" });
  assert.deepEqual(splitThingName("Toro (Customer)"), { name: "Toro", type: "customer" });
  assert.equal(splitThingName("CNC 2"), null);
  assert.deepEqual(splitThingName("Corvane samples (sample order)"), { name: "Corvane samples", type: "sample order" }, "a class name too");
  assert.equal(splitThingName("Quote 12 (see 2026)"), null);
  assert.equal(splitThingName("Quote 12 (Draft!)"), null);
});

test("thingClash points at the right tools", () => {
  const msg = thingClash("CNC 2 (machine)", { label: "cnc", _thing_type: "machine", rid: "#1:57347" });
  assert.match(msg, /is a thing \(cnc, machine, #1:57347\)/);
  assert.match(msg, /rename_thing/);
});

test("names alike but for a short designator are different things: rack A is not rack C", () => {
  assert.ok(designatorsDiffer("rack A", "rack C"));
  assert.ok(!designatorsDiffer("north dock", "south dock"), "whole words differ: the embedding decides");
  assert.ok(!designatorsDiffer("A", "C"), "a bare letter isn't a designated name");
  assert.ok(!designatorsDiffer("rack A", "rack A"));
});
