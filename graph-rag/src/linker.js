/**
 * The linker (see things.js): resolving a statement's subjects to things through resolve.js, linking the
 * statement to them, and finding things and entries by name, key or id.
 *
 * Admission (docs/ORGANIZATION-MODEL.md): the linker mints a thing only from a record key (an instance, with
 * its SourceRef) or when the caller vouches for the name (`create: true`: a worker's link_things, a person).
 * Running on its own (jobMentions) it mints nothing but by key: a subject it can't resolve comes back
 * unresolved, on the entry (`_unresolved`) and to triage, for a worker or a person to decide.
 */
import { effectiveHome, homeName, visibleHomes } from "./positions.js";
import { duplicateEntries, entryId, keysInText, MAX_MENTIONS, mentionsPrompt, ngrams, normalize, splitThingName, normalizeKey, parseMentions, parseResidue, parseSort, partialPerson, personCandidates, residuePrompt, thingName } from "./things.js";
import { admits, confirmedClasses, hintType, pickCandidate, resolveSubject, sameKey, sameNamedPeople, subjectOf } from "./resolve.js";
import { referTo } from "./sourceref.js";
import { parseTable, statements, TYPES } from "./model/schema.js";
import { DECISION_API_KEY, log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, FACETS, RID_RE } from "./db.js";
import { embedBatch } from "./models.js";
import { homeFilter, positionMap } from "./scope.js";
import { enqueue, worker, workerCall } from "./worker-pool.js";
import { intakeWithTriage } from "./triage.js";

const THING_KINDS_READ = ["document", "section"]; // besides plain entries, what the worker reads for things
const THING_COLS = "@rid AS rid, label, _norm, _alias_norms, _thing_type, _keys, _class, _homes";
const CLASS_CACHE_MS = 60_000; // confirmed classes are read this often...
const NO_CLASS_CACHE_MS = 5_000; // ...unless there were none yet: discovery may confirm the first one any moment

