// B4-B7, B11 (review of integration 9a84cd2): what a claim with no rule does, a stale authority,
// the per-claim visibility rule on reads, intervals closed per reader. The position map is the
// fixture tree, loaded as the server loads it; state reads run the real code over a fake query.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

process.env.POSITION_MAP_PATH = new URL("./fixtures/positions.json", import.meta.url).pathname;
process.env.ARCADEDB_URL = "http://127.0.0.1:9"; // read marks persist in the background; nothing listens here
const scope = await import("../src/scope.js");
const { loadPositionMap, scopeOf } = scope;
const { claimsSettle, hasClaims, placeByClaims } = await import("../src/placement.js");
const { authorityOf, decide, staleAuthorities, validatePolicy, visible } = await import("../src/model/authority.js");
const { applyPolicyUpdate, defaultPolicy, normalizeStored } = await import("../src/policy.js");
const { authorityMapFor, authorityPolicy, decideWrite, forgetAuthorityPolicy } = await import("../src/data-entry.js");
const { currentState, history, stateAsOf, stateOfAttribute, conflicts } = await import("../src/state.js");
const { namesOnly, parseStateQuestion } = await import("../src/needs.js");
loadPositionMap();
const map = scope.positionMap;
const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const ids = read("positions.json").identities;
const oracle = validatePolicy(read("policy.json"), map);
const EMPTY = { classes: {}, attributes: {} };
const d = defaultPolicy({});

/** ---- B4: a claim with no matching rule goes to the grader ---- */

test("B4: a claim with no matching rule does not settle where its section is seen from", () => {
  const entity = { facets: { identity: "Bob's pay is 34.50." }, claims: [{ kind: "state", class: "hires", attribute: "pay", value: 34.5, subject: { name: "Bob" } }] };
  assert.equal(claimsSettle(entity, EMPTY), false, "the default empty map: no rule, so the grader judges it");
  assert.equal(claimsSettle(entity, oracle), true, "a rule for pay, and the sentence is nothing but the claim: settled, no grader");
});

test("B4: a dummy claim is no way around the grader, whatever rule it matches", () => {
  const text = "Bob's pay is rising to 34.50 an hour.";
  // a claim on a ruled class that the text does not state
  assert.equal(claimsSettle({ name: "n", facets: { identity: text }, claims: [{ class: "jobs", attribute: "gauge", value: "set" }] }, oracle), false, "jobs has a rule, but nothing in the sentence states gauge = set");
  // a sentence no claim states, beside one that is settled
  const mixed = { name: "n", facets: { identity: "Job 4471 ran on CNC 2. Tomas was let go on Friday." }, claims: [{ class: "jobs", attribute: "machine", value: "CNC 2" }] };
  assert.equal(claimsSettle(mixed, oracle), false, "the second sentence maps to no claim: free text");
  // a claim with no rule among ruled ones
  assert.equal(claimsSettle({ name: "n", facets: { identity: "Job 4471 ran on CNC 2." }, claims: [{ class: "jobs", attribute: "machine", value: "CNC 2" }, { class: "visits", attribute: "date", value: "CNC 2" }] }, oracle), false);
  // the claim's placement still holds: it is the floor under the grader's verdict
  assert.equal(placeByClaims(map, { origin: "floor", claims: [{ class: "hires", attribute: "pay" }], policy: oracle }).home, "org");
  assert.equal(hasClaims({ name: "x", claims: [] }), false);
});

test("B4: a settled section is still placed with no grader call", () => {
  const entity = { facets: { identity: "The quantity of Exatron's order is 1,200." }, claims: [{ class: "orders", attribute: "quantity", value: 1200, subject: { name: "Exatron order" } }] };
  assert.equal(claimsSettle(entity, oracle), true, "1,200 in the text is the claim's 1200");
  assert.equal(claimsSettle({ claims: [{ class: "orders", attribute: "quantity", value: 1200 }] }, oracle), true, "no text: nothing to judge");
});

