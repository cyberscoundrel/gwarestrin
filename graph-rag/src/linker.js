/**
 * The linker (see things.js): resolving mentions to things, linking statements to them, and finding things and
 * entries by name, key or id.
 */
import { effectiveHome, homeName } from "./positions.js";
import { duplicateEntries, entryId, mentionsPrompt, normalize, splitThingName, normalizeKey, parseMentions, parseSort, partialPerson, personCandidates, resolve, thingName } from "./things.js";
import { DECISION_API_KEY } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, FACETS, RID_RE } from "./db.js";
import { embedBatch } from "./models.js";
import { positionMap } from "./scope.js";
import { queueWrite } from "./write.js";
import { enqueue, intakeWithTriage, worker, workerCall } from "./server.js";

const THING_KINDS_READ = ["document", "section"]; // besides plain entries, what the worker reads for things

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
 * Resolve mentions to things and link a statement to them (see things.js):
 * exact or very close -> that thing; close but unsure -> a new thing plus a
 * merge question for a person (or, with `unsure: "skip"`, nothing: a worker
 * thread decides instead); otherwise a new thing. Returns what happened.
 */
export async function linkMentions(rid, mentions, home, { unsure = "ask", create = true } = {}) {
  const vecs = mentions.length ? await embedBatch(mentions.map((m) => `${m.type}: ${m.name}`)) : [];
  const out = [];
  for (const [i, m] of mentions.entries()) {
    const n = normalize(m.name);
    // a record key finds its thing whatever it's called (and whatever type was guessed)
    const byKey = m.key
      ? await adbQuery(`SELECT @rid AS rid, label, _alias_norms, _thing_type, _keys FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS :k LIMIT 1`, { k: m.key }).catch(() => [])
      : [];
    const byName = byKey.length
      ? byKey
      : await adbQuery(
          `SELECT @rid AS rid, label, _alias_norms, _thing_type, _keys FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = :t AND (_norm = :n OR _alias_norms CONTAINS :n) LIMIT 5`,
          { t: m.type, n },
        ).catch(() => []);
    const near = byName.length
      ? []
      : await adbQuery(
          `SELECT @rid AS rid, label, _alias_norms, _thing_type, vectorCosineSimilarity(embed_thing, [${vecs[i].join(",")}]) AS score FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = :t AND embed_thing IS NOT NULL ORDER BY score DESC LIMIT 3`,
          { t: m.type },
        ).catch(() => []);
    const cands = [...byName, ...near].map((c) => ({
      rid: String(c.rid),
      name: c.label,
      aliases: c._alias_norms ?? [],
      // a keyed match counts as the mention's type: the key decides
      type: byKey.length ? m.type : c._thing_type,
      keys: c._keys ?? [],
      score: c.score === undefined ? undefined : Number(c.score),
    }));
    let r = resolve(m, cands);
    // a person written partially ("John F.") that would become a new thing: known people it could mean are candidates
    if (r.create && !r.maybe && m.type === "person" && !m.key && partialPerson(m.name)) {
      const part = partialPerson(m.name);
      const people = await adbQuery(`SELECT @rid AS rid, label FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = 'person' AND _norm LIKE :p LIMIT 40`, { p: `${part.first} %` }).catch(() => []);
      const found = personCandidates(part, people).slice(0, 6);
      if (found.length) r = { ambiguous: found.map((c) => String(c.rid)) };
    }
    if (r.create && !m.key) {
      // another entry's name ("ux-t06 bse certs"), or the code it starts with ("ux-t06"), is a cross-reference, not a thing: no placeholder for it
      const entry = await adbQuery(`SELECT @rid FROM ${ENTITY_LABEL} WHERE (name = :n OR name LIKE :code) AND ${ENTRY_KINDS} LIMIT 1`, {
        n: m.name,
        code: `${String(m.name).trim().replace(/[%_\\]/g, "")} %`,
      }).catch(() => []);
      if (entry.length) {
        out.push({ name: m.name, type: m.type, role: m.role, skipped: "that's an entry, not a thing: mention it in the text instead" });
        continue;
      }
    }
    if (r.create && !create) {
      // what a worker wrote links only to things that exist (it makes new ones on purpose, with link_things)
      out.push({ name: m.name, type: m.type, role: m.role, ...(m.key ? { key: m.key } : {}), skipped: NOT_A_THING });
      continue;
    }
    if (r.ambiguous) {
      // several things go by this name: nothing is linked; a thread (or the sorting step's escalation) picks
      const names = await adbQuery(`SELECT label, _keys FROM [${r.ambiguous.join(",")}]`).catch(() => []);
      out.push({ name: m.name, type: m.type, role: m.role, candidates: r.ambiguous, unsure: names.map((x) => `${x.label}${(x._keys ?? [])[0] ? ` [${x._keys[0]}]` : ""}`).join(" or ") });
      continue;
    }
    if (r.create && r.maybe && unsure === "skip") {
      const other = (await adbQuery(`SELECT label FROM ${r.maybe}`))[0]?.label;
      out.push({ name: m.name, type: m.type, role: m.role, candidates: [r.maybe], unsure: other ?? null });
      continue;
    }
    let thing = r.use;
    if (r.alias) {
      const cur = (await adbQuery(`SELECT _alias_norms FROM ${thing}`))[0]?._alias_norms ?? [];
      await adbCommand(`UPDATE ${thing} SET _alias_norms = :a`, "sql", { a: [...new Set([...cur, normalize(r.alias)])] }).catch(() => {});
    }
    if (r.create) {
      await adbCommand(
        `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, label = :label, _kind = 'thing', _thing_type = :t, _norm = :n, _alias_norms = :aliases, _keys = :keys, _homes = :homes, _home = :root, embed_thing = [${vecs[i].join(",")}], updated_at = :now`,
        "sql",
        { name: thingName(m.type, m.name), label: m.name, t: m.type, n, aliases: [], keys: m.key ? [m.key] : [], homes: [home], root: positionMap.root, now: new Date().toISOString() },
      );
      thing = String((await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = :t AND _norm = :n ORDER BY @rid DESC LIMIT 1`, { t: m.type, n }))[0]?.rid);
    } else if (m.key && RID_RE.test(String(thing))) {
      // a thing found by name learns its record key
      const cur = (await adbQuery(`SELECT _keys FROM ${thing}`))[0]?._keys ?? [];
      if (!cur.includes(m.key)) await adbCommand(`UPDATE ${thing} SET _keys = :k`, "sql", { k: [...cur, m.key].slice(-10) }).catch(() => {});
    }
    if (r.create) {
      if (r.maybe && RID_RE.test(thing)) {
        // unsure: a person decides whether they're the same (nothing merges on its own)
        const other = (await adbQuery(`SELECT label FROM ${r.maybe}`))[0]?.label;
        await queueWrite({ kind: "merge", payload: JSON.stringify({ keep: r.maybe, drop: thing, keep_name: other, drop_name: m.name, type: m.type }), user: "graph-rag worker", home: positionMap.root });
      }
    }
    if (!RID_RE.test(String(thing))) continue;
    await thingSeenFrom(thing, home);
    await aboutOnce(rid, thing, m.role);
    out.push({ name: m.name, type: m.type, role: m.role, [r.create ? "created" : "linked"]: true });
  }
  return out;
}

/**
 * The one-call job: find the things one statement is about and link them.
 * With a pool that sorts first, the same call decides whether a worker
 * thread should look (and an unsure match always sends it there instead of
 * to a person). Entries a worker wrote never go back to a thread.
 */
export async function jobMentions({ rid, from_worker, no_thread, intake }) {
  if (!RID_RE.test(String(rid))) return;
  const row = (await adbQuery(`SELECT FROM ${rid}`))[0];
  if (!row?.name || (row._kind && !THING_KINDS_READ.includes(row._kind))) return; // gone, or a question/thing/document entry
  const facets = Object.fromEntries(Object.keys(FACETS).filter((f) => row[`text_${f}`]).map((f) => [f, row[`text_${f}`]]));
  if (Object.keys(facets).length === 0) return;
  const sort = worker.pool.poolSize > 0 && worker.pool.sortFirst && !worker.pool.master && !from_worker && !no_thread && !intake;
  const reply = await workerCall(mentionsPrompt({ name: row.name, facets }, worker.instructions, { sort }));
  const mentions = parseMentions(reply);
  const home = effectiveHome(positionMap, row._home);
  // going to triage: only existing things now; a new name becomes a thing once triage has looked (intakeWithTriage)
  const deferNew = Boolean(intake && DECISION_API_KEY);
  const linked = await linkMentions(rid, mentions, home, { unsure: sort ? "skip" : "ask", create: !from_worker && !deferNew });
  await adbCommand(`UPDATE ${rid} SET _mentions_at = :now`, "sql", { now: new Date().toISOString() });
  // with a master: into the next batch, with what linking couldn't settle
  if (intake) await intakeWithTriage(String(rid), row, linked, home);
  if (sort) {
    const verdict = parseSort(reply);
    const unsure = linked.filter((l) => l.unsure);
    if (verdict.review || unsure.length) {
      const why = [verdict.why, ...unsure.map((u) => `"${u.name}" may be the existing ${u.type} "${u.unsure}"`)].filter(Boolean).join("; ");
      await enqueue("review", { rid: String(rid), why }, { key: `review:${rid}` });
    }
  }
  return { things: mentions.length };
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
    `SELECT @rid AS rid, label, _thing_type FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (name = :full OR _norm = :n OR _alias_norms CONTAINS :n)${full ? " AND _thing_type = :t" : ""} LIMIT 1`,
    { full: name, n, t: full?.type },
  ).catch(() => []);
  if (!things.length) return null;
  if (full) return things[0];
  const entry = await adbQuery(`SELECT @rid FROM ${ENTITY_LABEL} WHERE name = :n AND ${ENTRY_KINDS} LIMIT 1`, { n: name }).catch(() => []);
  return entry.length ? null : things[0];
}

/** one thing by key, or by name/alias and type; null when there's none (or several) */
export async function findThing(ref) {
  const t = bareThing(ref);
  const key = normalizeKey(t.key);
  if (key) {
    const k = (await adbQuery(`SELECT @rid AS rid, label, _thing_type, _homes FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS :k LIMIT 1`, { k: key }))[0];
    if (k) return k;
  }
  const n = normalize(t.name);
  const rows = await adbQuery(
    `SELECT @rid AS rid, label, _thing_type, _homes FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (_norm = :n OR _alias_norms CONTAINS :n)${t.type ? " AND _thing_type = :t" : ""} LIMIT 2`,
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
