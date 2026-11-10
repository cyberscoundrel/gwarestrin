// The restrict-only typed check per section (R4, R11.11). The answers below are fixed probability
// distributions: each test states what the decision model said and asserts what code does with it. No test
// here judges whether a model classified anything well; that is measured on real models.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adminOnly, categoryKeys, checkEntities, checkRequest, checkVerdict, piecesOf, placeChecked, strictestVerdict, UNCHECKED } from "../src/check.js";
import { DEFAULT_TOPICS } from "../src/grading.js";
import { parsePositionMap } from "../src/positions.js";

//        org
//         └ ops (Operations)
//            └ floor (Production floor)
const map = parsePositionMap({
  root: "org",
  positions: {
    org: { name: "org", description: "The whole organization" },
    ops: { name: "Operations", parent: "org", description: "orders, suppliers, staffing" },
    floor: { name: "Production floor", parent: "ops", description: "work orders, machines" },
  },
});

const choice = (choice, p, keys) => ({ choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? p : (1 - p) / (keys.length - 1)])) });
const verdictFor = (origin, category, visibleFrom, topics = DEFAULT_TOPICS, threshold = 0.6) => {
  const req = checkRequest(map, origin, { name: "s", facets: { identity: "text" } }, topics);
  const answers = {
    ...(category ? { category: choice(category[0], category[1], categoryKeys(topics)) } : {}),
    ...(visibleFrom ? { visible_from: choice(visibleFrom[0], visibleFrom[1], [...req.byLabel.keys()]) } : {}),
  };
  return checkVerdict(answers, { map, origin, byLabel: req.byLabel, byCategory: req.byCategory, threshold });
};

