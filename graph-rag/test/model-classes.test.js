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

// ---- the classes and discovery stream: seed, home from evidence, corrections, nodes, timeline, report ----
import * as model from "../src/model/classes.js";

test("decision and action are seeded under event, at the roots' home (R1)", () => {
  const seeded = model.seedClasses();
  assert.deepEqual(seeded.map((c) => c.key), ["agent", "commitment", "event", "resource", "decision", "action"]);
  assert.deepEqual(index.get("decision").parents, ["event"]);
  assert.deepEqual(index.get("action").parents, ["event"]);
  assert.deepEqual(primitivesOf("action", index), ["event"]);
  for (const c of seeded) assert.equal(c.home, "everyone");
  // still only four roots
  assert.deepEqual(seeded.filter((c) => !c.parents.length).map((c) => c.key), PRIMITIVES);
});

const homes = { mssql: "floor", hr: "org", open: "everyone", sales: "ops" };
const ctx = { positions, connectionHome: (s) => homes[s] ?? null, noteHome: (r) => ({ n1: "floor", n2: "ops", n3: "everyone" })[r] ?? null };

test("a class from a table takes the home of the connection that reads it (R11)", () => {
  assert.equal(model.homeFromEvidence([{ kind: "table", ref: "mssql:dbo_Job" }], ctx), "floor");
  assert.equal(model.homeFromEvidence([{ kind: "rows", ref: "hr:dbo_Pay:7" }], ctx), "org");
  assert.equal(model.homeFromEvidence([{ kind: "columns", ref: "open:dbo_Part" }], ctx), "everyone");
});

test("a connection with no home, an unknown table or no evidence fails upward to the root", () => {
  assert.equal(model.homeFromEvidence([{ kind: "table", ref: "elsewhere:dbo_X" }], ctx), "org");
  assert.equal(model.homeFromEvidence([{ kind: "table", note: "a table somewhere" }], ctx), "org");
  assert.equal(model.homeFromEvidence([], ctx), "org");
});

test("a class from notes takes the strictest home among them (R11)", () => {
  assert.equal(model.homeFromEvidence([{ kind: "notes", ref: "n1" }, { kind: "notes", ref: "n2" }], ctx), "ops");
  assert.equal(model.homeFromEvidence([{ kind: "notes", ref: "n1" }, { kind: "notes", ref: "n3" }], ctx), "floor");
  // a note with no ref, or one nobody knows, counts as the root's
  assert.equal(model.homeFromEvidence([{ kind: "notes", ref: "n1" }, { kind: "notes", note: "someone said" }], ctx), "org");
});

test("wider only when wider evidence independently supports it (R11)", () => {
  // restricted notes, and a table everyone's connection reads: the table supports it on its own
  assert.equal(model.homeFromEvidence([{ kind: "notes", ref: "n2" }, { kind: "table", ref: "open:dbo_Part" }], ctx), "everyone");
  // two tables on one chain: the deeper (wider) one
  assert.equal(model.homeFromEvidence([{ kind: "table", ref: "sales:dbo_Order" }, { kind: "table", ref: "mssql:dbo_Job" }], ctx), "floor");
});

test("evidence on different branches: neither is wider, so the common ancestor (NEEDS A RULING)", () => {
  const branched = parsePositionMap({ root: "org", positions: { org: { name: "o" }, a: { name: "a", parent: "org" }, b: { name: "b", parent: "org" } } });
  assert.equal(model.widestHome(branched, ["a", "b"]), "org");
  assert.equal(model.widestHome(branched, ["a", "a"]), "a");
});

test("a class is never seen where one of its parents is not: strictest wins (R9, NEEDS A RULING)", () => {
  assert.equal(model.classHome("floor", ["ops"], positions), "ops");
  assert.equal(model.classHome("everyone", ["everyone"], positions), "everyone");
  const idx = classIndex([
    normalizeClass({ name: "leased building", parents: ["resource"], home: "org" }),
    normalizeClass({ name: "warehouse", parents: ["leased building", "machines"], home: "floor" }),
    normalizeClass({ name: "machines", parents: ["resource"], home: "floor" }),
  ]);
  const own = { leased_building: "ops", warehouse: "floor", machines: "floor" };
  const got = model.treeHomes(idx, (c) => own[c.key], positions);
  assert.equal(got.get("warehouse"), "ops");
  assert.equal(got.get("machines"), "floor");
  assert.equal(got.get("resource"), "everyone");
});

