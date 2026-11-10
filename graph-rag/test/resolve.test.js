// Admission and resolution (src/resolve.js, src/sourceref.js) against the
// contract's fixtures: the admission test on the batches' known failures,
// each resolution stage, every oracle note's subjects, and source
// references against a fake database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { admits, classKind, hasDesignator, isRecordNumber, namesAnIndividual, classOfKey, confirmedClasses, hintType, memoryLookup, pickCandidate, resolveSubject, sameNamedPeople, subjectOf } from "../src/resolve.js";
import { referTo, sourceRefOf, sourceRefsOf, touchSourceRef, SOURCE_REF_FIELDS } from "../src/sourceref.js";
import { normalize } from "../src/things.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const CLASSES = read("classes.json");

/** a thing as the graph holds it */
const thing = (rid, label, { type = null, cls = null, keys = [], aliases = [] } = {}) => ({ rid, label, _norm: normalize(label), _alias_norms: aliases.map(normalize), _thing_type: type, _class: cls, _keys: keys });

/** an in-memory graph of things that applies what resolution asks to mint, the way the linker does */
function store(seed = []) {
  const things = [...seed];
  let n = 100;
  const lookup = memoryLookup(() => things);
  return {
    things,
    lookup,
    async resolve(subject, opts = {}) {
      const r = await resolveSubject(subject, { classes: CLASSES, lookup, ...opts });
      if (r.mint) {
        const made = thing(`#9:${n++}`, r.mint.name, { type: r.mint.type, cls: r.mint.class, keys: [r.mint.key] });
        things.push(made);
        return { ...r, thing: made, rid: made.rid, minted: true };
      }
      return r;
    },
  };
}

test("admission: the batches' known failures", () => {
  assert.equal(admits({ name: "holiday schedule" }).admitted, false, "a schedule is content inside a claim");
  assert.equal(admits({ name: "deburr bench" }, { references: 1 }).admitted, false, "a bench named once is a place inside a claim");
  assert.equal(admits({ name: "break room coffee maker" }, { references: ["ux-at03", "ux-au03"] }).admitted, false, "two references earn a node only for a name that picks out an individual");
  assert.deepEqual(admits({ name: "rack C1" }, { references: ["ux-ac13", "ux-ad15"] }).rule, 2, "a designated rack, referenced from two notes");
  assert.deepEqual(admits({ name: "4471", key: "mssql:dbo_Job:4471" }).rule, 1, "a record key is an identity");
  assert.equal(admits({ name: "job 4471" }, { hasKey: true }).admitted, true);
  assert.deepEqual(admits({ name: "Corvane sample order", kind: "commitment" }).rule, 3, "a commitment no source records");
  assert.equal(admits({ name: "Corvane quote" }, { isCommitment: true }).admitted, true);
  assert.deepEqual(admits({ name: "Tomas Reyes", actor: "person" }).rule, 1, "an actor outlives the document");
  assert.equal(admits({ name: "time clock" }, { references: 1, hasKey: false, isCommitment: false }).admitted, false);
  assert.match(admits({ name: "x" }).why, /content inside a claim/);
});

test("classes: only confirmed ones count, and a key finds its class by record table", () => {
  assert.deepEqual([...confirmedClasses(CLASSES).keys()], ["orders", "jobs", "hires", "maintenance"]);
  assert.deepEqual([...confirmedClasses([{ name: "a", status: "proposed" }, { name: "b", status: "confirmed" }, { name: "c" }]).keys()], ["b"], "proposed and unconfirmed are out");
  assert.equal(classOfKey("mssql:dbo_Job:4471", CLASSES)?.name, "jobs");
  assert.equal(classOfKey("mssql:dbo_Order:78912", CLASSES)?.name, "orders");
  assert.equal(classOfKey("mssql:dbo_Employee:NGUD", CLASSES), null, "no confirmed class records employees");
  assert.equal(hintType({ key: "mssql:dbo_Employee:NGUD" }), "person");
  assert.equal(hintType({ key: "mssql:dbo_Work_Center:INSPECT-2" }), "machine");
  assert.equal(hintType({ key: "mssql:dbo_Job:4471", class: "jobs" }), "order");
  assert.equal(hintType({ actor: "customer", key: "mssql:dbo_Customer:TORO" }), "customer");
  assert.equal(hintType({ class: "sample order" }), "sample order");
  assert.equal(hintType({}), "thing");
});

