// The map from classes to positions (R6: "A map from classes to positions is used only to choose Filed or
// Proposed"). It is not a visibility rule and not a proposal rule for graph writes: the single
// authority-over-a-class rule is dropped (R6). Visibility is a section's home plus the restrict-only check.
//
// The stored shape is the admin's authority map (Organization settings), unchanged so stored maps still
// load: { classes: { [class]: { authority, attributes?: { [column]: position } } }, attributes?, default? }.
// NEEDS A RULING (map entries beyond classes): R6 names classes only. `attributes` and `default` still
// validate and load, and `filedOrProposed` ignores them; a class's own per-column entries still count.
//
// Pure functions over a parsed position map (positions.js) and a map object.
import { ancestors, commonAncestor, EVERYONE, heldPositions } from "../positions.js";
import { snakeCase } from "./text.js";
import { classKey } from "./classes.js";

export const FILED = "filed";
export const PROPOSED = "proposed";

/** the entry for class/column, most specific first: { authority, field } or null */
export function authorityRule(map, cls, attribute) {
  if (!map || typeof map !== "object") return null;
  const key = cls ? (map.classes?.[cls] ? cls : classKey(cls)) : null;
  const c = key ? map.classes?.[key] : undefined;
  const a = snakeCase(attribute) || null;
  const pick = (v, field) => (typeof v === "string" && v ? { authority: v, field } : null);
  return (c && a && pick(c.attributes?.[a], `classes.${key}.attributes.${a}`)) || (a && pick(map.attributes?.[a], `attributes.${a}`)) || (c && pick(c.authority, `classes.${key}.authority`)) || pick(map.default, "default");
}

/** the position an entry names for class/column, or null */
export const authorityOf = (map, cls, attribute) => authorityRule(map, cls, attribute)?.authority ?? null;

/** the class's own entry (and its per-column entries for `columns`), strictest; null when the map names none */
function ownEntry(map, cls, columns, positions) {
  const key = cls ? (map?.classes?.[cls] ? cls : classKey(cls)) : null;
  const c = key ? map?.classes?.[key] : undefined;
  if (!c) return null;
  const named = [c.authority, ...(columns ?? []).map((col) => c.attributes?.[snakeCase(col)])].filter((v) => typeof v === "string" && v);
  if (!named.length) return null;
  return commonAncestor(positions, named.map((p) => (positions.positions[p] ? p : positions.root)));
}

/**
 * The position the map puts over a class: its own entry, else its parents' (R9: a class may have several
 * parents; where they conflict the strictest wins), nearest first. `index` is classes.js classIndex; without
 * it only the class's own entry counts. Null: the map names nothing for it or anything above it.
 * NEEDS A RULING (inheritance): R9 implies a parent's entry applies to its subclasses; a class's own entry
 * wins over its parents' here.
 */
export function mapPositionOf(map, cls, positions, { index = null, columns = [] } = {}) {
  const own = ownEntry(map, cls, columns, positions);
  if (own || !index) return own;
  const key = classKey(cls);
  // the nearest ancestors that have an entry, strictest among them
  const found = [];
  const seen = new Set([key]);
  let level = [...(index.get(key)?.parents ?? [])];
  while (level.length && !found.length) {
    const next = [];
    for (const k of level) {
      if (seen.has(k)) continue;
      seen.add(k);
      const p = ownEntry(map, k, [], positions);
      if (p) found.push(p);
      next.push(...(index.get(k)?.parents ?? []));
    }
    level = next;
  }
  return found.length ? commonAncestor(positions, found) : null;
}

/**
 * Filed or Proposed (R2, R6, R11): the authority that counts is the recorder's, never the agent's; a class
 * missing from the map means Proposed; a source that isn't writable means Proposed.
 * NEEDS A RULING (who has authority): holding the mapped position or one above it counts.
 * `recorder` is { positions: [held ids] }. Returns { outcome: "filed" | "proposed", authority, reason }.
 */
export function filedOrProposed({ recorder, cls, columns = [], map, positions, index = null, writable = true }) {
  const authority = cls ? mapPositionOf(map, cls, positions, { index, columns }) : null;
  if (!authority) return { outcome: PROPOSED, authority: null, reason: `the map names no position for ${cls ?? "this piece's class"}` };
  if (!writable) return { outcome: PROPOSED, authority, reason: "the source is not writable" };
  const held = heldPositions(positions, recorder?.positions);
  const above = new Set([authority, ...ancestors(positions, authority)]);
  if (held.some((h) => above.has(h))) return { outcome: FILED, authority, reason: "the recorder holds the authority the map names" };
  return { outcome: PROPOSED, authority, reason: "the recorder doesn't hold the authority the map names" };
}