test("a correction pins what it sets, and the latest of retire and restore wins (R11)", () => {
  const by = "admin";
  const cs = [
    model.normalizeCorrection({ kind: "home", value: "ops", by }, { positions }),
    model.normalizeCorrection({ kind: "retire", by }),
    model.normalizeCorrection({ kind: "rows_are_nodes", value: true, by }),
  ];
  assert.deepEqual(model.pinned(cs), { home: "ops", rows_are_nodes: true });
  assert.equal(model.retiredBy(cs), true);
  assert.equal(model.retiredBy([...cs, model.normalizeCorrection({ kind: "restore", by })]), false);
  assert.throws(() => model.normalizeCorrection({ kind: "home", value: "nowhere", by }, { positions }), /unknown position/);
  assert.throws(() => model.normalizeCorrection({ kind: "retire" }), /needs the person/);
  assert.throws(() => model.normalizeCorrection({ kind: "merge", by }), /must be one of/);
});

test("a rerun never brings back a retired class, by name or by table, nor a renamed one's old name (R11)", () => {
  const jobs = { ...index.get("jobs"), corrections: [model.normalizeCorrection({ kind: "retire", by: "admin" })] };
  const stored = [model.applyCorrections(jobs), index.get("orders")];
  assert.equal(stored[0].status, "retired");
  assert.throws(() => model.assertCreatable(normalizeClass({ name: "Jobs", parents: ["commitment"], home: "floor" }), stored), /retired by a person/);
  assert.throws(() => model.assertCreatable(normalizeClass({ name: "work orders", parents: ["commitment"], home: "floor", record_table: "mssql:dbo_job" }), stored), /retired by a person/);
  assert.throws(() => model.assertCreatable(normalizeClass({ name: "orders", parents: ["commitment"], home: "ops" }), stored), /exists already/);
  const renamed = model.applyCorrections({ ...index.get("machines"), corrections: [model.normalizeCorrection({ kind: "rename", value: "work centers", from: "machines", by: "admin" })] });
  assert.equal(renamed.key, "work_centers");
  assert.throws(() => model.assertCreatable(normalizeClass({ name: "machines", parents: ["resource"], home: "floor" }), [renamed]), /renamed machines to work centers/);
  assert.doesNotThrow(() => model.assertCreatable(normalizeClass({ name: "vehicles", parents: ["resource"], home: "ops" }), stored));
});

test("the orchestrator can't change what a person pinned, nor touch a retired class", () => {
  const c = { ...index.get("machines"), corrections: [model.normalizeCorrection({ kind: "rows_are_nodes", value: false, by: "admin" })] };
  assert.throws(() => model.assertUnpinned(c, "rows_are_nodes"), /only a person changes it/);
  assert.doesNotThrow(() => model.assertUnpinned(c, "description"));
  assert.throws(() => model.assertUnpinned({ ...c, status: "retired" }, "description"), /retired/);
  const u = { ...c, corrections: [model.normalizeCorrection({ kind: "unrelate", instance: "#4:2", by: "admin" })] };
  assert.ok(model.unrelated(u).has("#4:2"));
});

test("a transactional row gets a node only for what the source can't hold (R3)", () => {
  const orders = index.get("orders"); // rows stay in the source
  assert.equal(model.mayMakeNode(orders, { key: "mssql:dbo_Order:9001" }).ok, false);
  assert.equal(model.mayMakeNode(orders, { key: "mssql:dbo_Order:9001", dependency: true }).ok, true);
  assert.equal(model.mayMakeNode(orders, { key: "mssql:dbo_Order:9001", reason: "the graph must say it waits on a permit" }).ok, true);
  assert.equal(model.mayMakeNode(index.get("machines"), { key: "mssql:dbo_Work_Center:CNC1" }).ok, true);
  assert.equal(model.mayMakeNode(index.get("machines"), { key: "mssql:dbo_Job:7" }).ok, true, "rows are nodes: any key");
  assert.equal(model.mayMakeNode(index.get("warehouse"), { key: null }).ok, true);
});

