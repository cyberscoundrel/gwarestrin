/**
 * Class storage, reads and corrections (docs/ORGANIZATION-MODEL.md, "Classes, subclasses and instances";
 * model/classes.js for the shapes). A class is an Entity with `_kind: 'class'`, scoped by `_home` like any
 * node (earlier ruling), so every read filter that covers entities covers it. Its parents are SUBCLASS_OF
 * edges (R9: several allowed). Its home is worked out here from its evidence (R11), never chosen by a model,
 * and is no wider than any parent's (R9, strictest wins). A name is unique in the organization
 * (model/classes.js NAMES_UNIQUE), held by the database's unique index on `_class_key`.
 *
 * Who may do what (R5, R7): the orchestrator creates and changes classes; nothing else does (no chat agent,
 * no condenser, no worker). A person corrects (R11), and a correction is kept on the class and respected by
 * every later run: a retired class never returns on its own.
 *
 * The classes and discovery stream owns this module.
 */
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { entriesByUser, positionMap } from "./scope.js";
import { effectiveHome, EVERYONE, visibleHomes } from "./positions.js";
import { connectionHome, noteHome } from "./discovery.js";
import {
  AI_AGENTS,
  MIRROR_HOME,
  applyCorrections,
  assertCreatable,
  assertParents,
  assertUnpinned,
  classIndex,
  classKey,
  evidenceSystem,
  homeFromEvidence,
  mayHaveStages,
  normalizeClass,
  normalizeCorrection,
  normalizeEvidence,
  peopleInstances,
  pinned,
  positionClasses,
  seedClasses,
  SEEDED_KEYS,
  treeHomes,
} from "./model/classes.js";
import { ShapeError } from "./model/text.js";

const COLS = "@rid AS rid, _class_name, _class_key, _home, _description, _evidence, _rows_are_nodes, _record_table, _stages, _status, _corrections, _run, _mirror";

const json = (v, fallback) => {
  if (Array.isArray(v)) return v;
  try {
    const j = JSON.parse(v ?? "");
    return Array.isArray(j) ? j : fallback;
  } catch {
    return fallback;
  }
};

/** a stored row as a class */
function shape(r) {
  return {
    rid: String(r.rid),
    name: r._class_name,
    key: r._class_key,
    parents: [],
    home: r._home ?? positionMap?.root ?? null,
    description: r._description ?? null,
    evidence: json(r._evidence, []),
    rows_are_nodes: r._rows_are_nodes === true,
    record_table: r._record_table ?? null,
    stages: Array.isArray(r._stages) ? r._stages.map(String) : [],
    status: r._status === "retired" ? "retired" : "active",
    corrections: json(r._corrections, []),
    run: r._run ?? null,
    mirror: r._mirror ?? null,
  };
}

/** a 400 with the field it is about */
const refuse = (e) => Object.assign(e instanceof ShapeError ? e : new ShapeError("class", String(e?.message ?? e)), { status: 400 });

/** the tree as model/classes.js reads it */
export const treeIndex = (all) => classIndex(all);

/** every stored class with its parents, unscoped (the store's own view; reads go through visibleClasses) */
async function storedClasses() {
  const list = (await adbQuery(`SELECT ${COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'class'`)).map(shape);
  const keyOf = new Map(list.map((c) => [c.rid, c.key]));
  for (const e of await adbQuery("SELECT @out AS o, @in AS i FROM SUBCLASS_OF")) {
    const child = list.find((c) => c.rid === String(e.o));
    const parent = keyOf.get(String(e.i));
    if (child && parent && !child.parents.includes(parent)) child.parents.push(parent);
  }
  const nameOf = new Map(list.map((c) => [c.key, c.name]));
  for (const c of list) c.parent_names = c.parents.map((k) => nameOf.get(k) ?? k);
  return list;
}

const isDuplicate = (e) => /duplicat|unique|already/i.test(String(e?.message ?? e));

/**
 * Write a class row the store makes itself (seeded or mirrored) and its parent edges; returns its rid. The
 * unique index on `_class_key` refuses a second copy, so two requests seeding at once leave one, and the rid
 * is found by the key, which only that one has.
 */