test("subjects: a string is a key when it parses, else a name; a mention's actor type is its actor", () => {
  assert.deepEqual(subjectOf("mssql:dbo_Job:4471"), { key: "mssql:dbo_Job:4471", name: "4471", class: null, actor: null, type: null, scope: null });
  assert.equal(subjectOf("Tomas Reyes").name, "Tomas Reyes");
  assert.equal(subjectOf({ name: "Diep", type: "person" }).actor, "person");
  assert.equal(subjectOf({ name: "CNC 2", type: "machine" }).actor, null);
  assert.equal(subjectOf({ name: "x", class: "orders" }, "jobs").class, "orders");
  assert.equal(subjectOf({ name: "x" }, "jobs").class, "jobs", "an instance takes the claim's class");
  assert.equal(subjectOf({ name: "quotes", class: "orders", scope: "class" }).scope, "class");
});

test("by key: an existing instance, else a new one with its class and source reference; the name becomes an alias", async () => {
  const s = store([thing("#1:1", "Toro", { type: "customer", keys: ["mssql:dbo_Customer:TORO"] })]);
  const found = await s.resolve({ key: "mssql:dbo_Customer:TORO", name: "Toro Plating Co" });
  assert.equal(found.how, "key");
  assert.equal(found.rid, "#1:1");
  assert.equal(found.confidence, 1);
  assert.equal(found.alias, "Toro Plating Co");
  const fresh = await resolveSubject({ key: "mssql:dbo_Job:4471", name: "job 4471" }, { classes: CLASSES, lookup: s.lookup });
  assert.equal(fresh.how, "key");
  assert.equal(fresh.rid, null);
  assert.deepEqual(fresh.mint, { key: "mssql:dbo_Job:4471", system: "mssql", table: "dbo_Job", row_key: "4471", class: "jobs", name: "job 4471", type: "order" });
  const unknown = await resolveSubject("mssql:dbo_Work_Center:INSPECT-2", { classes: CLASSES, lookup: s.lookup });
  assert.equal(unknown.mint.class, null, "a key of a table no confirmed class records still mints: the row is an identity");
  assert.equal(unknown.mint.name, "INSPECT-2");
  assert.equal(unknown.mint.type, "machine");
});

test("by class and name, then by alias, then by embedding; identifiers never embed; nothing unsure merges", async () => {
  const embed = (a, b) => ({ "toro inc|toro": 0.95, "toronto plating|toro": 0.84, "acme|toro": 0.4, "rack a|rack c": 0.97 })[`${normalize(a)}|${normalize(b)}`] ?? 0;
  const things = [
    thing("#1:1", "Toro", { type: "customer", cls: null, aliases: ["Toro Co."] }),
    thing("#1:2", "Toro", { type: "supplier" }),
    thing("#1:3", "4471", { type: "order", cls: "jobs", keys: ["mssql:dbo_Job:4471"] }),
    thing("#1:4", "CNC 2", { type: "machine" }),
    thing("#1:5", "rack C", { type: "place" }),
  ];
  const lookup = memoryLookup(things, { embed });
  const run = (subject) => resolveSubject(subject, { classes: CLASSES, lookup });
  let r = await run({ name: "4471", class: "jobs" });
  assert.equal(r.how, "class-name", "a confirmed class's instance by name");
  assert.equal(r.rid, "#1:3");
  r = await run({ name: "toro co", actor: "customer" });
  assert.equal(r.how, "class-name", "an actor by type and alias");
  assert.equal(r.rid, "#1:1");
  r = await run({ name: "Toro", actor: "supplier" });
  assert.equal(r.rid, "#1:2", "same name, another actor type: its own thing");
  r = await run({ name: "CNC 2", class: "work center" });
  assert.equal(r.how, "alias", "a class no person confirmed: by exact name, whatever the class");
  assert.equal(r.rid, "#1:4");
  r = await run({ name: "Toro" });
  assert.equal(r.how, "none");
  assert.equal(r.ambiguous, true, "two things by one name and no class or actor to tell them apart: nobody guesses");
  assert.deepEqual(r.candidates.map((c) => c.rid), ["#1:1", "#1:2"]);
  r = await run({ name: "Toro Inc", actor: "customer" });
  assert.equal(r.how, "embedding");
  assert.equal(r.rid, "#1:1");
  assert.equal(r.alias, "Toro Inc");
  assert.equal(r.confidence, 0.95);
  r = await run({ name: "Toronto Plating", actor: "customer" });
  assert.equal(r.how, "none");
  assert.equal(r.maybe, "#1:1", "close but unsure: a candidate, not a merge and not a new thing");
  r = await run({ name: "Acme", actor: "customer" });
  assert.equal(r.how, "none");
  assert.deepEqual(r.candidates, []);
  r = await run({ name: "3260364", class: "jobs" });
  assert.equal(r.how, "none", "a number matches exactly or not at all");
  r = await run({ name: "rack A", type: "place", class: "material rack" });
  assert.equal(r.how, "none", "rack A and rack C embed alike and are two racks");
  r = await run({ name: "quotes", class: "orders", scope: "class" });
  assert.equal(r.how, "none", "a class itself is no instance");
  r = await resolveSubject({ name: "Toro", actor: "customer" }, { classes: CLASSES, lookup: {} });
  assert.equal(r.how, "none", "no lookup at all: none, nothing thrown");
});

