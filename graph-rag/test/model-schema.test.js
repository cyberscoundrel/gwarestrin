import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  ACTOR_TYPES,
  assertSubclassLink,
  authorityInChain,
  BUILTIN,
  CLASS_SELECT,
  classFromRow,
  shownClasses,
  DISCOVERY,
  discoveredHome,
  discoveryMayClassify,
  isDiscoveryReadTool,
  listedClasses,
  normalizeEvidence,
  planDiscoveryClass,
  CLAIM_KINDS,
  classAndSubclasses,
  classChain,
  confirmedClassMap,
  effectiveAttributes,
  effectiveRecordTable,
  effectiveStages,
  fromStatements,
  INSTANCE_CLASS_STATUSES,
  instanceClass,
  instanceEdgeSql,
  NEW_TYPES,
  parseKey,
  parseStatement,
  parseTable,
  planInstanceMigration,
  primitiveOf,
  PRIMITIVES,
  recordKey,
  rootClassStatements,
  statements,
  TYPES,
  UNRESOLVED_REASONS,
  validateClass,
} from "../src/model/schema.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/classes.json", import.meta.url), "utf8"));
const row = (name, status, parent, record_table = null, extra = {}) => ({ name, status, parent, record_table, ...extra });

test("the DDL is idempotent and parses back into the exported shapes", () => {
  const list = statements();
  assert.ok(list.length > 30);
  for (const s of list) assert.match(s, /IF NOT EXISTS/, s);
  const back = fromStatements(list);
  for (const [name, t] of Object.entries(TYPES)) {
    assert.equal(back[name].kind, t.kind, name);
    assert.deepEqual(back[name].properties, t.properties, `${name} properties`);
    assert.deepEqual(back[name].indexes, t.indexes, `${name} indexes`);
  }
  assert.deepEqual(Object.keys(back).sort(), Object.keys(TYPES).sort());
});

test("new types are declared before their properties; Entity is only extended", () => {
  const list = statements();
  for (const name of NEW_TYPES) {
    const decl = list.findIndex((s) => parseStatement(s).op === "type" && parseStatement(s).name === name);
    const firstProp = list.findIndex((s) => s.startsWith(`CREATE PROPERTY ${name}.`));
    assert.ok(decl >= 0, `${name} declared`);
    if (firstProp >= 0) assert.ok(decl < firstProp, `${name} declared before its properties`);
  }
  assert.ok(!list.some((s) => /CREATE (VERTEX|EDGE) TYPE Entity\b/.test(s)), "Entity exists already: never redeclared");
  assert.ok(list.includes("CREATE PROPERTY Entity._class IF NOT EXISTS STRING"));
  assert.ok(list.includes("CREATE PROPERTY Entity._on_record IF NOT EXISTS BOOLEAN"));
  assert.ok(list.includes("CREATE EDGE TYPE CLAIMS IF NOT EXISTS"));
  assert.ok(list.includes("CREATE INDEX IF NOT EXISTS ON SourceRef (key) UNIQUE"));
  assert.ok(list.includes("CREATE INDEX IF NOT EXISTS ON CLAIMS (class, attribute) NOTUNIQUE"));
});

test("the statement shapes match what server.js emits today", () => {
  assert.deepEqual(parseStatement("CREATE EDGE TYPE SOURCED_FROM IF NOT EXISTS"), { op: "type", kind: "edge", name: "SOURCED_FROM" });
  assert.deepEqual(parseStatement("CREATE PROPERTY Entity._keys IF NOT EXISTS LIST"), { op: "property", type: "Entity", name: "_keys", dataType: "LIST" });
  assert.deepEqual(parseStatement("CREATE INDEX IF NOT EXISTS ON ReadMark (who, pos) UNIQUE"), { op: "index", type: "ReadMark", properties: ["who", "pos"], unique: true });
  assert.throws(() => parseStatement("DROP TYPE Entity"), /not a schema statement/);
  assert.throws(() => parseStatement("CREATE PROPERTY Entity.x STRING"), /not a schema statement/, "nothing without IF NOT EXISTS");
});

test("a claim carries every field the design names, a class its stages and record table", () => {
  for (const f of ["kind", "class", "attribute", "value", "valid_from", "valid_until", "recorded_at", "recorded_by"]) assert.ok(f in TYPES.CLAIMS.properties, f);
  for (const f of ["name", "stages", "record_table", "confirmed_by", "confirmed_at"]) assert.ok(f in TYPES.CommitmentClass.properties, f);
  for (const f of ["key", "system", "table", "row_key", "last_seen"]) assert.ok(f in TYPES.SourceRef.properties, f);
  for (const f of ["key", "authorized_by", "position", "at", "change"]) assert.ok(f in TYPES.AuditEvent.properties, f);
  for (const f of ["_recorded_by", "_record_position", "_record_reason"]) assert.ok(f in TYPES.Entity.properties, f);
  assert.deepEqual(CLAIM_KINDS, ["commitment", "event", "state", "observation"]);
  assert.ok(ACTOR_TYPES.includes("person") && ACTOR_TYPES.includes("position"));
});

