// Organization policy: the data-scoping knobs an organization's admin sets
// (Organization settings in the app). Stored in ArcadeDB by graph-rag, which
// enforces it; environment variables only provide the defaults.
import { DEFAULT_TOPICS } from "./grading.js";
import { staleAuthorities, validatePolicy as validateAuthorityMap } from "./model/authority.js";

/** @typedef {{
 *   maxGrantDays: number,          // longest a share may last (non-standing)
 *   defaultShareDays: number,      // a share without an end date (agents usually omit it)
 *   standingGrants: "root" | "nobody", // who may share with no end date
 *   peopleShareDirectly: boolean,  // people share what they own at once (else: through review)
 *   gradingEnabled: boolean,       // grade new entries (needs a grader model)
 *   gradingConfidence: number,     // how sure the grader must be to act
 *   restrictedTopics: string[],    // what grading may hide an entry from its writer's team for (the residue: text that maps to no class)
 *   authorityMap: AuthorityMap,    // commitment classes and attributes -> the position holding authority (model/authority.js)
 *   derivedWindowHours: number,    // how long what an identity read bounds where its writes land (0 = off)
 *   requestDays: number,           // how long a request for access stays open
 *   pruneAfterDays: number,        // expired entries are removed this long after their end (0 = never)
 * }} Policy */

export const LIMITS = {
  maxGrantDays: [1, 365],
  defaultShareDays: [1, 365],
  gradingConfidence: [0.3, 0.95],
  derivedWindowHours: [0, 168],
  requestDays: [1, 90],
  pruneAfterDays: [0, 365],
};

/** defaults: the built-in values, overridable per deployment by env */
export function defaultPolicy(env = process.env) {
  const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
  return {
    maxGrantDays: num("MAX_GRANT_DAYS", 90),
    defaultShareDays: num("DEFAULT_SHARE_DAYS", 14),
    standingGrants: env.STANDING_GRANTS === "nobody" ? "nobody" : "root",
    peopleShareDirectly: env.PEOPLE_SHARE_DIRECTLY !== "false",
    gradingEnabled: env.GRADING_ENABLED !== "false",
    gradingConfidence: num("GRADING_CONFIDENCE", 0.6),
    restrictedTopics: env.RESTRICTED_TOPICS?.trim() ? topicList(env.RESTRICTED_TOPICS.split(",")) : [...DEFAULT_TOPICS],
    authorityMap: env.AUTHORITY_MAP?.trim() ? authorityMap(JSON.parse(env.AUTHORITY_MAP)) : EMPTY_AUTHORITY_MAP,
    derivedWindowHours: num("DERIVED_WINDOW_HOURS", 12),
    requestDays: num("REQUEST_DAYS", 14),
    pruneAfterDays: num("PRUNE_AFTER_DAYS", 30),
  };
}

/** a topic list: trimmed, non-empty, no repeats; throws when it isn't one */
function topicList(v) {
  if (!Array.isArray(v) || v.some((t) => typeof t !== "string")) throw new Error("restrictedTopics must be a list of topics");
  const out = [...new Set(v.map((t) => t.trim().replace(/\s+/g, " ")).filter(Boolean))];
  if (out.length > 20) throw new Error("restrictedTopics: at most 20 topics");
  if (out.some((t) => t.length > 80)) throw new Error("restrictedTopics: each topic at most 80 characters");
  return out;
}

/** no rule for any class: the grader judges every section (a claim with no rule settles nothing) */
export const EMPTY_AUTHORITY_MAP = Object.freeze({ classes: {}, attributes: {} });

/**
 * The authority map (docs/ORGANIZATION-MODEL.md, "Authority: the hierarchy read the other way"):
 * `{ classes: { [class]: { authority?, attributes?: { [attribute]: position } } }, attributes: { [attribute]: position }, default? }`.
 * Checked against the position tree when one is given (model/authority.js validatePolicy: every
 * authority a known position, never everyone); by shape alone when not (the defaults load before
 * the tree does). `options` as validatePolicy's: `stored` reads a saved map (stale entries stay),
 * `allowStale` lets an edit keep the entries already stale. Throws naming the field. Returns a
 * normalized copy, keys sorted so two maps that say the same thing compare equal.
 */
