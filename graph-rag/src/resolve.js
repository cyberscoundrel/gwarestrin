// Admission and resolution (docs/ORGANIZATION-MODEL.md, "Node admission" and
// "Reference, never copy"; the contract in model/README.md).
//
// A node earns its place when at least one holds: an identity that outlives
// any one document (a record key, an actor), a reference from more than one
// place, or a commitment or judgement no source system records. Everything
// else is content inside a claim: `admits` says which.
//
// A claim's subject is resolved to a thing in a fixed order, cheapest and
// surest first, and the embedding only when nothing else answered:
//   key         an existing instance holding the record key in `_keys` (the
//               case of a key doesn't tell two rows apart), else the one
//               keyless thing of that name (it learns the key), else a new
//               instance to mint from the key, with its class (the confirmed
//               class whose record table the key belongs to) and a
//               SourceRef: a key is an identity, so it always resolves
//   class-name  a confirmed class and a name: that class's instances by name
//               (for an actor: things of that actor type by name)
//   alias       an exact name or alias match without a class filter: machines
//               by name, people, anything a worker or person minted
//   embedding   nearest by name embedding, SAME_MIN to use, MAYBE_MIN to ask;
//               never for a name with a digit (identifiers are equal or not)
//   none        nothing found: the mention comes back unresolved, nothing is
//               minted (the linker never mints on its own)
// Pure where possible: the database is behind one injected `lookup`, so the
// fixtures stand in for it in tests (test/resolve.test.js).
import { ACTOR_TYPES, parseKey, parseTable } from "./model/schema.js";
import { designatorsDiffer, MAYBE_MIN, normalize, normalizeKey, SAME_MIN, THING_TYPES } from "./things.js";

/** how a subject was resolved */
export const HOW = ["key", "class-name", "alias", "embedding", "none"];

/**
 * The admission test. `candidate`: { name, key?, class?, actor?, kind? }.
 *   references   how many places refer to it (a number, or the list of them)
 *   hasKey       a source system holds a row for it (defaults to candidate.key)
 *   isCommitment a commitment, decision or judgement no source records
 *                (defaults to a candidate whose kind is commitment with no key)
 * Returns { admitted, rule: 1 | 2 | 3 | null, why }.
 */
export function admits(candidate = {}, { references = 0, hasKey, isCommitment } = {}) {
  const refs = Array.isArray(references) ? references.length : Number(references) || 0;
  const keyed = hasKey ?? Boolean(normalizeKey(candidate.key));
  const actor = typeof candidate.actor === "string" && ACTOR_TYPES.includes(candidate.actor.toLowerCase());
  const commits = isCommitment ?? (candidate.kind === "commitment" && !keyed);
  if (keyed) return { admitted: true, rule: 1, why: "a source system holds its row: an identity that outlives the document" };
  if (actor) return { admitted: true, rule: 1, why: `${candidate.actor} is an actor: an identity that outlives the document` };
  if (refs > 1) return { admitted: true, rule: 2, why: `referenced from ${refs} places` };
  if (commits) return { admitted: true, rule: 3, why: "a commitment or judgement no source system records" };
  return { admitted: false, rule: null, why: "content inside a claim: no identity of its own, one reference, nothing owed" };
}

/** the classes a resolution runs against: a list, the fixture's shape, or a map, confirmed ones only */
export function confirmedClasses(classes) {
  const list = Array.isArray(classes) ? classes : classes?.classes ? classes.classes : classes instanceof Map ? [...classes.values()] : Object.values(classes ?? {});
  const out = new Map();
  for (const c of list) {
    if (!c || typeof c.name !== "string") continue;
    const confirmed = c.status ? c.status === "confirmed" : Boolean(c.confirmed_by || c.confirmed_at);
    if (confirmed) out.set(c.name, c);
  }
  return out;
}

/** the confirmed class whose record table holds this key, or null */
export function classOfKey(key, classes) {
  const k = parseKey(key);
  if (!k) return null;
  for (const c of confirmedClasses(classes).values()) {
    const t = parseTable(c.record_table);
    if (t && t.system === k.system && t.table === k.table) return c;
  }
  return null;
}

/**
 * A `_thing_type` for a thing minted or matched here: a resolution hint for
 * the existing tools (search shows it, link_things filters by it), decided
 * by the subject, never by a model: the actor type; else a guess from the
 * record table's name; else the class; else "thing".
 */
export function hintType({ type, actor, key, class: cls } = {}) {
  if (actor && ACTOR_TYPES.includes(actor)) return actor;
  if (type) return String(type);
  const table = normalize(parseKey(key)?.table ?? "");
  if (/customer/.test(table)) return "customer";
  if (/vendor|supplier/.test(table)) return "supplier";
  if (/employee|person|staff/.test(table)) return "person";
  if (/job|order|po\b|quote/.test(table)) return "order";
  if (/work center|machine|asset|equipment/.test(table)) return "machine";
  if (/material|part|item|product/.test(table)) return "part";
  if (cls) return String(cls);
  return "thing";
}