test("the residue's pick: one of the candidates found, or none", async () => {
  const lookup = memoryLookup([thing("#1:1", "Diep Nguyen", { type: "person", keys: ["mssql:dbo_Employee:NGUD"], aliases: ["Diep"] }), thing("#1:2", "Diep Tran", { type: "person", keys: ["mssql:dbo_Employee:NGDT"], aliases: ["Diep"] })]);
  const r = await resolveSubject({ name: "Diep", actor: "person" }, { classes: CLASSES, lookup });
  assert.equal(r.how, "none");
  assert.equal(r.candidates.length, 2);
  const picked = pickCandidate(r, "#1:1");
  assert.equal(picked.how, "residue");
  assert.equal(picked.rid, "#1:1");
  assert.equal(picked.alias, null, "Diep is already an alias");
  assert.equal(pickCandidate(r, "#1:9").how, "none", "a rid outside the candidates picks nothing");
  const byKey = await resolveSubject({ name: "Diep", actor: "person", key: "mssql:dbo_Employee:NGUD" }, { classes: CLASSES, lookup });
  assert.equal(byKey.how, "key");
  assert.equal(byKey.rid, "#1:1", "the same-named Diep: the key decides");
});

/** the oracle's keyless actors, as the condenser would mark them (the oracle's subjects are strings) */
const ACTORS = {
  Lucas: "person",
  "Marisol Vega": "person",
  "Tomas Reyes": "person",
  "Andre (Staffmark temp)": "person",
  Kayla: "person",
  "Darrin S.": "person",
  "the owner": "person",
  "the shop": "position",
  "the floor": "position",
  "second shift": "position",
  "Corvane Medical": "customer",
  "Brightline Medical": "customer",
  "Master Fluid": "supplier",
  Blaser: "supplier",
};
/** things the graph already holds when the oracle runs: the actors (some only under another name), two machines, four keyed rows */
const SEED = [
  thing("#2:1", "Lucas Moreau", { type: "person", aliases: ["Lucas"] }),
  thing("#2:2", "Marisol Vega", { type: "person" }),
  thing("#2:3", "Tomas Reyes", { type: "person" }),
  thing("#2:4", "Andre", { type: "person", aliases: ["Andre (Staffmark temp)"] }),
  thing("#2:5", "Kayla", { type: "person" }),
  thing("#2:6", "Darrin Sato", { type: "person", aliases: ["Darrin S."] }),
  thing("#2:7", "the owner", { type: "person" }),
  thing("#2:8", "the shop", { type: "team" }), // a hint, not an actor type: found by alias, not by class-name
  thing("#2:9", "the floor", { type: "position" }),
  thing("#2:10", "second shift", { type: "team" }),
  thing("#2:11", "Corvane Medical", { type: "customer" }),
  thing("#2:12", "Brightline Medical", { type: "customer" }),
  thing("#2:13", "Master Fluid", { type: "supplier" }),
  thing("#2:14", "Blaser", { type: "supplier" }),
  thing("#2:15", "CNC 1", { type: "machine" }),
  thing("#2:16", "CNC 2", { type: "machine" }),
  thing("#2:17", "Diep Nguyen", { type: "person", keys: ["mssql:dbo_Employee:NGUD"], aliases: ["Diep"] }),
  thing("#2:18", "Diep Tran", { type: "person", keys: ["mssql:dbo_Employee:NGDT"], aliases: ["Diep"] }),
  thing("#2:19", "Exatron", { type: "customer", keys: ["mssql:dbo_Customer:EXATRON"] }),
  thing("#2:20", "INSPECT-2", { type: "machine", keys: ["mssql:dbo_Work_Center:INSPECT-2"] }),
];