test("a timeline reads times plus dependency (R1)", () => {
  const items = [
    { id: "inventory", at: "2026-01-05" },
    { id: "lease", at: "2026-03-01" },
    { id: "broker", at: "2026-02-01" },
    { id: "nodate" },
  ];
  // inventory depends on the lease, the lease on the broker being paid
  const deps = [{ from: "inventory", to: "lease" }, { from: "lease", to: "broker" }];
  const order = model.timeline(items, deps).map((i) => i.id);
  assert.deepEqual(order, ["broker", "lease", "inventory", "nodate"]);
  assert.deepEqual(model.timeline(items, []).map((i) => i.id), ["inventory", "broker", "lease", "nodate"]);
  const cyc = model.timeline([{ id: "a" }, { id: "b" }], [{ from: "a", to: "b" }, { from: "b", to: "a" }]);
  assert.ok(cyc.every((i) => i.cycle));
});

test("the tree report lists every class under its parents with what a person checks (R5)", () => {
  const idx = classIndex([...fixture, normalizeClass({ name: "rental", parents: ["commitment", "resource"], home: "ops" })]);
  const text = model.treeReport(idx, { counts: new Map([["machines", 3]]) });
  assert.match(text, /^- agent/m);
  assert.match(text, /^ {2}- warehouse|^ {4}- warehouse/m);
  assert.match(text, /- machines \(home: floor; table mssql:dbo_Work_Center, rows are nodes; 3 instances\)/);
  assert.match(text, /- rental \(.*also under resource\)/);
  assert.match(text, /- rental \(.*also under commitment\)/);
  assert.match(text, /evidence: table mssql:dbo_Order/);
  assert.match(text, /^ {2}- decision/m);
});

// ---- the reviewer's items on ba583bc: 5 (stages), 11 (names per home), 7 (the mirror under agent) ----

