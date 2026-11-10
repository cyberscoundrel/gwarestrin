/**
 * The linker (see things.js): resolving a statement's subjects to things through resolve.js, linking the
 * statement to them, and finding things and entries by name, key or id.
 *
 * Admission (docs/ORGANIZATION-MODEL.md): the linker mints a thing only from a record key (an instance, with
 * its SourceRef) or when the caller vouches for the name (`create: true`: a worker's link_things, a person).
 * Running on its own (jobMentions) it mints nothing but by key: a subject it can't resolve comes back
 * unresolved, on the entry (`_unresolved`) and to triage, for a worker or a person to decide.
 */
import { effectiveHome, EVERYONE, homeName, visibleHomes } from "./positions.js";
import { duplicateEntries, entryId, keysInText, MAX_MENTIONS, mentionsPrompt, ngrams, normalize, splitThingName, parseMentions, parseResidue, parseSort, partialPerson, personCandidates, residuePrompt, thingName } from "./things.js";
import { admits, classKind, confirmedClasses, hasDesignator, hintType, isRecordNumber, namesAnIndividual, pickCandidate, properName, resolveSubject, sameKey, sameNamedPeople, subjectOf } from "./resolve.js";
import { referTo } from "./sourceref.js";
import { ACTOR_TYPES, parseKey, parseTable, statements, TYPES } from "./model/schema.js";
import { DECISION_API_KEY, log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, FACETS, RID_RE } from "./db.js";
import { embedBatch } from "./models.js";
import { homeFilter, positionMap } from "./scope.js";
import { enqueue, worker, workerCall } from "./worker-pool.js";
import { intakeWithTriage } from "./triage.js";
import { sourceClient, sourcesConfig } from "./data-entry.js";

const THING_KINDS_READ = ["document", "section"]; // besides plain entries, what the worker reads for things
const THING_COLS = "@rid AS rid, label, _norm, _alias_norms, _thing_type, _keys, _class, _homes, _held_aliases, _held_keys";
const CLASS_CACHE_MS = 60_000; // confirmed classes are read this often...
const NO_CLASS_CACHE_MS = 5_000; // ...unless there were none yet: discovery may confirm the first one any moment

/**
 * A thing's visibility follows the statements about it: add a home. Only from where it could already be
 * seen (`from`, the statement's own home unless it just moved): a statement linked to a thing it can't see
 * (a record key names one row, whoever writes it) doesn't bring that thing's label, aliases and other keys
 * down with it. The thing stays where it is, and the statement counts for those who can see both.
 */
export async function thingSeenFrom(rid, home, { from = home } = {}) {
  const row = (await adbQuery(`SELECT _homes FROM ${rid}`))[0];
  const homes = Array.isArray(row?._homes) ? row._homes : [];
  if (!homes.includes(home) && seenThing({ _homes: homes }, from)) await adbCommand(`UPDATE ${rid} SET _homes = :homes`, "sql", { homes: [...homes, home] });
}

export async function aboutOnce(statementRid, thingRid, role) {
  const out = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${statementRid})`).catch(() => []);
  if (out.some((e) => String(e.dst) === thingRid)) return;
  await adbCommand(`CREATE EDGE ABOUT FROM ${statementRid} TO ${thingRid} SET role = :role`, "sql", { role });
}

export const NOT_A_THING = "not an existing thing";
/**
 * The linker's own verdict on a name it could not resolve and may not mint: it comes back with this
 * (and `unresolved: true`), is stored on the entry, and is a worker's or a person's to settle. It is
 * deliberately not NOT_A_THING: triage turns those into things once it finds nothing for a worker to do,
 * and the linker's residue must never become a thing that way.
 */
export const UNRESOLVED = "nothing resolves it: a worker or a person decides";

let schemaReady = false;
/** what the linker stores that the model adds to Entity (`_class`) and its own `_unresolved`; idempotent, once */
async function ensureLinkerSchema() {
  if (schemaReady) return;
  for (const sql of statements({ Entity: TYPES.Entity })) await adbCommand(sql).catch(() => {});
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._unresolved IF NOT EXISTS STRING`).catch(() => {});
  schemaReady = true;
}

let classCache = { at: 0, list: [] };
/** the confirmed classes (CommitmentClass rows a person confirmed), cached a minute; none when the type isn't there yet */
export async function confirmedClassList({ fresh = false } = {}) {
  if (!fresh && Date.now() - classCache.at < (classCache.list.length ? CLASS_CACHE_MS : NO_CLASS_CACHE_MS)) return classCache.list;
  const rows = await adbQuery("SELECT name, description, stages, record_table, status FROM CommitmentClass WHERE status = 'confirmed'").catch(() => []);
  classCache = { at: Date.now(), list: rows.map((r) => ({ name: r.name, description: r.description ?? "", stages: r.stages ?? [], record_table: r.record_table ?? null, status: "confirmed" })) };
  return classCache.list;
}