test("every oracle note's subjects: keys by key, actors by class-name or alias, nothing else minted; a job is one instance, its PO number no node", async (t) => {
  const notes = read("oracle-sixty.json");
  assert.ok(notes.length >= 62);
  const s = store(SEED);
  const before = s.things.length;
  const keyed = new Map(); // key -> rid
  const how = { key: 0, "class-name": 0, alias: 0, none: 0 };
  const minted = [];
  const byName = [];
  for (const note of notes) {
    for (const [j, c] of (note.claims ?? []).entries()) {
      const at = `${note.id}[${j}]`;
      const raw = String(c.subject);
      const m = /^(.*)\s\(class\)$/.exec(raw);
      const subject = m ? { name: m[1], class: c.class, scope: "class" } : ACTORS[raw] ? { name: raw, actor: ACTORS[raw] } : subjectOf(raw, c.class);
      const r = await s.resolve(subject);
      how[r.how]++;
      if (subject.key) {
        assert.equal(r.how, "key", `${at}: ${raw} resolves by key`);
        assert.ok(r.rid, `${at}: an instance`);
        if (keyed.has(subject.key)) assert.equal(r.rid, keyed.get(subject.key), `${at}: one instance per key`);
        keyed.set(subject.key, r.rid);
        if (r.minted) minted.push(subject.key);
      } else if (ACTORS[raw]) {
        assert.ok(["class-name", "alias"].includes(r.how), `${at}: actor ${raw} resolves by class-name or alias, got ${r.how}`);
        assert.ok(r.rid, `${at}: ${raw} found`);
      } else if (/^cnc [12]$/.test(normalize(raw))) {
        assert.equal(r.how, "alias", `${at}: a machine by name`);
        byName.push(raw);
      } else {
        assert.equal(r.how, "none", `${at}: "${raw}" (${c.class}) is content inside the claim, not a node`);
        assert.equal(r.mint, null, `${at}: nothing minted for "${raw}"`);
      }
    }
  }
  assert.equal(s.things.length - before, minted.length, "the only new things are instances minted by key");
  assert.ok(minted.every((k) => !SEED.some((x) => x._keys.includes(k))), "seeded keys were found, not minted");
  assert.ok(how.none > 0 && how.key > 0 && how["class-name"] > 0 && how.alias > 0);
  t.diagnostic(`oracle: ${how.key} by key (${minted.length} minted, ${keyed.size} distinct keys), ${how["class-name"]} by class-name, ${how.alias} by alias (${byName.length} machines by name), ${how.none} none`);
  // one key, one instance, however often it comes up (ux-note 13's job): the job's own row is the instance
  const job = (name) => s.resolve({ key: "mssql:dbo_Job:9100001", name, class: "jobs" });
  const first = await job("job 9100001");
  const second = await job("9100001");
  assert.equal(first.how, "key");
  assert.ok(first.minted, "the first mention mints the instance");
  assert.equal(first.thing._class, "jobs", "with its confirmed class, from the record table");
  assert.equal(second.how, "key");
  assert.equal(second.rid, first.rid, "the second finds it");
  assert.equal(second.minted, undefined);
  assert.equal(s.things.filter((x) => x._keys.includes("mssql:dbo_Job:9100001")).length, 1, "one instance");
  // ORACLE.md: the PO is an attribute of the job rows, never a node. In prose, keyless, it is content: no thing mints (or is found)
  const n = s.things.length;
  for (const name of ["PO 78912", "customer PO 78912", "Exatron PO 78912", "PO 78912 for Exatron", "order 78912", "78912"]) {
    const r = await s.resolve({ name, class: "orders" });
    assert.equal(r.mint, null, `${name}: nothing minted`);
    assert.equal(r.how, "none", `${name}: ${r.how}`);
  }
  assert.equal(s.things.length, n, "no keyless order things");
  // the same-named Diep (aq01): with the key the active employee; without it nobody guesses
  const aq01 = notes.find((x) => x.id === "ux-aq01");
  assert.equal((await s.resolve(subjectOf(aq01.claims[0].subject))).rid, "#2:17");
  const diep = await s.resolve({ name: "Diep", actor: "person" });
  assert.equal(diep.how, "none");
  assert.deepEqual(diep.candidates.map((c) => c.rid).sort(), ["#2:17", "#2:18"]);
});

