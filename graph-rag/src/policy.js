// Organization policy: the data-scoping knobs an organization's admin sets
// (Organization settings in the app). Stored in ArcadeDB by graph-rag, which
// enforces it; environment variables only provide the defaults.
import { DEFAULT_TOPICS } from "./grading.js";

/** @typedef {{
 *   maxGrantDays: number,          // longest a share may last (non-standing)
 *   defaultShareDays: number,      // a share without an end date (agents usually omit it)
 *   standingGrants: "root" | "nobody", // who may share with no end date
 *   peopleShareDirectly: boolean,  // people share what they own at once (else: through review)
 *   gradingEnabled: boolean,       // grade new entries (needs a grader model)
 *   gradingConfidence: number,     // how sure the grader must be to act
 *   restrictedTopics: string[],    // what grading may hide an entry from its writer's team for
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

/** validate a (partial) update against the current policy; throws with a person-readable message */
export function applyPolicyUpdate(current, input) {
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

/** a stored policy may predate a setting: fill it from the defaults, drop what's invalid */
export function normalizeStored(stored, defaults) {
  try {
    return applyPolicyUpdate(defaults, Object.fromEntries(Object.entries(stored ?? {}).filter(([k]) => k in defaults)));
  } catch {
    return defaults;
  }
}
