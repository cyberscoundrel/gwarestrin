/**
 * State queries over claims (docs/ORGANIZATION-MODEL.md, "Search" and "Triage" rows of the components
 * table; graph-rag/src/model/README.md, "State is a query"). A claim is a CLAIMS edge from the section or
 * entry it was extracted from to its subject thing (model/schema.js); the current state of a subject is
 * its latest claim per attribute, `as_of` gives the states that held at a date, a contradiction is two
 * claims on one attribute whose intervals overlap, and history is every claim on one attribute in order.
 *
 * Decision 3 applies here as model/claims.js codes it: a state with no `valid_until` is closed by the
 * next claim on the same attribute of the same subject (`closeIntervals`); events are points that
 * neither close nor are closed; two claims starting at the same instant with different values are a
 * contradiction, not a succession.
 *
 * Every read is scoped like about_thing: the subject thing must be visible to the caller, and a claim
 * counts only when the caller sees the section it came from and the per-claim rule lets it (seesClaim:
 * the claim's own `_home`, and the caller's authority over its class under today's policy, so a later
 * policy change takes effect on claims already written). Intervals are closed here, per reader, over
 * only the claims that reader sees: a claim the reader can't see neither ends a claim it can see nor
 * shows that a change happened, and the result doesn't depend on the order claims arrived in. Nothing
 * stamps a close on the stored edge. What the caller was shown is recorded through `recordReads`
 * (floor.js), so state reads bound later writes like every other read.
 *
 * The database is reached through an injected `query` (an adbQuery-like `(sql, params) => rows`), so
 * the unit tests run the same code over the oracle fixture's claims with no database.
 */
import { effectiveHome } from "./positions.js";
import { normalize } from "./things.js";
import { adbQuery, ENTITY_LABEL, esc, RID_RE } from "./db.js";
import { homeFilter, homeLabel, positionMap, seesClaim } from "./scope.js";
import { grantShows } from "./grants.js";
import { recordReads } from "./floor.js";
import { closeIntervals, inForce, isoDate, normalizeAttribute, overlaps, stateOf } from "./model/claims.js";
import { parseKey } from "./model/schema.js";

/** at most this many claims are read per subject (a subject with more has a history, not a state) */
export const MAX_CLAIMS = 2000;
/** at most this many things a subject reference may name at once */
export const MAX_THINGS = 5;

/** a stored home as the position it counts as (the raw home when no position map is loaded) */
const eff = (home) => (positionMap ? effectiveHome(positionMap, home) : home);

/** does the caller see a home: by its own positions or through a subtree grant (null homes = everything) */
export function seesHome(scope, home) {
  if (!scope || scope.homes === null || scope.homes === undefined) return true;
  const h = eff(home);
  return scope.homes.has(h) || Boolean(scope.granted?.homes?.has(h));
}

/**
 * Does the caller see this claim of a section it can read: the per-claim rule (seesClaim), or the
 * section was granted to it as an entity. Without a loaded map (a library caller) only the claim's
 * own home is checked. `section` is the row { rid, name, _home, _origin }; `rules` overrides the policy's map.
 */
export function seesSectionClaim(scope, claim, section, rules) {
  if (grantShows(scope?.granted, { rid: String(section.rid), name: section.name, origin: section._origin ?? null })) return true;
  if (!positionMap) return !claim.home || seesHome(scope, claim.home);
  return seesClaim(scope, { class: claim.class, attribute: claim.attribute, _home: claim.home ?? section._home }, undefined, rules);
}

/**
 * What a subject reference means: a record key (`mssql:dbo_Job:4471`), a name ("Kayla", "job 4471"),
 * or a contract subject object ({ key, name, class, actor }). Returns { key, name, norm } (each null
 * when not given); throws when there is nothing to look up.
 */
export function subjectRef(subject) {
  let key = null;
  let name = null;
  if (typeof subject === "string") {
    const s = subject.trim();
    if (parseKey(s)) key = s;
    else name = s;
  } else if (subject && typeof subject === "object") {
    key = subject.key ? String(subject.key).trim() : null;
    name = subject.name ? String(subject.name).trim() : null;
  }
  if (key && !parseKey(key)) throw new Error(`not a record key (system:table:row): ${key}`);
  const norm = name ? normalize(name) : null;
  if (!key && !norm) throw new Error("say which thing: a name or a record key");
  return { key, name, norm };
}