test("a keyed mention finds the one keyless thing of its name; a thing holding another key, or of another kind, is another row (B14, B15)", async () => {
  const lookup = memoryLookup([
    thing("#1:1", "Exatron", { type: "customer" }),
    thing("#1:2", "Diep", { type: "person", keys: ["mssql:dbo_Employee:NGDT"] }),
    thing("#1:3", "Gridley", { type: "machine" }),
    thing("#1:4", "Twin", { type: "customer" }),
    thing("#1:5", "Twin", { type: "customer" }),
  ]);
  const run = (subject) => resolveSubject(subject, { classes: CLASSES, lookup });
  const exatron = await run({ key: "mssql:dbo_Customer:EXATRON" });
  assert.equal(exatron.how, "key", "the row is that keyless thing");
  assert.equal(exatron.rid, "#1:1");
  assert.equal(exatron.mint, null);
  assert.equal(exatron.key, "mssql:dbo_Customer:EXATRON", "the key it learns");
  const ngud = await run({ key: "mssql:dbo_Employee:NGUD", name: "Diep", actor: "person" });
  assert.equal(ngud.rid, null, "a key miss never falls through to a thing holding another key");
  assert.equal(ngud.mint?.key, "mssql:dbo_Employee:NGUD", "it mints its own instance");
  assert.ok((await run({ key: "mssql:dbo_Customer:GRIDLEY" })).mint, "a machine by that name is not the customer");
  assert.ok((await run({ key: "mssql:dbo_Customer:TWIN" })).mint, "two keyless candidates: nobody guesses, the key mints");
});

test("a key is the same key in any case: found, with the spelling the thing holds, and nothing minted (B15)", async () => {
  const lookup = memoryLookup([thing("#1:1", "Toro", { type: "customer", keys: ["mssql:dbo_Customer:TORO"] })]);
  const r = await resolveSubject({ key: "mssql:dbo_Customer:Toro" }, { classes: CLASSES, lookup });
  assert.equal(r.how, "key");
  assert.equal(r.rid, "#1:1");
  assert.equal(r.mint, null);
  assert.equal(r.key, "mssql:dbo_Customer:TORO", "the stored spelling: no second spelling is learned, no second SourceRef opened");
});

test("the same name under two classes: a thing of another class is not the subject, confirmed or not (B14)", async () => {
  const lookup = memoryLookup([thing("#1:1", "Q-77", { cls: "quotes" }), thing("#1:2", "Bench 4", { type: "place" })]);
  const r = await resolveSubject({ name: "Q-77", class: "orders" }, { classes: CLASSES, lookup });
  assert.equal(r.how, "none", "the alias step keeps out a thing of another class");
  assert.equal((await resolveSubject({ name: "Bench 4", class: "orders" }, { classes: CLASSES, lookup })).rid, "#1:2", "a thing with no class still fits");
  assert.equal((await resolveSubject({ name: "Q-77", class: "unconfirmed class" }, { classes: CLASSES, lookup })).how, "none", "an unconfirmed class still names its class");
});

