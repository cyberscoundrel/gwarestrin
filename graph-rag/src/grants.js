// Grants: the "sometimes" in the position tree. A grant shows some data to a
// position outside its normal reach: as if the data were also homed there.
//
//   { id, kind: "entity" | "subtree", target, to, reason, granted_by,
//     created_at, expires_at | null, status: "active" | "revoked" }
//
// kind "entity": target = an entity record id; "subtree": target = a position
// id (everything homed at it or below). `to` = the receiving position; holders
// of `to` and of positions above it see the data. Only active, unexpired
// grants count. Pure functions; the server stores grants and filters queries.
import { ancestors, visibleHomes } from "./positions.js";

export const MAX_GRANT_DAYS = 90;

/** is this grant in force at `now` (ms) */
export function isActive(grant, now = Date.now()) {
  if (grant?.status !== "active") return false;
  if (!grant.expires_at) return true;
  const t = Date.parse(grant.expires_at);
  return Number.isFinite(t) && now < t;
}

/** positions in the subtree rooted at `id` (including it) */
export function subtree(map, id) {
  const out = new Set();
  if (!map.positions[id]) return out;
  for (const p of Object.keys(map.positions)) {
    if (p === id || ancestors(map, p).includes(id)) out.add(p);
  }
  return out;
}

/**
 * What a caller additionally sees through grants: extra homes (subtree
 * grants) and extra entity record ids (entity grants). A grant counts when
 * its receiving position is within the caller's view (it holds `to` or a
 * position above it). Callers that see everything need nothing extra.
 */
export function grantedView(map, held, grants, now = Date.now()) {
  const vis = visibleHomes(map, held);
  if (vis === null) return { homes: new Set(), rids: new Set() };
  const homes = new Set();
  const rids = new Set();
  for (const g of grants) {
    if (!isActive(g, now) || !vis.has(g.to)) continue;
    if (g.kind === "subtree") for (const p of subtree(map, g.target)) homes.add(p);
    else if (g.kind === "entity") rids.add(g.target);
  }
  return { homes, rids };
}

/**
 * Validate a requested expiry. Root callers may grant without one (standing
 * grants); everyone else needs one within MAX_GRANT_DAYS. Returns ISO or null.
 */
export function resolveExpiry(until, { root }, now = Date.now()) {
  if (until === undefined || until === null || until === "") {
    if (root) return null;
    throw new Error(`a grant needs an expiry (until), at most ${MAX_GRANT_DAYS} days out`);
  }
  const t = Date.parse(until);
  if (!Number.isFinite(t)) throw new Error(`invalid expiry: ${until}`);
  if (t <= now) throw new Error("the expiry must be in the future");
  if (!root && t - now > MAX_GRANT_DAYS * 86_400_000) throw new Error(`grants expire within ${MAX_GRANT_DAYS} days`);
  return new Date(t).toISOString();
}
