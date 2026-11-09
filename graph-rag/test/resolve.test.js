// Admission and resolution (src/resolve.js, src/sourceref.js) against the
// contract's fixtures: the admission test on the batches' known failures,
// each resolution stage, every oracle note's subjects, and source
// references against a fake database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { admits, classOfKey, confirmedClasses, hintType, memoryLookup, pickCandidate, resolveSubject, subjectOf } from "../src/resolve.js";
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
  assert.deepEqual(admits({ name: "break room coffee maker" }, { references: ["ux-at03", "ux-au03"] }).rule, 2, "referenced from two notes");
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

test("every oracle note's subjects: keys by key, actors by class-name or alias, nothing else minted; PO 78912 is one instance", async (t) => {
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
  // the two PO 78912 notes (ux-note 13 and 14) both name the PO a worker found in the ERP: one key, one instance, however often it comes up
  const po = (name) => s.resolve({ key: "mssql:dbo_Order:78912", name, class: "orders" });
  const first = await po("PO 78912");
  const second = await po("customer PO 78912");
  assert.equal(first.how, "key");
  assert.ok(first.minted, "the first mention mints the instance");
  assert.equal(first.thing._class, "orders", "with its confirmed class, from the record table");
  assert.equal(second.how, "key");
  assert.equal(second.rid, first.rid, "the second finds it");
  assert.equal(second.minted, undefined);
  assert.equal(s.things.filter((x) => x._keys.includes("mssql:dbo_Order:78912")).length, 1, "one instance");
  // without the key, the PO number in prose is content: nothing minted, not six keyless order things;
  // the one spelling that is the instance's own name finds it (by class and name), the rest resolve to nothing
  const n = s.things.length;
  for (const name of ["PO 78912", "customer PO 78912", "Exatron PO 78912", "PO 78912 for Exatron", "order 78912", "78912"]) {
    const r = await s.resolve({ name, class: "orders" });
    assert.equal(r.mint, null, `${name}: nothing minted`);
    assert.ok(r.how === "none" || (r.how === "class-name" && r.rid === first.rid), `${name}: ${r.how}`);
  }
  assert.equal((await s.resolve({ name: "PO 78912", class: "orders" })).how, "class-name", "the instance's own name finds it");
  assert.equal((await s.resolve({ name: "PO 78912" })).how, "alias", "even with no class: by exact name");
  assert.equal(s.things.length, n, "no keyless order things");
  // the same-named Diep (aq01): with the key the active employee; without it nobody guesses
  const aq01 = notes.find((x) => x.id === "ux-aq01");
  assert.equal((await s.resolve(subjectOf(aq01.claims[0].subject))).rid, "#2:17");
  const diep = await s.resolve({ name: "Diep", actor: "person" });
  assert.equal(diep.how, "none");
  assert.deepEqual(diep.candidates.map((c) => c.rid).sort(), ["#2:17", "#2:18"]);
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