test("record keys follow the _keys convention: system:table:row", () => {
  assert.deepEqual(parseKey("mssql:dbo_Customer:TORO"), { key: "mssql:dbo_Customer:TORO", system: "mssql", table: "dbo_Customer", row_key: "TORO" });
  assert.equal(parseKey("mssql:dbo_Job:4471").row_key, "4471");
  assert.equal(parseKey("Job 4471"), null);
  assert.equal(parseKey("mssql:dbo_Job"), null, "a table is not a row");
  assert.deepEqual(parseTable("mssql:dbo_Job"), { system: "mssql", table: "dbo_Job" });
  assert.equal(parseTable("mssql:dbo_Job:4471"), null);
  assert.equal(recordKey({ record_table: "mssql:dbo_Job" }, 4471), "mssql:dbo_Job:4471");
  assert.equal(recordKey({ record_table: null }, 4471), null, "a class with no record table keys nothing");
  assert.equal(recordKey({ record_table: "mssql:dbo_Job" }, " "), null);
});

const fixtureRows = fixture.classes.map((c) => ({ ...c, status: "confirmed", parent: "commitment" }));
const classes = [
  ...fixtureRows,
  row("buildings", "confirmed", "resource"),
  row("leased_building", "confirmed", "buildings", null, { attributes: ["landlord"] }),
  row("warehouse", "confirmed", "leased_building", null, { attributes: ["dock_doors"] }),
  row("employees", "confirmed", "actor", "mssql:dbo_Employee"),
  row("drivers", "confirmed", "employees"),
  row("customers", "confirmed", "actor", "mssql:dbo_Customer"),
  row("notices", "proposed", "commitment"),
  row("old_things", "retired", "resource"),
  row("drafted_table", "proposed", "resource", "mssql:dbo_Draft"),
  row("orphan", "confirmed", "nowhere"),
  row("under_a_draft", "confirmed", "notices"),
  row("loop_a", "confirmed", "loop_b"),
  row("loop_b", "confirmed", "loop_a"),
];

test("the hierarchy is declared: a class is an Entity, two edges, and the database holds names apart, a class to one parent and an instance to one edge per class", () => {
  const list = statements();
  assert.deepEqual(PRIMITIVES, ["actor", "commitment", "event", "resource"]);
  assert.ok(!list.some((s) => /TYPE Class\b/.test(s)), "no separate vertex type: a class is an Entity, scoped like any node");
  assert.ok(list.includes("CREATE EDGE TYPE SUBCLASS_OF IF NOT EXISTS"));
  assert.ok(list.includes("CREATE EDGE TYPE INSTANCE_OF IF NOT EXISTS"));
  assert.deepEqual(TYPES.INSTANCE_OF.to, ["Entity:class"]);
  assert.deepEqual(TYPES.SUBCLASS_OF.from, ["Entity:class"]);
  assert.ok(list.includes("CREATE INDEX IF NOT EXISTS ON SUBCLASS_OF (child, status) UNIQUE"), "one confirmed parent, and at most one proposed in its place");
  assert.ok(list.includes("CREATE INDEX IF NOT EXISTS ON INSTANCE_OF (instance, class_rid) UNIQUE"), "several classes, one edge to each");
  assert.ok(list.includes("CREATE INDEX IF NOT EXISTS ON Entity (_class_name) UNIQUE"), "names held apart by the database");
  for (const f of ["_class_name", "_stages", "_record_table", "_status", "_confirmed_by", "_attributes", "_occurrences", "_reasons", "_evidence", "_discovered_as", "_homed_by"]) assert.ok(f in TYPES.Entity.properties, f);
  assert.ok(!Object.keys(TYPES.Entity.properties).some((p) => /primitive/.test(p)), "a class's primitive is its root: storing it could disagree when a class moves");
  for (const f of ["child", "status", "confirmed_by", "reason"]) assert.ok(f in TYPES.SUBCLASS_OF.properties, f);
  for (const f of ["subject", "subject_norm", "unresolved"]) assert.ok(f in TYPES.CLAIMS.properties, f);
  assert.deepEqual(UNRESOLVED_REASONS, ["no-class", "no-row", "ambiguous"]);
  assert.deepEqual(INSTANCE_CLASS_STATUSES, ["confirmed", "retired"]);
});

test("only the four primitives exist before anyone confirms anything", () => {
  const bare = confirmedClassMap([]);
  assert.deepEqual([...bare.keys()], PRIMITIVES);
  for (const p of PRIMITIVES) {
    assert.equal(bare.get(p).status, "confirmed", p);
    assert.equal(bare.get(p).confirmed_by, BUILTIN, `${p} was confirmed by no person`);
    assert.equal(bare.get(p).parent, null, `${p} is a root`);
  }
  for (const name of ["person", "customer", "supplier", "position", "agent"]) assert.ok(!bare.has(name), `${name} has to be discovered and confirmed`);
  assert.equal(confirmedClassMap([row("actor", "retired", null)]).get("actor").status, "confirmed", "a row cannot touch a root");
});

test("a class counts only when its whole chain to a root is confirmed", () => {
  const map = confirmedClassMap(classes);
  for (const name of ["jobs", "warehouse", "drivers"]) assert.ok(map.has(name), name);
  for (const name of ["notices", "old_things", "drafted_table"]) assert.ok(!map.has(name), `${name} is not confirmed`);
  assert.ok(!map.has("orphan"), "a parent nobody knows");
  assert.ok(!map.has("under_a_draft"), "a confirmed class under a draft is not in the tree yet");
  assert.ok(!map.has("loop_a") && !map.has("loop_b"), "a cycle reaches no root");
  assert.ok(!confirmedClassMap([{ name: "drafted", parent: "resource" }]).has("drafted"), "no status and no person is not confirmed");
  assert.ok(confirmedClassMap([{ name: "named", parent: "resource", confirmed_by: "admin" }]).has("named"), "no status, and a person on it, is");
});

