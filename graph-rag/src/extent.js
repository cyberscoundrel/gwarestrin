// Time extents: how long an entry stays true or useful. "Where the paper
// blueprints are filed" lasts; "Sandra is in Friday 7-3" ends on Friday.
// Every entity may carry `_valid_until` (ISO; absent = lasting) and
// `_valid_by` ("writer" | "grader"). Past its end an entry drops out of
// reads; pruning (later) removes it for good after a retention window.
//
// Rules:
//  1. A writer's explicit end date (or "lasting") always wins and sticks:
//     grading never overrides it on later updates.
//  2. Otherwise the grader proposes one with its usual verdict. Unsure,
//     unclear or out-of-range answers mean lasting: the safe side is keeping.
//  3. Relative dates resolve against when the entry was written, not when a
//     queued write is approved.

/** the furthest end date that still counts as an end (beyond it: lasting) */
export const MAX_YEARS = 10;
/** grader end dates further out than this are treated as lasting */
export const GRADER_MAX_YEARS = 5;

const DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-10-16" = the end of that day; full ISO times as given */
function toInstant(s) {
  const t = Date.parse(DATE_RE.test(s) ? `${s}T23:59:59Z` : s);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * A writer's `valid_until`: undefined (not given), "lasting", "14d" (from
 * when it was written), or an ISO date. Returns { valid_until: ISO | null }
 * or undefined; throws a writer-readable error.
 */
export function parseValidUntil(value, writtenAt = Date.now()) {
  if (value === undefined || value === null || value === "") return undefined;
  const s = String(value).trim();
  if (/^(lasting|never|none|permanent)$/i.test(s)) return { valid_until: null };
  const rel = /^(\d{1,4})\s*d(ays?)?$/i.exec(s);
  const t = rel ? writtenAt + Number(rel[1]) * DAY : toInstant(s);
  if (!Number.isFinite(t)) throw new Error(`invalid valid_until: ${s} (an ISO date, e.g. 14d, or "lasting")`);
  if (t <= writtenAt) throw new Error(`valid_until ${s} is in the past; leave it out (or say "lasting") for facts that stay true`);
  if (t - writtenAt > MAX_YEARS * 365 * DAY) throw new Error(`valid_until is more than ${MAX_YEARS} years out; say "lasting" instead`);
  return { valid_until: new Date(t).toISOString() };
}

/** the grader's `until`: a date after the writing and within range, else lasting (null) */
export function graderUntil(raw, writtenAt = Date.now()) {
  if (raw === undefined || raw === null || raw === "" || /^null$/i.test(String(raw))) return null;
  const t = toInstant(String(raw).trim());
  if (!Number.isFinite(t) || t <= writtenAt || t - writtenAt > GRADER_MAX_YEARS * 365 * DAY) return null;
  return new Date(t).toISOString();
}

/**
 * What an entity's end date becomes on this write; null = leave it as is.
 *  explicit: parseValidUntil's result (or undefined)
 *  existing: { valid_until, valid_by } of the stored entity (or undefined)
 *  graded:   the grader's end date (ISO or null = lasting); undefined when
 *            grading didn't run or failed
 */
export function chooseValidity(explicit, existing, graded) {
  if (explicit) return { valid_until: explicit.valid_until, valid_by: "writer" };
  if (existing?.valid_by === "writer") return null;
  if (graded !== undefined) return { valid_until: graded, valid_by: "grader" };
  return null;
}

/** SQL predicate (prefixed with AND): entries still valid at `now` */
export function liveClause(now = Date.now()) {
  return ` AND (_valid_until IS NULL OR _valid_until > '${new Date(now).toISOString()}')`;
}

/** has this stored end date passed */
export const isExpired = (validUntil, now = Date.now()) => Boolean(validUntil) && Date.parse(validUntil) <= now;
