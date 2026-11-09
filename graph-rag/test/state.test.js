// State queries (src/state.js) over the sixty-note oracle's claims, through an injected query
// function standing in for ArcadeDB: the oracle's subjects become things, each note a section homed
// where the oracle says it was placed, each claim a CLAIMS edge row. The oracle gives no recording
// time, so each note is recorded a day after the one before it (batch order), which is what makes
// decision 3's closing visible: a later note on the same attribute closes the earlier one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeClaim, subjectId } from "../src/model/claims.js";
import { parsePositionMap, visibleHomes } from "../src/positions.js";
import { asOfDate, claimsOfThing, conflicts, conflictsOf, currentState, findThings, history, historyOf, inForceAt, stateAsOf, stateAt, stateOfAttribute, subjectRef, toClaim } from "../src/state.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const POSITION = { floor: "floor", Ops: "ops", "admins-only": "org", org: "org" };
const notes = read("oracle-sixty.json");
const map = parsePositionMap(read("positions.json"));

/** the oracle's own notations into the contract's (as test/oracle.test.js maps them) */
function adapt(c) {
  const m = typeof c.subject === "string" ? /^(.*)\s\(class\)$/.exec(c.subject) : null;
  const { authority: _authority, ...claim } = c;
  return m ? { ...claim, subject: { scope: "class", name: m[1] } } : claim;
}
/** note n was recorded n hours after 2026-10-01 (the sixty-two span three days, all before any dated claim) */
const recordedAt = (n) => new Date(Date.UTC(2026, 9, 1, n)).toISOString();

/**
 * The oracle as a graph: things (one per subject), sections (one per note, homed where the oracle
 * placed it), and CLAIMS edge rows between them, in the shape ArcadeDB returns them.
 */
function graph() {
  const things = new Map(); // subjectId -> thing row
  const sections = new Map(); // rid -> section row
  const edges = []; // CLAIMS rows
  let t = 0;
  let e = 0;
  notes.forEach((note, n) => {
    const srid = `#20:${n}`;
    sections.set(srid, { rid: srid, name: note.title, _home: POSITION[note.placed.home], _kind: null, _written_by: note.writer });
    (note.claims ?? []).forEach((raw, j) => {
      const c = normalizeClaim({ ...adapt(raw), id: `${note.id}[${j}]` }, note.id, { recordedAt: recordedAt(n), recordedBy: note.writer, section: n });
      // one thing per subject, whatever class each claim bears on (Kayla is one person: a need, an
      // assignment and a hire are claims about her, not three of her)
      const sid = c.subject.key ? `key|${c.subject.key}` : `name|${subjectId(c.subject).split("|").at(-1)}`;
      if (!things.has(sid)) {
        const name = c.subject.name ?? c.subject.key.split(":").at(-1);
        things.set(sid, {
          rid: `#10:${t++}`,
          label: name,
          name: `${name} (thing)`,
          _thing_type: c.subject.actor ?? "other",
          _norm: name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(),
          _alias_norms: [],
          _keys: c.subject.key ? [c.subject.key] : [],
          _class: c.subject.class,
          _homes: [],
        });
      }
      const thing = things.get(sid);
      thing._homes = [...new Set([...thing._homes, POSITION[note.placed.home]])];
      edges.push({
        rid: `#30:${e++}`,
        src: srid,
        dst: thing.rid,
        id: c.id,
        kind: c.kind,
        class: c.class,
        attribute: c.attribute,
        value: c.value,
        value_num: c.value_num,
        valid_from: c.valid_from,
        valid_until: c.valid_until,
        recorded_at: c.recorded_at,
        recorded_by: c.recorded_by,
        closed_by: null,
        _home: null,
      });
    });
  });
  return { things: [...things.values()], sections, edges };
}

const G = graph();
const pick = (sql, re) => re.exec(sql)?.[1];
const list = (s) => (s ? [...s.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, "$1")) : []);

/**
 * The injected query: answers the three statements state.js makes (things by key or name, a thing's
 * CLAIMS edges, the sources of those edges) over the oracle graph. `visible`: the homes the caller
 * sees (null = everything), applied to things and sources as the real home filter would; the test
 * checks that state.js asked for the filter when one applies.
 */