/**
 * A subject in the contract's shape ({ key, name, class, actor }, or a string:
 * a key when it parses, else a name) made whole: the key normalized, the
 * actor lower-cased, a `_thing_type` hint from a mention's `type` kept.
 */
export function subjectOf(raw, claimClass = null) {
  if (typeof raw === "string") raw = parseKey(raw.trim()) ? { key: raw.trim() } : { name: raw };
  const key = normalizeKey(raw?.key) && parseKey(raw.key) ? parseKey(raw.key).key : null;
  const name = raw?.name ? String(raw.name).replace(/\s+/g, " ").trim().slice(0, 120) : null;
  const actor = typeof raw?.actor === "string" && ACTOR_TYPES.includes(raw.actor.trim().toLowerCase()) ? raw.actor.trim().toLowerCase() : null;
  // a mention's type that is an actor type says what the subject is
  const typeActor = !actor && typeof raw?.type === "string" && ACTOR_TYPES.includes(raw.type.toLowerCase()) ? raw.type.toLowerCase() : null;
  const cls = !actor && !typeActor && raw?.class ? String(raw.class).trim() : !actor && !typeActor ? claimClass : null;
  return { key, name: name || (key ? parseKey(key).row_key : null), class: cls || null, actor: actor ?? typeActor, type: raw?.type ? String(raw.type) : null, scope: raw?.scope === "class" ? "class" : null };
}

const CONFIDENCE = { key: 1, "class-name": 0.97, alias: 0.93 };
/** two spellings of one key: a source's row keys don't differ by case */
export const sameKey = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
/** several people go by this name: only a key, a worker or a person settles it, never a model's pick */
export const sameNamedPeople = (r) => r?.how === "none" && Boolean(r.ambiguous) && (r.candidates ?? []).filter((t) => t._thing_type === "person").length > 1;
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const ridOf = (t) => (t ? String(t.rid ?? t["@rid"] ?? "") : "");
const nameOf = (t) => t?.label ?? t?.name ?? "";
const norm = (t) => t?._norm ?? normalize(nameOf(t));
const aliasesOf = (t) => asList(t?._alias_norms ?? t?.aliases).map((a) => normalize(a));
const keysOf = (t) => asList(t?._keys ?? t?.keys);
const hit = (how, thing, confidence, extra = {}) => ({ how, confidence, thing, rid: ridOf(thing), mint: null, alias: null, candidates: [], ...extra });
const miss = (candidates = [], extra = {}) => ({ how: "none", confidence: 0, thing: null, rid: null, mint: null, alias: null, candidates, ...extra });
/** the hint a keyed subject would mint with fits this thing's: an untyped thing fits anything; a thing of another hint is another thing */
const hintFits = (t, hint) => !t._thing_type || !THING_TYPES.includes(t._thing_type) || !THING_TYPES.includes(hint) || t._thing_type === hint;

/**
 * Resolve one claim subject. `classes`: the confirmed classes (fixture shape,
 * list or map). `lookup` (each may be async, each may be missing):
 *   byKey(key)                          -> thing | null
 *   byName({ class, actor }, norm)      -> [thing]   instances of the class, or things of the actor type, by exact name or alias
 *   byAlias(norm)                       -> [thing]   any thing by exact name or alias
 *   byEmbedding({ class, actor, type }, text) -> [thing with score]   nearest by name embedding
 * A thing: { rid, label | name, _norm?, _alias_norms? | aliases?, _keys? | keys?, _class?, _thing_type? }.
 * Returns { how, confidence, thing, rid, mint, alias, candidates, subject }:
 *   mint        when a key holds no instance yet: { key, system, table, row_key, class, name, type } to create
 *   key         the key as the instance found holds it (a different spelling is not a second key)
 *   alias       the subject's name when it should be kept as an alias of the thing found
 *   candidates  what the residue (a closed model call, a worker, a person) chooses among when `none`
 */