test("same-named people: found, ambiguous, and flagged so no model's pick settles them (B16)", async () => {
  const lookup = memoryLookup([thing("#1:1", "Diep Nguyen", { type: "person", keys: ["k:a:1"], aliases: ["Diep"] }), thing("#1:2", "Diep Tran", { type: "person", keys: ["k:a:2"], aliases: ["Diep"] }), thing("#1:3", "Toro", { type: "customer" }), thing("#1:4", "Toro", { type: "supplier" })]);
  const diep = await resolveSubject({ name: "Diep", actor: "person" }, { classes: CLASSES, lookup });
  assert.equal(sameNamedPeople(diep), true);
  assert.equal(sameNamedPeople(await resolveSubject({ name: "Toro" }, { classes: CLASSES, lookup })), false, "two records by one name aren't people");
  assert.equal(sameNamedPeople(await resolveSubject({ key: "k:a:1" }, { classes: CLASSES, lookup })), false, "a key has said which");
});

test("admission: a commitment with no record table is rule 3; a state of a name is content; a second place is rule 2; an actor is rule 1", () => {
  assert.equal(admits({ name: "holiday schedule" }, { references: 1, isCommitment: false }).admitted, false);
  assert.equal(admits({ name: "payroll" }, { references: 1, isCommitment: false }).admitted, false);
  assert.equal(admits({ name: "rack C1" }, { references: 2, isCommitment: false }).rule, 2);
  assert.equal(admits({ name: "CNC 2 spindle bearing order" }, { references: 1, isCommitment: true }).rule, 3);
  assert.equal(admits({ name: "Tomas Reyes", actor: "person" }, { references: 1 }).rule, 1);
});

