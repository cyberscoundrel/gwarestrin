// The Authority stream: visibility, proposals and grading as three readings of one rule,
// authority over a class of commitment (docs/ORGANIZATION-MODEL.md), over the contract's
// fixtures and the sixty-note oracle. decideWrite is decided purely here (ctx.policy and
// ctx.positions); the live-state paths (the derived floor, scope) are in authority-floor.test.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { authorityOf, claimHome, decide, validatePolicy, visible } from "../src/model/authority.js";
import { claimKeys, hasClaims, placeByClaims } from "../src/placement.js";
import { ancestors, EVERYONE, parsePositionMap } from "../src/positions.js";
import { decideWrite } from "../src/write.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const tree = read("positions.json");
//   org (admins only)
//    └ ops (Operations)
//       └ floor (Production floor)
const map = parsePositionMap(tree);
const policy = validatePolicy(read("policy.json"), map);
const { admin, alice, bob } = tree.identities;
const floorAgent = tree.identities["bob/agent:floor"];
const worker = { user: "admin/agent:w", positions: ["org"], caps: { write: "direct" }, role: { kind: "worker", job: "j1", entry: "#1:1" } };
// a sibling branch the batches don't have, for the hidden case
const wide = parsePositionMap({ ...tree, positions: { ...tree.positions, sales: { name: "Sales", parent: "org" } } });
const sam = { user: "sam", positions: ["sales"], caps: { write: "direct" } };
const pure = (extra = {}) => ({ policy, positions: map, ...extra });

test("claim keys: the class and attribute of each claim, from the claim or its subject; residue has none", () => {
  assert.deepEqual(claimKeys([{ class: "orders", attribute: "Unit Price" }, { subject: { key: "mssql:dbo_Job:1", class: "jobs" }, attribute: "shift_cover" }, { attribute: "pay" }, { kind: "event" }, null]), [
    { class: "orders", attribute: "unit_price" },
    { class: "jobs", attribute: "shift_cover" },
    { class: null, attribute: "pay" },
  ]);
  assert.equal(hasClaims({ name: "x", claims: [{ class: "orders", attribute: "quantity" }] }), true);
  assert.equal(hasClaims({ name: "x", claims: [] }), false);
  assert.equal(hasClaims({ name: "x", facets: { identity: "free text" } }), false, "no claims: the grader's residue");
});

test("decideWrite, reading 2: the write-or-propose decision is the rule", () => {
  // a floor worker can promise a shift swap, not a price
  assert.equal(decideWrite(bob, { kind: "upsert", cls: "jobs", attribute: "shift_cover" }, pure({ origin: "floor" })).action, "direct");
  const price = decideWrite(bob, { kind: "upsert", cls: "orders", attribute: "price" }, pure({ origin: "floor" }));
  assert.equal(price.action, "propose");
  assert.equal(price.home, "org", "the proposal is homed at the authority position: whoever holds it reviews it");
  assert.equal(price.authority, "org");
  assert.equal(price.floor, "org", "and the data may not land below it");
  assert.match(price.reason, /authority over orders\/price lies with Top of the organization/);
  assert.equal(decideWrite(alice, { kind: "upsert", cls: "orders", attribute: "quantity" }, pure({ origin: "ops" })).action, "direct");
  assert.equal(decideWrite(alice, { kind: "upsert", cls: "orders", attribute: "price" }, pure({ origin: "ops" })).action, "propose");
  assert.equal(decideWrite(admin, { kind: "upsert", cls: "hires", attribute: "pay" }, pure({ origin: "org" })).action, "direct");
  assert.equal(decideWrite(alice, { kind: "upsert", cls: "jobs", attribute: "shift_cover" }, pure({ origin: "ops" })).action, "direct", "ancestors command down");
  const own = decideWrite(bob, { kind: "upsert", cls: "visits", attribute: "date" }, pure({ origin: "floor" }));
  assert.deepEqual([own.action, own.home, own.floor, own.authority, own.reason], ["direct", "floor", "floor", null, ""], "no rule: the writer's own");
});

test("decideWrite: with several claims the strictest answer and the highest authority decide", () => {
  const claims = [
    { kind: "state", subject: { key: "mssql:dbo_Order:9001", class: "orders" }, attribute: "quantity", value: 120 },
    { kind: "state", subject: { key: "mssql:dbo_Order:9001", class: "orders" }, attribute: "price", value: 18.5 },
  ];
  const d = decideWrite(alice, { kind: "upsert", claims }, pure({ origin: "ops" }));
  assert.equal(d.action, "propose");
  assert.equal(d.authority, "org");
  assert.equal(d.home, "org");
  assert.equal(decideWrite(admin, { kind: "upsert", claims }, pure({ origin: "org" })).action, "direct");
  assert.equal(decideWrite(alice, { kind: "upsert", claims: [claims[0]] }, pure({ origin: "ops" })).action, "direct");
});

