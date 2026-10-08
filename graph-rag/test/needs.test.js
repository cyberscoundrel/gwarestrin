import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePositionMap } from "../src/positions.js";
import { askerView, cosine, needName, openUntil, ownersFor, ownerView, pickPositions } from "../src/needs.js";

//            org (admin)
//      ┌──────┴──────┐
//     ops (alice)   sales (nobody)
//      └── floor (bob, dave)
const map = parsePositionMap({
  root: "org",
  positions: {
    org: { name: "Organization" },
    ops: { name: "Operations", parent: "org" },
    floor: { name: "Production floor", parent: "ops" },
    sales: { name: "Sales", parent: "org" },
  },
});
const holders = new Map([
  ["admin", ["org"]],
  ["alice", ["ops"]],
  ["bob", ["floor"]],
  ["dave", ["floor"]],
]);
const NOW = Date.parse("2026-10-08T12:00:00Z");

test("owners: whoever holds the entry's position, else the nearest one above that someone holds", () => {
  assert.deepEqual(ownersFor(map, "ops", holders, "bob"), ["alice"]);
  assert.deepEqual(ownersFor(map, "floor", holders, "carol"), ["bob", "dave"]);
  assert.deepEqual(ownersFor(map, "sales", holders, "bob"), ["admin"], "nobody at Sales: up to the root");
  assert.deepEqual(ownersFor(map, "floor", holders, "bob"), ["dave"], "the asker is never an owner");
});

test("a need stays open for the request lifetime, or until its subject ends", () => {
  assert.equal(openUntil(NOW, 14, null), "2026-10-22T12:00:00.000Z");
  assert.equal(openUntil(NOW, 14, "2026-10-16T23:59:59.000Z"), "2026-10-16T23:59:59.000Z", "Friday's visit: no use asking after Friday");
  assert.equal(openUntil(NOW, 14, "2027-01-01T00:00:00.000Z"), "2026-10-22T12:00:00.000Z");
  assert.match(needName("0123456789abcdef", "When is Sandra here on Friday?"), /^Question 01234567: When is Sandra/);
});

test("posting by description: closest positions above the bar, never ones that see it already", () => {
  const positions = [
    { id: "ops", vec: [1, 0, 0] },
    { id: "floor", vec: [0.9, 0.1, 0] },
    { id: "sales", vec: [0, 1, 0] },
  ];
  assert.equal(Math.round(cosine([1, 0, 0], [1, 0, 0]) * 100), 100);
  assert.deepEqual(pickPositions([1, 0, 0], positions, new Set(["floor"])).map((p) => p.id), ["ops"]);
  assert.deepEqual(pickPositions([0, 0, 1], positions).map((p) => p.id), [], "nothing fits: posted nowhere");
  assert.equal(pickPositions([1, 0.2, 0], positions).length, 2, "at most two");
});

const need = (over = {}) => ({ qid: "q1", question: "When does the Toro order go to plating?", status: "open", open_until: "2026-10-22T12:00:00.000Z", asker: "bob", asked: 1, ...over });

test("the asker sees 'asked' whether nothing matched, something did, or owners declined", () => {
  const none = askerView(need(), [], NOW);
  const some = askerView(need(), [{ state: "open", name: "Toro PO" }], NOW);
  const declined = askerView(need(), [{ state: "declined", name: "Toro PO" }], NOW);
  for (const v of [none, some, declined]) {
    assert.equal(v.status, "asked");
    assert.deepEqual(v.shared, []);
  }
  assert.deepEqual(Object.keys(none).sort(), Object.keys(declined).sort());
});

test("the asker sees what was shared, and what turned up that they can see", () => {
  const v = askerView(need(), [{ state: "shared", name: "Toro PO" }, { state: "visible", name: "Plating schedule" }, { state: "open", name: "Pricing" }], NOW);
  assert.equal(v.status, "shared");
  assert.deepEqual(v.shared, ["Toro PO", "Plating schedule"]);
  assert.equal(v.still_open, true);
  assert.equal(askerView(need({ open_until: "2026-10-08T11:00:00.000Z" }), [], NOW).status, "expired");
  assert.equal(askerView(need({ status: "proposed" }), [], NOW).status, "proposed");
  assert.equal(askerView(need({ status: "withdrawn" }), [{ state: "shared", name: "x" }], NOW).still_open, false);
});

test("an owner sees only their own meetings; a posted need asks them to add what they know", () => {
  const v = ownerView(need(), [{ rid: "#1:1", name: "Toro PO", home: "Operations", state: "open" }], NOW);
  assert.deepEqual(v.entries, [{ key: "#1:1", name: "Toro PO", home: "Operations", shared: false }]);
  assert.equal(v.status, "open");
  assert.equal(v.posted, false);
  assert.equal(ownerView(need(), [{ rid: "#1:1", name: "Toro PO", home: "Operations", state: "shared" }], NOW).status, "shared");
  assert.equal(ownerView(need(), [{ rid: "#1:1", name: "Toro PO", home: "Operations", state: "declined" }], NOW).status, "dismissed");
  const posted = ownerView(need(), [], NOW);
  assert.equal(posted.posted, true);
  assert.equal(posted.status, "open");
});