/** a fake ArcadeDB that understands the SQL sourceref.js sends */
function fakeDb() {
  const refs = [];
  const edges = [];
  const commands = [];
  let n = 1;
  const ridOf = (sql) => /FROM (#\d+:\d+)/.exec(sql)?.[1];
  return {
    refs,
    edges,
    commands,
    async query(sql, params = {}) {
      if (/FROM SourceRef WHERE key = :k/.test(sql)) return refs.filter((r) => r.key === params.k).map((r) => ({ ...r }));
      if (/outE\('REFERS_TO'\)/.test(sql)) return edges.filter((e) => e.from === ridOf(sql)).map((e) => ({ dst: e.to }));
      if (/out\('REFERS_TO'\)/.test(sql)) return edges.filter((e) => e.from === ridOf(sql)).map((e) => ({ ...refs.find((r) => r.rid === e.to) }));
      throw new Error(`unexpected query: ${sql}`);
    },
    async command(sql, params = {}) {
      commands.push(sql);
      if (/^CREATE (VERTEX TYPE|EDGE TYPE|PROPERTY|INDEX)/.test(sql)) return [];
      if (/^CREATE VERTEX SourceRef/.test(sql)) return void refs.push({ rid: `#30:${n++}`, ...params });
      if (/^UPDATE SourceRef/.test(sql)) return void Object.assign(refs.find((r) => r.key === params.k), { last_seen: params.last_seen, seen_by: params.seen_by });
      if (/^CREATE EDGE REFERS_TO FROM (#\d+:\d+) TO (#\d+:\d+)/.test(sql)) {
        const m = /FROM (#\d+:\d+) TO (#\d+:\d+)/.exec(sql);
        return void edges.push({ from: m[1], to: m[2] });
      }
      throw new Error(`unexpected command: ${sql}`);
    },
  };
}

test("source references: a key becomes a SourceRef once, touched after; never a copy of the row", async () => {
  assert.deepEqual(Object.keys(sourceRefOf("mssql:dbo_Job:4471", { seen_by: "alice", at: "2026-11-08T10:00:00.000Z" })), SOURCE_REF_FIELDS);
  assert.deepEqual(sourceRefOf("mssql:dbo_Job:4471", { seen_by: "alice", at: "2026-11-08T10:00:00.000Z" }), { key: "mssql:dbo_Job:4471", system: "mssql", table: "dbo_Job", row_key: "4471", last_seen: "2026-11-08T10:00:00.000Z", seen_by: "alice" });
  assert.equal(sourceRefOf("4471"), null);
  assert.equal(sourceRefOf("mssql:dbo_Job"), null, "a table is not a row");
  const db = fakeDb();
  const a = await touchSourceRef("mssql:dbo_Order:78912", { seen_by: "graph-rag linker", at: "2026-11-08T10:00:00.000Z", db });
  assert.equal(a.created, true);
  assert.ok(db.commands.some((c) => /CREATE VERTEX TYPE SourceRef IF NOT EXISTS/.test(c)), "the schema is declared first, idempotently");
  const b = await touchSourceRef("mssql:dbo_Order:78912", { seen_by: "bob/agent:floor", at: "2026-11-08T11:00:00.000Z", db });
  assert.equal(b.created, false);
  assert.equal(b.rid, a.rid);
  assert.equal(db.refs.length, 1, "one SourceRef per key");
  assert.equal(db.refs[0].last_seen, "2026-11-08T11:00:00.000Z");
  assert.equal(db.refs[0].seen_by, "bob/agent:floor");
  assert.deepEqual(Object.keys(db.refs[0]).filter((k) => k !== "rid").sort(), [...SOURCE_REF_FIELDS].sort(), "nothing of the row is stored");
  await assert.rejects(touchSourceRef("not a key", { db }), /not a record key/);
  assert.equal(db.commands.filter((c) => /CREATE VERTEX TYPE SourceRef/.test(c)).length, 1, "the DDL ran once");
});

test("an instance refers to its row: one REFERS_TO edge however often it is linked", async () => {
  const db = fakeDb();
  const first = await referTo("#1:7", "mssql:dbo_Order:78912", { seen_by: "graph-rag linker", db });
  assert.equal(first.edge, "created");
  assert.equal(first.created, true);
  const again = await referTo("#1:7", "mssql:dbo_Order:78912", { seen_by: "graph-rag linker", db });
  assert.equal(again.edge, "existing");
  assert.equal(again.created, false);
  assert.equal(db.edges.length, 1);
  assert.equal(db.refs.length, 1);
  const other = await referTo("#1:8", "mssql:dbo_Job:4471", { db });
  assert.equal(other.edge, "created");
  assert.deepEqual((await sourceRefsOf("#1:7", db)).map((r) => r.key), ["mssql:dbo_Order:78912"]);
  assert.deepEqual((await sourceRefsOf("#1:8", db)).map((r) => r.key), ["mssql:dbo_Job:4471"]);
  await assert.rejects(referTo("nope", "mssql:dbo_Job:4471", { db }), /not a record id/);
  assert.deepEqual(await sourceRefsOf("nope", db), []);
});


test("admission: what a second mention can't earn (B14), and what a row's number can't earn on a name (B17)", () => {
  for (const name of ["holiday schedule", "Holiday Schedule", "HOLIDAY SCHEDULES", "payroll", "Payroll", "Time Clock", "deburr bench", "Front Left Tire", "vacation calendar"]) {
    assert.equal(admits({ name }, { references: 9 }).admitted, false, `${name}: never a node, however often named`);
    assert.equal(admits({ name }, { references: 1, isCommitment: true }).admitted, false, `${name}: nor as a commitment's subject`);
    assert.equal(admits({ name, actor: "customer" }).admitted, false, `${name}: nor by calling it an actor`);
  }
  for (const name of ["overtime policy", "Second Shift", "the shop", "forklift", "shipping pickups", "holiday party 2026", "anti-fatigue mats at CNC 3", "CNC 2 spindle bearing order", "Saturday Overtime"])
    assert.equal(admits({ name }, { references: 3 }).admitted, false, `${name}: a phrase, not an individual`);
  for (const name of ["PO 78912", "P.O. 78912", "po-78912", "PO#78912", "purchase order 78912", "Job 4471", "invoice 553", "part EPP-D98", "78912", "SO 12"]) {
    assert.equal(isRecordNumber(name), true, `${name} is a row's number`);
    assert.equal(admits({ name }, { references: 5, isCommitment: true }).admitted, false, name);
    assert.equal(admits({ name, key: "mssql:dbo_Job:4471" }).rule, 1, `${name}: with its key it can be`);
  }
  for (const name of ["rack C1", "CNC 2", "Line 4", "Bench 4"]) assert.equal(admits({ name }, { references: 2 }).rule, 2, `${name}: designated`);
  for (const name of ["Tomas Reyes", "Kayla", "Corvane Medical", "Andre (Staffmark temp)", "Darrin S."]) assert.equal(admits({ name }, { references: 2 }).rule, 2, `${name}: a proper name`);
  assert.equal(admits({ name: "Tomas Reyes" }, { references: 1 }).admitted, false, "a proper name once isn't yet a thing");
  assert.equal(admits({ name: "CNC 2" }, { identity: true }).rule, 1, "a machine by name");
  assert.equal(namesAnIndividual("PO 78912"), false);
  assert.equal(hasDesignator("PO 78912"), false);
  assert.equal(hasDesignator("rack C1"), true);
});

test("classKind reads a class's head noun: the subject of a customer class is a customer, of a customer order isn't", () => {
  assert.equal(classKind("customer"), "customer");
  assert.equal(classKind("customer order"), null);
  assert.equal(classKind("supplier invoice"), null);
  assert.equal(classKind("vendor"), "supplier");
  assert.equal(classKind("employment"), "person");
  assert.equal(classKind("work center"), "machine");
  assert.equal(classKind("equipment"), "machine");
  assert.equal(classKind("training"), null);
  assert.equal(classKind(null), null);
});

test("same-named people, by every route that can settle a name (B16)", async () => {
  const twins = [thing("#1:1", "Diep C", { type: "person", keys: ["k:a:1"], cls: "hires" }), thing("#1:2", "Diep C", { type: "person", keys: ["k:a:2"] })];
  const lookup = memoryLookup(twins);
  const classes = [...confirmedClasses(CLASSES).values(), { name: "hires", status: "confirmed" }];
  const stamped = await resolveSubject({ name: "Diep C", class: "hires" }, { classes, lookup });
  assert.equal(stamped.how, "none", "the class route: one of them stamped doesn't make it that one");
  assert.equal(sameNamedPeople(stamped), true);
  assert.equal(stamped.candidates.length, 2);
  const otherClass = memoryLookup([thing("#1:1", "Diep C", { type: "person", cls: "hires" }), thing("#1:2", "Diep C", { type: "person", cls: "leave" })]);
  assert.equal((await resolveSubject({ name: "Diep C", class: "unconfirmed" }, { classes, lookup: otherClass })).how, "none", "the alias route, a class filtering one of them out or none");
  const leaves = await resolveSubject({ name: "Diep C", class: "hires" }, { classes, lookup: otherClass });
  assert.equal(sameNamedPeople(leaves), true, "class stamps tell no people apart");
  assert.equal((await resolveSubject({ name: "Diep C", actor: "person" }, { classes, lookup })).how, "none", "the actor route");
  assert.equal((await resolveSubject({ key: "k:a:1" }, { classes, lookup })).rid, "#1:1", "a key still says which");
  const one = memoryLookup([thing("#1:1", "Solo", { type: "person", cls: "hires" }), thing("#1:2", "Solo", { type: "machine" })]);
  assert.equal((await resolveSubject({ name: "Solo", class: "hires" }, { classes, lookup: one })).rid, "#1:1", "one person of that name and a machine: not same-named people");
  const near = memoryLookup([thing("#1:1", "Nguyen Diep", { type: "person" }), thing("#1:2", "Nguyen Diep", { type: "person" })], { embed: () => 0.99 });
  assert.equal(sameNamedPeople(await resolveSubject({ name: "Nguyen Diepp", actor: "person" }, { classes, lookup: near })), true, "the embedding route");
});

test("a keyless thing with a held key isn't keyless: a second key doesn't adopt it (B8)", async () => {
  const held = { ...thing("#1:1", "Gantry", { type: "customer" }), _held_key: true };
  const r = await resolveSubject({ key: "mssql:dbo_Customer:OTHER", name: "Gantry" }, { classes: CLASSES, lookup: memoryLookup([held]) });
  assert.ok(r.mint, "a different row: its own instance");
});