test("B4: attribute keys in the policy are normalized like a claim's, so a misnamed key still matches", () => {
  const policy = validatePolicy({ classes: { orders: { attributes: { "Unit Price": "org" } } }, attributes: { "Pay Rate": "org", creditLimit: "ops" } }, map);
  assert.deepEqual(policy.attributes, { pay_rate: "org", credit_limit: "ops" });
  assert.deepEqual(policy.classes.orders.attributes, { unit_price: "org" });
  assert.equal(authorityOf(policy, "hires", "pay_rate"), "org", "a claim's normalized attribute finds the rule");
  assert.equal(authorityOf(policy, "orders", "Unit Price"), "org", "and a raw attribute name normalizes on the way in");
  assert.throws(() => validatePolicy({ attributes: { "Pay Rate": "org", pay_rate: "ops" } }, map), /same name/, "two spellings naming different positions are the admin's to settle");
  assert.throws(() => validatePolicy({ attributes: { "!!": "org" } }, map), /no name/);
  // a policy stored before normalization: both spellings settle on the stricter position, never an error
  assert.deepEqual(validatePolicy({ attributes: { "Pay Rate": "floor", pay_rate: "org" } }, map, { stored: true }).attributes, { pay_rate: "org" });
  assert.deepEqual(normalizeStored({ authorityMap: { attributes: { "Pay Rate": "org" } } }, d, map).authorityMap.attributes, { pay_rate: "org" });
});

/** ---- B5: a stale position fails upward for that entry and never erases the map ---- */