/** a thing's visibility follows the statements about it: add a home */
export async function thingSeenFrom(rid, home) {
  const row = (await adbQuery(`SELECT _homes FROM ${rid}`))[0];
  const homes = Array.isArray(row?._homes) ? row._homes : [];
  if (!homes.includes(home)) await adbCommand(`UPDATE ${rid} SET _homes = :homes`, "sql", { homes: [...homes, home] });
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

/** a thing row as resolve.js reads it */
const asThing = (c) => ({ rid: String(c.rid), label: c.label, _norm: c._norm, _alias_norms: c._alias_norms ?? [], _thing_type: c._thing_type ?? null, _keys: c._keys ?? [], _class: c._class ?? null, _homes: c._homes ?? [], ...(c.score === undefined ? {} : { score: Number(c.score) }) });

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
function seenThing(t, home) {
  if (!positionMap || !home) return true;
  const homes = visibleHomes(positionMap, [home]);
  return homes === null || (t._homes ?? []).some((h) => homes.has(h));
}

/** the thing holding a record key, however the key is cased (a source's row keys don't differ by case): the exact spelling first, then a scan of the lists as text, compared exactly here */
async function thingByKey(key) {
  const exact = (await adbQuery(`SELECT ${THING_COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS :k LIMIT 1`, { k: key }).catch(() => []))[0];
  if (exact) return exact;
  const rows = await adbQuery(`SELECT ${THING_COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys.asString().toLowerCase() LIKE :k LIMIT 20`, { k: `%${String(key).toLowerCase()}%` }).catch(() => []);
  return rows.find((r) => (r._keys ?? []).some((k) => sameKey(k, key))) ?? null;
}

/**
 * The database as resolve.js's lookup, as a statement homed at `home` may see it; `vec` is the mention's
 * name embedding for the last step. A key is exempt: it names one row exactly, and nothing was guessed.
 */
export function thingLookup(home, vec) {
  const seen = seenFromHome(home);
  return {
    byKey: async (key) => {
      const t = await thingByKey(key);
      return t ? asThing(t) : null;
    },
    byName: async ({ class: cls, actor }, n) =>
      (
        await adbQuery(`SELECT ${THING_COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND ${cls ? "_class = :c" : "_thing_type = :t"} AND (_norm = :n OR _alias_norms CONTAINS :n)${seen} LIMIT 5`, { c: cls, t: actor, n }).catch(() => [])
      ).map(asThing),
    byAlias: async (n) => (await adbQuery(`SELECT ${THING_COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (_norm = :n OR _alias_norms CONTAINS :n)${seen} LIMIT 5`, { n }).catch(() => [])).map(asThing),
    byEmbedding: async ({ class: cls, actor, type }) => {
      if (!Array.isArray(vec)) return [];
      const filter = cls ? " AND _class = :c" : actor || type ? " AND _thing_type = :t" : "";
      return (
        await adbQuery(`SELECT ${THING_COLS}, vectorCosineSimilarity(embed_thing, [${vec.join(",")}]) AS score FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND embed_thing IS NOT NULL${filter}${seen} ORDER BY score DESC LIMIT 3`, { c: cls, t: actor ?? type }).catch(
          () => [],
        )
      ).map(asThing);
    },
  };
}

/** mint a thing: an instance from a key (with its class and SourceRef), or a name a caller vouched for */
async function mintThing({ name, type, cls, key, home, vec, seen_by }) {
  await ensureLinkerSchema();
  const n = normalize(name);
  await adbCommand(
    `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, label = :label, _kind = 'thing', _thing_type = :t, _class = :c, _norm = :n, _alias_norms = :aliases, _keys = :keys, _homes = :homes, _home = :root, embed_thing = ${Array.isArray(vec) ? `[${vec.join(",")}]` : "null"}, updated_at = :now`,
    "sql",
    { name: thingName(type, name), label: name, t: type, c: cls ?? null, n, aliases: [], keys: key ? [key] : [], homes: [home], root: positionMap.root, now: new Date().toISOString() },
  );
  const rid = String(
    (
      await adbQuery(
        key ? `SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS :k ORDER BY @rid DESC LIMIT 1` : `SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = :t AND _norm = :n ORDER BY @rid DESC LIMIT 1`,
        { k: key, t: type, n },
      )
    )[0]?.rid,
  );
  if (key && RID_RE.test(rid)) await referTo(rid, key, { seen_by }).catch((e) => log.warn(`source ref ${key}: ${String(e?.message ?? e).slice(0, 120)}`));
  return rid;
}

/** what a resolution does to the graph: mints what it says to mint, or teaches the thing it found the alias and key it was found under, and refers to the row */
async function settle(r, { key, home, vec, seen_by }) {
  if (r.mint) return { thing: await mintThing({ name: r.mint.name, type: r.mint.type, cls: r.mint.class, key: r.mint.key, home, vec, seen_by }), created: true };
  const thing = r.rid;
  if (r.alias) {
    const cur = (await adbQuery(`SELECT _alias_norms FROM ${thing}`))[0]?._alias_norms ?? [];
    await adbCommand(`UPDATE ${thing} SET _alias_norms = :a`, "sql", { a: [...new Set([...cur, normalize(r.alias)])] }).catch(() => {});
  }
  if (key && RID_RE.test(String(thing))) {
    // a thing found by name learns its record key, and refers to the row; a different spelling of a key it holds is the key it holds
    const cur = (await adbQuery(`SELECT _keys FROM ${thing}`))[0]?._keys ?? [];
    if (!cur.some((k) => sameKey(k, key))) await adbCommand(`UPDATE ${thing} SET _keys = :k`, "sql", { k: [...cur, key].slice(-10) }).catch(() => {});
    await referTo(thing, cur.find((k) => sameKey(k, key)) ?? key, { seen_by }).catch((e) => log.warn(`source ref ${key}: ${String(e?.message ?? e).slice(0, 120)}`));
  }
  return { thing, created: false };
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
      // a record key nobody holds yet: the instance, with its class and its SourceRef (the row stays in the source system)
      ({ thing, created } = await settle(r, { home, vec: vecs[i], seen_by }));
    } else if (r.how === "none") {
      if (!create) {
        // the linker on its own mints nothing: the name goes back for a worker or a person
        out.push({ ...base, skipped: UNRESOLVED, unresolved: true });
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
  const claimed = (await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('CLAIMS')) FROM ${rid})`).catch(() => [])).map((e) => String(e.dst)).filter((d) => RID_RE.test(d) && d !== String(rid)); // (an unresolved claim points back at its own section)
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
    if (verdict.review || unsure.length || fresh.length) {
      const why = [
        verdict.why,
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
export async function recordSubject(subject, home, { kind = null, classes } = {}) {
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
    const references = (await placesNaming(subject.name)) + 1;
    if (!admits({ name: subject.name, actor: subject.actor }, { references, isCommitment: kind === "commitment" && !recorded }).admitted) return null;
    return mintThing({ name: subject.name, type: hint, cls: subject.class, key: null, home, vec, seen_by });
  }
  // minted from a key: the class the record names when no confirmed class claims the table
  const named = r.mint ? { ...r, mint: { ...r.mint, class: r.mint.class ?? subject.class ?? null } } : r;
  const { thing, created } = await settle(named, { key: r.key ?? subject.key, home, vec, seen_by });
  if (!created) {
    if (subject.class && !r.thing?._class) await adbCommand(`UPDATE ${thing} SET _class = :c`, "sql", { c: subject.class }).catch(() => {});
    await thingSeenFrom(thing, home);
  }
  return thing;
}

/** how many sections already hold an unresolved claim about this name (admission's second rule: a reference from more than one place earns a node) */
async function placesNaming(name) {
  const rows = await adbQuery("SELECT @out AS src FROM CLAIMS WHERE subject_norm = :n LIMIT 200", { n: normalize(name) }).catch(() => []);
  return new Set(rows.map((r) => String(r.src))).size;
}

/** one thing by key, or by name/alias and type (a hint, an actor type or a class); null when there's none (or several). A key is an identity: a key nobody holds is no thing, whatever shares its name */
export async function findThing(ref) {
  const t = bareThing(ref);
  const key = normalizeKey(t.key);
  if (key) return thingByKey(key);
  const n = normalize(t.name);
  const rows = await adbQuery(
    `SELECT @rid AS rid, label, _thing_type, _class, _homes FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (_norm = :n OR _alias_norms CONTAINS :n)${t.type ? " AND (_thing_type = :t OR _class = :t)" : ""} LIMIT 2`,
    { n, t: t.type },
  );
  return rows.length === 1 ? rows[0] : null;
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