/** the things a set of references names that the caller can see: by key first, then by name or alias */
export async function findThings(refs, { scope = { homes: null }, query = adbQuery, limit = MAX_THINGS } = {}) {
  const keys = [...new Set(refs.map((r) => r.key).filter(Boolean))];
  const norms = [...new Set(refs.map((r) => r.norm).filter(Boolean))];
  const conds = [];
  if (keys.length) conds.push(`_keys CONTAINSANY [${keys.map((k) => `'${esc(k)}'`).join(",")}]`);
  if (norms.length) {
    const list = `[${norms.map((n) => `'${esc(n)}'`).join(",")}]`;
    conds.push(`_norm IN ${list}`, `_alias_norms CONTAINSANY ${list}`);
  }
  if (!conds.length) return [];
  const rows = await query(
    `SELECT @rid AS rid, label, name, _thing_type, _alias_norms, _keys, _class, _homes FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (${conds.join(" OR ")})${homeFilter(scope)} LIMIT ${Math.max(1, Math.min(limit, 50))}`,
  );
  const things = rows.filter((r) => RID_RE.test(String(r.rid))).map(thingOf);
  // a key the caller named, held by a thing homed where it can't see: what it wrote about that row is still its
  // own to read, as the row's key and nothing of the thing's name, aliases or other keys (linker.js thingSeenFrom)
  const unseen = scope?.homes ? keys.filter((k) => !things.some((t) => t.keys.includes(k))) : [];
  for (const k of unseen) {
    const hit = (await query(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS '${esc(k)}' LIMIT 1`).catch(() => []))[0];
    const shell = hit && RID_RE.test(String(hit.rid)) ? { rid: String(hit.rid), name: k, type: null, keys: [k] } : null;
    if (shell && (await claimsOfThing(shell, { scope, query })).claims.length) things.push(shell);
  }
  // a thing found by its key comes first: the key is the reference
  return things.sort((a, b) => Number(b.keys.some((k) => keys.includes(k))) - Number(a.keys.some((k) => keys.includes(k))));
}

/** a thing row as state results carry it */
export const thingOf = (r) => ({
  rid: String(r.rid),
  name: r.label ?? r.name,
  type: r._thing_type ?? null,
  keys: Array.isArray(r._keys) ? r._keys : [],
  ...(r._class ? { class: r._class } : {}),
});

/** the subject a thing is, in the contract's shape, for grouping claims */
export const subjectOfThing = (t) => ({ key: t.keys?.[0] ?? null, name: t.name ?? t.rid, class: t.class ?? null, actor: null, scope: null });

/** every CLAIMS edge into a thing, as stored (no visibility applied; empty when the type does not exist yet) */
export async function rawClaims(thingRid, query = adbQuery) {
  if (!RID_RE.test(String(thingRid))) return [];
  return query(
    `SELECT @rid AS rid, @out AS src, id, kind, class, attribute, value, value_num, valid_from, valid_until, recorded_at, recorded_by, closed_by, _home FROM (SELECT expand(inE('CLAIMS')) FROM ${thingRid}) LIMIT ${MAX_CLAIMS}`,
  ).catch(() => []);
}

/** one stored edge row as a claim (the contract's shape plus where it came from); null when unusable */
export function toClaim(row, thing) {
  const kind = String(row.kind ?? "").toLowerCase();
  const attribute = String(row.attribute ?? "").trim();
  if (!kind || !attribute) return null;
  const recorded = isoDate(row.recorded_at) ?? null;
  const from = isoDate(row.valid_from) ?? recorded;
  if (!from) return null;
  // a stored close with closed_by is a write-time stamp from an earlier build, made over claims this
  // reader may not see: read it as open, and let closeIntervals close it over what the reader sees
  let until = row.closed_by || row.valid_until === undefined || row.valid_until === null || row.valid_until === "" ? null : (isoDate(row.valid_until) ?? null);
  if (kind === "event" && until === null) until = from;
  const num = row.value_num === undefined || row.value_num === null ? null : Number(row.value_num);
  return {
    id: row.id ?? String(row.rid),
    rid: String(row.rid),
    kind,
    class: row.class ?? null,
    attribute,
    value: row.value === undefined || row.value === null ? "" : String(row.value),
    value_num: Number.isFinite(num) ? num : null,
    valid_from: from,
    valid_until: until,
    recorded_at: recorded ?? from,
    recorded_by: row.recorded_by ?? null,
    home: row._home ?? null,
    subject: subjectOfThing(thing),
    source: String(row.src ?? ""),
  };
}

/**
 * The claims about one thing the caller may see, each with the section (or entry) it came from, and
 * the homes the caller was thereby shown (for recordReads). A claim is seen when its source is and
 * the per-claim rule lets the caller see it (seesSectionClaim).
 */
export async function claimsOfThing(thing, { scope = { homes: null }, query = adbQuery, rules } = {}) {
  const rows = await rawClaims(thing.rid, query);
  const claims = rows.map((r) => toClaim(r, thing)).filter(Boolean);
  const srcs = [...new Set(claims.map((c) => c.source).filter((s) => RID_RE.test(s)))];
  const sources = srcs.length
    ? await query(`SELECT @rid AS rid, name, _home, _origin, _kind, _doc_title, _doc_id, _section FROM [${srcs.join(",")}] WHERE name IS NOT NULL${homeFilter(scope)}`).catch(() => [])
    : [];
  const byRid = new Map(sources.map((s) => [String(s.rid), s]));
  const read = [];
  const out = [];
  for (const c of claims) {
    const s = byRid.get(c.source);
    if (!s || !seesSectionClaim(scope, c, s, rules)) continue;
    read.push(eff(s._home));
    out.push({
      ...c,
      section: {
        rid: c.source,
        name: s.name,
        // the position's id and name when a map is loaded; the stored id alone when not (unscoped, or a library caller)
        ...(s._home ? { home: homeLabel(s._home) ?? { id: s._home } } : {}),
        ...(s._kind === "section" ? { document: s._doc_title, document_id: s._doc_id, section: Number(s._section) + 1 } : {}),
      },
    });
  }
  return { claims: out, read };
}

/** ---- pure: over claims already loaded ---- */

/** claims with decision 3 applied: open intervals closed by the next claim on the same attribute */
export const closed = (claims) => closeIntervals(claims);

/** the state of one subject's claims at `asOf` (ISO): attribute -> the claim in force (events left out) */
export function stateAt(claims, asOf) {
  if (!claims.length) return {};
  return stateOf(closed(claims), claims[0].subject, asOf);
}

/** contradictions among one subject's claims: [{ attribute, claims: [a, b] }], after closing */
export function conflictsOf(claims) {
  return overlaps(closed(claims)).map(([a, b]) => ({ attribute: a.attribute, claims: [a, b] }));
}

/** every claim on one attribute, events included, oldest first, after closing */
export function historyOf(claims, attribute) {
  const a = normalizeAttr(attribute);
  return closed(claims)
    .filter((c) => c.attribute === a)
    .sort((x, y) => x.valid_from.localeCompare(y.valid_from) || x.recorded_at.localeCompare(y.recorded_at));
}

/** the claims in force at `asOf` (ISO) after closing: what a search hit bearing them says about that date */
export const inForceAt = (claims, asOf) => inForce(closed(claims), asOf);

/** "Pay rate" -> "pay_rate" (as model/claims.js normalizes attributes) */
export const normalizeAttr = normalizeAttribute;

/** a claim as results show it: the claim and where it came from, never the subject again or the edge id */
export function claimView(c) {
  return {
    id: c.id,
    kind: c.kind,
    ...(c.class ? { class: c.class } : {}),
    attribute: c.attribute,
    value: c.value,
    ...(c.value_num !== null && c.value_num !== undefined ? { value_num: c.value_num } : {}),
    valid_from: c.valid_from,
    valid_until: c.valid_until,
    ...(c.closed_by !== undefined ? { closed_by: c.closed_by } : {}),
    recorded_at: c.recorded_at,
    recorded_by: c.recorded_by,
    ...(c.section ? { section: c.section } : {}),
  };
}

/** a state map as results show it */
export const stateView = (state) => Object.fromEntries(Object.entries(state).map(([a, c]) => [a, claimView(c)]));

/** ---- the queries ---- */

/** an as_of argument as an instant; now when not given */
export function asOfDate(date, now = Date.now()) {
  if (date === undefined || date === null || date === "") return new Date(now).toISOString();
  const t = isoDate(date);
  if (!t) throw new Error(`as_of must be an ISO date (2026-11-08 or 2026-11-08T12:00:00Z), got ${String(date).slice(0, 40)}`);
  return t;
}

/**
 * The subject's things the caller sees, each with its visible claims. `identity` given: what was shown
 * is recorded as read. Returns { things: [{ thing, claims }], read }.
 */
async function load(subject, { scope = { homes: null }, identity = null, query = adbQuery, reads = recordReads, rules } = {}) {
  const ref = subjectRef(subject);
  const things = await findThings([ref], { scope, query });
  const read = [];
  const out = [];
  for (const t of things) {
    const r = await claimsOfThing(t, { scope, query, rules });
    read.push(...r.read);
    out.push({ thing: t, claims: r.claims });
  }
  if (identity) reads(identity, read);
  return { ref, things: out, read };
}

const describe = (ref) => ref.key ?? ref.name;
const nothing = (ref) => ({ things: [], note: `nothing called "${describe(ref)}" that you can see is known yet` });
const header = (t, claims) => ({ name: t.name, type: t.type, ...(t.keys.length ? { keys: t.keys } : {}), ...(t.class ? { class: t.class } : {}), claims: claims.length });

/**
 * The current state of a subject: its latest claim per attribute, among the claims the caller sees.
 * `subject`: a name, a record key, or a contract subject. One entry per thing the name means (a key
 * means one), as about_thing lists them.
 */
export async function currentState(subject, opts = {}) {
  return stateAsOf(subject, undefined, opts);
}

/** the states that held at a date (ISO; a date alone is its start): the claims in force then */
export async function stateAsOf(subject, date, opts = {}) {
  const asOf = asOfDate(date, opts.now);
  const { ref, things } = await load(subject, opts);
  if (!things.length) return nothing(ref);
  return {
    as_of: asOf,
    things: things.map(({ thing, claims }) => ({ ...header(thing, claims), state: stateView(stateAt(claims, asOf)) })),
  };
}

/**
 * Contradictions about a subject: two claims on one attribute with overlapping intervals and different
 * values, after decision 3 closed what a later claim supersedes; each with the two claims and their
 * sections, for a person or the worker to settle.
 */
export async function conflicts(subject, opts = {}) {
  const { ref, things } = await load(subject, opts);
  if (!things.length) return nothing(ref);
  return {
    things: things.map(({ thing, claims }) => ({
      ...header(thing, claims),
      conflicts: conflictsOf(claims).map(({ attribute, claims: [a, b] }) => ({ attribute, claims: [claimView(a), claimView(b)] })),
    })),
  };
}

/** every claim on one attribute of a subject, oldest first, events included, intervals closed */
export async function history(subject, attribute, opts = {}) {
  const a = normalizeAttr(attribute);
  if (!a) throw new Error("say which attribute (stage, pay_rate, due_date, ...)");
  const { ref, things } = await load(subject, opts);
  if (!things.length) return nothing(ref);
  return {
    attribute: a,
    things: things.map(({ thing, claims }) => ({ ...header(thing, claims), history: historyOf(claims, a).map(claimView) })),
  };
}

/**
 * For answering a question from state (requests.js): among the things any of `refs` names, the ones
 * with a claim on `attribute` in force now. Returns [{ thing, claim, claims }]; reads are recorded.
 */
export async function stateOfAttribute(refs, attribute, { scope = { homes: null }, identity = null, query = adbQuery, reads = recordReads, now = Date.now(), rules } = {}) {
  const a = normalizeAttr(attribute);
  const things = await findThings(refs, { scope, query, limit: 10 });
  const asOf = new Date(now).toISOString();
  const read = [];
  const out = [];
  for (const t of things) {
    const { claims, read: r } = await claimsOfThing(t, { scope, query, rules });
    read.push(...r);
    const claim = stateAt(claims, asOf)[a];
    if (claim) out.push({ thing: t, claim, claims });
  }
  if (identity) reads(identity, read);
  return out;
}