export function authorityMap(v, positions = null, options = {}) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("authorityMap must be an object with classes and attributes");
  const out = validateAuthorityMap(v, positions ?? anyPosition, options);
  const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const classes = sortKeys(
    Object.fromEntries(
      Object.entries(out.classes)
        .map(([c, r]) => [c, { ...(r.authority ? { authority: r.authority } : {}), ...(r.attributes && Object.keys(r.attributes).length ? { attributes: sortKeys(r.attributes) } : {}) }])
        .filter(([, r]) => Object.keys(r).length),
    ),
  );
  const names = [...Object.keys(classes), ...Object.keys(out.attributes), ...Object.values(classes).flatMap((r) => Object.keys(r.attributes ?? {}))];
  if (names.length > 500) throw new Error("authorityMap: at most 500 rules");
  for (const k of names) if (k.length > 80) throw new Error(`authorityMap: "${k.slice(0, 20)}…" is longer than 80 characters`);
  return { classes, attributes: sortKeys(out.attributes), ...(out.default ? { default: out.default } : {}) };
}

/** a position map that knows every id: shape validation when no tree is at hand */
const anyPosition = { root: "", positions: new Proxy({}, { get: (_, k) => (typeof k === "string" && k ? { name: k, parent: null } : undefined), has: () => true }) };

/**
 * Validate a (partial) update against the current policy; throws with a person-readable message.
 * `positions` (a parsed position map) checks the authority map's positions against the tree.
 */
export function applyPolicyUpdate(current, input, positions = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("settings must be an object");
  const next = { ...current };
  const known = new Set(Object.keys(current));
  for (const [k, v] of Object.entries(input)) {
    if (!known.has(k)) throw new Error(`unknown setting: ${k}`);
    if (k in LIMITS) {
      const [lo, hi] = LIMITS[k];
      const n = Number(v);
      if (typeof v !== "number" || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be a number from ${lo} to ${hi}`);
      next[k] = k === "gradingConfidence" ? Math.round(n * 100) / 100 : Math.round(n);
    } else if (k === "restrictedTopics") {
      next[k] = topicList(v);
    } else if (k === "authorityMap") {
      // an edit may keep entries that are already stale; a new one must name a real position
      next[k] = authorityMap(v, positions, { allowStale: positions ? new Set(staleAuthorities(current.authorityMap ?? {}, positions).map((e) => e.position)) : null });
    } else if (k === "standingGrants") {
      if (v !== "root" && v !== "nobody") throw new Error('standingGrants must be "root" or "nobody"');
      next[k] = v;
    } else {
      if (typeof v !== "boolean") throw new Error(`${k} must be true or false`);
      next[k] = v;
    }
  }
  if (next.defaultShareDays > next.maxGrantDays) throw new Error("the default share length can't be longer than the longest share");
  return next;
}

/**
 * A stored policy may predate a setting: fill it from the defaults, drop what's invalid, and say so
 * through `warn`. An authority entry naming a position the tree no longer has stays: the rule fails
 * it upward (model/authority.js), where dropping it, let alone the whole map, would fail open and
 * be persisted by the next save. `warn(message)` hears about each stale entry and each dropped part.
 */
export function normalizeStored(stored, defaults, positions = null, warn = () => {}) {
  const { authorityMap: storedMap, ...rest } = Object.fromEntries(Object.entries(stored ?? {}).filter(([k]) => k in defaults));
  let out = defaults;
  try {
    out = applyPolicyUpdate(defaults, rest, positions);
  } catch (e) {
    warn(`stored organization settings dropped, defaults used: ${String(e?.message ?? e)}`);
  }
  if (storedMap === undefined) return out;
  try {
    out = { ...out, authorityMap: authorityMap(storedMap, positions, { stored: true }) };
  } catch (e) {
    warn(`stored authority map dropped: ${String(e?.message ?? e)}`);
    return out;
  }
  if (positions) for (const e of staleAuthorities(out.authorityMap, positions)) warn(`authority map: ${e.field} names ${e.position}, no longer a position; it fails upward to the root until an admin changes it`);
  return out;
}
