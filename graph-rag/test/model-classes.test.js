import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ancestorsOf,
  assertParents,
  classIndex,
  classKey,
  dependencyVisible,
  descendantsOf,
  mayHaveStages,
  normalizeClass,
  normalizeDependency,
  normalizeInstanceEdge,
  PRIMITIVES,
  primitivesOf,
} from "../src/model/classes.js";
import { parsePositionMap } from "../src/positions.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const positions = parsePositionMap(read("positions.json"));
const fixture = read("classes.json").classes.map((c) => normalizeClass(c, { positions }));
const index = classIndex(fixture);

test("the four primitives are the only roots (R1)", () => {
  assert.deepEqual(PRIMITIVES, ["agent", "commitment", "event", "resource"]);
  for (const p of PRIMITIVES) assert.deepEqual(index.get(p).parents, []);
  assert.throws(() => normalizeClass({ name: "Agent", parents: ["resource"], home: "org" }), /primitive: it has no parents/);
  assert.throws(() => normalizeClass({ name: "trucks", home: "org" }), /needs at least one parent/);
});

test("a class is scoped by home like any node: it needs one, and a known one", () => {
  assert.throws(() => normalizeClass({ name: "trucks", parents: ["resource"] }), /needs a home/);
  assert.throws(() => normalizeClass({ name: "trucks", parents: ["resource"], home: "nowhere" }, { positions }), /unknown position/);
  assert.equal(normalizeClass({ name: "trucks", parents: ["resource"], home: "everyone" }, { positions }).home, "everyone");
});

test("a class holds what R11 lists, and nothing else", () => {
  const c = normalizeClass({ name: "Leased Building", parents: ["resource"], home: "ops", description: "x", record_table: "mssql:dbo_Lease", rows_are_nodes: true, evidence: [{ kind: "table", ref: "mssql:dbo_Lease" }], extra: 1 }, { positions });
  assert.deepEqual(Object.keys(c).sort(), ["description", "evidence", "home", "key", "name", "parents", "record_table", "rows_are_nodes", "stages", "status"]);
  assert.equal(c.name, "Leased Building");
  assert.equal(c.key, "leased_building");
  assert.equal(classKey("leased-building"), c.key);
});

test("rows stay in the source unless the class says otherwise (R3)", () => {
  assert.equal(normalizeClass({ name: "invoices", parents: ["commitment"], home: "ops" }).rows_are_nodes, false);
  assert.equal(index.get("machines").rows_are_nodes, true);
  assert.throws(() => normalizeClass({ name: "x", parents: ["event"], home: "ops", rows_are_nodes: "yes" }), /true or false/);
});

test("evidence cites, never copies: a ref or a note, of a known kind", () => {
  assert.throws(() => normalizeClass({ name: "x", parents: ["event"], home: "ops", evidence: [{ kind: "rows" }] }), /ref .* or a note/);
  assert.throws(() => normalizeClass({ name: "x", parents: ["event"], home: "ops", evidence: [{ kind: "guess", note: "n" }] }), /must be one of/);
});

test("several parents (R9): ancestors, descendants and primitives follow every parent", () => {
  const idx = classIndex([...fixture, normalizeClass({ name: "leased vehicle", parents: ["leased building", "machines"], home: "ops" })]);
  assert.deepEqual(new Set(ancestorsOf("leased_vehicle", idx)), new Set(["leased_building", "machines", "resource"]));
  assert.deepEqual(primitivesOf("leased_vehicle", idx), ["resource"]);
  assert.deepEqual(new Set(descendantsOf("resource", idx)), new Set(["machines", "leased_building", "warehouse", "leased_vehicle"]));
  const both = classIndex([...fixture, normalizeClass({ name: "rental", parents: ["commitment", "resource"], home: "ops" })]);
  assert.deepEqual(new Set(primitivesOf("rental", both)), new Set(["commitment", "resource"]));
});

test("the user's example: leased building, warehouse under it, an address an instance of warehouse", () => {
  assert.deepEqual(ancestorsOf("warehouse", index), ["leased_building", "resource"]);
  const edge = normalizeInstanceEdge({ instance: "#12:3", class: "Warehouse", added_by: "worker" });
  assert.equal(edge.class, "warehouse");
});

test("assertParents refuses a cycle, a missing or retired parent, and a class reaching no primitive", () => {
  assert.throws(() => assertParents("leased_building", ["warehouse"], index), /below it: a cycle/);
  assert.throws(() => assertParents("warehouse", ["warehouse"], index), /a cycle/);
  assert.throws(() => assertParents("warehouse", ["depots"], index), /no class depots/);
  const retired = classIndex([...fixture, { ...normalizeClass({ name: "old", parents: ["event"], home: "ops" }), status: "retired" }]);
  assert.throws(() => assertParents("warehouse", ["old"], retired), /retired/);
  assert.deepEqual(assertParents("warehouse", ["leased building", "machines"], index), ["leased_building", "machines"]);
});

test("stages are for commitment classes only (R11)", () => {
  assert.equal(mayHaveStages("orders", index), true);
  assert.equal(mayHaveStages("machines", index), false);
});

test("a dependency is stated by a person, a record or an agent, between two instances (R1)", () => {
  const d = normalizeDependency({ from: "#1:1", to: "#1:2", stated_as: "record", stated_by: "doc-1", stated_at: "2026-11-01", valid_from: "2026-11-02" });
  assert.equal(d.stated_at, "2026-11-01T00:00:00.000Z");
  assert.throws(() => normalizeDependency({ from: "#1:1", to: "#1:1", stated_as: "person", stated_by: "bob" }), /itself/);
  assert.throws(() => normalizeDependency({ from: "#1:1", to: "#1:2", stated_as: "guess", stated_by: "bob" }), /must be one of/);
  assert.throws(() => normalizeDependency({ from: "#1:1", to: "#1:2", stated_as: "agent", stated_by: "w", valid_from: "2026-11-05", valid_until: "2026-11-01" }), /before it starts/);
});

test("a dependency edge is visible only to someone who sees both ends (R11)", () => {
  const seen = new Set(["#1:1"]);
  assert.equal(dependencyVisible({ from: "#1:1", to: "#1:2" }, (r) => seen.has(r)), false);
  seen.add("#1:2");
  assert.equal(dependencyVisible({ from: "#1:1", to: "#1:2" }, (r) => seen.has(r)), true);
});