test("a class not under commitment can't have stages: normalizeClass refuses them (R11, item 5)", () => {
  assert.throws(() => normalizeClass({ name: "trucks", parents: ["resource"], home: "ops", stages: ["parked", "driving"] }), /only a class under commitment has stages/);
  assert.deepEqual(normalizeClass({ name: "inspections", parents: ["event", "commitment"], home: "ops", stages: ["due"] }).stages, ["due"], "one parent under commitment is enough");
  assert.deepEqual(normalizeClass({ name: "rush jobs", parents: ["jobs"], home: "floor", stages: ["rushed"] }, { index }).stages, ["rushed"]);
  assert.throws(() => normalizeClass({ name: "rush jobs", parents: ["jobs"], home: "floor", stages: ["rushed"] }), /isn't in the class tree given/);
  assert.throws(() => normalizeClass({ name: "big machines", parents: ["machines"], home: "floor", stages: ["x"] }, { index }), /only a class under commitment/);
});

test("a class name is unique in the organization: a rerun can't make again a class a person re-homed (review C-B3)", () => {
  // the orchestrator made it from a floor note; a person moved it to ops; a rerun computes the floor again
  const moved = { ...normalizeClass({ name: "warehouse", parents: ["resource"], home: "ops" }), corrections: [model.normalizeCorrection({ kind: "home", value: "ops", by: "admin" }, { positions })] };
  const rerun = normalizeClass({ name: "Warehouse", parents: ["resource"], home: "floor" });
  assert.throws(() => model.assertCreatable(rerun, [moved]), /exists already/);
  assert.equal(model.NAMES_UNIQUE, true);
});

test("a class the writer can't see still takes its name, and the refusal never names it (item 11)", () => {
  const hidden = { ...normalizeClass({ name: "Board Succession", parents: ["commitment"], home: "org" }), corrections: [] };
  const sees = (h) => h !== "org";
  let message = null;
  try {
    model.assertCreatable(normalizeClass({ name: "board succession", parents: ["commitment"], home: "floor" }), [hidden], { sees });
  } catch (e) {
    message = e.message;
  }
  assert.ok(message, "refused: names are unique in the organization");
  assert.doesNotMatch(message, /Board Succession/, "it doesn't repeat the hidden class's own name");
  assert.doesNotMatch(message, /org|retired|renamed/, "nor where it is or what became of it");
  // a renamed hidden class's old name: taken, unnamed
  const renamed = { ...hidden, name: "Exit plan", key: "exit_plan", corrections: [model.normalizeCorrection({ kind: "rename", value: "Exit plan", from: "Board Succession", by: "admin" })] };
  assert.throws(() => model.assertCreatable(normalizeClass({ name: "board succession", parents: ["commitment"], home: "floor" }), [renamed], { sees }), (e) => !/Exit plan/.test(e.message));
});

test("a row of another table isn't a class's row: no node through the wrong class (R3, review non-blocking 8)", () => {
  assert.equal(model.mayMakeNode(index.get("orders"), { key: "mssql:dbo_Invoice:9" }).ok, false);
});

test("the tree report keeps the subclasses of a retired class, marked (R5, review non-blocking 5)", () => {
  const idx = classIndex([...fixture.map((c) => (c.key === "leased_building" ? { ...c, status: "retired" } : c))]);
  const text = model.treeReport(idx);
  assert.match(text, /- leased building \[retired by a person\]/);
  assert.match(text, /- warehouse/);
});

test("positions are mirrored as classes under agent, nested as the positions are, people as their instances (R6)", () => {
  const got = model.positionClasses(positions);
  assert.deepEqual(got.map((c) => [c.key, c.parents]), [
    ["top_of_the_organization", ["agent"]],
    ["operations", ["top_of_the_organization"]],
    ["production_floor", ["operations"]],
  ]);
  assert.ok(got.every((c) => c.home === "everyone" && c.position));
  const people = model.peopleInstances(positions, [
    { user: "alice", positions: ["ops"] },
    { user: "bob", positions: ["floor", "ops"] },
    { user: "bob/agent:floor", positions: ["floor"] },
    { user: "nobody", positions: ["gone"] },
  ]);
  assert.deepEqual(people.map((p) => [p.key, p.classes]), [
    ["authentik:user:alice", ["operations"]],
    ["authentik:user:bob", ["production_floor", "operations"]],
  ]);
  // the mirror is a tree under agent the model accepts
  const idx = classIndex(got.map((c) => normalizeClass(c, { positions })));
  assert.deepEqual(primitivesOf("production_floor", idx), ["agent"]);
});

test("the AI agents are instances under agent: the orchestrator and the Graph worker profile (R1)", () => {
  assert.deepEqual(model.AI_AGENTS.map((a) => [a.name, a.classes]), [
    ["Orchestrator", ["agent"]],
    ["Graph worker", ["agent"]],
  ]);
});

test("a new instance with no evidence lives at its writer's home, not the root, so the writer finds it again (review C-B4)", async () => {
  const { instanceHome } = await import("../src/instances.js");
  const ctx = { positions, connectionHome: (s) => ({ e2econn: null, open: "everyone" })[s] ?? null, noteHome: (n) => ({ n1: "floor" })[n] ?? null };
  assert.equal(instanceHome({ writer: "floor" }, ctx), "floor");
  assert.equal(instanceHome({ home: "ops", key: "open:dbo_Bin:1", writer: "floor" }, ctx), "ops", "a section's home, given by the caller, wins (R11.8)");
  assert.equal(instanceHome({ key: "open:dbo_Bin:1", writer: "floor" }, ctx), "everyone");
  assert.equal(instanceHome({ notes: ["n1", "gone"], writer: "floor" }, ctx), "org", "a note the writer can't see counts as the root's");
});