/**
 * Does going from map `prev` to `next` tighten class/column: an entry where there was none, or one not
 * below the old one? Re-homing follows a tightening (R6: sections related to instances of that class move
 * to the stricter home). A stale position counts as the root.
 */
export function tightens(prev, next, cls, attribute, positions) {
  const at = (m) => {
    const a = authorityOf(m, cls, attribute);
    return a === null ? null : positions.positions[a] ? a : positions.root;
  };
  const [from, to] = [at(prev), at(next)];
  if (to === null || from === to) return false;
  return from === null || !ancestors(positions, to).includes(from);
}

/** every position the map names, with where: [{ field, position }] */
function namedAuthorities(map) {
  const out = [];
  const add = (field, v) => typeof v === "string" && v && out.push({ field, position: v });
  add("default", map?.default);
  for (const [a, p] of Object.entries(map?.attributes ?? {})) add(`attributes.${a}`, p);
  for (const [c, r] of Object.entries(map?.classes ?? {})) {
    add(`classes.${c}.authority`, r?.authority);
    for (const [a, p] of Object.entries(r?.attributes ?? {})) add(`classes.${c}.attributes.${a}`, p);
  }
  return out;
}

/** the entries naming a position the tree no longer has (each counts as the root) */
export const staleAuthorities = (map, positions) => namedAuthorities(map).filter((e) => !positions.positions[e.position]);

/**
 * A map, checked against the position map: every entry names a known position (never `everyone`), names
 * normalized, nothing else in it. Throws naming the field; returns a normalized copy. `stored` reads one as
 * saved earlier (stale entries stay, two spellings settle on the stricter); `allowStale` lets an edit keep
 * entries that were already stale.
 */
export function validatePolicy(policy, positions, { stored = false, allowStale = null } = {}) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("policy: must be an object");
  const pos = (v, field) => {
    if (typeof v !== "string" || !v) throw new Error(`${field}: must name a position`);
    if (v === EVERYONE) throw new Error(`${field}: ${EVERYONE} holds no authority`);
    if (!positions.positions[v] && !stored && !allowStale?.has(v)) throw new Error(`${field}: unknown position ${v}`);
    return v;
  };
  const stricter = (a, b) => (positions.positions[a] && positions.positions[b] ? commonAncestor(positions, [a, b]) : positions.root || a);
  const put = (into, key, p, field, raw) => {
    const v = pos(p, field);
    if (into[key] !== undefined && into[key] !== v) {
      if (!stored) throw new Error(`${field}: "${raw}" is the same name as another rule, which names a different position`);
      into[key] = stricter(into[key], v);
    } else into[key] = v;
  };
  const keyOf = (raw, field) => {
    if (!stored && String(raw).length > 80) throw new Error(`${field}: a name longer than 80 characters`);
    const k = snakeCase(raw);
    if (!k && !stored) throw new Error(`${field}: no name in "${raw}"`);
    return k || null;
  };
  const putAttribute = (into, raw, p, field) => {
    const a = keyOf(raw, field);
    if (a) put(into, a, p, field, raw);
  };
  const out = { classes: {}, attributes: {} };
  for (const [k, v] of Object.entries(policy)) {
    if (k === "default") out.default = pos(v, "default");
    else if (k === "attributes") {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("attributes: must map attribute names to positions");
      for (const [a, p] of Object.entries(v)) putAttribute(out.attributes, a, p, `attributes.${a}`);
    } else if (k === "classes") {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("classes: must map class names to rules");
      for (const [c, rule] of Object.entries(v)) {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`classes.${c}: must be an object`);
        const key = keyOf(c, `classes.${c}`);
        if (!key) continue;
        const r = (out.classes[key] ??= {});
        for (const [rk, rv] of Object.entries(rule)) {
          if (rk === "authority") put(r, "authority", rv, `classes.${c}.authority`, c);
          else if (rk === "attributes") {
            if (!rv || typeof rv !== "object" || Array.isArray(rv)) throw new Error(`classes.${c}.attributes: must map attribute names to positions`);
            r.attributes ??= {};
            for (const [a, p] of Object.entries(rv)) putAttribute(r.attributes, a, p, `classes.${c}.attributes.${a}`);
          } else throw new Error(`classes.${c}.${rk}: unknown field`);
        }
      }
    } else throw new Error(`${k}: unknown field`);
  }
  return out;
}