test("B5: a stale position stays in the stored map, is reported, and fails upward for that entry alone", () => {
  const stored = { maxGrantDays: 30, authorityMap: { classes: { orders: { authority: "ops" } }, attributes: { price: "hr", pay: "org" } } };
  const warnings = [];
  const p = normalizeStored(stored, d, map, (w) => warnings.push(w));
  assert.deepEqual(p.authorityMap, stored.authorityMap, "the whole map survives, the stale entry included");
  assert.equal(p.maxGrantDays, 30, "the rest of the policy stands");
  assert.deepEqual(staleAuthorities(p.authorityMap, map).map((e) => e.position), ["hr"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /price/);
  assert.match(warnings[0], /hr/);
  assert.equal(decide({ positions: ["ops"] }, "orders", "price", p.authorityMap, map), "propose", "the stale entry counts as the root: ops proposes");
  assert.equal(decide({ positions: ["org"] }, "orders", "price", p.authorityMap, map), "direct");
  assert.equal(decide({ positions: ["ops"] }, "orders", "quantity", p.authorityMap, map), "direct", "another entry is unaffected");
});

test("B5: saving any setting keeps a stale entry; an edit may keep it but not add a new one", () => {
  const current = { ...d, authorityMap: { classes: {}, attributes: { price: "hr", pay: "org" } } };
  const next = applyPolicyUpdate(current, { maxGrantDays: 60 }, map);
  assert.deepEqual(next.authorityMap, current.authorityMap, "editing another setting keeps the map");
  const kept = applyPolicyUpdate(current, { authorityMap: { classes: {}, attributes: { price: "hr", pay: "ops" } } }, map);
  assert.equal(kept.authorityMap.attributes.price, "hr", "the panel's echo of the stale row saves");
  assert.equal(kept.authorityMap.attributes.pay, "ops");
  assert.throws(() => applyPolicyUpdate(current, { authorityMap: { classes: {}, attributes: { price: "hr", margin: "gone" } } }, map), /unknown position gone/);
});

test("B5: data entry follows: a stale stored authority fails upward, it doesn't open up", async () => {
  forgetAuthorityPolicy();
  const db = { adbQuery: async () => [{ json: JSON.stringify({ classes: {}, attributes: { price: "hr" } }) }] };
  const live = await authorityPolicy(db, { positions: map, now: 1 });
  assert.equal(live.attributes.price, "hr", "the stale entry survives the stored row's check");
  assert.equal(await decideWrite({ positions: ["ops"], caps: { write: "direct" } }, "orders", "price", { policy: live, positions: map, db }), "propose");
  forgetAuthorityPolicy();
  assert.equal((await authorityMapFor({ policy: live, positions: map, db })).attributes.price, "hr", "a map given is used as it is");
});

/** ---- B6, B7: claims read through the per-claim rule; intervals closed per reader ---- */

const THING = { rid: "#10:1", label: "Job 88001", name: "Job 88001 (thing)", _thing_type: "order", _keys: ["mssql:dbo_Job:88001"], _alias_norms: [], _norm: "job 88001", _class: "jobs", _homes: ["floor", "org"] };
const SECTIONS = {
  "#20:1": { rid: "#20:1", name: "bob's note", _home: "floor", _origin: "floor", _kind: "section", _doc_title: "t", _doc_id: "d", _section: 0 },
  "#20:2": { rid: "#20:2", name: "admin's note", _home: "org", _origin: "org", _kind: "section", _doc_title: "t", _doc_id: "d", _section: 0 },
};
const claim = (over) => ({ rid: `#30:${over.id}`, src: "#20:1", kind: "state", class: "jobs", attribute: "machine", value: "CNC 2", valid_from: "2026-10-01T00:00:00.000Z", recorded_at: "2026-10-01T00:00:00.000Z", recorded_by: "bob", _home: "floor", ...over });
const BOB_CLAIM = claim({ id: "bob" });
const ADMIN_CLAIM = claim({ id: "admin", src: "#20:2", value: "CNC 9 secret", valid_from: "2026-10-05T00:00:00.000Z", recorded_at: "2026-10-05T00:00:00.000Z", recorded_by: "admin", _home: "org" });
const NOW = Date.parse("2026-11-08T12:00:00Z");

/** the real state.js over rows held here; arrival order is the order of `edges` */
const fakeDb = (edges) => async (sql) => {
  if (/inE\('CLAIMS'\)/.test(sql)) return edges;
  const list = /FROM \[([^\]]+)\]/.exec(sql)?.[1]?.split(",").map((r) => r.trim()) ?? [];
  if (!list.length && /_kind = 'thing'/.test(sql)) return [THING];
  // the home filter riding in the SQL: which sections this caller sees
  const homes = [...sql.matchAll(/_home IN \[([^\]]*)\]/g)].flatMap((m) => m[1].split(",").map((s) => s.trim().replace(/'/g, "")));
  return list.map((r) => SECTIONS[r]).filter((s) => s && (!/_home IN/.test(sql) || homes.includes(s._home)));
};
const bobScope = () => scopeOf(ids.bob);
const adminScope = () => scopeOf(ids.admin);

test("B6: a later policy change takes effect on claims already written", async () => {
  const query = fakeDb([{ ...BOB_CLAIM, attribute: "zz_rate", value: "21.50" }]);
  const visible = await currentState("mssql:dbo_Job:88001", { scope: bobScope(), query, now: NOW, rules: EMPTY });
  assert.equal(visible.things[0].state.zz_rate.value, "21.50", "no rule: the writer's own position sees it");
  const rules = { classes: {}, attributes: { zz_rate: "org" } };
  const hidden = await currentState("mssql:dbo_Job:88001", { scope: bobScope(), query, now: NOW, rules });
  assert.deepEqual(hidden.things[0].state, {}, "the rule now says the top: gone from bob's state");
  assert.equal(hidden.things[0].claims, 0, "and not counted either");
  const ask = await history("mssql:dbo_Job:88001", "zz_rate", { scope: bobScope(), query, now: NOW, rules });
  assert.deepEqual(ask.things[0].history, [], "nor in history");
  const asOf = await stateAsOf("mssql:dbo_Job:88001", "2026-11-01", { scope: bobScope(), query, rules });
  assert.deepEqual(asOf.things[0].state, {}, "nor at an earlier date");
  const admin = await currentState("mssql:dbo_Job:88001", { scope: adminScope(), query, now: NOW, rules });
  assert.equal(admin.things[0].state.zz_rate.value, "21.50", "the top still sees it");
  const answered = await stateOfAttribute([{ key: "mssql:dbo_Job:88001", name: null, norm: null }], "zz_rate", { scope: bobScope(), query, rules, now: NOW });
  assert.deepEqual(answered, [], "and a question can't answer from a claim the asker can't see");
});

test("B6: a worker reading as its entry's audience keeps the claims that audience covers", async () => {
  const audience = { homes: new Set(["everyone", "floor"]), root: false }; // entryAudience's shape: homes, no held positions
  const query = fakeDb([BOB_CLAIM]);
  const rules = { classes: { jobs: { authority: "floor" } }, attributes: { secret: "org" } };
  const r = await currentState("mssql:dbo_Job:88001", { scope: audience, query, now: NOW, rules });
  assert.equal(r.things[0].state.machine?.value, "CNC 2", "the floor covers jobs: its audience reads the claim");
  const hid = await currentState("mssql:dbo_Job:88001", { scope: audience, query: fakeDb([{ ...BOB_CLAIM, attribute: "secret" }]), now: NOW, rules });
  assert.deepEqual(hid.things[0].state, {}, "the top's attribute stays hidden from the floor's audience");
});

for (const [order, edges] of [
  ["bob's claim first", [BOB_CLAIM, ADMIN_CLAIM]],
  ["the admin's claim first", [ADMIN_CLAIM, BOB_CLAIM]],
]) {
  test(`B7: a claim above the reader neither closes the reader's claim nor shows a change (${order})`, async () => {
    const query = fakeDb(edges);
    const bob = await currentState("mssql:dbo_Job:88001", { scope: bobScope(), query, now: NOW, rules: EMPTY });
    assert.equal(bob.things[0].state.machine?.value, "CNC 2", "bob still reads his claim");
    assert.equal(bob.things[0].state.machine.valid_until, null, "open: nothing he can see closed it");
    assert.equal(bob.things[0].state.machine.closed_by, undefined, "and no hint that something did");
    assert.equal(bob.things[0].claims, 1);
    const bobHist = await history("mssql:dbo_Job:88001", "machine", { scope: bobScope(), query, now: NOW, rules: EMPTY });
    assert.deepEqual(bobHist.things[0].history.map((c) => [c.value, c.valid_until]), [["CNC 2", null]]);
    const conf = await conflicts("mssql:dbo_Job:88001", { scope: bobScope(), query, now: NOW, rules: EMPTY });
    assert.deepEqual(conf.things[0].conflicts, []);
    const admin = await currentState("mssql:dbo_Job:88001", { scope: adminScope(), query, now: NOW, rules: EMPTY });
    assert.equal(admin.things[0].state.machine.value, "CNC 9 secret", "the admin reads the latest");
    const adminHist = await history("mssql:dbo_Job:88001", "machine", { scope: adminScope(), query, now: NOW, rules: EMPTY });
    assert.deepEqual(adminHist.things[0].history.map((c) => [c.value, c.closed_by ?? null]), [["CNC 2", "admin"], ["CNC 9 secret", null]], "and the succession, closed by the claim the admin can see");
  });
}

test("B7: a close stamped on the stored edge by an earlier build is read as open and re-derived per reader", async () => {
  const stamped = { ...BOB_CLAIM, valid_until: ADMIN_CLAIM.valid_from, closed_by: ADMIN_CLAIM.id };
  const query = fakeDb([stamped, ADMIN_CLAIM]);
  const bob = await currentState("mssql:dbo_Job:88001", { scope: bobScope(), query, now: NOW, rules: EMPTY });
  assert.equal(bob.things[0].state.machine?.valid_until, null, "the hidden close does not reach bob");
  assert.equal(bob.things[0].state.machine?.closed_by, undefined);
  const explicit = { ...BOB_CLAIM, valid_until: "2026-10-20T00:00:00.000Z" };
  const q2 = fakeDb([explicit]);
  assert.equal((await history("mssql:dbo_Job:88001", "machine", { scope: bobScope(), query: q2, now: NOW, rules: EMPTY })).things[0].history[0].valid_until, "2026-10-20T00:00:00.000Z", "a writer's own end date is kept");
});

/** ---- B11: an attribute word in a question doesn't make it a state query ---- */

test("B11: a question only reads as a state query when it asks for the current value", () => {
  const attributes = ["holds", "machine", "stage", "status", "pay_rate"];
  const q = (s) => parseStateQuestion(s, { attributes });
  assert.equal(q("Who holds the key to rack Z1?"), null, "who");
  assert.equal(q("Which machine was job 88006 on three weeks ago?"), null, "another time");
  assert.equal(q("What was the stage of job 4471?"), null, "past tense");
  assert.equal(q("Is job 4471 at plating?"), null, "yes-no");
  assert.equal(q("Which machine should job 88006 go on?"), null, "advice, not a state");
  assert.equal(q("What machine will job 88006 be on next week?"), null, "the future");
  assert.equal(q("What stage is job 4471 at?").attribute, "stage");
  assert.equal(q("What machine is job 88006 on?").attribute, "machine");
  assert.equal(q("Current status of the Toro order").attribute, "status");
  assert.equal(q("Stage of job 2012").attribute, "stage", "a four-digit row number is not a year");
  assert.equal(q("What stage was job 4471 at in 2024?"), null);
});

test("B11: the words naming what's asked about must be only the thing's", () => {
  const job = { name: "Job 88006", keys: ["mssql:dbo_Job:88006"], class: "jobs" };
  assert.equal(namesOnly("job 88006", job), true);
  assert.equal(namesOnly("job 88006 and who ran it", job), false, "a second question");
  assert.equal(namesOnly("job 88006", { name: "88006", keys: ["mssql:dbo_Job:88006"], class: "jobs" }), true, "job from its key");
  const rack = { name: "rack Z1", keys: [], class: null };
  assert.equal(namesOnly("rack z1", rack), true);
  assert.equal(namesOnly("key to rack z1", rack), false, "the key is what's asked about");
});

test("B11 remainder: only the shapes of a current-value question are read as one", () => {
  const attributes = ["holds", "machine", "stage", "status", "pay_rate", "pay"];
  const job = { name: "Job 90401", keys: ["mssql:dbo_Job:90401"], class: "jobs" };
  const answered = (s) => {
    const p = parseStateQuestion(s, { attributes });
    return Boolean(p && namesOnly(p.about, job));
  };
  for (const s of [
    "What machine is job 90401 on?",
    "Which machine is job 90401 on right now?",
    "What is the machine of job 90401?",
    "What's the current machine for job 90401?",
    "What is job 90401's machine?",
    "Machine of job 90401",
    "Latest machine of job 90401",
    "What machine is job 90401 currently on?",
  ]) assert.equal(answered(s), true, s);
  // the reviewer's four, and the neighbours they stand for: tense, perfect, modal, plural, all, comparison, a second subject, another time
  for (const s of [
    "What machine has job 90401 been on?",
    "Which machines has job 90401 been on?",
    "What are all the machines of job 90401?",
    "Which machine can job 90401 be on?",
    "What machines is job 90401 on?",
    "Which machine might job 90401 go on?",
    "What machine does job 90401 need?",
    "What machine is job 90401 supposed to be on?",
    "What is the best machine of job 90401?",
    "What is the usual machine of job 90401?",
    "What is the expected machine of job 90401?",
    "What is the machine of job 90401 or job 90402?",
    "What machine is job 90401 on and who runs it?",
    "What is the machine of job 90401 in 2024?",
    "What is the machine of job 90401 as of Tuesday?",
    "What machine is job 90401 not on?",
    "What machine was job 90401 on?",
    "Quelle machine pour le job 90401?",
    "Tell me about the machine of job 90401",
  ]) assert.equal(answered(s), false, s);
  assert.equal(parseStateQuestion("What is the pay rate of Diep?", { attributes }).attribute, "pay_rate", "the longest attribute that fits");
});

test("B4 remainder: a sentence is settled only when every word in it is a claim's or filler", () => {
  const gauge = { classes: {}, attributes: { gauge: "floor" } };
  const claim = (over = {}) => ({ kind: "state", class: "jobs", attribute: "gauge", value: "set", ...over });
  const settles = (text, c = claim(), more = {}) => claimsSettle({ facets: { identity: text }, claims: [c], ...more }, gauge);
  assert.equal(settles("The gauge is set."), true, "nothing but the claim");
  assert.equal(settles("The gauge is set and Bob's pay is rising to 34.50 an hour [admins]"), false, "the reviewer's sentence");
  assert.equal(settles("gauge set; Bob's pay is rising to 34.50 an hour"), false, "no sentence break at all");
  assert.equal(settles("the gauge was read and Bob's pay is rising", claim({ value: "ok" })), false, "stated by its attribute alone");
  assert.equal(settles("Bob's pay is rising to 34.50 an hour", claim({ value: "is" })), false, "a value that is a common word");
  assert.equal(settles("Bob's pay is rising to 34.50 an hour", claim({ value: "Bob's pay is rising to 34.50 an hour" })), false, "the sentence as the claim's own value");
  assert.equal(settles("gauge of Bob pay rising fast now", claim({ subject: { name: "Bob pay rising fast now and more" } })), false, "the sentence as the claim's subject");
  assert.equal(settles("The gauge is set, confidentiel.", claim()), false, "any other word, in any language");
  assert.equal(claimsSettle({ name: "Bob's pay is rising", facets: { identity: "The gauge is set." }, claims: [claim()] }, gauge), false, "a caller's entry name");
  assert.equal(claimsSettle({ facets: { identity: "The gauge is set." }, properties: { heading: "Bob's pay" }, claims: [claim()], _system: { _kind: "section" } }, gauge), false, "a heading");
  assert.equal(claimsSettle({ name: "Doc §1", facets: { identity: "The gauge is set." }, claims: [claim()], _system: { _kind: "section" } }, gauge), true, "a section's built name is not judged");
  assert.equal(claimsSettle({ facets: { identity: "The gauge is set." }, _text: "The gauge is set. Bob's pay is rising.", claims: [claim()], _system: { _kind: "section" } }, gauge), false, "past the preview");
  const junk = { class: "", attribute: "", value: "Bob's pay is rising" };
  assert.equal(claimsSettle({ facets: { identity: "Bob's pay is rising." }, claims: [claim(), junk] }, gauge), false, "a claim the rule can't read accounts for nothing");
});

test("B4 remainder: class keys are normalized as attribute keys are, and one lookup serves every reading", () => {
  const p = validatePolicy({ classes: { Jobs: { authority: "ops", attributes: { "Pay Rate": "org" } }, "Work Center": { authority: "floor" } } }, map);
  assert.deepEqual(Object.keys(p.classes).sort(), ["jobs", "work_center"]);
  assert.equal(authorityOf(p, "jobs", "stage"), "ops");
  assert.equal(authorityOf(p, "JOBS", "pay_rate"), "org", "any spelling of the claim's class");
  assert.equal(authorityOf(p, "work center", "status"), "floor", "a class name with a space");
  assert.equal(decide({ positions: ["floor"] }, "Jobs", "stage", p, map), "propose", "the proposal reading");
  assert.equal(visible({ positions: ["floor"] }, "jobs", "stage", p, map), false, "the visibility reading");
  assert.throws(() => validatePolicy({ classes: { Jobs: { authority: "org" }, jobs: { authority: "ops" } } }, map), /same name/, "two spellings naming different positions");
  const stored = validatePolicy({ classes: { Jobs: { authority: "floor", attributes: { a: "floor" } }, jobs: { authority: "ops", attributes: { b: "ops" } } } }, map, { stored: true });
  assert.deepEqual(stored.classes.jobs, { authority: "ops", attributes: { a: "floor", b: "ops" } }, "stored: the stricter position, every rule kept");
  assert.equal(validatePolicy({ classes: { "!!": { authority: "ops" } } }, map, { stored: true }).classes["!!"], undefined);
  assert.throws(() => validatePolicy({ classes: { "!!": { authority: "ops" } } }, map), /no name/);
});
