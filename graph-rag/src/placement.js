// Where an entry is seen from: the one place the rules meet. An entry's
// home comes from its origin (who wrote it), the grader's verdict (which may
// only restrict it, or propose a release), and the derived-data floor (what
// its writer read bounds how low it may go). Every path that homes an entry
// (a write, a regrade, a worker's write) goes through here.
import { decide } from "./grading.js";
import { ancestors, EVERYONE, homeName } from "./positions.js";

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

/** would a floor hold a write above where the entry lives (a worker's write is then refused or proposed, never silently lifted) */
export function floorLifts(map, at, floor) {
  return Boolean(floor) && floor !== at && at !== EVERYONE && ancestors(map, at).includes(floor);
}
