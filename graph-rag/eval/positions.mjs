// Who sees what, written again here on purpose: the evaluation judges the system's visibility, so it doesn't
// borrow the system's own `canSee`. A holder of a position sees homes at that position and below it, and
// `everyone`. Positions doc: { root, positions: { id: { parent? } } }.

export const EVERYONE = "everyone";

/** the chain from a position up to the root, itself first; [] for an unknown id */
export function chain(doc, id) {
  const out = [];
  let at = id;
  const seen = new Set();
  while (at && doc.positions[at] && !seen.has(at)) {
    seen.add(at);
    out.push(at);
    at = doc.positions[at].parent;
  }
  return out;
}

/** does a holder of `audience` see something homed at `home` */
export function sees(doc, audience, home) {
  if (home === EVERYONE) return true;
  if (!home) return audience === doc.root; // no home: treat as the root's
  if (audience === EVERYONE) return false;
  return chain(doc, home).includes(audience);
}

/** is `a` at or above `b` (so a holder of a has authority where b is named) */
export const atOrAbove = (doc, a, b) => chain(doc, b).includes(a);

// A home nearer the root is seen by fewer people (its holders and those above them); `everyone` by all.
const depth = (doc, h) => (h === EVERYONE ? Infinity : chain(doc, h).length);

/** the strictest of some homes: the one nearest the root, seen by the fewest (ties: the first). The test tree is one
 * chain; on homes in different branches, the nearest the root is taken, which no ruling settles */
export function strictest(doc, homes) {
  let best = null;
  for (const h of homes) if (h && (best === null || depth(doc, h) < depth(doc, best))) best = h;
  return best;
}

/** the widest of some homes: the one seen by the most (`everyone`, else the deepest) */
export function widest(doc, homes) {
  let best = null;
  for (const h of homes) if (h && (best === null || depth(doc, h) > depth(doc, best))) best = h;
  return best;
}
