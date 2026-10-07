// Position tree: who may see which part of the knowledge graph.
//
// The organization is a tree of positions (authentik groups marked
// gw_position, mirrored by the provisioner into position-map.json). Every
// graph entity has a home (`_home` = a position id). A caller holding
// position P sees entities homed at P or anywhere below P; holding the root
// means seeing everything. Entities without a home count as homed at the root
// (fail upward: unclassified data is visible to the root only).
//
// Pure functions over the parsed map; the server wires them into queries.

/**
 * @typedef {{ name: string, parent: string | null, description?: string }} Position
 * @typedef {{ root: string, positions: Record<string, Position> }} PositionMap
 */

/** validate + normalize a parsed position-map.json; throws on a broken tree */
export function parsePositionMap(doc) {
  if (!doc || typeof doc !== "object") throw new Error("position map must be an object");
  const { root, positions } = doc;
  if (typeof root !== "string" || !root) throw new Error("position map needs a root");
  if (!positions || typeof positions !== "object" || !positions[root]) throw new Error("root position missing from positions");
  const out = {};
  for (const [id, p] of Object.entries(positions)) {
    if (!p || typeof p.name !== "string") throw new Error(`position ${id} needs a name`);
    const parent = id === root ? null : typeof p.parent === "string" && positions[p.parent] ? p.parent : root;
    out[id] = { name: p.name, parent, ...(typeof p.description === "string" ? { description: p.description } : {}) };
  }
  // every chain must reach the root without cycles
  for (const id of Object.keys(out)) {
    const seen = new Set();
    for (let cur = id; cur !== root; cur = out[cur].parent) {
      if (seen.has(cur)) throw new Error(`position cycle through ${cur}`);
      seen.add(cur);
    }
  }
  return { root, positions: out };
}

/** children lists, computed once per map */
function childIndex(map) {
  const kids = new Map();
  for (const [id, p] of Object.entries(map.positions)) {
    if (p.parent === null) continue;
    if (!kids.has(p.parent)) kids.set(p.parent, []);
    kids.get(p.parent).push(id);
  }
  return kids;
}

/** ancestors of id, nearest first, ending at the root (excludes id) */
export function ancestors(map, id) {
  const out = [];
  for (let cur = map.positions[id]?.parent; cur; cur = map.positions[cur]?.parent ?? null) out.push(cur);
  return out;
}

/** the positions a caller actually holds (unknown ids dropped) */
export function heldPositions(map, held) {
  return (Array.isArray(held) ? held : []).filter((id) => typeof id === "string" && map.positions[id]);
}

/**
 * Homes visible to a caller: null = everything (holds the root), otherwise the
 * set of position ids at or below any held position.
 */
export function visibleHomes(map, held) {
  const mine = heldPositions(map, held);
  if (mine.includes(map.root)) return null;
  const kids = childIndex(map);
  const out = new Set();
  const stack = [...mine];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(kids.get(id) ?? []));
  }
  return out;
}

/** can a caller see an entity homed at `home` (missing home = root) */
export function canSee(map, held, home) {
  const vis = visibleHomes(map, held);
  if (vis === null) return true;
  return vis.has(effectiveHome(map, home));
}

/** stored home -> the position it counts as (unknown or missing = root) */
export function effectiveHome(map, home) {
  return typeof home === "string" && map.positions[home] ? home : map.root;
}

/** default home for a caller's writes: deepest held position, then by name */
export function defaultHome(map, held) {
  const mine = heldPositions(map, held);
  if (mine.length === 0) return null;
  return [...mine].sort((a, b) => ancestors(map, b).length - ancestors(map, a).length || map.positions[a].name.localeCompare(map.positions[b].name))[0];
}

/**
 * Where a caller may home a write: a held position, or an ancestor of one
 * (restricting is always allowed). Homing below or beside one's positions
 * would show the data to people the writer doesn't answer for.
 */
export function writableHomes(map, held) {
  const out = new Set();
  for (const id of heldPositions(map, held)) {
    out.add(id);
    for (const a of ancestors(map, id)) out.add(a);
  }
  return out;
}

/**
 * Moving an entity from `from` to `to`: "restrict" when `to` is `from` or one
 * of its ancestors (fewer people see it), otherwise "widen" (needs a person's
 * approval).
 */
export function moveKind(map, from, to) {
  const f = effectiveHome(map, from);
  if (to === f || ancestors(map, f).includes(to)) return "restrict";
  return "widen";
}

/**
 * The deepest position that is at or above every given home: the lowest
 * point from which all of them are visible. Unknown/missing homes count as
 * the root. Used for derived data: an entry built from several sources may
 * only be seen by positions that can see all of them.
 */
export function commonAncestor(map, homes) {
  const list = [...homes].map((h) => effectiveHome(map, h));
  if (list.length === 0) return map.root;
  let chain = [list[0], ...ancestors(map, list[0])];
  for (const h of list.slice(1)) {
    const up = new Set([h, ...ancestors(map, h)]);
    chain = chain.filter((p) => up.has(p));
  }
  return chain[0] ?? map.root;
}