/**
 * Names and keys a thing learned from a statement some of its readers can't see are held apart
 * (`_held_aliases`, `_held_keys`: "home<TAB>value"), so everything that reads `_alias_norms` and `_keys` is
 * safe by where the value sits. They still find the thing, and they're shown only where that home is seen.
 */
const HELD = "\t";
const heldValue = (e) => String(e).slice(String(e).indexOf(HELD) + 1);
const heldHome = (e) => String(e).slice(0, Math.max(0, String(e).indexOf(HELD)));
/** a thing's held names a reader at `home` may see */
export function heldSeen(list, home) {
  if (!Array.isArray(list) || !list.length) return [];
  if (!positionMap) return list.map(heldValue);
  if (!home) return [];
  const homes = visibleHomes(positionMap, [home]);
  return list.filter((e) => homes === null || homes.has(heldHome(e))).map(heldValue);
}
/** what can be held under a value for a reader at `home`: the values a held-list lookup asks for */
function heldAsked(value, home) {
  if (!positionMap || !home) return [];
  const homes = visibleHomes(positionMap, [home]);
  return (homes === null ? [...Object.keys(positionMap.positions), EVERYONE] : [...homes]).map((h) => `${h}${HELD}${value}`);
}
/** a thing row as resolve.js reads it, with what a reader at `home` may see of its held names */
const asThing = (c, home) => ({ rid: String(c.rid), label: c.label, _norm: c._norm, _alias_norms: [...(c._alias_norms ?? []), ...heldSeen(c._held_aliases, home)], _thing_type: c._thing_type ?? null, _keys: [...(c._keys ?? []), ...heldSeen(c._held_keys, home)], _held_key: Boolean(c._held_keys?.length), _class: c._class ?? null, _homes: c._homes ?? [], ...(c.score === undefined ? {} : { score: Number(c.score) }) });

/**
 * The clause limiting a name lookup to what a statement homed at `home` may name: the same reading
 * about_thing applies for a reader there (scope.js `homeFilter`). A thing homed where that reader can't
 * see is, to the statement, no thing at all: linking to it would add this home and show its name here.
 */
function seenFromHome(home) {
  if (!positionMap || !home) return "";
  return homeFilter({ homes: visibleHomes(positionMap, [home]) });
}

/** can a reader at `home` see this thing already? */
export function seenThing(t, home) {
  if (!positionMap || !home) return true;
  const homes = visibleHomes(positionMap, [home]);
  return homes === null || (t._homes ?? []).some((h) => homes.has(h));
}

/** is a statement at `home` one every reader of this thing can read? Then what it teaches the thing may show to them all */
export function everyReaderSees(t, home) {
  if (!positionMap || !home) return true;
  return (t._homes ?? []).every((h) => {
    if (h === EVERYONE) return home === EVERYONE;
    const seen = visibleHomes(positionMap, [h]);
    return seen === null || seen.has(home);
  });
}

/** the thing holding a record key, however the key is cased (a source's row keys don't differ by case): the exact spelling first, then a scan of the lists as text, compared exactly here */
async function thingByKey(key) {
  const exact = (await adbQuery(`SELECT ${THING_COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS :k LIMIT 1`, { k: key }).catch(() => []))[0];
  if (exact) return exact;
  const pattern = `%${String(key).toLowerCase()}%`;
  const rows = await adbQuery(`SELECT ${THING_COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (_keys.asString().toLowerCase() LIKE :k OR _held_keys.asString().toLowerCase() LIKE :k) LIMIT 20`, { k: pattern }).catch(() => []);
  return rows.find((r) => [...(r._keys ?? []), ...(r._held_keys ?? []).map(heldValue)].some((k) => sameKey(k, key))) ?? null;
}

/**
 * The database as resolve.js's lookup, as a statement homed at `home` may see it; `vec` is the mention's
 * name embedding for the last step. A key is exempt: it names one row exactly, so a statement can be
 * linked to a thing it can't see, but nothing more of that thing comes back to it (thingSeenFrom).
 */
export function thingLookup(home, vec) {
  const seen = seenFromHome(home);
  const named = (n) => {
    const held = heldAsked(n, home);
    return { clause: `(_norm = :n OR _alias_norms CONTAINS :n${held.length ? " OR _held_aliases CONTAINSANY :held" : ""})`, held };
  };
  return {
    byKey: async (key) => {
      const t = await thingByKey(key);
      return t ? asThing(t, home) : null;
    },
    byName: async ({ class: cls, actor }, n) => {
      const { clause, held } = named(n);
      return (await adbQuery(`SELECT ${THING_COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND ${cls ? "_class = :c" : "_thing_type = :t"} AND ${clause}${seen} LIMIT 5`, { c: cls, t: actor, n, held }).catch(() => [])).map((t) => asThing(t, home));
    },
    byAlias: async (n) => {
      const { clause, held } = named(n);
      return (await adbQuery(`SELECT ${THING_COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND ${clause}${seen} LIMIT 5`, { n, held }).catch(() => [])).map((t) => asThing(t, home));
    },
    byEmbedding: async ({ class: cls, actor, type }) => {
      if (!Array.isArray(vec)) return [];
      const filter = cls ? " AND _class = :c" : actor || type ? " AND _thing_type = :t" : "";
      return (
        await adbQuery(`SELECT ${THING_COLS}, vectorCosineSimilarity(embed_thing, [${vec.join(",")}]) AS score FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND embed_thing IS NOT NULL${filter}${seen} ORDER BY score DESC LIMIT 3`, { c: cls, t: actor ?? type }).catch(
          () => [],
        )
      ).map((t) => asThing(t, home));
    },
  };
}