async function writeFixed(c, { mirror = null, ridOf }) {
  await adbCommand(
    `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, _kind = 'class', _class_name = :name, _class_key = :key, _home = :home, _origin = :home, _description = :description, _evidence = '[]', _rows_are_nodes = false, _stages = [], _status = 'active', _corrections = '[]', _mirror = :mirror, _written_by = 'seed'`,
    "sql",
    { name: c.name, key: c.key, home: c.home, description: c.description ?? null, mirror },
  ).catch((e) => {
    if (!isDuplicate(e)) throw e; // another request wrote it first: its edges are its own
  });
  const rid = String((await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'class' AND _class_key = :key`, { key: c.key }))[0]?.rid);
  ridOf.set(c.key, rid);
  const have = new Set((await adbQuery(`SELECT @in AS i FROM SUBCLASS_OF WHERE @out = ${rid}`)).map((e) => String(e.i)));
  for (const p of c.parents) if (ridOf.get(p) && !have.has(ridOf.get(p))) await adbCommand(`CREATE EDGE SUBCLASS_OF FROM ${rid} TO ${ridOf.get(p)} SET added_by = 'seed', at = :at`, "sql", { at: new Date().toISOString() });
  return rid;
}

let seeding = null;
/** write the seeded classes that are missing (the four roots, decision and action under event: R1), parents first; one at a time */
function seedMissing(have) {
  seeding ??= (async () => {
    const ridOf = new Map(have.filter((c) => SEEDED_KEYS.includes(c.key)).map((c) => [c.key, c.rid]));
    for (const c of seedClasses()) if (!ridOf.has(c.key)) await writeFixed(c, { ridOf });
  })().finally(() => (seeding = null));
  return seeding;
}

/* ---- the mirror under agent: positions as classes, people and the AI agents as instances (R6, R1) ---- */

let mirrored = { map: null, people: null };
let mirroring = null;

/** a mirrored instance: found by its key, made at the mirror's home when missing; returns its rid */
async function mirrorInstance({ name, key, home }) {
  const find = async () => (await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS :k ORDER BY @rid LIMIT 1`, { k: key }))[0];
  const found = await find();
  if (found) return String(found.rid);
  await adbCommand(
    `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, label = :name, _norm = :norm, _kind = 'thing', _keys = [:k], _home = :home, _homes = [:home], _origin = :home, _mirror = :k, _written_by = 'seed'`,
    "sql",
    { name, norm: String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(), k: key, home },
  );
  return String((await find()).rid);
}

/** an instance belongs to exactly these mirrored classes (one-way: what authentik no longer grants goes) */
async function mirrorEdges(rid, classRids, mirroredRids) {
  const have = (await adbQuery(`SELECT @rid AS e, @in AS c FROM INSTANCE_OF WHERE @out = ${rid}`)).map((r) => ({ e: String(r.e), c: String(r.c) }));
  // the link is the mirror's, seen where the mirror is (instances.js linkHome)
  for (const c of classRids) if (!have.some((h) => h.c === c)) await adbCommand(`CREATE EDGE INSTANCE_OF FROM ${rid} TO ${c} SET added_by = 'seed', at = :at, home = :home`, "sql", { at: new Date().toISOString(), home: MIRROR_HOME });
  for (const h of have) if (mirroredRids.has(h.c) && !classRids.includes(h.c)) await adbCommand(`DELETE FROM ${h.e}`, "sql");
}

/**
 * One-way sync from the position map and the token map's people (R6: authentik keeps granting access; this
 * only mirrors it), and the AI agents (R1). Positions become classes under agent, nested as the positions
 * are; people become instances of their positions' classes; a position that left the map is retired, and a
 * person who left loses their positions' edges.
 */
