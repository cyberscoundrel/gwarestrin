import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionsPrompt, normalize, parseMentions, resolve, thingName } from "../src/things.js";

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
    { name: "Mystery", type: "other", role: "mentions" },
  ]);
  assert.deepEqual(parseMentions("nope"), []);
});

test("resolution: exact or alias match uses it; very close uses it as an alias; close asks; else new", () => {
  const cands = [
    { rid: "#1:1", name: "Toro", aliases: ["Toro Co."], type: "customer" },
    { rid: "#1:2", name: "Toro", type: "supplier" },
  ];
  assert.deepEqual(resolve({ name: "toro co", type: "customer" }, cands), { use: "#1:1" });
  assert.deepEqual(resolve({ name: "Toro", type: "supplier" }, cands), { use: "#1:2" }, "same name, different type: its own thing");
  assert.deepEqual(resolve({ name: "Toro Inc", type: "customer" }, [{ rid: "#1:1", name: "Toro", type: "customer", score: 0.95 }]), { use: "#1:1", alias: "Toro Inc" });
  assert.deepEqual(resolve({ name: "Toronto Plating", type: "customer" }, [{ rid: "#1:1", name: "Toro", type: "customer", score: 0.84 }]), { create: true, maybe: "#1:1" });
  assert.deepEqual(resolve({ name: "Acme", type: "customer" }, [{ rid: "#1:1", name: "Toro", type: "customer", score: 0.4 }]), { create: true });
  assert.equal(thingName("customer", "Toro"), "Toro (customer)");
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
  assert.deepEqual(resolve(m[0], [{ rid: "#1:1", name: "Toro", type: "customer", keys: ["mssql:dbo_Customer:TORO"] }]), { use: "#1:1", alias: "Toro Plating Co" });
  assert.deepEqual(
    resolve({ name: "Acme Inc", type: "customer", key: "mssql:dbo_Customer:ACME2" }, [{ rid: "#1:2", name: "Acme Inc", type: "customer", keys: ["mssql:dbo_Customer:ACME1"] }]),
    { create: true },
    "same name, another record: another thing",
  );
  assert.equal(parseMentions(JSON.stringify({ things: Array.from({ length: 30 }, (_, i) => ({ name: `Customer ${i}`, type: "customer" })) }), 25).length, 25);
});

test("identifiers match exactly or not at all: close embeddings of numbers are different things", () => {
  assert.deepEqual(resolve({ name: "3260364", type: "order" }, [{ rid: "#1:1", name: "3260372", type: "order", score: 0.97 }]), { create: true });
  assert.deepEqual(resolve({ name: "PO 4471", type: "order" }, [{ rid: "#1:1", name: "PO-4471", type: "order" }]), { use: "#1:1" }, "the same number written differently is the same");
});