/**
 * Mint a thing: an instance from a key (with its class and SourceRef), or a name a caller vouched for.
 * `also` is homes that named it first, for a mint that holds nothing but the name they wrote. The new
 * record's own id comes back from the create, never from a search by name, which could find another's.
 * Earlier claims that resolve to it now move onto it.
 */
async function mintThing({ name, type, cls, key, home, also = [], vec, seen_by }) {
  await ensureLinkerSchema();
  const n = normalize(name);
  const made = await adbCommand(
    `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, label = :label, _kind = 'thing', _thing_type = :t, _class = :c, _norm = :n, _alias_norms = :aliases, _keys = :keys, _homes = :homes, _home = :root, embed_thing = ${Array.isArray(vec) ? `[${vec.join(",")}]` : "null"}, updated_at = :now`,
    "sql",
    { name: thingName(type, name), label: name, t: type, c: cls ?? null, n, aliases: [], keys: key ? [key] : [], homes: [...new Set([home, ...also])], root: positionMap.root, now: new Date().toISOString() },
  );
  const rid = String(made?.[0]?.["@rid"] ?? "");
  if (!RID_RE.test(rid)) throw new Error(`minting "${name}" returned no record`);
  if (key) await referTo(rid, key, { seen_by }).catch((e) => log.warn(`source ref ${key}: ${String(e?.message ?? e).slice(0, 120)}`));
  await adoptFirstMentions(rid, [n, ...(key ? [normalize(parseKey(key)?.row_key ?? "")] : [])]).catch((e) => log.warn(`earlier claims of ${name}: ${String(e?.message ?? e).slice(0, 120)}`));
  return rid;
}

/**
 * What a source says of a key's row: "found", "absent", "unknown" (no source to ask, or none reachable) or
 * "error" (it answered, and not with a row: a table it doesn't publish, a key it can't read). A key may stand
 * for a row nothing can check (ORACLE.md: "the key is still the reference, the row may not exist").
 */
async function rowOf(key) {
  const k = parseKey(key);
  if (!k) return "absent";
  try {
    const urls = (await sourcesConfig(undefined, { ttlMs: 0 }))[k.system];
    if (!urls?.read) return "unknown";
    return (await sourceClient(k.system, urls).readRow(k.table, k.row_key)) ? "found" : "absent";
  } catch (e) {
    const said = String(e?.message ?? e);
    log.warn(`row of ${key}: ${said.slice(0, 120)}`);
    return /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out|aborted/i.test(said) ? "unknown" : "error";
  }
}

export const NO_ROW = "the source holds no such row, or couldn't be asked: nothing is made of it";
/** may a key nobody holds be minted? A row the source holds, yes; one it can't be asked about, unless what's written is a row's number given a key (PO 78912) */
async function keyMayMint(mint) {
  const row = await rowOf(mint.key);
  if (row === "found") return true;
  return row === "unknown" && !(normalize(mint.name) !== normalize(mint.row_key) && isRecordNumber(mint.name));
}

/**
 * A resolution's teaching: the name and the key a thing was found under. Where every reader of the thing can
 * read the statement, they join the thing's own (and leave the held list); otherwise they are held,
 * for those who can read it.
 */
export async function teach(thing, { alias, key }, home, { seen_by } = {}) {
  if (!alias && !key) return;
  const t = (await adbQuery(`SELECT _alias_norms, _keys, _homes, _held_aliases, _held_keys FROM ${thing}`))[0];
  if (!t) return;
  const open = everyReaderSees(t, home);
  let learned = null;
  if (alias) {
    const a = normalize(alias);
    const aliases = t._alias_norms ?? [];
    const held = t._held_aliases ?? [];
    const without = held.filter((e) => heldValue(e) !== a);
    if (open && !aliases.includes(a)) {
      await adbCommand(`UPDATE ${thing} SET _alias_norms = :a, _held_aliases = :h`, "sql", { a: [...aliases, a], h: without }).catch(() => {});
      learned = a;
    } else if (!open && !aliases.includes(a) && !held.includes(`${home}${HELD}${a}`)) {
      await adbCommand(`UPDATE ${thing} SET _held_aliases = :h`, "sql", { h: [...held, `${home}${HELD}${a}`] }).catch(() => {});
      learned = a;
    }
  }
  if (key && RID_RE.test(String(thing))) {
    const keys = t._keys ?? [];
    const held = t._held_keys ?? [];
    const without = held.filter((e) => !sameKey(heldValue(e), key));
    const heldSpelling = held.map(heldValue).find((k) => sameKey(k, key));
    if (!keys.some((k) => sameKey(k, key))) {
      if (open) await adbCommand(`UPDATE ${thing} SET _keys = :k, _held_keys = :h`, "sql", { k: [...keys, heldSpelling ?? key].slice(-10), h: without }).catch(() => {});
      else if (!held.some((e) => heldHome(e) === home && sameKey(heldValue(e), key))) await adbCommand(`UPDATE ${thing} SET _held_keys = :h`, "sql", { h: [...held, `${home}${HELD}${key}`] }).catch(() => {});
    }
    await referTo(thing, keys.find((k) => sameKey(k, key)) ?? heldSpelling ?? key, { seen_by }).catch((e) => log.warn(`source ref ${key}: ${String(e?.message ?? e).slice(0, 120)}`));
  }
  if (learned) await adoptFirstMentions(thing, [learned]).catch((e) => log.warn(`earlier claims of ${alias}: ${String(e?.message ?? e).slice(0, 120)}`));
}