export async function syncMirror() {
  if (!positionMap) return { classes: 0, people: 0 };
  const map = positionMap;
  const people = entriesByUser;
  let have = await storedClasses();
  const byMirror = new Map(have.filter((c) => c.mirror).map((c) => [c.mirror, c]));
  const ridOf = new Map(have.filter((c) => SEEDED_KEYS.includes(c.key)).map((c) => [c.key, c.rid]));
  const wanted = positionClasses(map);
  const skipped = new Set();
  for (const p of wanted) {
    const tag = `position:${p.position}`;
    const cur = byMirror.get(tag);
    // a position whose parent couldn't be mirrored isn't mirrored either: it would become a fifth root
    if (!ridOf.get(p.parents[0]) && !cur) {
      skipped.add(p.key);
      console.warn(`[graph-rag] position ${p.position} isn't mirrored: its parent position isn't`);
      continue;
    }
    if (!cur) {
      if (have.some((c) => c.key === p.key && !c.mirror)) {
        skipped.add(p.key);
        console.warn(`[graph-rag] position ${p.position} isn't mirrored: a class called ${p.name} exists`);
        continue;
      }
      await writeFixed(p, { mirror: tag, ridOf });
      continue;
    }
    ridOf.set(p.key, cur.rid);
    if (cur.key !== p.key || cur.name !== p.name || cur.status === "retired") await adbCommand(`UPDATE ${cur.rid} SET name = :n, _class_name = :n, _class_key = :k, _status = 'active'`, "sql", { n: p.name, k: p.key });
    const parent = ridOf.get(p.parents[0]);
    const edges = (await adbQuery(`SELECT @in AS i FROM SUBCLASS_OF WHERE @out = ${cur.rid}`)).map((e) => String(e.i));
    if (parent && (edges.length !== 1 || edges[0] !== parent)) {
      await adbCommand(`DELETE FROM SUBCLASS_OF WHERE @out = ${cur.rid}`, "sql");
      await adbCommand(`CREATE EDGE SUBCLASS_OF FROM ${cur.rid} TO ${parent} SET added_by = 'seed', at = :at`, "sql", { at: new Date().toISOString() });
    }
  }
  const gone = [...byMirror.entries()].filter(([tag, c]) => tag.startsWith("position:") && !wanted.some((p) => `position:${p.position}` === tag) && c.status !== "retired");
  for (const [, c] of gone) await adbCommand(`UPDATE ${c.rid} SET _status = 'retired'`, "sql");
  have = await storedClasses();
  const positionRid = new Map(have.filter((c) => c.mirror?.startsWith("position:")).map((c) => [c.key, c.rid]));
  const mirroredRids = new Set(positionRid.values());
  const persons = peopleInstances(map, [...people.values()]);
  for (const person of persons) await mirrorEdges(await mirrorInstance(person), person.classes.map((k) => positionRid.get(k)).filter(Boolean), mirroredRids);
  // a person who left the token map keeps their node (sections may be about them) but holds no position
  const keys = new Set(persons.map((p) => p.key));
  for (const r of await adbQuery(`SELECT @rid AS rid, _mirror FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _mirror LIKE 'authentik:user:%'`)) if (!keys.has(r._mirror)) await mirrorEdges(String(r.rid), [], mirroredRids);
  const agentRid = have.find((c) => c.key === "agent")?.rid;
  for (const a of AI_AGENTS) await mirrorEdges(await mirrorInstance(a), agentRid ? [agentRid] : [], new Set(agentRid ? [agentRid] : []));
  mirrored = { map, people };
  return { classes: wanted.length - skipped.size, people: persons.length, agents: AI_AGENTS.length };
}

/** every class, seeded ones written first if missing (an empty graph starts with them: R3, R8), the mirror kept current */
export async function allClasses() {
  let have = await storedClasses();
  if (!SEEDED_KEYS.every((k) => have.some((c) => c.key === k))) {
    await seedMissing(have);
    have = await storedClasses();
  }
  if (positionMap && (mirrored.map !== positionMap || mirrored.people !== entriesByUser)) {
    mirroring ??= syncMirror()
      .catch((e) => console.warn(`[graph-rag] mirror: ${String(e).slice(0, 200)}`))
      .finally(() => (mirroring = null));
    await mirroring;
    have = await storedClasses();
  }
  return have;
}

/** does a reader see something at this home (its homes, granted homes, and everyone) */
export function seesHome(scope, home) {
  if (!scope || scope.homes === null || !positionMap) return true;
  const at = effectiveHome(positionMap, home);
  return at === EVERYONE || scope.homes.has(at) || Boolean(scope.granted?.homes?.has(at));
}