test("the chain, the root, and a query on a class covering its subclasses", () => {
  assert.deepEqual(classChain("warehouse", classes), ["warehouse", "leased_building", "buildings", "resource"]);
  assert.equal(primitiveOf("warehouse", classes), "resource");
  assert.equal(primitiveOf("jobs", classes), "commitment");
  assert.equal(primitiveOf("drivers", classes), "actor");
  assert.deepEqual(classChain("notices", classes), [], "a draft has no chain");
  assert.equal(primitiveOf("notices", classes), null);
  assert.deepEqual(classAndSubclasses("leased_building", classes).sort(), ["leased_building", "warehouse"]);
  assert.deepEqual(classAndSubclasses("warehouse", classes), ["warehouse"]);
  assert.ok(classAndSubclasses("resource", classes).includes("warehouse"), "a root covers everything under it");
  assert.deepEqual(classAndSubclasses("notices", classes), [], "nothing is under a draft");
});

test("inheritance: the nearest stage list and record table up the chain, and every ancestor's attributes", () => {
  const tree = [row("orders", "confirmed", "commitment", "mssql:dbo_Order", { stages: ["quoted", "shipped"] }), row("rush_orders", "confirmed", "orders"), row("sample_orders", "confirmed", "orders", null, { stages: ["sent", "returned"] }), row("sample_rush", "confirmed", "sample_orders")];
  assert.deepEqual(effectiveStages("rush_orders", tree), ["quoted", "shipped"], "inherited");
  assert.deepEqual(effectiveStages("sample_orders", tree), ["sent", "returned"], "its own list wins");
  assert.deepEqual(effectiveStages("sample_rush", tree), ["sent", "returned"], "the nearest wins");
  assert.deepEqual(effectiveStages("warehouse", classes), [], "no stages up the chain, none in force");
  assert.equal(effectiveRecordTable("rush_orders", tree), "mssql:dbo_Order");
  assert.equal(effectiveRecordTable("warehouse", classes), null);
  assert.deepEqual(effectiveAttributes("warehouse", classes).sort(), ["dock_doors", "landlord"]);
});

test("authority along a chain: an attribute rule anywhere above beats a class-wide rule below, and the nearest wins on each level", () => {
  const chain = ["rush_jobs", "jobs", "commitment"];
  assert.equal(authorityInChain({ classes: { jobs: { authority: "ops" } } }, chain, "price"), "ops", "a rule on a parent applies to its subclasses");
  assert.equal(authorityInChain({ classes: { jobs: { authority: "ops" }, rush_jobs: { authority: "floor" } } }, chain, "price"), "floor", "the nearest class wins");
  assert.equal(authorityInChain({ classes: { jobs: { attributes: { price: "org" } }, rush_jobs: { authority: "floor" } } }, chain, "price"), "org", "an attribute rule above is more specific than a class-wide rule below");
  assert.equal(authorityInChain({ classes: { jobs: { attributes: { price: "org" } }, rush_jobs: { attributes: { price: "ops" } } } }, chain, "price"), "ops");
  assert.equal(authorityInChain({ attributes: { price: "org" }, classes: { jobs: { authority: "ops" } } }, chain, "price"), "org", "a named attribute goes before a class-wide rule");
  assert.equal(authorityInChain({ attributes: { pay: "org" }, classes: { jobs: { authority: "ops" } } }, chain, "price"), "ops");
  assert.equal(authorityInChain({ default: "ops" }, chain, "price"), "ops");
  assert.equal(authorityInChain({}, chain, "price"), null);
  assert.equal(authorityInChain({ classes: { jobs: { authority: "ops" } } }, chain, null), "ops", "with no attribute, the class-wide rule");
  assert.equal(authorityInChain({ classes: { jobs: { authority: "ops" } } }, ["jobs_moved", "other", "commitment"], "price"), null, "a class moved from under a rule stops inheriting it at once");
});

test("a subclass link: a confirmed parent, no root below anything, and no cycle, however long", () => {
  assert.equal(assertSubclassLink("depot", "leased_building", classes), true, "a draft under a confirmed class");
  assert.equal(assertSubclassLink("warehouse", "buildings", classes), true, "a move");
  assert.throws(() => assertSubclassLink("actor", "resource", classes), /^Error: child: /, "a root has no parent");
  assert.throws(() => assertSubclassLink("depot", "notices", classes), /^Error: parent: .*not a confirmed class/, "a tree is confirmed from the top");
  assert.throws(() => assertSubclassLink("depot", "made_up", classes), /^Error: parent: /);
  assert.throws(() => assertSubclassLink("warehouse", "warehouse", classes), /itself.*cycle/);
  assert.throws(() => assertSubclassLink("buildings", "warehouse", classes), /under "buildings".*cycle/, "two levels down is still a cycle");
});