/** what a resolution does to the graph: mints what it says to mint, or teaches the thing it found the alias and key it was found under, and refers to the row */
async function settle(r, { key, home, also, vec, seen_by }) {
  if (r.mint) return { thing: await mintThing({ name: r.mint.name, type: r.mint.type, cls: r.mint.class, key: r.mint.key, home, also, vec, seen_by }), created: true };
  await teach(r.rid, { alias: r.alias, key }, home, { seen_by });
  return { thing: r.rid, created: false };
}

/** a claim's edge moved to its subject, in one transaction: a claim id is unique, so the old edge goes first, and a failure leaves it where it was */
export async function repointClaim(edge, section, to, { subject } = {}) {
  const c = (await adbQuery(`SELECT id, kind, class, attribute, value, value_num, valid_from, valid_until, recorded_at, recorded_by, closed_by, _home, subject FROM ${edge}`))[0];
  if (!c) throw new Error("the claim's edge is gone");
  await adbCommand(
    `BEGIN;
DELETE FROM ${edge};
CREATE EDGE CLAIMS FROM ${section} TO ${to} SET id = :id, kind = :kind, class = :cls, attribute = :attr, value = :value, value_num = :num, valid_from = :vf, valid_until = :vu, recorded_at = :ra, recorded_by = :rb, closed_by = :cb, _home = :home, subject = :subject;
COMMIT;`,
    "sqlscript",
    { id: c.id, kind: c.kind, cls: c.class, attr: c.attribute, value: c.value, num: c.value_num ?? null, vf: c.valid_from, vu: c.valid_until ?? null, ra: c.recorded_at, rb: c.recorded_by, cb: c.closed_by ?? null, home: c._home ?? null, subject: subject ?? c.subject ?? null },
  );
}

/**
 * Claims that had no thing when they were written, and resolve to this one now that it exists. Each is
 * put through resolution again as its own section's readers see it, so everything that keeps a claim
 * off a thing still applies (homes, classes, people who share a name).
 */
async function adoptFirstMentions(rid, norms) {
  const wanted = [...new Set(norms.filter(Boolean))];
  if (!wanted.length) return 0;
  const rows = await adbQuery("SELECT @rid AS edge, @out AS src, @in AS dst, _home, subject FROM CLAIMS WHERE subject_norm IN :n LIMIT 200", { n: wanted }).catch(() => []);
  const open = rows.filter((r) => String(r.src) === String(r.dst) && r.subject);
  if (!open.length) return 0;
  const classes = await confirmedClassList();
  let moved = 0;
  for (const c of open) {
    let subject;
    try {
      subject = JSON.parse(c.subject);
    } catch {
      continue;
    }
    const r = await resolveSubject(subject, { classes, lookup: thingLookup(effectiveHome(positionMap, c._home)) });
    if (r.rid !== rid || r.how === "none") continue;
    await repointClaim(String(c.edge), String(c.src), rid);
    moved++;
  }
  if (moved) log.info(`${moved} earlier claim(s) now rest on ${rid}`);
  return moved;
}

/**
 * A key a model wrote that the statement itself doesn't carry (Admission: a name mints nothing, and a
 * number made into a key is a name): it can find a row already admitted, nothing more. It mints nothing;
 * it reaches only what this statement's reader can see; it teaches nothing to a keyless thing; and
 * where the name it came with fits several people, it hasn't said which.
 */
async function keyHint(r, subject, { classes, lookup, home }) {
  const byName = await resolveSubject({ ...subject, key: null }, { classes, lookup });
  const heldKey = r.how === "key" && r.confidence === 1 && r.thing;
  return heldKey && seenThing(r.thing, home) && !sameNamedPeople(byName) ? r : byName;
}

/** the unresolved shape jobMentions stores and returns: what was named, how it was described, what it could be */
const unresolvedOf = (l) => ({ name: l.name, role: l.role, ...(l.type ? { type: l.type } : {}), ...(l.class ? { class: l.class } : {}), ...(l.actor ? { actor: l.actor } : {}), ...(l.key ? { key: l.key } : {}), ...(l.candidates?.length ? { candidates: l.candidates, unsure: l.unsure } : {}) });