/** the classes a reader sees, as the tree: a class above the reader is not in it, nor named as a parent */
export async function visibleClasses(scope, { retired = false } = {}) {
  const all = await allClasses();
  const seen = all.filter((c) => seesHome(scope, c.home) && (retired || c.status !== "retired"));
  const nameOf = new Map(seen.map((c) => [c.key, c.name]));
  return seen.map((c) => {
    const parents = c.parents.filter((p) => nameOf.has(p));
    return { ...c, parents, parent_names: parents.map((p) => nameOf.get(p)) };
  });
}

/** the one class a name names among `list`: a 404 ShapeError when none */
export function resolveClass(ref, list, field = "class") {
  const key = classKey(ref);
  const hit = list.find((c) => c.key === key);
  if (!hit) throw Object.assign(new ShapeError(field, `no class ${ref} that you can see`), { status: 404 });
  return hit;
}

/** one class a reader sees, by name or key; null when there is none it can see */
export async function visibleClass(name, scope) {
  const key = classKey(name);
  return (await visibleClasses(scope, { retired: true })).find((c) => c.key === key) ?? null;
}

/** an entry that counts as a note: a record, a section, an entry (not a class, an instance or a task) */
const NOTE_KINDS = new Set([null, undefined, "document", "section", "entry"]);

/**
 * The home-from-evidence context: connection homes from CONNECTION_HOMES; a note's home from the history,
 * or, for a graph rid, the home of that entry when it is a note `scope` sees. A rid the caller can't see,
 * or one that isn't a note (an instance, a class), counts as the root's: fail upward (review C-B2).
 */
export async function evidenceContext(evidence, scope = null) {
  const homes = new Map();
  const refs = [...new Set((evidence ?? []).filter((e) => e.kind === "notes" && RID_RE.test(String(e.ref ?? ""))).map((e) => e.ref))];
  if (refs.length) {
    for (const r of await adbQuery(`SELECT @rid AS rid, _home, _kind FROM [${refs.join(",")}]`).catch(() => [])) {
      const ok = NOTE_KINDS.has(r._kind ?? null) && (!scope || seesHome(scope, r._home));
      homes.set(String(r.rid), ok ? effectiveHome(positionMap, r._home) : positionMap.root);
    }
  }
  return {
    positions: positionMap,
    connectionHome: (system) => connectionHome(system),
    noteHome: (ref) => (RID_RE.test(String(ref)) ? homes.get(String(ref)) ?? positionMap.root : noteHome(ref, positionMap)),
  };
}

/**
 * The evidence of a class a reader may be shown: each item whose own home the reader sees (a table's or a
 * row's connection, a note's home). A free note with no ref has no home of its own, so only the root sees it
 * (review C-B6: evidence wider than its class is how a class gets wide, R11.9, and must not show above).
 */
export async function visibleEvidence(evidence, scope) {
  if (!scope || scope.homes === null) return evidence ?? [];
  const ctx = await evidenceContext(evidence);
  return (evidence ?? []).filter((e) => {
    if (e.kind === "notes") return e.ref ? seesHome(scope, ctx.noteHome(e.ref) ?? positionMap.root) : false;
    const system = evidenceSystem(e);
    return system ? seesHome(scope, connectionHome(system) ?? positionMap.root) : false;
  });
}

/** the home a class has of its own: a person's correction, else its evidence (R11); seeded and mirrored keep theirs */
async function ownHome(c) {
  if (SEEDED_KEYS.includes(c.key) || c.mirror) return c.home;
  const p = pinned(c.corrections);
  if (p.home) return p.home;
  return homeFromEvidence(c.evidence, await evidenceContext(c.evidence));
}

/**
 * Work every class's home out again, parents first, and store the ones that changed: a parent's home
 * tightening tightens every class below it (R9); wider evidence widens a class (R11). Returns the moves.
 */
export async function settleHomes() {
  const all = await allClasses();
  const own = new Map();
  for (const c of all) own.set(c.key, await ownHome(c));
  const homes = treeHomes(treeIndex(all), (c) => own.get(c.key) ?? positionMap.root, positionMap);
  const moved = [];
  for (const c of all) {
    const to = homes.get(c.key);
    if (to && to !== c.home) {
      await adbCommand(`UPDATE ${c.rid} SET _home = :h, _origin = :h`, "sql", { h: to });
      moved.push({ class: c.key, from: c.home, to });
    }
  }
  return moved;
}

