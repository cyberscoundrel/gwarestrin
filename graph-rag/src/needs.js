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
export const MATCH_MIN = 0.45;
/** at most this many meetings per need from one search */
export const MATCH_MAX = 8;
/** the same person asking nearly the same thing again joins the open need */
export const JOIN_MIN = 0.9;
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
    entries: mine.map((e) => ({ key: e.rid, name: e.name, home: e.home, shared: e.state === "shared" })),
    posted: mine.length === 0,
    expires_at: need.open_until ?? null,
  };
}