/**
 * Resolve mentions to things and link a statement to them (see resolve.js):
 * by key (minting the instance and its SourceRef when the key is new), by
 * confirmed class and name, by alias, by embedding; the residue (several
 * things it could be) is linked to nothing and comes back `unsure` with its
 * candidates, for a worker thread, triage or a person. A name nothing
 * resolves is minted only when the caller vouches for it (`create: true`,
 * the default: a worker's link_things, a person) and it isn't a record key
 * mention; otherwise it comes back `skipped: UNRESOLVED` and `unresolved: true`.
 * `unsure` ("ask" | "skip") is kept for callers; nothing is created either
 * way for an unsure match. Names resolve only to things a reader at `home`
 * can see. `vouchedKeys` (a set of lowercase keys) is the keys the statement
 * itself carries: any other key on a mention came from a model and is only a
 * hint (`keyHint`); without it every key is taken as given (a worker, a
 * person). Returns what happened, one item per mention.
 */
export async function linkMentions(rid, mentions, home, { unsure = "ask", create = true, seen_by = "graph-rag linker", classes, vouchedKeys } = {}) {
  void unsure;
  const confirmed = classes ?? (await confirmedClassList());
  const vecs = mentions.length ? await embedBatch(mentions.map((m) => `${m.actor ?? m.type ?? m.class ?? "thing"}: ${m.name}`)) : [];
  const out = [];
  for (const [i, m] of mentions.entries()) {
    const subject = subjectOf({ key: m.key, name: m.name, class: m.class, actor: m.actor, type: m.type });
    const base = { name: m.name, type: m.type ?? subject.actor ?? null, role: m.role, ...(m.key ? { key: m.key } : {}), ...(subject.class ? { class: subject.class } : {}), ...(subject.actor ? { actor: subject.actor } : {}) };
    const lookup = thingLookup(home, vecs[i]);
    let r = await resolveSubject(subject, { classes: confirmed, lookup });
    const hintOnly = Boolean(m.key && vouchedKeys && !vouchedKeys.has(String(m.key).toLowerCase()));
    if (hintOnly) r = await keyHint(r, subject, { classes: confirmed, lookup, home });
    // a model that picked a known thing under a looser name ("the Exatron guys"): the thing's own name resolves it, or doesn't
    if (r.how === "none" && !r.candidates.length && m.picked_name) r = await resolveSubject({ ...subject, key: null, name: m.picked_name }, { classes: confirmed, lookup });
    // the residue's choice (the closed model call, or a worker naming a candidate): one of the candidates found.
    // Not among same-named people: the design opens with this failure, and a model's pick there is a guess
    if (r.how === "none" && m.candidate && r.candidates.length && !sameNamedPeople(r)) r = pickCandidate(r, m.candidate);
    // a person written partially ("John F.") that nothing resolved: known people it could mean are candidates
    if (r.how === "none" && !r.candidates.length && subject.actor === "person" && !m.key && partialPerson(m.name)) {
      const part = partialPerson(m.name);
      const people = (await adbQuery(`SELECT ${THING_COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = 'person' AND _norm LIKE :p${seenFromHome(home)} LIMIT 40`, { p: `${part.first} %` }).catch(() => [])).map(asThing);
      const found = personCandidates(part, people).slice(0, 6);
      if (found.length) r = { ...r, candidates: found, ambiguous: true };
    }
    if (r.how === "none" && !m.key) {
      // another entry's name ("ux-t06 bse certs"), or the code it starts with ("ux-t06"), is a cross-reference, not a thing: no placeholder for it
      const entry = await adbQuery(`SELECT @rid FROM ${ENTITY_LABEL} WHERE (name = :n OR name LIKE :code) AND ${ENTRY_KINDS} LIMIT 1`, {
        n: m.name,
        code: `${String(m.name).trim().replace(/[%_\\]/g, "")} %`,
      }).catch(() => []);
      if (entry.length) {
        out.push({ ...base, skipped: "that's an entry, not a thing: mention it in the text instead" });
        continue;
      }
    }
    if (r.how === "none" && r.candidates.length) {
      // several things it could be: nothing is linked and nothing is made; a thread, triage or a person picks
      const names = r.candidates.map((x) => `${x.label}${(x._keys ?? [])[0] ? ` [${x._keys[0]}]` : ""}`);
      out.push({ ...base, candidates: r.candidates.map((x) => x.rid), unsure: names.join(" or "), ...(r.maybe ? { maybe: r.maybe } : {}), ...(sameNamedPeople(r) ? { same_named: true } : {}) });
      continue;
    }
    let thing = r.rid;
    let created = false;
    if (r.mint) {
      // a record key nobody holds yet: the instance, with its class and its SourceRef (the row stays in the source system), when the source doesn't say otherwise
      if (!(await keyMayMint(r.mint))) {
        out.push({ ...base, skipped: NO_ROW, unresolved: true });
        continue;
      }
      ({ thing, created } = await settle(r, { home, vec: vecs[i], seen_by }));
    } else if (r.how === "none") {
      if (!create) {
        // the linker on its own mints nothing: the name goes back for a worker or a person
        out.push({ ...base, skipped: UNRESOLVED, unresolved: true });
        continue;
      }
      // a row's number takes its key, whoever vouches for it (PO 78912: an attribute of the job rows)
      if (isRecordNumber(m.name)) {
        out.push({ ...base, skipped: "a row's number is content or a key, not a name to make a thing of", unresolved: true });
        continue;
      }
      // the caller vouches for the name (a worker's judgement, a person): minted, with its class when a confirmed one was named
      thing = await mintThing({ name: m.name, type: hintType({ type: m.type, actor: subject.actor, class: r.class }), cls: r.class, key: null, home, vec: vecs[i], seen_by });
      created = true;
    } else {
      // a hint teaches nothing unless the key really found the row
      await settle(r, { key: hintOnly && r.how !== "key" ? null : (r.key ?? m.key), home, vec: vecs[i], seen_by });
    }
    if (!RID_RE.test(String(thing))) continue;
    await thingSeenFrom(thing, home);
    await aboutOnce(rid, thing, m.role);
    out.push({ ...base, [created ? "created" : "linked"]: true, how: r.how, ...(r.class ? { class: r.class } : {}), thing });
  }
  return out;
}

