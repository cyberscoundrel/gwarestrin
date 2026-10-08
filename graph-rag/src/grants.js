// Grants: the "sometimes" in the position tree. A grant shows some data to a
// position outside its normal reach: as if the data were also homed there.
//
//   { id, kind: "entity" | "subtree", target, to, to_user, reason,
//     granted_by, created_at, expires_at | null, status: "active" | "revoked" }
//
// kind "entity": target = an entity record id; "subtree": target = a position
// id (everything homed at it or below). The recipient is either a position
// (`to`: holders of it and of positions above it see the data) or one person
// (`to_user`: that person and the agents acting for them, nobody else). Only
// active, unexpired grants count. Pure functions; the server stores grants and
// filters queries.
import { ancestors, visibleHomes } from "./positions.js";

export const MAX_GRANT_DAYS = 90;
/** what a share from a conversation lasts unless the person says otherwise */
export const DEFAULT_SHARE_DAYS = 14;

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

/** does a grant reach this caller: its person, or a position within its view */
export function reaches(grant, vis, person) {
  return grant.to_user ? Boolean(person) && grant.to_user === person : vis.has(grant.to);
}

/**
 * What a caller additionally sees through grants: extra homes (subtree
 * grants) and extra entity record ids (entity grants). A position grant
 * counts when its receiving position is within the caller's view (it holds
 * `to` or a position above it); a person grant only for that person (and
 * their agents: `person` is who the caller acts for). Callers that see
 * everything need nothing extra.
 */
export function grantedView(map, held, grants, now = Date.now(), person = null) {
  const vis = visibleHomes(map, held);
  if (vis === null) return { homes: new Set(), rids: new Set() };
  const homes = new Set();
  const rids = new Set();
  for (const g of grants) {
    if (!isActive(g, now) || !reaches(g, vis, person)) continue;
    if (g.kind === "subtree") for (const p of subtree(map, g.target)) homes.add(p);
    else if (g.kind === "entity") rids.add(g.target);
  }
  return { homes, rids };
}

/**
 * Resolve a requested expiry under the organization's policy.
 *  - no end date given: a standing share for a root person when the policy
 *    allows standing shares, otherwise the default share length
 *  - "14d" (relative) or an ISO date; within maxDays unless standing shares
 *    are allowed and the caller is a root person
 * Returns ISO, or null (standing).
 */
export function resolveExpiry(
  until,
  { root, agent = false, maxDays = MAX_GRANT_DAYS, defaultDays = DEFAULT_SHARE_DAYS, standing = "root" },
  now = Date.now(),
) {
  const unbounded = root && !agent && standing === "root";
  if (until === undefined || until === null || until === "") {
    return unbounded ? null : new Date(now + defaultDays * 86_400_000).toISOString();
  }
  // "14d" = 14 days from now (agents needn't know today's date)
  const rel = /^\s*(\d{1,3})\s*d(ays?)?\s*$/i.exec(String(until));
  const t = rel ? now + Number(rel[1]) * 86_400_000 : Date.parse(until);
  if (!Number.isFinite(t)) throw new Error(`invalid expiry: ${until} (an ISO date, or e.g. 14d)`);
  if (t <= now) throw new Error("the expiry must be in the future");
  if (!unbounded && t - now > maxDays * 86_400_000) throw new Error(`grants expire within ${maxDays} days`);
  return new Date(t).toISOString();
}