async function linkParents(rid, parents, all, by) {
  const ridOf = new Map(all.map((c) => [c.key, c.rid]));
  const at = new Date().toISOString();
  for (const p of parents) await adbCommand(`CREATE EDGE SUBCLASS_OF FROM ${rid} TO ${ridOf.get(p)} SET added_by = :who, at = :at`, "sql", { who: by, at });
}

/** a class only the store writes: one of the seeded six, or the mirror of a position */
const fixedClass = (c) => (SEEDED_KEYS.includes(c.key) ? `${c.name} is one of the four primitives or seeded under event (R1)` : c.mirror ? `${c.name} mirrors a position from authentik (R6): it changes there` : null);

/** stage names, normalized as a class's are */
const stageList = (stages) => normalizeClass({ name: "x", parents: ["commitment"], home: positionMap.root, stages }).stages;

/**
 * The orchestrator creates a class (R5, R7). Its home comes from its evidence and its parents, never from
 * the caller (R11, R9). Refused, naming the field: a name a class has anywhere (NAMES_UNIQUE), a class a
 * person retired or renamed (R11), parents that don't exist or close a cycle, stages on a class not under
 * commitment (R11). `actor`: { user, run? }. Returns the class as stored.
 */
/**
 * A class's source table as system:table. A bare table name ("dbo_Customer") is taken as the one declared source
 * that has that table (its read side's entities), named as that source names it; with none or several, refused with
 * the form wanted and the declared sources. `sources` and `entitiesOf` are injectable for tests.
 */
export async function qualifyTable(value, { sources, entitiesOf, field = "record_table" } = {}) {
  const v = String(value ?? "").trim();
  if (!v || v.includes(":")) return value;
  const decls = Object.values(sources ?? (await (await import("./sources.js")).loadSources(undefined, { ttlMs: 0 }).catch(() => ({})))).filter(Boolean);
  const list = entitiesOf ?? (async (d) => (d.read?.url ? await (await import("./data-entry.js")).sourceClient(d.system, { read: d.read.url }).entities().catch(() => []) : []));
  const has = [];
  for (const d of decls) {
    const name = (await list(d)).find((n) => String(n).toLowerCase() === v.toLowerCase());
    if (name) has.push(`${d.system}:${name}`);
  }
  if (has.length === 1) return has[0];
  const systems = decls.map((d) => d.system);
  throw refuse(
    new ShapeError(
      field,
      has.length
        ? `${v} is a table of several sources: name it as system:table, one of ${has.join(", ")}`
        : `not system:table: ${v}. Name the table with its source, as system:table (${systems.length ? `for example ${systems[0]}:${v}` : "no source is declared"}${systems.length ? `; declared sources: ${systems.join(", ")}` : ""})`,
    ),
  );
}