test("the gate by key: only the confirmed class whose table holds it, or the subclass of it the subject names", () => {
  assert.deepEqual(instanceClass({ key: "mssql:dbo_Job:4471" }, classes), { class: "jobs", via: "key" });
  assert.deepEqual(instanceClass({ key: "mssql:dbo_Job:4471", class: "hires" }, classes), { class: "jobs", via: "key" }, "the table says what the row is");
  assert.deepEqual(instanceClass({ key: "mssql:dbo_Employee:NGUD", class: "drivers" }, classes), { class: "drivers", via: "key" }, "the row, as the more specific class the subject says it is");
  assert.deepEqual(instanceClass({ key: "mssql:dbo_Employee:NGUD", class: "buildings" }, classes), { class: "employees", via: "key" }, "a class unrelated to the row's is not taken");
  const unbound = instanceClass({ key: "mssql:dbo_Vendor:JOHNH" }, classes);
  assert.equal(unbound.reason, "no-class");
  assert.match(unbound.why, /mssql:dbo_Vendor/);
  assert.equal(instanceClass({ key: "mssql:dbo_Vendor:JOHNH", class: "hires" }, classes).reason, "no-class", "a class that doesn't hold the table can't claim its row");
  assert.equal(instanceClass({ key: "mssql:dbo_Vendor:JOHNH", actor: "supplier" }, classes).reason, "no-class", "nor can a word for what it is");
  assert.equal(instanceClass({ key: "mssql:dbo_Draft:1" }, classes).reason, "no-class", "a proposed class's table gives no instance");
  assert.equal(instanceClass({ key: "mssql:dbo_Old:1" }, [row("old", "retired", "resource", "mssql:dbo_Old")]).reason, "no-class", "a retired class admits no new instance");
  assert.equal(instanceClass({ key: "mssql:dbo_T:1" }, [row("x", "confirmed", "notices", "mssql:dbo_T"), row("notices", "proposed", "commitment")]).reason, "no-class", "a table on a class outside the tree gives nothing");
});

test("the gate by name: a confirmed class named for the subject, never the claim's class, and a person is not exempt", () => {
  assert.deepEqual(instanceClass({ name: "12 Dock Rd", class: "warehouse" }, classes), { class: "warehouse", via: "class" });
  assert.deepEqual(instanceClass({ name: "Maya", class: "hires" }, classes), { class: "hires", via: "class" });
  const bare = instanceClass({ name: "Tomas Reyes" }, classes);
  assert.equal(bare.class, null, "a bare name has no class of its own, whatever the claim bears on");
  assert.equal(bare.reason, "no-class");
  const before = instanceClass({ name: "Tomas Reyes", actor: "person" }, []);
  assert.equal(before.reason, "no-class", "before any class is confirmed a person is a value on the claim");
  assert.deepEqual(instanceClass({ name: "Tomas", actor: "person" }, [row("person", "confirmed", "actor")]), { class: "person", via: "class" }, "and once someone confirms that class, an instance");
  assert.equal(instanceClass({ name: "someone", class: "actor" }, classes).reason, "no-class", "a primitive holds no instances directly");
  assert.match(instanceClass({ name: "someone", class: "actor" }, classes).why, /primitive/);
  assert.equal(instanceClass({ name: "holiday schedule", class: "notices" }, classes).reason, "no-class", "a draft class mints nothing");
  assert.equal(instanceClass({ name: "x", class: "old_things" }, classes).reason, "no-class", "nor a retired one");
  assert.equal(instanceClass({ name: "x", class: "made_up" }, classes).reason, "no-class");
  assert.equal(instanceClass({ name: "x", class: "Warehouse" }, classes).reason, "no-class", "class names are exact");
  assert.equal(instanceClass({ scope: "class", class: "orders" }, classes).reason, "class-subject", "the class itself is no instance");
  assert.equal(instanceClass(undefined, classes).reason, "no-class");
});

test("the gate: a class recorded in a table needs the row, and a subclass shares its parent's table", () => {
  const po = instanceClass({ name: "PO 78912", class: "orders" }, classes.concat(row("orders", "confirmed", "commitment", "mssql:dbo_Order")));
  assert.equal(po.reason, "no-row", "however often the name comes up");
  assert.match(po.why, /mssql:dbo_Order/);
  const driver = instanceClass({ name: "Bob", class: "drivers" }, classes);
  assert.equal(driver.reason, "no-row", "a subclass with no table of its own still needs its parent's row");
  assert.match(driver.why, /mssql:dbo_Employee/);
});

test("a class's shape: a parent, a name that isn't a primitive, and stages on anything", () => {
  assert.equal(validateClass({ name: "warehouse", parent: "leased_building" }).name, "warehouse");
  assert.deepEqual(validateClass({ name: "machines", parent: "resource" }).stages, []);
  assert.deepEqual(validateClass({ name: "vehicles", parent: "resource", stages: ["in_service", "sold"] }).stages, ["in_service", "sold"], "a class can be of anything");
  assert.throws(() => validateClass({ name: "warehouse" }), /^Error: parent: /);
  assert.throws(() => validateClass({ parent: "resource" }), /^Error: name: /);
  assert.throws(() => validateClass({ name: "actor", parent: "resource" }), /^Error: name: /);
  assert.throws(() => validateClass({ name: "x", parent: "resource", record_table: "dbo_Customer" }), /^Error: record_table: /);
});