export async function resolveSubject(raw, { classes = [], lookup = {} } = {}) {
  const subject = subjectOf(raw);
  const confirmed = confirmedClasses(classes);
  const n = normalize(subject.name ?? "");
  // 1. the record key: an identity, so it always resolves
  if (subject.key) {
    const found = lookup.byKey ? await lookup.byKey(subject.key) : null;
    const k = parseKey(subject.key);
    const cls = (subject.class && confirmed.has(subject.class) && classOfKey(subject.key, [confirmed.get(subject.class)]) ? confirmed.get(subject.class) : classOfKey(subject.key, confirmed))?.name ?? null;
    if (found) return hit("key", found, CONFIDENCE.key, { subject, class: cls ?? found._class ?? null, key: keysOf(found).find((x) => sameKey(x, subject.key)) ?? subject.key, alias: n && norm(found) !== n && !aliasesOf(found).includes(n) ? subject.name : null });
    // nobody holds the key. A thing of that name with no key at all is this row, as long as exactly one fits;
    // a thing holding another key is another row, however alike the names ("Diep" NGDT is not NGUD)
    if (n && lookup.byAlias) {
      const hint = hintType({ type: subject.type, actor: subject.actor, key: k.key, class: cls });
      const keyless = asList(await lookup.byAlias(n)).filter((t) => (norm(t) === n || aliasesOf(t).includes(n)) && keysOf(t).length === 0 && hintFits(t, hint) && (!cls || !t._class || t._class === cls));
      if (keyless.length === 1) return hit("key", keyless[0], CONFIDENCE.alias, { subject, class: cls ?? keyless[0]._class ?? null, key: k.key });
    }
    const name = subject.name && normalize(subject.name) !== normalize(k.row_key) ? subject.name : subject.name ?? k.row_key;
    return {
      ...miss([], { subject, class: cls }),
      how: "key",
      confidence: CONFIDENCE.key,
      mint: { key: k.key, system: k.system, table: k.table, row_key: k.row_key, class: cls, name, type: hintType({ type: subject.type, actor: subject.actor, key: k.key, class: cls }) },
    };
  }
  if (!n) return miss([], { subject, class: subject.class });
  // a class itself (an aggregate observation, a need on a process) is no instance: nothing to resolve to
  if (subject.scope === "class") return miss([], { subject, class: subject.class });
  // 2. a confirmed class (or an actor type) and a name
  const cls = subject.class && confirmed.has(subject.class) ? subject.class : null;
  if ((cls || subject.actor) && lookup.byName) {
    const rows = asList(await lookup.byName({ class: cls, actor: subject.actor }, n)).filter((t) => norm(t) === n || aliasesOf(t).includes(n));
    if (rows.length === 1) return hit("class-name", rows[0], CONFIDENCE["class-name"], { subject, class: cls ?? rows[0]._class ?? null, alias: norm(rows[0]) !== n && !aliasesOf(rows[0]).includes(n) ? subject.name : null });
    if (rows.length > 1) return miss(rows, { subject, class: cls, ambiguous: true });
  }
  // 3. an exact name or alias, whatever the class
  if (lookup.byAlias) {
    const rows = asList(await lookup.byAlias(n)).filter((t) => norm(t) === n || aliasesOf(t).includes(n));
    // a thing keyed to a row of another class's table is not this subject
    const fit = rows.filter((t) => !subject.class || !t._class || t._class === subject.class).filter((t) => !subject.actor || !t._thing_type || !ACTOR_TYPES.includes(t._thing_type) || t._thing_type === subject.actor);
    if (fit.length === 1) return hit("alias", fit[0], CONFIDENCE.alias, { subject, class: cls ?? fit[0]._class ?? null });
    if (fit.length > 1) return miss(fit, { subject, class: cls, ambiguous: true });
  }
  // 4. the embedding, last: never for identifiers, and never a merge when unsure
  if (/\d/.test(n) || !lookup.byEmbedding) return miss([], { subject, class: cls });
  const near = asList(await lookup.byEmbedding({ class: cls, actor: subject.actor, type: subject.type }, subject.name))
    .map((t) => ({ ...t, score: Number(t.score) }))
    .filter((t) => Number.isFinite(t.score) && !designatorsDiffer(n, norm(t)))
    .sort((a, b) => b.score - a.score);
  const best = near[0];
  if (best && best.score >= SAME_MIN) return hit("embedding", best, best.score, { subject, class: cls ?? best._class ?? null, alias: subject.name });
  if (best && best.score >= MAYBE_MIN) return miss([best], { subject, class: cls, maybe: ridOf(best) });
  return miss([], { subject, class: cls });
}

/**
 * The residue's choice applied: a worker, a person or the closed model call
 * picked one of `resolution.candidates` (by rid) or none. Returns a
 * resolution the linker treats like any other find, with `how` "residue".
 */
export function pickCandidate(resolution, rid) {
  const chosen = (resolution?.candidates ?? []).find((c) => ridOf(c) === String(rid ?? ""));
  if (!chosen) return { ...resolution, how: "none", thing: null, rid: null };
  const n = normalize(resolution.subject?.name ?? "");
  return hit("residue", chosen, 0.8, { subject: resolution.subject, class: resolution.class ?? chosen._class ?? null, alias: n && norm(chosen) !== n && !aliasesOf(chosen).includes(n) ? resolution.subject.name : null, candidates: resolution.candidates });
}

/** the things of an in-memory store (a test fixture, or a cache) as a `lookup` */
export function memoryLookup(things, { embed } = {}) {
  const all = () => (typeof things === "function" ? things() : things);
  return {
    byKey: (key) => all().find((t) => keysOf(t).some((x) => sameKey(x, key))) ?? null,
    byName: ({ class: cls, actor }, n) => all().filter((t) => (cls ? t._class === cls : t._thing_type === actor) && (norm(t) === n || aliasesOf(t).includes(n))),
    byAlias: (n) => all().filter((t) => norm(t) === n || aliasesOf(t).includes(n)),
    ...(embed ? { byEmbedding: ({ class: cls, actor, type }, text) => all().filter((t) => (cls ? t._class === cls : true) && (actor ? t._thing_type === actor : type ? t._thing_type === type : true)).map((t) => ({ ...t, score: embed(text, nameOf(t)) })) } : {}),
  };
}
