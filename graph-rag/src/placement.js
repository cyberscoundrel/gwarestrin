// Where an entry is seen from: the one place the rules meet. An entry's home comes from its origin (who wrote
// it: a section starts at the position of the person who put it on record, R11.5), the typed check's verdict
// (which may only restrict it, R4; check.js), and the derived-data floor (an agent cannot write lower than what
// it read, R11.13). Every path that homes an entry (a write, a recheck, a worker's write) goes through here.
import { placeChecked } from "./check.js";
import { ancestors, EVERYONE, homeName } from "./positions.js";

/**
 * Apply a derived-data floor to a placement. The floor is at or above the origin, so it and the placement lie
 * on one line through the origin. The entry goes at least as high as the floor, and nothing is proposed below
 * it (a review back to the origin would widen derived data).
 */
export function applyFloor(map, place, origin, floor) {
  if (!floor || floor === origin) return place;
  const { review: _review, ...rest } = place;
  const raises = floor !== place.home && ancestors(map, place.home).includes(floor);
  if (!raises) return rest;
  return {
    ...rest,
    home: floor,
    note: `held at ${homeName(map, floor)}: built from what its writer read there or below (${place.note})`,
  };
}

/**
 * Place one entity. `verdict` is the check's (check.js checkVerdict), undefined when there was no answer: a new
 * entity is then admin-only, marked `ungraded` (waiting for its check), and placed again when the check answers
 * (no person needed). `existing` = its current home on an update (an update never widens).
 */
export function place(map, { origin, verdict, existing, floor }) {
  const p = placeChecked(map, { origin, verdict, existing });
  const { unchecked, ...rest } = p;
  return applyFloor(map, unchecked ? { ...rest, ungraded: true } : rest, origin, floor);
}

/** would a floor hold a write above where the entry lives (a worker's write is then refused or proposed, never silently lifted) */
export function floorLifts(map, at, floor) {
  return Boolean(floor) && floor !== at && at !== EVERYONE && ancestors(map, at).includes(floor);
}
