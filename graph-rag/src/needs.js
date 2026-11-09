// Needs: questions as points in the same space as knowledge. An entry is an
// assertion (what someone knows) or a need (what someone wishes they knew:
// `_kind = "need"`, homed at the asker's position, embedded like anything
// else). An answer is an assertion near a need; it doesn't matter which came
// first, so posting a question and saving an entry run the same meeting.
//
// The one rule: a meeting is shown only to someone who can see both points.
//  1. the asker sees the assertion: they're told (state "visible")
//  2. else the assertion's owners are shown the need (a person share of it)
//     and asked whether to share the assertion back (state "open" ->
//     "shared" | "declined")
// A need nobody's data matches is posted for the positions whose own
// descriptions fit it best (so the asker learns nothing about hidden data),
// for someone who knows to add the answer; saving it is a meeting again.
//
// NEAR edges (need -> assertion, { score, state }) record the meetings; they
// show in traversal only to those who see both ends, like every edge.
// A need is a commitment with the sign flipped (docs/ORGANIZATION-MODEL.md): a request for an
// information-delivery event nobody has promised yet. So a question that names a thing and an
// attribute is a state query first (parseStateQuestion; requests.js answers it from state.js when a
// claim exists, with no model call), and the embedding meeting above is for every other question.
// Pure functions; the server stores needs and edges and runs the searches.
import { ancestors } from "./positions.js";
import { normalize } from "./things.js";
import { parseKey, recordKey } from "./model/schema.js";

/** how close an assertion must be to a need to count as a meeting */
export const MATCH_MIN = 0.55;
/** at most this many meetings per need from one search */
export const MATCH_MAX = 8;
/** the same person asking nearly the same thing again joins the open need */
export const JOIN_MIN = 0.9;
/** different people asking nearly the same thing: their questions are linked */
export const LINK_MIN = 0.85;
/** an unmatched need is posted for positions whose description is at least this close */
export const POST_MIN = 0.3;
export const POST_MAX = 2;

/**
 * Who owns data homed at `home`: the people holding that position, or, if
 * nobody does, the nearest position above it that someone holds. `holders`
 * maps person -> the position ids they hold. The asker is never an owner.
 */
export function ownersFor(map, home, holders, asker) {
  for (const pos of [home, ...ancestors(map, home)]) {
    const people = [...holders].filter(([person, held]) => person !== asker && held.includes(pos)).map(([person]) => person);
    if (people.length) return people.sort();
  }
  return [];
}

/** a need's entity name: unique, readable in traversal */
export const needName = (qid, question) => `Question ${String(qid).slice(0, 8)}: ${String(question).slice(0, 80)}`;

