// Access requests: "when does the next Toro order go to plating?" asked by
// someone who can't see the answer. graph-rag (which alone sees the whole
// graph) matches the question against entries the asker can't see and routes
// it to the people who own those entries; an owner answers by sharing the
// matches with the asker (a person grant). Nobody writes an answer.
//
//   { id, question, asker, asked_by, status, created_at, expires_at,
//     routes: [{ person, status, entries: [{ rid, name, home, score, shared? }] }],
//     questions: [{ text, at }]   // the same ask, repeated while open
//   }
//
// status: proposed (an agent drafted it; the person hasn't said yes) | open |
// answered (every route handled, something shared) | closed (every route
// handled, nothing shared) | withdrawn | expired | joined (merged into an
// earlier open request of the same person: joined_into).
//
// The asker never learns whether anything matched, who it went to, or that
// an owner said no: their view is "asked" until something is shared with
// them. Pure functions; the server stores requests and runs the search.
import { ancestors } from "./positions.js";

/** how close an entry must be to the question to count as a match */
export const MATCH_MIN = 0.45;
/** at most this many matches are routed per request */
export const MATCH_MAX = 8;

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

/**
 * Group matches into one route per owner. `matches`: [{ rid, name, home,
 * score }], best first, already limited to what the asker can't see.
 */
export function routeMatches(map, matches, holders, asker) {
  const routes = new Map();
  for (const m of matches.slice(0, MATCH_MAX)) {
    for (const person of ownersFor(map, m.home, holders, asker)) {
      if (!routes.has(person)) routes.set(person, { person, status: "open", entries: [] });
      routes.get(person).entries.push({ rid: m.rid, name: m.name, home: m.home, score: Math.round(m.score * 1000) / 1000 });
    }
  }
  return [...routes.values()];
}

/**
 * Shared entries count for every route that holds them (two owners of one
 * entry: either may share it). A route is done when each of its entries was
 * shared or its owner dismissed it; the request when every route is done.
 */
export function applyShare(req, person, rids) {
  const shared = new Set(rids);
  for (const r of req.routes) {
    for (const e of r.entries) if (shared.has(e.rid)) e.shared = true;
    if (r.status === "open" && r.entries.every((e) => e.shared)) r.status = "shared";
  }
  const own = req.routes.find((r) => r.person === person);
  if (own && own.status === "open" && own.entries.some((e) => e.shared)) own.status = "shared";
  return settle(req);
}

/** the owner's no: their route closes; the asker isn't told */
export function applyDismiss(req, person) {
  const own = req.routes.find((r) => r.person === person);
  if (own && own.status === "open") own.status = "dismissed";
  return settle(req);
}

function settle(req) {
  if (req.status === "open" && req.routes.length && req.routes.every((r) => r.status !== "open")) {
    req.status = req.routes.some((r) => r.entries.some((e) => e.shared)) ? "answered" : "closed";
  }
  return req;
}

/** an open request of the same person whose matches overlap: ask once */
export function mergeTarget(openRequests, asker, routes) {
  const rids = new Set(routes.flatMap((r) => r.entries.map((e) => e.rid)));
  if (rids.size === 0) return null;
  return (
    openRequests.find(
      (q) => q.asker === asker && q.status === "open" && q.routes.some((r) => r.entries.some((e) => !e.shared && rids.has(e.rid))),
    ) ?? null
  );
}

/** what the asker sees: never the routes, matches or refusals */
export function askerView(req, now = Date.now()) {
  const expired = req.expires_at && Date.parse(req.expires_at) <= now && ["proposed", "open"].includes(req.status);
  const status = expired ? "expired" : req.status;
  const shared = [...new Set(req.routes.flatMap((r) => r.entries.filter((e) => e.shared).map((e) => e.name)))];
  return {
    id: req.id,
    question: req.question,
    // "asked" covers open, closed (owners said no) and answered-in-part alike
    status: status === "proposed" ? "proposed" : ["withdrawn", "expired", "joined"].includes(status) ? status : shared.length ? "shared" : "asked",
    still_open: status === "open",
    shared,
    created_at: req.created_at,
    expires_at: req.expires_at ?? null,
    ...(req.joined_into ? { joined_into: req.joined_into } : {}),
  };
}

/** what one owner sees: the question, who asked, and only their own matches */
export function ownerView(req, person, now = Date.now()) {
  const route = req.routes.find((r) => r.person === person);
  if (!route) return null;
  const expired = req.expires_at && Date.parse(req.expires_at) <= now;
  return {
    id: req.id,
    question: req.question,
    asked: (req.questions ?? []).length || 1,
    asker: req.asker,
    status: expired && route.status === "open" ? "expired" : route.status,
    entries: route.entries.map((e) => ({ key: e.rid, name: e.name, home: e.home, shared: Boolean(e.shared) })),
    created_at: req.created_at,
    expires_at: req.expires_at ?? null,
  };
}