test("the roots are seeded with statements safe to repeat", () => {
  const list = rootClassStatements("org");
  assert.equal(list.length, PRIMITIVES.length);
  for (const [i, p] of PRIMITIVES.entries()) {
    assert.match(list[i], new RegExp(`^UPDATE Entity SET .* UPSERT WHERE _class_name = '${p}'$`));
    assert.match(list[i], /_kind = 'class'/);
    assert.match(list[i], /_status = 'confirmed'/);
    assert.match(list[i], /_confirmed_by = 'built-in'/);
    assert.match(list[i], /_homes = \['everyone'\]/, "a root is the one class everyone sees");
  }
  assert.deepEqual(rootClassStatements("org"), list, "the same on every start");
});

test("the edge statement repeats harmlessly and takes only rids", () => {
  assert.equal(instanceEdgeSql("#12:34", "#4:1", { migrated: true }), "CREATE EDGE INSTANCE_OF FROM #12:34 TO #4:1 IF NOT EXISTS SET instance = '#12:34', class_rid = '#4:1', migrated = true");
  assert.doesNotMatch(instanceEdgeSql("#1:2", "#4:1"), /migrated/);
  assert.throws(() => instanceEdgeSql("1:2) DELETE VERTEX Entity", "#4:1"), /not a rid/);
  assert.throws(() => instanceEdgeSql("#1:2", "jobs"), /not a rid/);
  assert.throws(() => instanceEdgeSql(undefined, "#4:1"), /not a rid/);
});

const thing = (rid, fields) => ({ rid, label: rid, ...fields });
const legacy = [{ name: "jobs", status: "confirmed", record_table: "mssql:dbo_Job", stages: ["planned"], confirmed_by: "admin" }, { name: "hires", status: "confirmed", record_table: null, stages: ["opened"], confirmed_by: "admin" }];

test("migration: each thing's class, surest signal first, and a claim's class never makes a person a hire", () => {
  const plan = planInstanceMigration({
    legacyClasses: legacy,
    things: [
      thing("#1:1", { _keys: ["mssql:dbo_Job:4471"], _thing_type: "order", _class: "wrong" }),
      thing("#1:2", { _thing_type: "person", _class: "hires" }),
      thing("#1:3", { _thing_type: "machine", _class: "jobs" }),
      thing("#1:4", { _keys: ["mssql:dbo_Quote:9"], _thing_type: "order", _class: "quotes" }),
      thing("#1:5", { _class: "hires" }),
    ],
  });
  const of = Object.fromEntries(plan.edges.map((e) => [e.rid, e]));
  assert.deepEqual([of["#1:1"].class, of["#1:1"].via, of["#1:1"].held], ["jobs", "key", false], "the record table settles it");
  assert.deepEqual(of["#1:1"].discarded, ["_class wrong", "_thing_type order"]);
  assert.deepEqual([of["#1:2"].class, of["#1:2"].via, of["#1:2"].held], ["person", "type", true], "a person is held: nobody has confirmed a class for people");
  assert.deepEqual(of["#1:2"].discarded, ["_class hires"], "the stamp came from a claim and is reported, not used");
  assert.deepEqual([of["#1:3"].class, of["#1:3"].via, of["#1:3"].held], ["machine", "type", true], "a machine stamped with a claim's class stays a machine");
  assert.deepEqual([of["#1:4"].class, of["#1:4"].via, of["#1:4"].held], ["quotes", "class", true], "a keyed thing's type was a guess from the table's name");
  assert.deepEqual([of["#1:5"].class, of["#1:5"].via, of["#1:5"].held], ["hires", "class", false]);
});

test("migration: it never confirms a class, and what it proposes sits under the right root", () => {
  const plan = planInstanceMigration({ things: [thing("#1:1", { _thing_type: "machine" }), thing("#1:2", { _thing_type: "machine" }), thing("#1:3", { _thing_type: "team" }), thing("#1:4", { _thing_type: "customer" }), thing("#1:5", { _thing_type: "project" })] });
  const of = Object.fromEntries(plan.classes.map((c) => [c.name, c]));
  assert.equal(plan.classes.filter((c) => c.name === "machine").length, 1, "one class however many things name it");
  assert.equal(of.machine.parent, "resource");
  assert.equal(of.team.parent, "actor");
  assert.equal(of.customer.parent, "actor");
  assert.equal(of.project.parent, "commitment");
  assert.equal(of.machine.proposed_by, "migration");
  assert.ok(plan.classes.every((c) => c.status === "proposed" && !c.confirmed_by));
  assert.ok(plan.edges.every((e) => e.held), "held until a person confirms the class");
});

test("migration: CommitmentClass rows are copied with their status, under commitment", () => {
  const plan = planInstanceMigration({ legacyClasses: [...legacy, { name: "drafted", status: "proposed", stages: ["x"] }, { name: "gone", status: "retired", stages: ["x"] }, { name: "commitment", status: "proposed" }] });
  const of = Object.fromEntries(plan.classes.map((c) => [c.name, c]));
  assert.equal(of.jobs.status, "confirmed");
  assert.equal(of.jobs.parent, "commitment");
  assert.equal(of.jobs.confirmed_by, "admin");
  assert.equal(of.drafted.status, "proposed");
  assert.equal(of.gone.status, "retired");
  assert.equal(of.commitment, undefined, "a root is never replaced by a copy");
  assert.equal(primitiveOf("jobs", plan.classes), "commitment", "and the copies are in the tree");
});

