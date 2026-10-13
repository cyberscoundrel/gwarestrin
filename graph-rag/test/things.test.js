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
