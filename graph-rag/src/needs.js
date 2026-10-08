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
// Pure functions; the server stores needs and edges and runs the searches.
import { ancestors } from "./positions.js";

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