/** a need stays open for the request lifetime, or until its subject ends if sooner */
export function openUntil(now, days, validUntil) {
  const open = now + days * 86_400_000;
  const end = validUntil ? Date.parse(validUntil) : NaN;
  return new Date(Number.isFinite(end) && end < open ? end : open).toISOString();
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Positions to post an unmatched need for, by their own descriptions only
 * (never by hidden data). `positions`: [{ id, vec }]; `exclude`: positions
 * that see the need already (the asker's and above).
 */
export function pickPositions(vec, positions, exclude = new Set(), min = POST_MIN, max = POST_MAX) {
  return positions
    .filter((p) => !exclude.has(p.id) && Array.isArray(p.vec))
    .map((p) => ({ id: p.id, score: cosine(vec, p.vec) }))
    .filter((p) => p.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

/**
 * What the asker sees: never who was asked, what matched or who declined.
 * `need`: { qid, question, status, open_until, valid_until, joined_into };
 * `edges`: [{ state, name }] of the need's meetings.
 */
export function askerView(need, edges, now = Date.now()) {
  const ended = need.open_until && Date.parse(need.open_until) <= now;
  const shared = [...new Set(edges.filter((e) => e.state === "shared" || e.state === "visible").map((e) => e.name))];
  const status =
    need.status === "proposed" || need.status === "joined" || need.status === "withdrawn"
      ? need.status
      : need.status === "met"
        ? "answered" // met by a claim the asker sees (a state query): nobody was asked
        : ended
          ? "expired"
          : shared.length
            ? "shared"
            : "asked";
  return {
    id: need.qid,
    question: need.question,
    // "asked" covers no matches, matches, and refusals alike
    status,
    still_open: need.status === "open" && !ended,
    shared,
    expires_at: need.open_until ?? null,
    ...(need.joined_into ? { joined_into: need.joined_into } : {}),
  };
}

/**
 * What one owner sees: the question, who asked, and only the meetings with
 * entries they own (none for a need posted to their position: then they're
 * asked to add the answer if they know it).
 */
export function ownerView(need, mine, now = Date.now()) {
  const ended = need.open_until && Date.parse(need.open_until) <= now;
  const open = mine.filter((e) => e.state === "open");
  return {
    id: need.qid,
    question: need.question,
    asked: need.asked ?? 1,
    asker: need.asker,
    status: ended ? "expired" : mine.length === 0 ? "open" : open.length ? "open" : mine.some((e) => e.state === "shared") ? "shared" : "dismissed",
    entries: mine.map((e) => ({ key: e.rid, name: e.name, home: e.home, shared: e.state === "shared", score: e.score ?? 0 })),
    posted: mine.length === 0,
    expires_at: need.open_until ?? null,
  };
}

/**
 * Linked questions shown to one owner, as groups (connected through links
 * among the shown ones). `qids`: the shown questions; `links`: [[a, b]].
 */
export function groupLinked(qids, links) {
  const parent = new Map(qids.map((q) => [q, q]));
  const find = (q) => (parent.get(q) === q ? q : find(parent.get(q)));
  for (const [a, b] of links) if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  const groups = new Map();
  for (const q of qids) {
    const root = find(q);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(q);
  }
  return [...groups.values()];
}

/**
 * One item for a group of linked questions (owner views, oldest first):
 * every asker and question, the union of the owner's entries (shared only
 * once shared with every asker), open while any of them is.
 */
export function groupView(views) {
  if (views.length === 1) return { ...views[0], askers: [views[0].asker], questions: [views[0].question], ids: [views[0].id] };
  const entries = new Map();
  for (const v of views) {
    for (const e of v.entries) {
      const prev = entries.get(e.key);
      entries.set(e.key, prev ? { ...prev, shared: prev.shared && e.shared, score: Math.max(prev.score ?? 0, e.score ?? 0) } : { ...e });
    }
  }
  // an asker whose question doesn't meet an entry hasn't had it shared
  for (const [key, e] of entries) if (views.some((v) => !v.entries.some((x) => x.key === key))) entries.set(key, { ...e, shared: false });
  const open = views.some((v) => v.status === "open");
  const list = [...entries.values()];
  return {
    ...views[0],
    askers: [...new Set(views.map((v) => v.asker))],
    questions: views.map((v) => v.question),
    ids: views.map((v) => v.id),
    asked: views.reduce((n, v) => n + (v.asked ?? 1), 0),
    status: open ? "open" : views.some((v) => v.status === "shared") ? "shared" : views[0].status,
    entries: list,
    posted: list.length === 0,
    expires_at: views.map((v) => v.expires_at).filter(Boolean).sort().at(-1) ?? null,
  };
}

/** ---- needs as commitments with the sign flipped ---- */

/** words that never name a thing on their own */
const STOP = new Set(
  "what whats which who whose when where why how is are was were be been being do does did has have had can could will would should the a an of at on in for to by from with about into as and or but not no if then than so its it this that these those there here any some all each every my our your their his her them they we you i me us s still yet now currently current latest right please tell know show give me find out whats".split(
    " ",
  ),
);
/** words saying the question is about another time, a hypothetical or a negation: not what holds now */
const NOT_NOW = new Set(
  "was were did had ago yesterday tomorrow last next previous previously before after since until ever originally former prior earlier later history past future used will would should could might may must shall not never no if without january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday".split(
    " ",
  ),
);
/** questions an attribute's value doesn't answer: who, when, where, why, how, and yes-no */
const OTHER_ASK = /^(who|whose|whom|when|where|why|how|is|are|was|were|do|does|did|can|could|will|would|should|has|have|had|may|might|shall|must)( |$)/;
/** how a question asking for a value opens: "what stage ...", "which machine ...", or the attribute named outright ("current status of X") */
const ASKS_VALUE = /^((what|which|current|latest) |[a-z0-9_ ]{1,40} of )/;

/**
 * Is this question (normalized) asking for the value something has now? A what/which question, or
 * a bare "<attribute> of X", about the present: anything else asks something an attribute's value
 * doesn't answer, and a question about another time isn't the current state (a date, or a year
 * read as one: "in 2024"; a bare four-digit number stays a row number). Deliberately narrow: what
 * this refuses goes to the embedding path and an owner.
 */
export function asksCurrentValue(norm) {
  const words = norm.split(" ");
  const year = (i) => /^(19|20)\d{2}$/.test(words[i]) && (["in", "during"].includes(words[i - 1]) || /^\d{1,2}$/.test(words[i + 1] ?? ""));
  if (words.some((w, i) => NOT_NOW.has(w) || year(i))) return false;
  return !OTHER_ASK.test(norm) && ASKS_VALUE.test(norm);
}

/**
 * Does the question ask only for this attribute of this thing? Every word has to be a stop word,
 * the attribute's, or the thing's (its name, its key, its class): anything left over ("the key" in
 * "who holds the key to rack Z1") means the question is about something else. Pure; `thing` is
 * { name, keys, class }.
 */
export function asksOnly(norm, attribute, thing) {
  const words = new Set(attribute.split("_"));
  for (const w of normalize(thing.name ?? "").split(" ")) words.add(w);
  for (const k of thing.keys ?? []) for (const w of normalize(k).split(" ")) words.add(w);
  for (const w of normalize(thing.class ?? "").split(" ")) words.add(w);
  const known = (w) => STOP.has(w) || words.has(w) || words.has(w.replace(/s$/, "")) || words.has(w.replace(/es$/, "")) || words.has(`${w}s`);
  return norm.split(" ").filter(Boolean).every(known);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const KEY_IN_TEXT = /[a-z0-9_-]{1,40}:[^\s:]{1,120}:[^\s]{1,160}/gi;

/**
 * A question read as a state query: the attribute it names (one the graph's claims use, the longest
 * match winning: "pay rate" before "pay") and the things it may be about, as subject references for
 * state.js (`{ key }` or `{ name }`): record keys written out, "job 4471"-style row numbers turned
 * into the record key of every class with a record table (`classes`: [{ name, record_table }]) and
 * kept as names too, and every run of one to three words that does not start or end on a stop word.
 * Null when no known attribute is named, or the question doesn't ask for a current value (asksCurrentValue): then
 * the question is for the embedding path and an owner.
 */
export function parseStateQuestion(question, { attributes = [], classes = [] } = {}) {
  const text = String(question ?? "").replace(/['’]s\b/g, "");
  const norm = normalize(text);
  if (!norm || !asksCurrentValue(norm)) return null;
  let attribute = null;
  for (const a of attributes) {
    const words = String(a ?? "").split("_").filter(Boolean);
    if (!words.length) continue;
    if (!new RegExp(`(^| )${words.map(escapeRe).join(" ")}(s|es)?( |$)`).test(norm)) continue;
    const prev = attribute ? attribute.split("_").length : 0;
    if (!attribute || words.length > prev || (words.length === prev && a.length > attribute.length)) attribute = a;
  }
  if (!attribute) return null;
  const attrWords = new Set(attribute.split("_"));
  const subjects = [];
  const seen = new Set();
  const push = (s) => {
    const k = s.key ? `key|${s.key}` : `name|${s.name}`;
    if (seen.has(k) || subjects.length >= 40) return;
    seen.add(k);
    subjects.push(s);
  };
  for (const m of text.match(KEY_IN_TEXT) ?? []) if (parseKey(m)) push({ key: m });
  const tokens = norm.split(" ").filter(Boolean);
  tokens.forEach((t, i) => {
    if (!/^\d{2,}$/.test(t)) return;
    // a row number: that row in every class's record table, and the words around it as names
    for (const cls of classes) {
      const k = recordKey(cls, t);
      if (k) push({ key: k });
    }
    if (i > 0 && !STOP.has(tokens[i - 1]) && !attrWords.has(tokens[i - 1])) push({ name: `${tokens[i - 1]} ${t}` });
    push({ name: t });
  });
  for (let i = 0; i < tokens.length; i++) {
    for (let n = 1; n <= 3 && i + n <= tokens.length; n++) {
      const gram = tokens.slice(i, i + n);
      if (STOP.has(gram[0]) || STOP.has(gram.at(-1)) || gram.every((w) => attrWords.has(w))) continue;
      if (gram.some((w) => attrWords.has(w)) && n > 1) continue;
      push({ name: gram.join(" ") });
    }
  }
  return { attribute, subjects };
}

/**
 * A need in the shape of a commitment claim (model/README.md), so open needs and open commitments
 * list together: the asker is the party owed, nobody owes yet, the question is what is owed, the
 * interval runs from the asking to when the need closes. `need` as requests.js loads it.
 */
export function needAsCommitment(need) {
  const asked = need.questions?.[0]?.at ?? null;
  return {
    id: need.qid,
    kind: "commitment",
    class: "need",
    attribute: "answer",
    value: need.question,
    value_num: null,
    subject: { key: null, name: need.asker, class: null, actor: "person", scope: null },
    owed_to: need.asker,
    owed_by: null,
    valid_from: asked,
    valid_until: need.open_until ?? null,
    recorded_at: asked,
    recorded_by: need.asker,
    section: null,
    status: need.status,
    asked: need.asked ?? 1,
    ...(need.home ? { home: need.home } : {}),
  };
}