test("migration: a class-scope placeholder gets no edge, its claims move; a thing with nothing to go on is left for a person", () => {
  const plan = planInstanceMigration({ things: [thing("#1:1", { _thing_type: "class", _class: "quotes" }), thing("#1:2", { _thing_type: "thing" }), thing("#1:3", {}), thing("#1:4", { _keys: ["not a key"] })] });
  assert.deepEqual(plan.classSubjects, [{ rid: "#1:1", class: "quotes" }]);
  assert.deepEqual(plan.edges, [], "no instance is made of any of them");
  assert.deepEqual(plan.unclassified.map((u) => u.rid), ["#1:2", "#1:3", "#1:4"]);
  assert.deepEqual(plan.classes, [], "a placeholder names a class; it doesn't draft one");
});

test("migration is idempotent: applying a plan and planning again does nothing", () => {
  const input = { legacyClasses: legacy, things: [thing("#1:1", { _keys: ["mssql:dbo_Job:1"] }), thing("#1:2", { _thing_type: "machine" }), thing("#1:3", { _thing_type: "person", _class: "x" })] };
  const first = planInstanceMigration(input);
  assert.equal(first.edges.length, 3);
  const done = new Set(first.edges.map((e) => e.rid));
  const second = planInstanceMigration({ legacyClasses: input.legacyClasses, classes: first.classes, things: input.things.map((t) => ({ ...t, classed: done.has(t.rid) })) });
  assert.deepEqual(second, { classes: [], edges: [], classSubjects: [], unclassified: [] });
});

test("the old actor list is not a class vocabulary any more", () => {
  assert.ok(ACTOR_TYPES.includes("person"), "still exported while claims.js validates against it");
  assert.equal(instanceClass({ name: "x", actor: "person" }, []).class, null);
});

const tree = { root: "org", positions: { org: { name: "org" }, ops: { name: "Operations", parent: "org" }, floor: { name: "Floor", parent: "ops" }, sales: { name: "Sales", parent: "org" } } };
const notes = [{ kind: "note", ref: "#1:1", home: "floor" }, { kind: "note", ref: "#1:2", home: "floor" }];
const tableEv = [{ kind: "columns", ref: "mssql:dbo_Disciplinary", home: "org", detail: "EmployeeID, Action, Date" }];
const opts = { positions: tree };

test("what a discovery run made counts as confirmed, with nobody having confirmed it", () => {
  const made = row("employees", "confirmed", "actor", "mssql:dbo_Employee", { confirmed_by: "discovery" });
  assert.ok(confirmedClassMap([made]).has("employees"));
  assert.deepEqual(instanceClass({ key: "mssql:dbo_Employee:NGUD" }, [made]), { class: "employees", via: "key" }, "people are instances without anyone confirming anything");
  assert.deepEqual(instanceClass({ name: "x", class: "employees" }, [{ ...made, record_table: null }]), { class: "employees", via: "class" });
});

test("read-only is an exact tool list: nothing that writes, and no hint can add one", () => {
  for (const t of ["describe_entities", "read_records", "aggregate_records"]) assert.ok(isDiscoveryReadTool(t), t);
  for (const t of ["update_record", "create_record", "delete_record", "execute_entity", "enter_data", "READ_RECORDS", "read_records ", ""]) assert.ok(!isDiscoveryReadTool(t), JSON.stringify(t));
  assert.ok(isDiscoveryReadTool("list_views", ["list_views"]), "only a connection's own configured list adds a name");
});

test("evidence: required, bounded, and rows are cited by key", () => {
  assert.throws(() => normalizeEvidence([]), /^Error: evidence: /);
  assert.throws(() => normalizeEvidence(undefined), /^Error: evidence: /);
  assert.throws(() => normalizeEvidence([{ kind: "vibes", ref: "x" }]), /^Error: evidence\[0\]\.kind: /);
  assert.throws(() => normalizeEvidence([{ kind: "note" }]), /^Error: evidence\[0\]\.ref: /);
  assert.throws(() => normalizeEvidence([{ kind: "rows", ref: "Tomas Reyes, 34.50" }]), /cited by record key/);
  assert.deepEqual(normalizeEvidence([{ kind: "rows", ref: "mssql:dbo_Job:1, mssql:dbo_Job:2" }])[0].home, null);
  assert.equal(normalizeEvidence([{ kind: "columns", ref: "t", detail: "x".repeat(900) }])[0].detail.length, 300);
});

test("a discovered class's home follows its evidence: restricted material can't produce a name anyone lower can see", () => {
  assert.equal(discoveredHome({ pass: "floor", evidence: notes }, tree), "floor");
  assert.equal(discoveredHome({ pass: "floor", evidence: tableEv }, tree), "org", "evidence above the pass raises it");
  assert.equal(discoveredHome({ pass: "floor", evidence: [{ kind: "note", ref: "#1:9" }] }, tree), "org", "no home on the evidence fails to the root");
  assert.equal(discoveredHome({ pass: "floor", evidence: notes, read: ["ops"] }, tree), "ops", "what the run read raises it, whatever it cites");
  assert.equal(discoveredHome({ pass: "floor", evidence: [{ kind: "note", ref: "#1:9", home: "sales" }] }, tree), "org", "two branches meet at their common ancestor");
  assert.equal(discoveredHome({ pass: "ops", evidence: [{ kind: "note", ref: "#1:9", home: "everyone" }] }, tree), "ops", "what everyone can see constrains nothing");
});