test("decideWrite: a writer on another branch is hidden, and its write is held at the common ancestor", () => {
  const d = decideWrite(sam, { kind: "upsert", cls: "jobs", attribute: "shift_cover" }, { policy, positions: wide, origin: "sales" });
  assert.equal(d.action, "hidden");
  assert.equal(d.home, "org", "held where someone with authority over both sides decides");
  assert.equal(d.floor, "org");
  assert.match(d.reason, /on another branch/);
  assert.equal(decideWrite(sam, { kind: "upsert", cls: "orders", attribute: "price" }, { policy, positions: wide, origin: "sales" }).action, "propose", "but may propose a price to the top");
});

test("decideWrite keeps today's site rules: queued writers, a worker's raw command, widening, a person's placement, asking on purpose", () => {
  const queued = decideWrite(floorAgent, { kind: "upsert", cls: "jobs", attribute: "shift_cover" }, pure({ origin: "floor" }));
  assert.equal(queued.action, "propose");
  assert.equal(queued.home, "floor", "no authority above: reviewed where it was written");
  assert.match(queued.reason, /queued/);
  assert.equal(decideWrite(admin, { kind: "command" }, pure()).action, "direct");
  assert.equal(decideWrite(worker, { kind: "command" }, pure()).action, "propose", "a worker's raw command is always a proposal");
  assert.equal(decideWrite(bob, { kind: "rehome", lives: "floor" }, pure({ to: "ops" })).action, "direct", "restricting applies");
  assert.equal(decideWrite(bob, { kind: "rehome", lives: "ops" }, pure({ to: "floor" })).action, "propose", "widening is a person's call");
  assert.equal(decideWrite(admin, { kind: "rehome", lives: "ops" }, pure({ to: EVERYONE })).action, "propose", "even the admin widens through approval");
  assert.equal(decideWrite(worker, { kind: "rehome", lives: "floor" }, pure({ to: "ops", placedBy: "alice" })).action, "propose", "a person placed it: an agent asks");
  assert.equal(decideWrite(alice, { kind: "rehome", lives: "floor" }, pure({ to: "ops", placedBy: "bob" })).action, "direct", "a person moves what a person placed");
  assert.equal(decideWrite(admin, { kind: "upsert" }, pure({ origin: "org", propose: true })).action, "propose");
  // moving an entry whose claims lie with an authority the mover lacks asks too, restricting or not
  assert.equal(decideWrite(bob, { kind: "rehome", lives: "floor", claims: [{ class: "hires", attribute: "pay" }] }, pure({ to: "ops" })).action, "propose");
  assert.equal(decideWrite(admin, { kind: "rehome", lives: "floor", claims: [{ class: "hires", attribute: "pay" }] }, pure({ to: "ops" })).action, "direct");
});

test("decideWrite unscoped: direct, unless the identity's writes are queued or it asked to propose", () => {
  assert.deepEqual(decideWrite(bob, { kind: "upsert" }), { action: "direct", floor: undefined, home: undefined, reason: "", authority: null, lift: null });
  assert.equal(decideWrite(floorAgent, { kind: "upsert" }).action, "propose");
  assert.equal(decideWrite(bob, { kind: "upsert" }, { propose: true }).action, "propose");
});

