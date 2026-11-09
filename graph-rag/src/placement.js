// Where an entry is seen from: the one place the rules meet. An entry's
// home comes from its origin (who wrote it), the grader's verdict (which may
// only restrict it, or propose a release), and the derived-data floor (what
// its writer read bounds how low it may go). Every path that homes an entry
// (a write, a regrade, a worker's write) goes through here.
import { decide } from "./grading.js";
import { ancestors, commonAncestor, EVERYONE, homeName } from "./positions.js";
import { authorityOf, claimHome } from "./model/authority.js";
import { normalizeAttribute } from "./model/claims.js";

export const AWAITING = "held one level up: awaiting grading";

/**
 * Apply a derived-data floor to a placement. The floor is at or above the
 * origin, so it and the placement lie on one line through the origin. The
 * entry goes at least as high as the floor, and nothing is proposed below it
 * (a release or a review back to the origin would widen derived data).
 */
export function applyFloor(map, place, origin, floor) {
  if (!floor || floor === origin) return place;
  const { release: _release, review: _review, ...rest } = place;
  const raises = floor !== place.home && ancestors(map, place.home).includes(floor);
  if (!raises) return rest;
  return {
    ...rest,
    home: floor,
    note: `held at ${homeName(map, floor)}: built from what its writer read there or below (${place.note})`,
  };
}

/**
 * Place one entity. `verdict` is the grader's (null = it answered but the
 * answer was unusable: a person reviews), `graded` is false when the grader
 * couldn't be reached at all: a new entity is then held one level up, marked
 * `ungraded`, and graded again when the grader is back (no person needed).
 * `existing` = its current home on an update; an existing entity that is
 * still awaiting grading counts as new.
 */
export function place(map, { origin, verdict, graded = true, existing, awaiting = false, floor, threshold }) {
  const current = awaiting ? undefined : existing;
  if (!graded && current === undefined) {
    const up = map.positions[origin]?.parent ?? origin;
    return applyFloor(map, { home: up, note: up === origin ? "at the root (awaiting grading)" : AWAITING, ungraded: true }, origin, floor);
  }
  return applyFloor(map, decide(map, origin, graded ? verdict : null, current, threshold), origin, floor);
}

/**
 * The class and attribute of each claim an entity carries (the contract's claim shape; a claim
 * may name its class on its subject). Claims naming neither are dropped: they say nothing the
 * authority map can read.
 */
export function claimKeys(claims) {
  return (Array.isArray(claims) ? claims : [])
    .filter((c) => c && typeof c === "object")
    .map((c) => ({
      class: typeof c.class === "string" && c.class.trim() ? c.class.trim() : typeof c.subject?.class === "string" && c.subject.class.trim() ? c.subject.class.trim() : null,
      attribute: normalizeAttribute(c.attribute) || null,
    }))
    .filter((c) => c.class || c.attribute);
}

/** does this entity carry claims the authority rule can place (else it is residue: the grader's) */
export const hasClaims = (entity) => claimKeys(entity?.claims).length > 0;

/** lower-cased tokens for matching a claim to a sentence: 1,200 reads as 1200, 34.50 stays one token */
const tokensOf = (s) => String(s).toLowerCase().replace(/(\d),(?=\d)/g, "$1").match(/[\p{L}\p{N}]+(?:\.\d+)?/gu) ?? [];
const sentencesOf = (text) =>
  String(text ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));

/** does the sentence state this claim: its value, or every word of its attribute, is in it */
function stated(claim, words) {
  const value = tokensOf(claim.value ?? "");
  if (value.length && value.every((w) => words.has(w))) return true;
  const attribute = normalizeAttribute(claim.attribute).split("_").filter(Boolean);
  return attribute.length > 0 && attribute.every((w) => words.has(w));
}

/**
 * Do this entity's claims settle where it is seen from, so the grader has nothing left to judge?
 * Only when every claim has a rule (decision 2: what maps to no rule is the grader's) and every
 * sentence of its text states one of them. A sentence no claim states is free text mapping to no
 * class, however many claims sit beside it, so a claim attached to unrelated text is no way around
 * the grader. Pure; judged on the text the grader itself would see.
 */
export function claimsSettle(entity, policy) {
  const claims = (Array.isArray(entity?.claims) ? entity.claims : []).filter((c) => c && typeof c === "object");
  const keys = claimKeys(claims);
  if (!keys.length || keys.some((k) => authorityOf(policy, k.class, k.attribute) === null)) return false;
  const text = Object.values(entity.facets ?? {}).filter((v) => typeof v === "string").join("\n");
  return sentencesOf(text).every((s) => {
    const words = new Set(tokensOf(s));
    return claims.some((c) => stated(c, words));
  });
}

/**
 * Place a claim-bearing entity from its claims' authority: the grading reading of the rule. The
 * grader is not asked here; floor.js asks it as well when the claims don't settle the text
 * (claimsSettle), and this placement then holds as the floor under its verdict. Each claim is homed at claimHome(origin, authority), never below the origin
 * (provenance); the section carrying them is homed no lower than its most restricted claim
 * (decision 5: a claim is seen by whoever sees its section), and an existing entry never widens.
 * `policy` is the authority map. Returns { home, note, authority, claims: [{ class, attribute,
 * authority, home }], graded: false }: `authority` is the position whose authority put the
 * section where it is (null when no rule applied and it sits at its writer's position).
 */
export function placeByClaims(map, { origin, claims, policy, existing, awaiting = false, floor }) {
  const placed = claimKeys(claims).map((k) => {
    const authority = authorityOf(policy, k.class, k.attribute);
    return { ...k, authority, home: claimHome(map, origin, authority) };
  });
  const current = awaiting ? undefined : existing;
  const home = commonAncestor(map, [origin, ...(current !== undefined ? [current] : []), ...placed.map((p) => p.home)]);
  const ruled = placed.filter((p) => p.authority);
  const decisive = ruled.filter((p) => p.home === home);
  const by = decisive[0] ?? null;
  const label = (p) => (p.class && p.attribute ? `${p.class}/${p.attribute}` : p.class ?? p.attribute);
  const note = !ruled.length
    ? "placed by its claims: no rule names an authority, so it is its writer's own"
    : by
      ? `placed by its claims: ${decisive.map(label).join(", ")} (authority ${homeName(map, by.authority)})`
      : `placed by its claims (${ruled.map(label).join(", ")}); kept where it is seen from`;
  return { ...applyFloor(map, { home, note }, origin, floor), authority: by?.authority ?? null, claims: placed, graded: false };
}

/** would a floor hold a write above where the entry lives (a worker's write is then refused or proposed, never silently lifted) */
export function floorLifts(map, at, floor) {
  return Boolean(floor) && floor !== at && at !== EVERYONE && ancestors(map, at).includes(floor);
}