test("the request asks two closed questions: the categories plus none, and the origin and the positions above it", () => {
  const req = checkRequest(map, "floor", { name: "s", _text: "Job 4471 runs on CNC 2.", properties: { heading: "Jobs" } }, DEFAULT_TOPICS);
  assert.deepEqual(Object.keys(req.questions.category.criteria), categoryKeys(DEFAULT_TOPICS));
  assert.equal(Object.keys(req.questions.category.criteria).length, 10, "the nine categories in code, and none");
  assert.deepEqual(Object.keys(req.questions.visible_from.criteria), ["P1", "P2", "P3"]);
  assert.deepEqual([...req.byLabel.values()], ["floor", "ops", "org"], "nothing below the origin is a choice: the check only restricts");
  assert.match(req.state.entry, /^Jobs\nJob 4471 runs on CNC 2\./);
  assert.match(req.state.positions, /P3: org \(the top of the organization only/);
  assert.equal(req.questions.category.type, "choice");
  assert.equal(req.questions.visible_from.type, "choice");
});

test("categories an admin edited are what the check asks about", () => {
  const req = checkRequest(map, "floor", { name: "s", _text: "x" }, ["tooling secrets", "union talks"]);
  assert.deepEqual([...req.byCategory.values()], ["tooling secrets", "union talks"]);
  assert.deepEqual(Object.keys(req.questions.category.criteria), ["c1", "c2", "none"]);
});

test("a sure none stays at its origin", () => {
  const v = verdictFor("floor", ["none", 0.9], ["P1", 0.9]);
  assert.equal(v.home, "floor");
  assert.equal(v.sure, true);
  assert.equal(v.category, null);
});

test("a sure none stays at its origin whatever visible_from says: no category, no restriction", () => {
  assert.equal(verdictFor("floor", ["none", 0.9], ["P3", 0.95]).home, "floor");
});

test("a sure category with a sure visible_from above raises the section there", () => {
  const v = verdictFor("floor", ["c1", 0.85], ["P3", 0.8]);
  assert.equal(v.home, "org");
  assert.equal(v.sure, true);
  assert.equal(v.category, "pay and compensation");
});

test("a sure category whose sure visible_from is the origin stays at the origin", () => {
  const v = verdictFor("floor", ["c5", 0.9], ["P1", 0.9]);
  assert.equal(v.home, "floor");
  assert.equal(v.sure, true);
});

test("an unsure category holds one level higher", () => {
  const v = verdictFor("floor", ["c3", 0.45], ["P1", 0.9]);
  assert.equal(v.home, "ops");
  assert.equal(v.sure, false);
  const none = verdictFor("floor", ["none", 0.5], ["P1", 0.9]);
  assert.equal(none.home, "ops", "an unsure none is unsure too");
  assert.equal(none.sure, false);
});

test("a sure category with an unsure visible_from holds at the stricter of one level up and the level it leaned to", () => {
  assert.equal(verdictFor("floor", ["c4", 0.9], ["P3", 0.4]).home, "org");
  assert.equal(verdictFor("floor", ["c4", 0.9], ["P1", 0.4]).home, "ops");
  assert.equal(verdictFor("floor", ["c4", 0.9], null).home, "ops", "no visible_from answer: one level up");
});

test("the threshold decides what is sure", () => {
  assert.equal(verdictFor("floor", ["c1", 0.7], ["P3", 0.7], DEFAULT_TOPICS, 0.6).sure, true);
  assert.equal(verdictFor("floor", ["c1", 0.7], ["P3", 0.7], DEFAULT_TOPICS, 0.8).sure, false);
});

test("an unusable answer is no answer", () => {
  assert.equal(verdictFor("floor", null, ["P1", 0.9]), null, "no category");
  const req = checkRequest(map, "floor", { name: "s", _text: "x" }, DEFAULT_TOPICS);
  const ctx = { map, origin: "floor", byLabel: req.byLabel, byCategory: req.byCategory };
  assert.equal(checkVerdict({ category: { choice: "c99", probabilities: { c99: 1 } } }, ctx), null, "a category outside the list");
  assert.equal(checkVerdict({ category: { choice: "c1" } }, ctx), null, "no probability");
  assert.equal(checkVerdict(undefined, ctx), null);
});

test("a visible_from outside the choices never places anything below the origin", () => {
  const req = checkRequest(map, "ops", { name: "s", _text: "x" }, DEFAULT_TOPICS);
  const v = checkVerdict({ category: { choice: "c1", probabilities: { c1: 0.9 } }, visible_from: { choice: "P9", probabilities: { P9: 0.99 } } }, { map, origin: "ops", byLabel: req.byLabel, byCategory: req.byCategory });
  assert.equal(v.home, "org", "unusable visible_from: unsure, one level up");
  assert.equal(v.sure, false);
});

test("no answer is admin-only and marked unchecked", () => {
  const p = placeChecked(map, { origin: "floor", verdict: undefined });
  assert.equal(p.home, adminOnly(map));
  assert.equal(p.home, "org");
  assert.equal(p.unchecked, true);
  assert.equal(p.note, UNCHECKED);
});

test("an unsure verdict is held higher and flagged for a person to bring it back", () => {
  const p = placeChecked(map, { origin: "floor", verdict: { home: "ops", sure: false, confidence: 0.4, reason: "unsure" } });
  assert.equal(p.home, "ops");
  assert.deepEqual(p.review?.to, "floor");
  assert.equal(p.unchecked, undefined);
});

test("a sure verdict places it, and no placement ever proposes a release below its origin", () => {
  const p = placeChecked(map, { origin: "floor", verdict: { home: "org", sure: true, confidence: 0.9, reason: "pay" } });
  assert.equal(p.home, "org");
  assert.equal(p.release, undefined);
  assert.equal(p.review, undefined);
});

test("an update never widens; new text over it follows R11.11: unsure is held higher and flagged, no answer is admin-only", () => {
  assert.equal(placeChecked(map, { origin: "floor", verdict: { home: "org", sure: true, confidence: 0.9, reason: "pay" }, existing: "ops" }).home, "org");
  assert.equal(placeChecked(map, { origin: "floor", verdict: { home: "floor", sure: true, confidence: 0.9, reason: "none" }, existing: "ops" }).home, "ops", "never widened");
  const unsure = placeChecked(map, { origin: "floor", verdict: { home: "ops", sure: false, confidence: 0.4, reason: "maybe pay" }, existing: "floor" });
  assert.equal(unsure.home, "ops", "unsure: one level above where it started");
  assert.equal(unsure.review?.to, "floor", "and a person is asked to bring it back");
  const held = placeChecked(map, { origin: "floor", verdict: { home: "ops", sure: false, confidence: 0.4, reason: "maybe" }, existing: "org" });
  assert.equal(held.home, "org", "already held higher: stays");
  assert.equal(held.review, undefined);
  const none = placeChecked(map, { origin: "floor", verdict: undefined, existing: "floor" });
  assert.equal(none.home, "org", "no answer: admin-only until checked");
  assert.equal(none.unchecked, true);
  assert.equal(none.keep, "floor", "its recheck never goes below where it was");
  assert.equal(placeChecked(map, { origin: "floor", verdict: undefined, existing: "org" }).unchecked, undefined, "already admin-only: nothing to hold");
});

test("a long section is checked whole, in overlapping pieces, and the strictest piece holds (R4)", async () => {
  const filler = "Job 4471 runs on CNC 2 this week and ships on Friday. ".repeat(170);
  const text = `${filler}SECRET: Diep's pay goes to 30 an hour.`;
  assert.ok(text.length > 9000);
  const pieces = piecesOf({ _text: text, properties: { heading: "Week" } });
  assert.ok(pieces.length >= 2, "more than one piece");
  assert.ok(pieces.every((p) => p.startsWith("Week\n")), "each led by its heading");
  assert.ok(pieces.at(-1).includes("SECRET"), "the end of the section is read");
  assert.equal(pieces.map((p) => p.slice(5)).join("").replace(/\s/g, "").length >= text.replace(/\s/g, "").length, true, "nothing is left out");
  const keys = categoryKeys(DEFAULT_TOPICS);
  const ask = async ({ state }) => ({ answers: state.entry.includes("SECRET") ? { category: choice("c1", 0.9, keys), visible_from: choice("P3", 0.9, ["P1", "P2", "P3"]) } : { category: choice("none", 0.9, keys), visible_from: choice("P1", 0.9, ["P1", "P2", "P3"]) } });
  const [v] = await checkEntities(map, "floor", [{ name: "long", _text: text }], { topics: DEFAULT_TOPICS, threshold: 0.6, ask });
  assert.equal(v.home, "org", "the restricted part at the end raises the whole section");
  assert.equal(v.sure, true);
  let n = 0;
  const failsLater = async (req) => (++n === 2 ? Promise.reject(new Error("503")) : ask(req));
  assert.deepEqual(await checkEntities(map, "floor", [{ name: "long", _text: text }], { topics: DEFAULT_TOPICS, threshold: 0.6, ask: failsLater }), [undefined], "no answer for any piece is no answer");
});

test("the strictest verdict: any unsure piece makes the section unsure, the strictest home holds", () => {
  const v = strictestVerdict(map, [
    { home: "floor", sure: true, confidence: 0.9, category: null, reason: "none" },
    { home: "ops", sure: false, confidence: 0.4, category: null, reason: "unsure" },
  ]);
  assert.equal(v.home, "ops");
  assert.equal(v.sure, false);
  assert.equal(strictestVerdict(map, [{ home: "floor", sure: true, confidence: 0.9, reason: "x" }, null]), null);
});

test("checkEntities makes one call per entity, and an error, a null or a bad answer is no answer", async () => {
  const calls = [];
  const answers = [
    { answers: { category: choice("none", 0.9, categoryKeys(DEFAULT_TOPICS)), visible_from: choice("P1", 0.9, ["P1", "P2", "P3"]) } },
    "throw",
    null,
    { answers: { category: { choice: "nonsense" } } },
  ];
  const ask = async (req) => {
    calls.push(req);
    const a = answers[calls.length - 1];
    if (a === "throw") throw new Error("decision model 503");
    return a;
  };
  const errors = [];
  const entities = ["a", "b", "c", "d"].map((name) => ({ name, _text: `section ${name}` }));
  const out = await checkEntities(map, "floor", entities, { topics: DEFAULT_TOPICS, threshold: 0.6, ask, onError: (e) => errors.push(e.message) });
  assert.equal(calls.length, 4, "once per section");
  assert.equal(out[0].home, "floor");
  assert.deepEqual(out.slice(1), [undefined, undefined, undefined]);
  assert.deepEqual(errors, ["decision model 503"]);
  assert.equal(calls[1].state.entry, "section b", "each call carries only its own section");
});