export async function createClass(input, actor) {
  if (input?.record_table) input = { ...input, record_table: await qualifyTable(input.record_table) };
  const all = await allClasses();
  const index = treeIndex(all);
  let cls;
  let home;
  try {
    const parents = (Array.isArray(input.parents) ? input.parents : []).map((p, i) => resolveClass(p, all, `parents[${i}]`).key);
    cls = normalizeClass({ ...input, parents, stages: [], home: positionMap.root, status: "active" }, { positions: positionMap });
    if (SEEDED_KEYS.includes(cls.key)) throw new ShapeError("name", `${cls.name} is one of the seeded classes (R1)`);
    assertCreatable(cls, all);
    cls.parents = assertParents(cls.key, cls.parents, index);
    const trial = classIndex([...all, cls]);
    cls.stages = input.stages?.length ? stageList(input.stages) : [];
    if (cls.stages.length && !mayHaveStages(cls.key, trial)) throw new ShapeError("stages", "only a class under commitment has stages (R11)");
    const own = homeFromEvidence(cls.evidence, await evidenceContext(cls.evidence));
    home = treeHomes(trial, (c) => (c.key === cls.key ? own : c.home), positionMap).get(cls.key);
  } catch (e) {
    throw refuse(e);
  }
  try {
    await adbCommand(
      `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, _kind = 'class', _class_name = :name, _class_key = :key, _home = :home, _origin = :home, _description = :description, _evidence = :evidence, _rows_are_nodes = :nodes, _record_table = :table, _stages = :stages, _status = 'active', _corrections = '[]', _run = :run, _written_by = :who, _created_at = :at`,
      "sql",
      { name: cls.name, key: cls.key, home, description: cls.description, evidence: JSON.stringify(cls.evidence), nodes: cls.rows_are_nodes, table: cls.record_table, stages: cls.stages, run: actor.run ?? null, who: actor.user, at: new Date().toISOString() },
    );
  } catch (e) {
    if (isDuplicate(e)) throw refuse(new ShapeError("name", `${cls.name} exists already`)); // made meanwhile by another call
    throw e;
  }
  const rid = String((await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'class' AND _class_key = :key`, { key: cls.key }))[0]?.rid);
  await linkParents(rid, cls.parents, all, actor.user);
  return (await allClasses()).find((c) => c.rid === rid) ?? { ...cls, rid, home, run: actor.run ?? null };
}

/**
 * The orchestrator changes a class it made (R5): more parents, more evidence, its description, stages,
 * table or rows-become-nodes setting. Never a field a person pinned, nor a retired, seeded or mirrored class
 * (R11, R1, R6). The home follows the new evidence and parents.
 */
export async function updateClass(name, patch, actor) {
  if (patch?.record_table) patch = { ...patch, record_table: await qualifyTable(patch.record_table) };
  const all = await allClasses();
  const cur = resolveClass(name, all);
  if (fixedClass(cur)) throw refuse(new ShapeError("class", `${fixedClass(cur)}: the orchestrator doesn't change it`));
  const index = treeIndex(all);
  const sets = {};
  let parents = [];
  try {
    const touch = (field) => assertUnpinned(cur, field);
    if (patch.add_parents?.length) {
      touch("parents");
      const keys = patch.add_parents.map((p, i) => resolveClass(p, all, `add_parents[${i}]`).key);
      parents = assertParents(cur.key, [...cur.parents, ...keys], index).filter((p) => !cur.parents.includes(p));
    }
    if (patch.add_evidence?.length) {
      touch("evidence"); // a retired class takes no more evidence
      sets._evidence = JSON.stringify([...cur.evidence, ...patch.add_evidence.map((e, i) => normalizeEvidence(e, `add_evidence[${i}]`))]);
    }
    const plain = { name: cur.name, parents: ["agent"], home: cur.home };
    if (patch.description !== undefined) {
      touch("description");
      sets._description = normalizeClass({ ...plain, description: patch.description }).description;
    }
    if (patch.rows_are_nodes !== undefined) {
      touch("rows_are_nodes");
      sets._rows_are_nodes = normalizeClass({ ...plain, rows_are_nodes: patch.rows_are_nodes }).rows_are_nodes;
    }
    if (patch.record_table !== undefined) {
      touch("record_table");
      sets._record_table = normalizeClass({ ...plain, record_table: patch.record_table }).record_table;
      // R14: a source table declared now may give Kept pieces a home (filing.js laterClassOrSource)
      if (sets._record_table && sets._record_table !== cur.record_table) sets._table_at = new Date().toISOString();
    }
    if (patch.stages !== undefined) {
      touch("stages");
      sets._stages = stageList(patch.stages);
      if (sets._stages.length && !mayHaveStages(cur.key, index)) throw new ShapeError("stages", "only a class under commitment has stages (R11)");
    }
  } catch (e) {
    throw refuse(e);
  }
  const keys = Object.keys(sets);
  if (keys.length) await adbCommand(`UPDATE ${cur.rid} SET ${keys.map((k) => `${k} = :${k}`).join(", ")}`, "sql", sets);
  if (parents.length) await linkParents(cur.rid, parents, all, actor.user);
  const moved = await settleHomes();
  return { class: (await allClasses()).find((c) => c.rid === cur.rid), moved };
}

/**
 * A person corrects a class (R11): it is kept on the class, applied now, and respected by every later
 * run. `person`: the identity's user. Returns the class and any homes that moved.
 */
export async function correctClass(name, raw, person) {
  const all = await allClasses();
  const cur = resolveClass(name, all);
  const index = treeIndex(all);
  let c;
  try {
    c = normalizeCorrection({ ...raw, by: person, from: cur.name }, { positions: positionMap });
    if (fixedClass(cur) && (cur.mirror || c.kind !== "description")) throw new ShapeError("class", `${fixedClass(cur)}${cur.mirror ? "" : ": only its description changes"}`);
    if (c.kind === "rename" && classKey(c.value) !== cur.key && all.some((x) => x.key === classKey(c.value))) throw new ShapeError("value", `a class called ${c.value} exists already`);
    if (c.kind === "parents") {
      c.value = assertParents(cur.key, c.value.map((p, i) => resolveClass(p, all, `value[${i}]`).key), index);
      // stages stay only on a class still under commitment (R11): moving it out takes a stages correction first
      const trial = classIndex(all.map((x) => (x.key === cur.key ? { ...x, parents: c.value } : x)));
      const stages = pinned(cur.corrections).stages ?? cur.stages;
      if (stages.length && !mayHaveStages(cur.key, trial)) throw new ShapeError("value", `${cur.name} has stages, and only a class under commitment has them (R11): correct its stages to none first`);
    }
    if (c.kind === "stages" && c.value.length && !mayHaveStages(cur.key, index)) throw new ShapeError("value", "only a class under commitment has stages (R11)");
  } catch (e) {
    throw refuse(e);
  }
  const corrections = [...cur.corrections, c];
  const next = applyCorrections({ ...cur, corrections });
  await adbCommand(
    `UPDATE ${cur.rid} SET _corrections = :corrections, _class_name = :name, name = :name, _class_key = :key, _description = :description, _rows_are_nodes = :nodes, _record_table = :table, _stages = :stages, _status = :status`,
    "sql",
    { corrections: JSON.stringify(corrections), name: next.name, key: next.key, description: next.description, nodes: next.rows_are_nodes, table: next.record_table, stages: next.stages, status: next.status },
  );
  if (c.kind === "parents") {
    await adbCommand(`DELETE FROM SUBCLASS_OF WHERE @out = ${cur.rid}`, "sql");
    await linkParents(cur.rid, c.value, all, person);
  }
  if (c.kind === "unrelate") {
    const target = RID_RE.test(c.instance) ? c.instance : (await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS :k LIMIT 1`, { k: c.instance }))[0]?.rid;
    if (target) await adbCommand(`DELETE FROM INSTANCE_OF WHERE @out = ${target} AND @in = ${cur.rid}`, "sql");
  }
  const moved = await settleHomes();
  return { class: (await allClasses()).find((x) => x.rid === cur.rid), correction: c, moved };
}

/** instances per class key (for the tree report) */
export async function instanceCounts() {
  const rows = await adbQuery("SELECT @in AS c, count(*) AS n FROM INSTANCE_OF GROUP BY @in").catch(() => []);
  const keyOf = new Map((await allClasses()).map((c) => [c.rid, c.key]));
  return new Map(rows.map((r) => [keyOf.get(String(r.c)), Number(r.n)]).filter(([k]) => k));
}

/* ---- discovery runs (R9: reruns and new tables count as discovery) ---- */

/** start a run: its id, kept in the DiscoveryRun log with what it examines */
export async function startRun(by, focus = "") {
  const id = `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  await adbCommand("INSERT INTO DiscoveryRun SET id = :id, started_by = :who, started_at = :at, focus = :focus, examined = []", "sql", { id, who: by, at: new Date().toISOString(), focus: String(focus).slice(0, 1000) });
  return id;
}

/** every table any run examined, lower-cased `system:table` */
export async function examinedTables() {
  const out = new Set();
  for (const r of await adbQuery("SELECT examined FROM DiscoveryRun").catch(() => [])) for (const t of r.examined ?? []) out.add(String(t).toLowerCase());
  return out;
}

/** a run examined these tables of a system (whether or not they became classes) */
export async function recordExamined(run, system, tables) {
  const list = tables.map((t) => `${system}:${t}`.toLowerCase());
  const row = (await adbQuery("SELECT examined FROM DiscoveryRun WHERE id = :id", { id: run }))[0];
  if (!row) throw Object.assign(new Error(`no discovery run ${run}`), { status: 404 });
  const next = [...new Set([...(row.examined ?? []), ...list])];
  await adbCommand("UPDATE DiscoveryRun SET examined = :e WHERE id = :id", "sql", { e: next, id: run });
  return { examined: list.length, total: next.length };
}

const discoveryEntries = new Map();
/**
 * Is this entry a part of a discovery run (a task entry marked with its run): `{ run, home }`, the home being
 * the one its worker reads as (one worker per evidence home), or null.
 */
export async function discoveryPartOf(rid) {
  if (!RID_RE.test(String(rid ?? ""))) return null;
  if (discoveryEntries.has(rid)) return discoveryEntries.get(rid);
  const r = (await adbQuery(`SELECT _discovery_run, _discovery_home FROM ${rid}`).catch(() => []))[0];
  const part = r?._discovery_run ? { run: r._discovery_run, home: r._discovery_home ?? positionMap?.root ?? null } : null;
  discoveryEntries.set(rid, part);
  return part;
}
/** the run of a discovery part entry, or null */
export const discoveryRunOf = async (rid) => (await discoveryPartOf(rid))?.run ?? null;

/** mark a task entry as a part of a run read as `home`, so its worker is held to the discovery tools and that home */
export async function markDiscoveryEntry(rid, run, home) {
  await adbCommand(`UPDATE ${rid} SET _discovery_run = :run, _discovery_home = :home`, "sql", { run, home });
  discoveryEntries.set(rid, { run, home });
}

/**
 * Make the task entry of a discovery part, marked, and its job; returns { rid, job }. createTask (filing's)
 * doesn't return the entry, so it is found by its title among the task entries no part has claimed, newest
 * first; the title carries the run and the part, so two parts share it only when the orchestrator repeats one.
 */
export async function createPartTask({ title, brief, minutes, by, run, home, level = 2 }) {
  const { createTask } = await import("./worker-pool.js"); // lazily: worker-pool reaches the MCP server
  const r = await createTask({ title, brief, minutes, by, audience: home === EVERYONE ? EVERYONE : undefined, level });
  const rid = (await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'task' AND name = :n AND _discovery_run IS NULL ORDER BY @rid DESC LIMIT 1`, { n: r.task }))[0]?.rid;
  if (!rid) throw new Error("the part's task entry wasn't found");
  await markDiscoveryEntry(String(rid), run, home);
  return { ...r, rid: String(rid) };
}

/** the scope a discovery part's worker reads with: what the people of its home see (R11.6, one worker per home) */
export function partScope(home) {
  if (!positionMap) return { homes: null, root: false };
  const at = effectiveHome(positionMap, home);
  const homes = at === EVERYONE ? new Set([EVERYONE]) : visibleHomes(positionMap, [at]);
  return homes === null ? { homes: null, root: true, writeHome: at } : { homes, root: false, writeHome: at };
}

/**
 * A worker on a discovery part's entry acts in that run, whatever its token says: graph-rag marked the entry
 * itself (createPartTask), and only the admin's workspace mints worker tokens. Called on every MCP request
 * before its tools are listed, so a real part's worker gets its tools though no token carries the claim
 * (the re-review of c1323a3, non-blocking 3). `partOf` is for tests.
 */
export async function withDiscoveryRole(identity, { partOf = discoveryPartOf } = {}) {
  if (identity?.role?.kind !== "worker" || identity.role.discovery) return identity;
  const part = await partOf(identity.role.entry);
  if (part?.run) identity.role = { ...identity.role, discovery: true, run: String(part.run) };
  return identity;
}

/** the run an identity acts in: the orchestrator's claim, or its worker entry's mark; null outside a run */
export async function runOf(identity) {
  if (identity?.role?.discovery && identity.role.run) return String(identity.role.run);
  if (identity?.role?.kind === "worker") return discoveryRunOf(identity.role.entry);
  return null;
}