test("a reader is listed only the classes it can see, and a hidden parent doesn't travel in the tree", () => {
  const rows = [row("buildings", "confirmed", "resource", null, { _homes: ["org"] }), row("warehouse", "confirmed", "buildings", null, { _homes: ["floor"] }), row("disciplinary_actions", "confirmed", "commitment", null, { _homes: ["org"] }), row("no_home_yet", "confirmed", "resource")];
  const floorHomes = new Set(["everyone", "floor"]);
  const seen = listedClasses(rows, floorHomes);
  assert.deepEqual(seen.map((c) => c.name).sort(), ["warehouse"], "a class with no home is the root's, as any node with no home is");
  assert.equal(seen.find((c) => c.name === "warehouse").parent, "resource", "the hidden parent is skipped");
  assert.deepEqual(listedClasses(rows, null).map((c) => c.name).sort(), ["buildings", "disciplinary_actions", "no_home_yet", "warehouse"], "the root reader sees all");
  assert.equal(listedClasses(rows, null).find((c) => c.name === "warehouse").parent, "buildings");
  assert.equal(instanceClass({ name: "x", class: "disciplinary_actions" }, seen).reason, "no-class", "to a writer who can't see it the class is simply not there");
  assert.deepEqual(instanceClass({ name: "x", class: "warehouse" }, seen), { class: "warehouse", via: "class" }, "and its chain still reaches a root for one who can");
});

const draft = (over = {}) => ({ name: "employees", parent: "actor", pass: "floor", evidence: [{ kind: "columns", ref: "mssql:dbo_Employee", home: "floor" }], record_table: "mssql:dbo_Employee", stages: [], ...over });

test("a discovery run creates a class usable at once, with its evidence and home", () => {
  const r = planDiscoveryClass(draft(), [], opts);
  assert.equal(r.action, "create");
  assert.equal(r.row.status, "confirmed");
  assert.equal(r.row.confirmed_by, DISCOVERY);
  assert.deepEqual(r.row._homes, ["floor"]);
  assert.deepEqual(r.row.discovered_as, ["employees"]);
  assert.equal(r.row.evidence[0].ref, "mssql:dbo_Employee");
  assert.deepEqual(instanceClass({ key: "mssql:dbo_Employee:NGUD" }, [r.row]), { class: "employees", via: "key" });
  assert.throws(() => planDiscoveryClass(draft({ evidence: [] }), [], opts), /evidence/, "nothing without evidence");
  assert.throws(() => planDiscoveryClass(draft({ parent: undefined }), [], opts), /parent/, "the agent decides the parent, but there is one");
  assert.throws(() => planDiscoveryClass(draft({ name: "actor" }), [], opts), /primitive/);
  assert.equal(planDiscoveryClass(draft({ name: "x", record_table: null, evidence: [notes[0]] }), [], opts).action, "skip", "one note is not a pattern");
  assert.equal(planDiscoveryClass(draft({ name: "x", record_table: null, evidence: notes }), [], opts).action, "create", "two are");
  assert.match(planDiscoveryClass(draft({ parent: "nope" }), [], opts).reason, /not a confirmed class/, "parents first");
});

const madeRow = (over = {}) => ({ name: "employees", parent: "actor", parent_by: DISCOVERY, status: "confirmed", confirmed_by: DISCOVERY, record_table: "mssql:dbo_Employee", discovered_as: ["employees"], evidence: [], _homes: ["ops"], ...over });

test("a re-run refreshes what discovery made and never touches what a person corrected", () => {
  const up = planDiscoveryClass(draft({ description: "staff", stages: ["active", "left"] }), [madeRow()], opts);
  assert.equal(up.action, "update");
  assert.deepEqual(up.patch, { description: "staff", stages: ["active", "left"] });
  assert.deepEqual(up._homes, ["ops", "floor"], "a lower pass that found it itself lists it there too");
  const locked = planDiscoveryClass(draft({ description: "staff", stages: ["x"], parent: "resource" }), [madeRow({ name: "people", confirmed_by: "alice", discovered_as: ["employees"] })], opts);
  assert.equal(locked.action, "evidence", "a person's name on it: found by the name discovery first used, and only the evidence grows");
  assert.equal(locked.name, "people");
  assert.equal(locked.patch, undefined);
  assert.equal(locked.parent, undefined);
  const moved = planDiscoveryClass(draft({ parent: "resource" }), [madeRow({ parent: "actor", parent_by: "alice" })], opts);
  assert.equal(moved.parent, "actor", "a person's move stands");
  assert.equal(planDiscoveryClass(draft({ parent: "resource" }), [madeRow()], opts).parent, "resource", "discovery's own link can change");
});

test("what a person retired stays retired, by name, by an older name or by table", () => {
  const retired = madeRow({ status: "retired", retired_by: "alice" });
  assert.equal(planDiscoveryClass(draft(), [retired], opts).action, "skip");
  assert.match(planDiscoveryClass(draft(), [retired], opts).reason, /retired/);
  assert.equal(planDiscoveryClass(draft({ name: "staff" }), [retired], opts).action, "skip", "the same table under another name");
  assert.equal(planDiscoveryClass(draft({ name: "staff", record_table: null }), [{ ...retired, discovered_as: ["staff", "employees"] }], opts).action, "skip", "an older name");
});