test("reading 3, placement by claim: a section goes where its most restricted claim goes, never below its origin, no grader", () => {
  const p = placeByClaims(map, { origin: "floor", claims: [{ class: "jobs", attribute: "shift_cover" }, { class: "orders", attribute: "price" }, { class: "orders", attribute: "quantity" }], policy });
  assert.equal(p.home, "org");
  assert.equal(p.authority, "org");
  assert.equal(p.graded, false);
  assert.match(p.note, /placed by its claims: orders\/price \(authority Top of the organization/);
  assert.deepEqual(p.claims.map((c) => c.home), ["floor", "org", "ops"], "each claim keeps its own home: three sensitivities, not one blob");
  const own = placeByClaims(map, { origin: "floor", claims: [{ class: "jobs", attribute: "shift_cover" }], policy });
  assert.deepEqual([own.home, own.authority], ["floor", "floor"]);
  assert.match(own.note, /at its origin|placed by its claims/);
  const none = placeByClaims(map, { origin: "ops", claims: [{ class: "visits", attribute: "date" }], policy });
  assert.deepEqual([none.home, none.authority], ["ops", null]);
  assert.match(none.note, /no rule/);
  assert.equal(placeByClaims(map, { origin: "ops", claims: [{ class: "jobs", attribute: "machine" }], policy }).home, "ops", "an ops note about floor work stays at ops: provenance never widens");
  assert.equal(placeByClaims(wide, { origin: "sales", claims: [{ class: "jobs", attribute: "machine" }], policy }).home, "org", "a sales note about a floor matter is held where both are seen");
});

test("placement by claim: an existing entry never widens; the derived floor still bounds it", () => {
  assert.equal(placeByClaims(map, { origin: "floor", claims: [{ class: "jobs", attribute: "machine" }], policy, existing: "ops" }).home, "ops", "a person's restriction stands");
  assert.equal(placeByClaims(map, { origin: "floor", claims: [{ class: "jobs", attribute: "machine" }], policy, existing: "ops", awaiting: true }).home, "floor", "held awaiting grading: placed like a new one");
  assert.equal(placeByClaims(map, { origin: "floor", claims: [{ class: "hires", attribute: "pay" }], policy, existing: "floor" }).home, "org", "a pay claim raises the section that carries it");
  const floored = placeByClaims(map, { origin: "floor", claims: [{ class: "jobs", attribute: "machine" }], policy, floor: "ops" });
  assert.equal(floored.home, "ops");
  assert.match(floored.note, /built from what its writer read/);
  assert.equal(placeByClaims(map, { origin: EVERYONE, claims: [{ class: "orders", attribute: "quantity" }], policy }).home, "ops", "written for everyone: a ruled class still goes to its authority");
  assert.equal(placeByClaims(map, { origin: EVERYONE, claims: [{ class: "visits", attribute: "date" }], policy }).home, EVERYONE);
});

test("the three readings agree on the fixtures: seen, entered directly, and homed at the writer's position are one answer", () => {
  const pairs = [["orders", "quantity"], ["orders", "price"], ["jobs", "shift_cover"], ["hires", "pay"], ["orders", "balance_due"], ["visits", "date"]];
  for (const who of [admin, alice, bob]) {
    const origin = who.positions[0];
    for (const [cls, attribute] of pairs) {
      const rule = decide(who, cls, attribute, policy, map);
      const write = decideWrite(who, { kind: "upsert", cls, attribute }, pure({ origin }));
      const placed = placeByClaims(map, { origin, claims: [{ class: cls, attribute }], policy });
      assert.equal(write.action, rule, `${who.user} ${cls}/${attribute}: proposals read the rule`);
      assert.equal(visible(who, cls, attribute, policy, map), rule === "direct", `${who.user} ${cls}/${attribute}: visibility reads the rule`);
      assert.equal(placed.home === origin, rule === "direct", `${who.user} ${cls}/${attribute}: a direct write is homed at its writer's position, a proposed one above`);
      assert.equal(placed.home, claimHome(map, origin, authorityOf(policy, cls, attribute)));
      assert.equal(write.floor, placed.home, "the write's floor is where the claim is homed");
    }
  }
});

// ---- the sixty-note oracle ----
const POSITION = { floor: "floor", Ops: "ops", "admins-only": "org", org: "org" };
const oracle = read("oracle-sixty.json");
const oraclePolicy = validatePolicy(read("policy-oracle.json"), map);
/** the one claim a map by class and attribute cannot reproduce: a question's authority follows what it asks about */
const EXCEPTIONS = ["ux-t07[1]"];

test("the oracle's authority column is a map by class and attribute, bar one claim", (t) => {
  const differ = [];
  let claims = 0;
  for (const note of oracle) {
    const origin = POSITION[note.origin_position];
    for (const [j, c] of (note.claims ?? []).entries()) {
      claims++;
      const expected = POSITION[c.authority];
      const ruled = authorityOf(oraclePolicy, c.class, c.attribute) ?? origin; // no rule: the writer's own
      if (ruled !== expected) differ.push(`${note.id}[${j}]`);
    }
  }
  t.diagnostic(`${claims} oracle claims; the map reproduces ${claims - differ.length}; differs on ${differ.join(", ") || "none"}`);
  assert.ok(claims >= 95);
  assert.deepEqual(differ, EXCEPTIONS, "ux-t07's question is admins-only because it asks about a margin: an attribute's authority the map cannot give a need");
});

test("for every oracle claim the three readings agree: the authority position enters it directly and sees it, lower positions are hidden, an agent for a lower one proposes", (t) => {
  const below = (pos) => Object.keys(map.positions).filter((p) => ancestors(map, p).includes(pos));
  const above = (pos) => ancestors(map, pos);
  let checked = 0;
  let sectionsAgree = 0;
  let notes = 0;
  for (const note of oracle) {
    const origin = POSITION[note.origin_position];
    const keys = (note.claims ?? []).map((c) => ({ class: c.class, attribute: c.attribute }));
    for (const [j, c] of (note.claims ?? []).entries()) {
      if (EXCEPTIONS.includes(`${note.id}[${j}]`)) continue;
      checked++;
      const authority = POSITION[c.authority];
      const holder = { positions: [authority], caps: { write: "direct" } };
      const label = `${note.id}[${j}] ${c.class}/${c.attribute}`;
      // reading 2: the position the oracle names enters it directly, and so do the positions above it
      assert.equal(decide(holder, c.class, c.attribute, oraclePolicy, map), "direct", `${label}: the authority position commits directly`);
      assert.equal(decideWrite(holder, { kind: "upsert", cls: c.class, attribute: c.attribute }, { policy: oraclePolicy, positions: map, origin: authority }).action, "direct", label);
      for (const p of above(authority)) assert.equal(decide({ positions: [p], caps: { write: "direct" } }, c.class, c.attribute, oraclePolicy, map), "direct", `${label}: ${p} is above`);
      // reading 1: a lower position does not see it (where a rule names the authority), and
      // reading 2: a person below proposes; so does an agent acting for them
      const ruled = authorityOf(oraclePolicy, c.class, c.attribute);
      for (const p of below(authority)) {
        const person = { positions: [p], caps: { write: "direct" } };
        const agent = { positions: [p], caps: { write: "queued" } };
        if (ruled) {
          assert.equal(visible(person, c.class, c.attribute, oraclePolicy, map), false, `${label}: ${p} is below the authority and does not see it`);
          assert.equal(decide(person, c.class, c.attribute, oraclePolicy, map), "propose", `${label}: ${p} proposes`);
        }
        assert.equal(decideWrite(agent, { kind: "upsert", cls: c.class, attribute: c.attribute }, { policy: oraclePolicy, positions: map, origin: p }).action, "propose", `${label}: an agent for ${p} proposes`);
        // and whatever it writes of it is homed where the authority sees it
        assert.equal(placeByClaims(map, { origin: p, claims: [c], policy: oraclePolicy }).home, ruled ? authority : p, `${label}: written from ${p}, homed at the authority`);
      }
      // reading 3: the writer's own standing is never hidden (provenance never fails)
      assert.notEqual(decide({ positions: [origin], caps: { write: "direct" } }, c.class, c.attribute, oraclePolicy, map), "hidden", label);
    }
    // the section carrying the note's claims goes where its most restricted claim goes
    if (keys.length) {
      notes++;
      const section = placeByClaims(map, { origin, claims: keys, policy: oraclePolicy });
      const highest = [origin, ...keys.map((k) => POSITION[note.claims.find((c) => c.class === k.class && c.attribute === k.attribute).authority])].sort((a, b) => ancestors(map, a).length - ancestors(map, b).length)[0];
      if (!EXCEPTIONS.some((e) => e.startsWith(note.id))) assert.equal(section.home, highest, `${note.id}: the section is homed at its highest authority`);
      if (section.home === POSITION[note.placed?.home]) sectionsAgree++;
    }
  }
  t.diagnostic(`${checked} oracle claims checked across ${Object.keys(map.positions).length} positions; ${sectionsAgree} of ${notes} sections land where the grader had put the note`);
  assert.ok(checked >= 94);
});

test("the batches' misgrades come out as the oracle's authority says", () => {
  const note = (id) => oracle.find((n) => n.id === id);
  const home = (id) => placeByClaims(map, { origin: POSITION[note(id).origin_position], claims: note(id).claims, policy: oraclePolicy }).home;
  // ab05: an order quantity read as money by the grader; under the map quantity is Ops's own
  assert.equal(home("ux-ab05"), "ops");
  assert.equal(decideWrite(alice, { kind: "upsert", claims: note("ux-ab05").claims }, { policy: oraclePolicy, positions: map, origin: "ops" }).action, "direct");
  // ak06: "payroll" the word is not pay the attribute: the schedule is Ops's policy
  assert.equal(home("ux-ak06"), "ops");
  assert.equal(decideWrite(alice, { kind: "upsert", claims: note("ux-ak06").claims }, { policy: oraclePolicy, positions: map, origin: "ops" }).action, "direct");
  // aj10: a person's review result is admins-only, whoever writes it; alice proposes it to the top
  assert.equal(home("ux-aj10"), "org");
  const d = decideWrite(alice, { kind: "upsert", claims: note("ux-aj10").claims }, { policy: oraclePolicy, positions: map, origin: "ops" });
  assert.deepEqual([d.action, d.home, d.authority], ["propose", "org", "org"]);
  assert.equal(decideWrite(admin, { kind: "upsert", claims: note("ux-aj10").claims }, { policy: oraclePolicy, positions: map, origin: "org" }).action, "direct");
  // aa07: pay is admins-only by the map whatever the text says
  assert.equal(home("ux-aa07"), "org");
  // al04: one note, two sensitivities: the order at Ops, its price admins-only; the section goes with the price
  const al04 = placeByClaims(map, { origin: "ops", claims: note("ux-al04").claims, policy: oraclePolicy });
  assert.deepEqual(al04.claims.map((c) => c.home), ["ops", "org"]);
  assert.equal(al04.home, "org");
});