/** the things already known that a text names, by exact name or alias, as a reader at `home` sees them: the candidates the closed call chooses from */
export async function knownInText(text, home, limit = 12) {
  const grams = ngrams(text);
  if (!grams.length) return [];
  const visible = seenFromHome(home);
  const rows = [
    ...(await adbQuery(`SELECT ${THING_COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _norm IN :g${visible} LIMIT ${limit}`, { g: grams }).catch(() => [])),
    ...(await adbQuery(`SELECT ${THING_COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _alias_norms CONTAINSANY :g${visible} LIMIT ${limit}`, { g: grams }).catch(() => [])),
  ];
  const seen = new Set();
  return rows
    .filter((r) => !seen.has(String(r.rid)) && seen.add(String(r.rid)))
    .slice(0, limit)
    .map((r) => ({ rid: String(r.rid), label: r.label, type: r._thing_type ?? null, class: r._class ?? null, keys: r._keys ?? [] }));
}

/**
 * The one-call job: find the subjects one statement names and link them.
 * Subjects already on record (CLAIMS edges from the entry) and record keys
 * written in the text need no model. The closed call over the confirmed
 * classes and the things already known finds the rest; resolution settles
 * each (resolve.js); the residue with candidates gets one more closed call
 * (which candidate) unless a worker thread will look anyway. Nothing is
 * minted but by key: unresolved names are stored on the entry
 * (`_unresolved`) and returned; with a pool that sorts first they go to a
 * review thread, and the same call decides whether a worker thread should
 * look anyway.
 */
