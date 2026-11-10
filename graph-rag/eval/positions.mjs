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

/** the strictest of some homes: the one deepest in the tree (ties: the first) */
export function strictest(doc, homes) {
  let best = null;
  for (const h of homes) {
    if (!h) continue;
    if (best === null || (h !== EVERYONE && (best === EVERYONE || chain(doc, h).length > chain(doc, best).length))) best = h;
  }
  return best;
}