test("a run settles a draft from a worker or the migration", () => {
  const r = planDiscoveryClass(draft(), [{ name: "employees", status: "proposed", parent: "actor", confirmed_by: null }], opts);
  assert.equal(r.action, "confirm");
  assert.deepEqual(r.patch, { status: "confirmed", confirmed_by: DISCOVERY, stages: [] });
  const held = planInstanceMigration({ things: [thing("#1:1", { _thing_type: "machine" })] });
  assert.equal(planDiscoveryClass({ name: "machine", parent: "resource", pass: "org", evidence: tableEv }, held.classes, opts).action, "confirm", "the migration's held things can be settled by a run");
});

test("a run never moves a class under itself", () => {
  const rows = [madeRow({ name: "a", record_table: null, parent: "resource" }), madeRow({ name: "b", record_table: null, parent: "a" })];
  const r = planDiscoveryClass(draft({ name: "a", record_table: null, parent: "b" }), rows, opts);
  assert.equal(r.parent, "resource", "the cycle is refused and the existing link kept");
  assert.match(r.reason, /cycle/);
});

test("nothing a hidden name does tells a pass it exists", () => {
  const hidden = madeRow({ name: "disciplinary_actions", record_table: "mssql:dbo_D", discovered_as: ["disciplinary_actions"], _homes: ["org"] });
  const r = planDiscoveryClass(draft({ name: "disciplinary_actions", record_table: "mssql:dbo_D" }), [hidden], opts);
  assert.equal(r.action, "update");
  assert.deepEqual(r._homes, ["org", "floor"], "a lower pass that found it from what it can read adds its own home");
  assert.equal(r.reason, undefined);
});

test("a re-run leaves an entity a person retired or classified", () => {
  assert.ok(discoveryMayClassify({}));
  assert.ok(discoveryMayClassify({ classed_by: ["discovery"] }));
  assert.ok(!discoveryMayClassify({ _retired_by: "alice" }));
  assert.ok(!discoveryMayClassify({ classed_by: ["discovery", "alice"] }));
  assert.equal(instanceEdgeSql("#1:2", "#4:1", { by: DISCOVERY }), "CREATE EDGE INSTANCE_OF FROM #1:2 TO #4:1 IF NOT EXISTS SET instance = '#1:2', class_rid = '#4:1', added_by = 'discovery'");
});

test("a hidden subclass's visible instance reads as the class above it; a visible subclass under a hidden parent keeps its own name", () => {
  const rows = [row("buildings", "confirmed", "resource", null, { _homes: ["floor"] }), row("secret_sites", "confirmed", "buildings", null, { _homes: ["org"] }), row("hidden_top", "confirmed", "resource", null, { _homes: ["org"] }), row("visible_under", "confirmed", "hidden_top", null, { _homes: ["floor"] }), row("only_hidden", "confirmed", "resource", null, { _homes: ["org"] })];
  const floor = new Set(["everyone", "floor"]);
  assert.deepEqual(shownClasses(["secret_sites"], rows, floor), ["buildings"], "shown as the nearest class it can see");
  assert.deepEqual(shownClasses(["visible_under"], rows, floor), ["visible_under"]);
  assert.deepEqual(shownClasses(["only_hidden"], rows, floor), [], "never a root: it shows no class");
  assert.deepEqual(shownClasses(["only_hidden", "buildings"], rows, null), ["only_hidden", "buildings"], "the root reader sees them as they are");
  assert.deepEqual(classAndSubclasses("buildings", rows.map((r) => r)).sort(), ["buildings", "secret_sites"], "a query on the visible parent still covers the hidden subclass's instances, on the server");
});

test("a re-run never widens a home a person set", () => {
  const set = planDiscoveryClass(draft(), [madeRow({ _homes: ["org"], homed_by: "alice" })], opts);
  assert.deepEqual(set._homes, ["org"], "a person homed it; a lower pass adds nothing");
  const confirmed = planDiscoveryClass(draft(), [madeRow({ _homes: ["org"], confirmed_by: "alice" })], opts);
  assert.equal(confirmed.action, "evidence");
  assert.deepEqual(confirmed._homes, ["org"]);
});

test("the migration keeps today's vocabulary visible and files its own proposals for the root alone", () => {
  const plan = planInstanceMigration({ legacyClasses: legacy, things: [thing("#1:1", { _thing_type: "machine" })] });
  const of = Object.fromEntries(plan.classes.map((c) => [c.name, c]));
  assert.deepEqual(of.jobs._homes, ["everyone"], "a confirmed vocabulary everyone could read stays that way until someone re-homes it");
  assert.deepEqual(of.machine._homes, [], "a proposal seen by the root only (N2)");
});

test("a class row round-trips through its stored columns, and a bad evidence column costs nothing", () => {
  assert.match(CLASS_SELECT, /_class_name AS name/);
  assert.match(CLASS_SELECT, /outE\('SUBCLASS_OF'\)\[status = 'confirmed'\]\.inV\(\)\._class_name\) AS parent/, "the link's own status, not the class's");
  assert.deepEqual(classFromRow({ name: "x", status: "confirmed", evidence_json: '[{"kind":"note","ref":"#1:1"}]', stages: null }).evidence, [{ kind: "note", ref: "#1:1" }]);
  assert.deepEqual(classFromRow({ name: "x", evidence_json: "{broken" }).evidence, []);
  assert.deepEqual(classFromRow({ name: "x", stages: null }).stages, []);
});
