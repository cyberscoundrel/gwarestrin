// The authority rule (docs/ORGANIZATION-MODEL.md, "Authority: the hierarchy
// read the other way"): the positions tree says who sees what; read the
// other way it says who may commit the organization to what. One rule,
// authority over a class of commitment (or one of its attributes), of which
// visibility, proposals and grading are readings:
//
//   decide(identity, class, attribute, policy, positions)
//     -> "direct"   the identity holds the authority position or one above
//                   it: it sees claims of this class/attribute and commits
//                   directly
//     -> "propose"  the identity reports to the authority position (holds a
//                   position below it): it does not see others' claims of
//                   this kind, and a write of its own becomes a proposal,
//                   homed at the authority position
//     -> "hidden"   the identity is on another branch: it neither sees nor
//                   proposes; a write of its own is held at the common
//                   ancestor of its origin and the authority (claimHome),
//                   where someone with authority over both decides
//
// The policy is the map an admin edits: classes and attributes to the
// position holding authority. Resolution, most specific first:
//   policy.classes[class].attributes[attribute]
//   policy.attributes[attribute]
//   policy.classes[class].authority
//   policy.default (optional)
//   null: no rule, the writer's own position holds it (direct)
//
// Pure functions over the parsed position map (positions.js) and a policy
// object. An identity is { positions: [held ids], caps?: { write } } as
// server.js resolves it; an identity whose writes are queued never gets
// "direct" (its best is "propose"), which is today's queueWrite rule.
import { ancestors, commonAncestor, EVERYONE, heldPositions } from "../positions.js";

export const DECISIONS = ["direct", "propose", "hidden"];

/** the position holding authority over class/attribute, or null when no rule applies */
export function authorityOf(policy, cls, attribute) {
  if (!policy || typeof policy !== "object") return null;
  const c = cls ? policy.classes?.[cls] : undefined;
  const a = attribute ?? null;
  const pick = (v) => (typeof v === "string" && v ? v : null);
  if (c && a) {
    const r = pick(c.attributes?.[a]);
    if (r) return r;
  }
  if (a) {
    const r = pick(policy.attributes?.[a]);
    if (r) return r;
  }
  if (c) {
    const r = pick(c.authority);
    if (r) return r;
  }
  return pick(policy.default);
}

/**
 * The rule. `positions` is a parsed position map; unknown held positions
 * count for nothing (as everywhere); an authority position the map does not
 * know counts as the root (fail upward: nobody below the top commits to it).
 */
export function decide(identity, cls, attribute, policy, positions) {
  const held = heldPositions(positions, identity?.positions);
  const authority = authorityOf(policy, cls, attribute);
  const queued = identity?.caps?.write === "queued";
  if (authority === null) return queued ? "propose" : "direct";
  const at = positions.positions[authority] ? authority : positions.root;
  const above = new Set([at, ...ancestors(positions, at)]);
  if (held.some((h) => above.has(h))) return queued ? "propose" : "direct";
  if (held.some((h) => ancestors(positions, h).includes(at))) return "propose";
  return "hidden";
}

/** the visibility reading: may this identity see a claim of this class/attribute */
export function visible(identity, cls, attribute, policy, positions) {
  return decide({ ...identity, caps: undefined }, cls, attribute, policy, positions) === "direct";
}

/**
 * Where a claim written from `origin` is homed: no lower than its origin
 * (provenance), raised to the authority position when the class demands
 * it, or to the lowest position above both when they lie on different
 * branches. The section's own home still applies on top (decision 5): the
 * stricter wins, which the caller takes with commonAncestor.
 */
export function claimHome(positions, origin, authority) {
  if (!authority) return origin;
  return commonAncestor(positions, [origin, positions.positions[authority] ? authority : positions.root]);
}

/** the grading reading, per claim: the home each claim gets from its class and the writer's origin */
export function claimHomes(claims, origin, policy, positions) {
  return claims.map((c) => claimHome(positions, origin, authorityOf(policy, c.class, c.attribute)));
}

/**
 * A policy as stored, checked against the position map: every authority is
 * a known position (never `everyone`), names are non-empty, nothing else is
 * in it. Throws naming the field. Returns a normalized copy.
 */
export function validatePolicy(policy, positions) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("policy: must be an object");
  const pos = (v, field) => {
    if (typeof v !== "string" || !v) throw new Error(`${field}: must name a position`);
    if (v === EVERYONE) throw new Error(`${field}: ${EVERYONE} holds no authority`);
    if (!positions.positions[v]) throw new Error(`${field}: unknown position ${v}`);
    return v;
  };
  const out = { classes: {}, attributes: {} };
  for (const [k, v] of Object.entries(policy)) {
    if (k === "default") out.default = pos(v, "default");
    else if (k === "attributes") {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("attributes: must map attribute names to positions");
      for (const [a, p] of Object.entries(v)) out.attributes[a] = pos(p, `attributes.${a}`);
    } else if (k === "classes") {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("classes: must map class names to rules");
      for (const [c, rule] of Object.entries(v)) {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`classes.${c}: must be an object`);
        const r = {};
        for (const [rk, rv] of Object.entries(rule)) {
          if (rk === "authority") r.authority = pos(rv, `classes.${c}.authority`);
          else if (rk === "attributes") {
            if (!rv || typeof rv !== "object" || Array.isArray(rv)) throw new Error(`classes.${c}.attributes: must map attribute names to positions`);
            r.attributes = {};
            for (const [a, p] of Object.entries(rv)) r.attributes[a] = pos(p, `classes.${c}.attributes.${a}`);
          } else throw new Error(`classes.${c}.${rk}: unknown field`);
        }
        out.classes[c] = r;
      }
    } else throw new Error(`${k}: unknown field`);
  }
  return out;
}