function fakeQuery(visible = null) {
  const calls = [];
  const q = async (sql) => {
    calls.push(sql);
    if (/^SELECT @rid AS rid, name, _home/.test(sql)) {
      if (visible) assert.match(sql, /_home IN \[/, "a scoped read of sources carries the home filter");
      const rids = pick(sql, /FROM \[([^\]]*)\]/).split(",");
      return rids.map((r) => G.sections.get(r)).filter((s) => s && (!visible || visible.has(s._home)));
    }
    if (/_kind = 'thing'/.test(sql)) {
      if (visible) assert.match(sql, /_home IN \[/, "a scoped read carries the home filter");
      const keys = list(pick(sql, /_keys CONTAINSANY (\[[^\]]*\])/));
      const norms = list(pick(sql, /_norm IN (\[[^\]]*\])/));
      const limit = Number(pick(sql, /LIMIT (\d+)/) ?? 50);
      return G.things
        .filter((t) => t._keys.some((k) => keys.includes(k)) || norms.includes(t._norm) || t._alias_norms.some((a) => norms.includes(a)))
        .filter((t) => !visible || t._homes.some((h) => visible.has(h)))
        .slice(0, limit);
    }
    if (/inE\('CLAIMS'\)/.test(sql)) {
      const rid = pick(sql, /FROM (#\d+:\d+)\)/);
      return G.edges.filter((e) => e.dst === rid);
    }
    throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
  };
  q.calls = calls;
  return q;
}

const scopeFor = (held) => {
  const homes = visibleHomes(map, held);
  return { homes, granted: { homes: new Set(), entities: [] }, root: homes === null };
};
const ROOT = scopeFor(["org"]);
const FLOOR = scopeFor(["floor"]);
const NOW = "2026-11-08T12:00:00.000Z";

test("a subject reference is a key, a name, or a contract subject", () => {
  assert.deepEqual(subjectRef("mssql:dbo_Job:4471"), { key: "mssql:dbo_Job:4471", name: null, norm: null });
  assert.deepEqual(subjectRef("  Kayla "), { key: null, name: "Kayla", norm: "kayla" });
  assert.deepEqual(subjectRef({ key: "mssql:dbo_Employee:NGUD", name: "Diep" }), { key: "mssql:dbo_Employee:NGUD", name: "Diep", norm: "diep" });
  assert.throws(() => subjectRef(""), /say which thing/);
  assert.throws(() => subjectRef({ key: "not a key" }), /not a record key/);
  assert.equal(asOfDate("2026-12-01"), "2026-12-01T00:00:00.000Z", "a date alone is its start");
  assert.equal(asOfDate(undefined, Date.parse(NOW)), NOW);
  assert.throws(() => asOfDate("Friday"), /as_of must be an ISO date/);
});

test("the oracle's 100 claims all load as claims, every one reachable from its subject", async () => {
  const query = fakeQuery();
  let total = 0;
  for (const t of G.things) {
    const { claims } = await claimsOfThing({ rid: t.rid, name: t.label, type: t._thing_type, keys: t._keys, class: t._class }, { scope: ROOT, query });
    total += claims.length;
    for (const c of claims) {
      assert.ok(c.valid_from <= (c.valid_until ?? "9999"), `${c.id} interval`);
      assert.equal(c.section.name, notes.find((n) => n.id === c.id.replace(/\[\d+\]$/, "")).title, `${c.id} knows its section`);
    }
  }
  assert.equal(total, G.edges.length);
  assert.ok(total >= 100, `the oracle carries ${total} claims`);
  assert.equal(toClaim({ rid: "#30:9", kind: "state", attribute: "" }, { rid: "#10:0", keys: [] }), null, "a row with no attribute is not a claim");
});

test("current state is the latest claim per attribute; events are what happened, not what holds", async () => {
  const query = fakeQuery();
  const r = await currentState("Kayla", { scope: ROOT, query, now: Date.parse(NOW) });
  assert.equal(r.as_of, NOW);
  assert.equal(r.things.length, 1);
  const [k] = r.things;
  assert.equal(k.name, "Kayla");
  assert.equal(k.claims, 4);
  assert.equal(k.state.wants.value, "forklift certification", "an15: a need on Kayla, still open");
  assert.equal(k.state.ends.value, "extended through January", "ao04: the assignment's end");
  assert.equal(k.state.ends.valid_until, "2027-01-31T00:00:00.000Z");
  assert.equal(k.state.status, undefined, "au04's status holds from December 1, not yet");
  assert.equal(k.state.accepted, undefined, "the acceptance is an event: it happened, it is not a state");
  assert.equal(k.state.ends.section.name, "ux-ao04 kayla extended", "a state names the section it rests on");
  assert.equal(k.state.ends.section.home.id, "org", "and where that section lives");
});

test("as_of gives the states that held at a date: before and after a change", async () => {
  const query = fakeQuery();
  const before = await stateAsOf("Kayla", "2026-11-30", { scope: ROOT, query });
  const after = await stateAsOf("Kayla", "2026-12-15", { scope: ROOT, query });
  assert.equal(before.things[0].state.status, undefined);
  assert.equal(after.things[0].state.status.value, "permanent from 2026-12-01");
  assert.equal(after.things[0].state.ends.value, "extended through January", "still in force in December");
  const later = await stateAsOf("Kayla", "2027-02-10", { scope: ROOT, query });
  assert.equal(later.things[0].state.ends, undefined, "ended January 31");
  assert.equal(later.things[0].state.status.value, "permanent from 2026-12-01", "open-ended: still holds");
  const early = await stateAsOf("Kayla", "2026-09-01", { scope: ROOT, query });
  assert.deepEqual(early.things[0].state, {}, "nothing was known yet");
});

test("a subject is found by its record key, and the key comes first when a name matches too", async () => {
  const query = fakeQuery();
  const r = await currentState("mssql:dbo_Job:4471", { scope: ROOT, query, now: Date.parse(NOW) });
  assert.equal(r.things.length, 1);
  assert.deepEqual(r.things[0].keys, ["mssql:dbo_Job:4471"]);
  assert.equal(r.things[0].state.priority.value, "proposed: ahead of BSE");
  assert.equal(r.things[0].state.request.value, "Toro asks to rush PO 4471 ahead of BSE");
  const things = await findThings([subjectRef("mssql:dbo_Employee:NGUD"), subjectRef("Kayla")], { scope: ROOT, query });
  assert.equal(things[0].keys[0], "mssql:dbo_Employee:NGUD", "keyed match first");
  assert.equal(things[1].name, "Kayla");
  const none = await currentState("nobody at all", { scope: ROOT, query });
  assert.deepEqual(none.things, []);
  assert.match(none.note, /nothing called "nobody at all"/);
});

test("decision 3: the next claim on the same attribute closes the open one; history shows the succession", async () => {
  const query = fakeQuery();
  // ac13 (rack C1 holds titanium) then ad15 (holds aluminum), hours apart in this fixture
  const h = await history("rack C1", "holds", { scope: ROOT, query });
  assert.equal(h.attribute, "holds");
  const [first, second] = h.things[0].history;
  assert.equal(first.value, "titanium");
  assert.equal(second.value, "aluminum");
  assert.equal(first.valid_until, second.valid_from, "closed when the next claim starts");
  assert.equal(first.closed_by, second.id);
  assert.equal(second.valid_until, null);
  const now = await currentState("rack C1", { scope: ROOT, query, now: Date.parse(NOW) });
  assert.equal(now.things[0].state.holds.value, "aluminum", "the later claim is the state");
  const then = await stateAsOf("rack C1", first.valid_from, { scope: ROOT, query });
  assert.equal(then.things[0].state.holds.value, "titanium", "the earlier one held before the change");
  // what one claim supersedes is not a contradiction
  const c = await conflicts("rack C1", { scope: ROOT, query });
  assert.deepEqual(c.things[0].conflicts, []);
  assert.equal((await history("rack C1", "Holds", { scope: ROOT, query })).attribute, "holds", "attributes normalize");
  await assert.rejects(history("rack C1", "", { scope: ROOT, query }), /which attribute/);
});

test("a contradiction is two claims on one attribute with overlapping intervals and different values", () => {
  const thing = { rid: "#10:99", name: "Diep", type: "person", keys: ["mssql:dbo_Employee:NGUD"] };
  const row = (over) => ({ rid: "#30:1", src: "#20:1", kind: "state", class: "employment", attribute: "pay_rate", value: "21.50 per hour", value_num: null, valid_from: "2026-10-01T09:00:00Z", valid_until: null, recorded_at: "2026-10-01T09:00:00Z", recorded_by: "alice", ...over });
  const a = toClaim(row({ id: "a" }), thing);
  const b = toClaim(row({ id: "b", rid: "#30:2", src: "#20:2", value: "22 per hour", recorded_by: "bob" }), thing);
  const same = toClaim(row({ id: "c", rid: "#30:3", src: "#20:3", recorded_by: "bob" }), thing);
  const later = toClaim(row({ id: "d", rid: "#30:4", src: "#20:4", value: "23 per hour", valid_from: "2026-11-01T09:00:00Z", recorded_at: "2026-11-01T09:00:00Z" }), thing);
  // the same start: neither closes the other, so two values clash
  const clash = conflictsOf([a, b]);
  assert.equal(clash.length, 1);
  assert.equal(clash[0].attribute, "pay_rate");
  assert.deepEqual(clash[0].claims.map((c) => c.id), ["a", "b"]);
  assert.deepEqual(conflictsOf([a, same]), [], "the same value twice is agreement");
  assert.deepEqual(conflictsOf([a, later]), [], "a later start closes the earlier: a succession");
  assert.equal(stateAt([a, later], "2026-11-08T00:00:00Z").pay_rate.id, "d");
  assert.equal(stateAt([a, later], "2026-10-15T00:00:00Z").pay_rate.id, "a");
  assert.equal(stateAt([a, b], "2026-11-08T00:00:00Z").pay_rate.id, "a", "two open claims: the first recorded wins until someone settles it");
  // an explicit interval that overlaps an open one
  const span = toClaim(row({ id: "e", rid: "#30:5", src: "#20:5", value: "20 per hour", valid_from: "2026-09-15T00:00:00Z", valid_until: "2026-11-30T00:00:00Z" }), thing);
  assert.deepEqual(conflictsOf([a, span]).map((c) => c.claims.map((x) => x.id)), [["a", "e"]]);
  assert.deepEqual(historyOf([later, a], "pay_rate").map((c) => c.id), ["a", "d"], "oldest first");
  assert.deepEqual(inForceAt([a, later], "2026-10-15T00:00:00Z").map((c) => c.id), ["a"]);
  assert.deepEqual(inForceAt([a, later], "2026-11-08T00:00:00Z").map((c) => c.id), ["d"]);
});

test("the oracle recorded an hour apart holds no contradiction: af04's 'no plans' and aq10's contingent plan are two attributes, not one", async () => {
  const query = fakeQuery();
  const r = await conflicts("the shop", { scope: ROOT, query });
  assert.deepEqual(r.things[0].conflicts, []);
  const s = await currentState("the shop", { scope: ROOT, query, now: Date.parse(NOW) });
  assert.equal(s.things[0].state.plan.value, "none", "af04 at Ops");
  assert.equal(s.things[0].state.contingent_plan, undefined, "aq10 holds from March 2027");
  assert.equal((await stateAsOf("the shop", "2027-03-02", { scope: ROOT, query })).things[0].state.contingent_plan.value.slice(0, 20), "lay off two people i");
  // every subject: closing leaves nothing overlapping
  let pairs = 0;
  for (const t of G.things) for (const th of (await conflicts(t._keys[0] ?? t.label, { scope: ROOT, query })).things) pairs += th.conflicts.length;
  assert.equal(pairs, 0);
});

test("a worker whose scope excludes a claim never sees it in state; the root sees all of them", async () => {
  // Diep (NGUD): a floor assignment (aq01, floor), a pay rate (aa07, admins-only), a work restriction (aw10, admins-only)
  const all = await currentState("mssql:dbo_Employee:NGUD", { scope: ROOT, query: fakeQuery(), now: Date.parse(NOW) });
  assert.ok(all.things[0].state.pay_rate, "the root sees the pay rate");
  assert.ok(all.things[0].claims >= 5);
  const floor = await currentState("mssql:dbo_Employee:NGUD", { scope: FLOOR, query: fakeQuery(FLOOR.homes), now: Date.parse(NOW) });
  assert.equal(floor.things.length, 1, "the thing itself is seen from the floor's own statements");
  assert.equal(floor.things[0].state.pay_rate, undefined, "the pay claim is not");
  assert.equal(floor.things[0].state.no_lifting_over, undefined, "nor the doctor's note");
  assert.ok(floor.things[0].claims < all.things[0].claims);
  for (const c of Object.values(floor.things[0].state)) assert.equal(c.section.home.id, "floor");
  // a claim raised to an authority position by its own _home is held back even when its section is seen
  const thing = { rid: "#10:0", name: "x", type: "other", keys: [] };
  const q = async (sql) => (/inE/.test(sql) ? [{ rid: "#30:1", src: "#20:1", id: "p", kind: "state", attribute: "pay", value: "9", valid_from: "2026-10-01T00:00:00Z", recorded_at: "2026-10-01T00:00:00Z", _home: "org" }] : [{ rid: "#20:1", name: "s", _home: "floor" }]);
  assert.equal((await claimsOfThing(thing, { scope: FLOOR, query: q })).claims.length, 0);
  assert.equal((await claimsOfThing(thing, { scope: ROOT, query: q })).claims.length, 1);
});

test("what a state read showed is recorded as read, by the homes of the sections it rests on", async () => {
  const seen = [];
  const reads = (identity, homes) => seen.push([identity.user, [...new Set(homes)].sort()]);
  await currentState("Kayla", { scope: ROOT, query: fakeQuery(), identity: { user: "admin" }, reads });
  assert.deepEqual(seen, [["admin", ["floor", "org"]]], "an15 on the floor, ao04 and au04 at the top");
  seen.length = 0;
  await currentState("Kayla", { scope: FLOOR, query: fakeQuery(FLOOR.homes), identity: { user: "bob" }, reads });
  assert.deepEqual(seen, [["bob", ["floor"]]], "only what the floor was shown");
  seen.length = 0;
  await currentState("Kayla", { scope: ROOT, query: fakeQuery(), reads });
  assert.deepEqual(seen, [], "no identity: nothing to record (a library call, not a caller's read)");
});

test("a question's subject and attribute resolve to the one thing with that state", async () => {
  const query = fakeQuery();
  const refs = [subjectRef("job 4471"), subjectRef("mssql:dbo_Job:4471"), subjectRef("4471")];
  const hits = await stateOfAttribute(refs, "priority", { scope: ROOT, query, now: Date.parse(NOW) });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].thing.keys[0], "mssql:dbo_Job:4471");
  assert.equal(hits[0].claim.value, "proposed: ahead of BSE");
  assert.deepEqual(await stateOfAttribute(refs, "stage", { scope: ROOT, query }), [], "no claim on that attribute: nothing to answer from");
  assert.deepEqual(await stateOfAttribute([subjectRef("Kayla")], "ends", { scope: FLOOR, query: fakeQuery(FLOOR.homes), now: Date.parse(NOW) }), [], "the floor can't see ao04, so there is no state to answer with");
});

test("every oracle subject answers a state query without error, at the root and from the floor", async () => {
  for (const t of G.things) {
    const ref = t._keys[0] ?? t.label;
    const r = await currentState(ref, { scope: ROOT, query: fakeQuery(), now: Date.parse(NOW) });
    assert.ok(r.things.length >= 1, `${ref} found`);
    const f = await currentState(ref, { scope: FLOOR, query: fakeQuery(FLOOR.homes), now: Date.parse(NOW) });
    for (const th of f.things) for (const c of Object.values(th.state)) assert.equal(c.section.home.id, "floor", `${ref}: the floor sees floor sections only`);
    await conflicts(ref, { scope: ROOT, query: fakeQuery() });
  }
});