export async function jobMentions({ rid, from_worker, no_thread, intake }) {
  if (!RID_RE.test(String(rid))) return;
  const row = (await adbQuery(`SELECT FROM ${rid}`))[0];
  if (!row?.name || (row._kind && !THING_KINDS_READ.includes(row._kind))) return; // gone, or a question/thing/document entry
  const facets = Object.fromEntries(Object.keys(FACETS).filter((f) => row[`text_${f}`]).map((f) => [f, row[`text_${f}`]]));
  if (Object.keys(facets).length === 0) return;
  const home = effectiveHome(positionMap, row._home);
  const text = Object.values(facets).join("\n");
  // subjects the condenser already resolved: the entry's claims point at them
  const claimEdges = (await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('CLAIMS')) FROM ${rid})`).catch(() => [])).map((e) => String(e.dst));
  const claimed = claimEdges.filter((d) => RID_RE.test(d) && d !== String(rid)); // (an unresolved claim points back at its own section)
  const thingless = claimEdges.length - claimed.length;
  for (const dst of new Set(claimed)) {
    await thingSeenFrom(dst, home).catch(() => {});
    await aboutOnce(rid, dst, "subject").catch(() => {});
  }
  // record keys written in the text resolve without a model
  const keyed = keysInText(text).map((k) => ({ name: k.split(":")[2], type: null, role: "subject", key: k }));
  const sort = worker.pool.poolSize > 0 && worker.pool.sortFirst && !worker.pool.master && !from_worker && !no_thread && !intake;
  const classes = await confirmedClassList();
  const candidates = await knownInText(text, home);
  const reply = await workerCall(mentionsPrompt({ name: row.name, facets }, worker.instructions, { sort, classes, candidates }));
  const vouchedKeys = new Set(keyed.map((k) => k.key.toLowerCase()));
  const named = parseMentions(reply, MAX_MENTIONS, { candidates }).filter((m) => !m.key || !vouchedKeys.has(m.key.toLowerCase()));
  const mentions = [...keyed, ...named];
  // the linker on its own: by key, by class and name, by alias, by embedding; never a new name, and never a number a model made into a key
  let linked = await linkMentions(rid, mentions, home, { unsure: sort ? "skip" : "ask", create: false, classes, vouchedKeys });
  // the residue: several known things a name could be; one closed call picks, unless a worker thread will look anyway (same-named people aren't a model's to settle: linkMentions would drop its pick)
  const residue = linked.filter((l) => l.unsure && l.candidates?.length && !l.key && !l.same_named);
  if (residue.length && !sort && !(intake && DECISION_API_KEY)) {
    const cands = (await adbQuery(`SELECT ${THING_COLS} FROM [${[...new Set(residue.flatMap((r) => r.candidates))].join(",")}]`).catch(() => [])).map(asThing);
    const byRid = new Map(cands.map((c) => [c.rid, c]));
    const asked = residue.map((r) => ({ name: r.name, role: r.role, candidates: r.candidates.map((c) => byRid.get(c)).filter(Boolean).map((c) => ({ rid: c.rid, label: c.label, type: c._thing_type, class: c._class, keys: c._keys })) })).filter((r) => r.candidates.length);
    const picks = asked.length ? parseResidue(await workerCall(residuePrompt({ name: row.name, facets }, asked)).catch(() => ""), asked) : new Map();
    if (picks.size) {
      const settled = await linkMentions(
        rid,
        residue.filter((r) => picks.has(r.name)).map((r) => ({ name: r.name, type: r.type, role: r.role, class: r.class, actor: r.actor, candidate: picks.get(r.name) })),
        home,
        { unsure: "skip", create: false, classes, vouchedKeys },
      );
      linked = linked.map((l) => settled.find((s) => s.name === l.name && (s.linked || s.created)) ?? l);
    }
  }
  const unresolved = linked.filter((l) => l.unresolved || l.unsure).map(unresolvedOf);
  await ensureLinkerSchema();
  await adbCommand(`UPDATE ${rid} SET _mentions_at = :now, _unresolved = :u`, "sql", { now: new Date().toISOString(), u: unresolved.length ? JSON.stringify(unresolved) : null });
  // with a master: into the next batch, with what linking couldn't settle (unresolved names go as fresh ones for its worker)
  if (intake) await intakeWithTriage(String(rid), row, linked, home);
  if (sort) {
    const verdict = parseSort(reply);
    const unsure = linked.filter((l) => l.unsure);
    const fresh = linked.filter((l) => l.unresolved);
    if (verdict.review || unsure.length || fresh.length || thingless) {
      const why = [
        verdict.why,
        ...(thingless ? [`${thingless} claim(s) here have a subject nothing resolves`] : []),
        ...unsure.map((u) => `"${u.name}" may be the existing ${u.type ?? "thing"} "${u.unsure}"`),
        ...(fresh.length ? [`nothing known resolves ${fresh.map((f) => `"${f.name}"`).join(", ")}: link an existing thing, make one on purpose, or leave it in the text`] : []),
      ]
        .filter(Boolean)
        .join("; ");
      await enqueue("review", { rid: String(rid), why }, { key: `review:${rid}` });
    }
  }
  return { things: linked.filter((l) => l.linked || l.created).length, unresolved };
}

/** a thing's full name ("Toro (customer)", as searches show it) is its name and type */
export function bareThing(t) {
  const m = splitThingName(t?.name);
  return m ? { ...t, name: m.name, type: t.type ?? m.type } : t;
}

/**
 * An entry write naming a thing ("CNC 2 (machine)", or a bare "CNC 2" with
 * no entry of that name yet) would make a copy beside the thing: the thing it
 * clashes with, or null.
 */
export async function thingNamed(name) {
  const full = splitThingName(name);
  const n = normalize(full ? full.name : name);
  const things = await adbQuery(
    `SELECT @rid AS rid, label, _thing_type FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (name = :full OR _norm = :n OR _alias_norms CONTAINS :n)${full ? " AND (_thing_type = :t OR _class = :t)" : ""} LIMIT 1`,
    { full: name, n, t: full?.type },
  ).catch(() => []);
  if (!things.length) return null;
  if (full) return things[0];
  const entry = await adbQuery(`SELECT @rid FROM ${ENTITY_LABEL} WHERE name = :n AND ${ENTRY_KINDS} LIMIT 1`, { n: name }).catch(() => []);
  return entry.length ? null : things[0];
}

/**
 * The subject of a claim on the record path, as the rid of its thing, or null when it has none: a thing
 * resolved the way a mention is (key, class and name, alias, embedding; only what a reader at `home`
 * sees), else minted when admission says it earned a node. Null is an unresolved subject: several things
 * it could be (nobody picks here, and the next document must not mint another), or content inside the
 * claim. The caller points such a claim back at its section, the shape worker-pool.js reads as
 * unresolved. A class subject (`scope: "class"`) is that class's own thing, one per class and name.
 */
export async function recordSubject(subject, home, { kind = null, classes, notFrom } = {}) {
  const seen_by = "graph-rag record path";
  const confirmed = classes ?? (await confirmedClassList());
  const name = subject.scope === "class" ? (subject.name ? `${subject.class} (${subject.name})` : subject.class) : subject.name ?? subject.key;
  const hint = hintType({ actor: subject.actor, key: subject.key, class: subject.class });
  const vec = (await embedBatch([`${hint}: ${name}`]).catch(() => [null]))[0];
  const lookup = thingLookup(home, vec);
  if (subject.scope === "class") {
    const own = (await lookup.byName({ class: subject.class }, normalize(name)))[0]?.rid;
    const rid = own ?? (await mintThing({ name, type: "class", cls: subject.class, key: null, home, vec, seen_by }));
    if (own) await thingSeenFrom(rid, home);
    return rid;
  }
  const r = await resolveSubject(subject, { classes: confirmed, lookup });
  if (r.how === "none") {
    if (r.candidates.length) return null;
    const recorded = parseTable(confirmedClasses(confirmed).get(subject.class)?.record_table);
    const said = classKind(subject.class);
    const individual = namesAnIndividual(subject.name);
    const actor = subject.actor ?? (individual && ACTOR_TYPES.includes(said) ? said : null);
    const machine = !actor && said === "machine" && hasDesignator(subject.name);
    const places = await placesNaming(subject, notFrom);
    const verdict = admits({ name: subject.name, actor }, { references: places.count + 1, isCommitment: kind === "commitment" && !recorded, identity: machine });
    // a class whose rows live in a source takes the row's key, unless it is about an actor or a machine, which are things by name
    if (!verdict.admitted || (recorded && verdict.rule !== 1)) return null;
    // an actor, a machine or a proper name is one thing under every class it is written with: no class of its own, or the next class wouldn't find it
    const whole = actor || machine || properName(subject.name);
    return mintThing({ name: subject.name, type: actor ?? (machine ? "machine" : whole ? "thing" : hint), cls: whole ? null : subject.class, key: null, home, also: places.homes, vec, seen_by });
  }
  if (r.mint && !(await keyMayMint(r.mint))) return null;
  // minted from a key: the class the record names when no confirmed class claims the table
  const named = r.mint ? { ...r, mint: { ...r.mint, class: r.mint.class ?? subject.class ?? null } } : r;
  const { thing, created } = await settle(named, { key: r.key ?? subject.key, home, vec, seen_by });
  if (!created) {
    if (subject.class && !r.thing?._class && everyReaderSees(r.thing ?? {}, home)) await adbCommand(`UPDATE ${thing} SET _class = :c`, "sql", { c: subject.class }).catch(() => {});
    await thingSeenFrom(thing, home);
  }
  return thing;
}

/**
 * The other sections holding an unresolved claim about this subject, and where they are homed (admission's
 * second rule: a reference from more than one place earns a node). A code under another class is another subject,
 * and a document's own sections are one place (`notFrom`), however many times it is run.
 */
async function placesNaming(subject, notFrom = new Set()) {
  const rows = await adbQuery("SELECT @out AS src, _home, subject FROM CLAIMS WHERE subject_norm = :n LIMIT 200", { n: normalize(subject.name) }).catch(() => []);
  const fits = rows.filter((r) => {
    if (notFrom.has(String(r.src))) return false;
    try {
      const s = JSON.parse(r.subject);
      return properName(subject.name) || !s.class || !subject.class || s.class === subject.class; // (a proper name is one subject whatever class it is written under; a code is not: Q-77)
    } catch {
      return false;
    }
  });
  return { count: new Set(fits.map((r) => String(r.src))).size, homes: [...new Set(fits.map((r) => effectiveHome(positionMap, r._home)))] };
}

export const ENTRY_KINDS = "(_kind IS NULL OR _kind IN ['document', 'section', 'task'])";

/** an entry by its id ("#1:352258") or its name; when several share the name, the id is needed */
export async function findEntry(ref) {
  const id = entryId(ref);
  if (id) {
    const row = (await adbQuery(`SELECT @rid AS rid, name, _home, _origin FROM ${id} WHERE name IS NOT NULL AND ${ENTRY_KINDS}`).catch(() => []))[0];
    if (!row) throw new Error(`no entry ${id}`);
    return row;
  }
  const rows = await adbQuery(`SELECT @rid AS rid, name, _home, _origin, updated_at FROM ${ENTITY_LABEL} WHERE name = :n AND ${ENTRY_KINDS} LIMIT 6`, { n: String(ref) });
  if (!rows.length) throw new Error(`no entry called "${ref}"`);
  if (rows.length > 1) {
    for (const r of rows) {
      r.home = homeName(positionMap, r._home);
      r.links = Number((await adbQuery(`SELECT count(*) AS n FROM (SELECT expand(outE('ABOUT')) FROM ${r.rid})`).catch(() => []))[0]?.n ?? 0);
    }
    throw new Error(duplicateEntries(String(ref), rows.map((r) => ({ ...r, rid: String(r.rid) }))));
  }
  return rows[0];
}
