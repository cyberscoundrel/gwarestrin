/**
 * Class storage, reads and corrections (docs/ORGANIZATION-MODEL.md, "Classes, subclasses and instances";
 * model/classes.js for the shapes). A class is an Entity with `_kind: 'class'`, scoped by `_home` like any
 * node (earlier ruling), so every read filter that covers entities covers it. Its parents are SUBCLASS_OF
 * edges (R9: several allowed). Its home is worked out here from its evidence (R11), never chosen by a model,
 * and is no wider than any parent's (R9, strictest wins).
 *
 * Who may do what (R5, R7): the orchestrator creates and changes classes; nothing else does (no chat agent,
 * no condenser, no worker). A person corrects (R11), and a correction is kept on the class and respected by
 * every later run: a retired class never returns on its own.
 *
 * The classes and discovery stream owns this module.
 */
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { positionMap } from "./scope.js";
import { effectiveHome, EVERYONE } from "./positions.js";
import { connectionHome, noteHome } from "./discovery.js";
import {
  applyCorrections,
  assertCreatable,
  assertParents,
  assertUnpinned,
  classIndex,
  classKey,
  homeFromEvidence,
  mayHaveStages,
  normalizeClass,
  normalizeCorrection,
  normalizeEvidence,
  pinned,
  seedClasses,
  SEEDED_KEYS,
  treeHomes,
} from "./model/classes.js";
import { ShapeError } from "./model/text.js";

const COLS = "@rid AS rid, _class_name, _class_key, _home, _description, _evidence, _rows_are_nodes, _record_table, _stages, _status, _corrections, _run";

const json = (v, fallback) => {
  if (Array.isArray(v)) return v;
  try {
    const j = JSON.parse(v ?? "");
    return Array.isArray(j) ? j : fallback;
  } catch {
    return fallback;
  }
};

/** a stored row as a class (corrections applied by the store when it wrote them; kept for the checks) */
function shape(r, parents) {
  return {
    rid: String(r.rid),
    name: r._class_name,
    key: r._class_key,
    parents: parents ?? [],
    home: r._home ?? positionMap?.root ?? null,
    description: r._description ?? null,
    evidence: json(r._evidence, []),
    rows_are_nodes: r._rows_are_nodes === true,
    record_table: r._record_table ?? null,
    stages: Array.isArray(r._stages) ? r._stages.map(String) : [],
    status: r._status === "retired" ? "retired" : "active",
    corrections: json(r._corrections, []),
    run: r._run ?? null,
  };
}

/** a 400 with the field it is about */
const refuse = (e) => Object.assign(e instanceof ShapeError ? e : new ShapeError("class", String(e?.message ?? e)), { status: 400 });

/** every stored class with its parents, unscoped (the store's own view; reads go through visibleClasses) */
async function storedClasses() {
  const rows = await adbQuery(`SELECT ${COLS} FROM ${ENTITY_LABEL} WHERE _kind = 'class'`);
  const keyOf = new Map(rows.map((r) => [String(r.rid), r._class_key]));
  const parents = new Map();
  for (const e of await adbQuery("SELECT @out AS o, @in AS i FROM SUBCLASS_OF")) {
    const child = keyOf.get(String(e.o));
    const parent = keyOf.get(String(e.i));
    if (!child || !parent) continue;
    if (!parents.has(child)) parents.set(child, []);
    if (!parents.get(child).includes(parent)) parents.get(child).push(parent);
  }
  return rows.map((r) => shape(r, parents.get(r._class_key)));
}

/** write a seeded class that is missing (the four roots, decision and action under event: R1) */
async function seedMissing(have) {
  let made = false;
  for (const c of seedClasses()) {
    if (have.some((x) => x.key === c.key)) continue;
    await adbCommand(
      `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, _kind = 'class', _class_name = :name, _class_key = :key, _home = :home, _origin = :home, _evidence = '[]', _rows_are_nodes = false, _stages = [], _status = 'active', _corrections = '[]', _written_by = 'seed'`,
      "sql",
      { name: c.name, key: c.key, home: c.home },
    ).catch((e) => {
      if (!/duplicate|unique/i.test(String(e))) throw e; // another request seeded it first
    });
    made = true;
  }
  if (!made) return false;
  const rid = new Map((await adbQuery(`SELECT @rid AS rid, _class_key FROM ${ENTITY_LABEL} WHERE _kind = 'class' AND _class_key IN :keys`, { keys: SEEDED_KEYS })).map((r) => [r._class_key, String(r.rid)]));
  const edges = new Set((await adbQuery("SELECT @out AS o, @in AS i FROM SUBCLASS_OF")).map((e) => `${e.o}>${e.i}`));
  for (const c of seedClasses()) for (const p of c.parents) if (!edges.has(`${rid.get(c.key)}>${rid.get(p)}`)) await adbCommand(`CREATE EDGE SUBCLASS_OF FROM ${rid.get(c.key)} TO ${rid.get(p)} SET added_by = 'seed', at = :at`, "sql", { at: new Date().toISOString() });
  return true;
}

/** every class, seeded ones written first if missing (an empty graph starts with them: R3, R8) */
export async function allClasses() {
  const have = await storedClasses();
  if (SEEDED_KEYS.every((k) => have.some((c) => c.key === k))) return have;
  return (await seedMissing(have)) ? storedClasses() : have;
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
  const keys = new Set(seen.map((c) => c.key));
  return seen.map((c) => ({ ...c, parents: c.parents.filter((p) => keys.has(p)) }));
}

/** one class a reader sees, by name or key; null when there is none it can see */
export async function visibleClass(name, scope) {
  const key = classKey(name);
  return (await visibleClasses(scope, { retired: true })).find((c) => c.key === key) ?? null;
}

/** the home-from-evidence context: connection homes from CONNECTION_HOMES, notes from the history or a section's home */
export async function evidenceContext(evidence) {
  const sections = new Map();
  const refs = (evidence ?? []).filter((e) => e.kind === "notes" && RID_RE.test(String(e.ref ?? ""))).map((e) => e.ref);
  if (refs.length) for (const r of await adbQuery(`SELECT @rid AS rid, _home FROM [${refs.join(",")}]`).catch(() => [])) sections.set(String(r.rid), r._home ?? positionMap.root);
  return {
    positions: positionMap,
    connectionHome: (system) => connectionHome(system),
    noteHome: (ref) => (sections.has(ref) ? effectiveHome(positionMap, sections.get(ref)) : noteHome(ref, positionMap)),
  };
}

/** the home a class has of its own: a person's correction, else its evidence (R11) */
async function ownHome(c) {
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
  const index = classIndex(all);
  const own = new Map();
  for (const c of all) own.set(c.key, await ownHome(c));
  const homes = treeHomes(index, (c) => own.get(c.key) ?? positionMap.root, positionMap);
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

/**
 * The orchestrator creates a class (R5, R7). Its home comes from its evidence and its parents, never from
 * the caller (R11, R9). Refused, naming the field: a name a class has (NEEDS A RULING, names are unique in
 * the organization: model/classes.js), a class a person retired or renamed (R11), parents that don't
 * exist or close a cycle, stages on a class not under commitment (R11).
 * `actor`: { user, run? }. Returns the class as stored.
 */
export async function createClass(input, actor) {
  const all = await allClasses();
  let cls;
  try {
    cls = normalizeClass({ ...input, home: positionMap.root, status: "active" }, { positions: positionMap });
    assertCreatable(cls, all);
    const index = classIndex(all);
    cls.parents = assertParents(cls.key, cls.parents, index);
    const trial = classIndex([...all, cls]);
    if (cls.stages.length && !mayHaveStages(cls.key, trial)) throw new ShapeError("stages", "only a class under commitment has stages");
  } catch (e) {
    throw refuse(e);
  }
  const own = homeFromEvidence(cls.evidence, await evidenceContext(cls.evidence));
  const home = treeHomes(classIndex([...all, cls]), (c) => (c.key === cls.key ? own : c.home), positionMap).get(cls.key);
  await adbCommand(
    `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, _kind = 'class', _class_name = :name, _class_key = :key, _home = :home, _origin = :home, _description = :description, _evidence = :evidence, _rows_are_nodes = :nodes, _record_table = :table, _stages = :stages, _status = 'active', _corrections = '[]', _run = :run, _written_by = :who`,
    "sql",
    { name: cls.name, key: cls.key, home, description: cls.description, evidence: JSON.stringify(cls.evidence), nodes: cls.rows_are_nodes, table: cls.record_table, stages: cls.stages, run: actor.run ?? null, who: actor.user },
  );
  const rid = String((await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'class' AND _class_key = :key`, { key: cls.key }))[0]?.rid);
  await linkParents(rid, cls.parents, all, actor.user);
  return { ...cls, rid, home, run: actor.run ?? null };
}

/**
 * The orchestrator changes a class it made (R5): more parents, more evidence, its description, stages,
 * table or rows-become-nodes setting. Never a field a person pinned, nor a retired class (R11). The home
 * follows the new evidence and parents.
 */
export async function updateClass(name, patch, actor) {
  const all = await allClasses();
  const cur = all.find((c) => c.key === classKey(name));
  if (!cur) throw Object.assign(new Error(`no class ${name}`), { status: 404 });
  if (SEEDED_KEYS.includes(cur.key)) throw refuse(new ShapeError("class", `${cur.name} is one of the seeded classes: only a person changes it`));
  const sets = {};
  let parents = [];
  try {
    const touch = (field) => assertUnpinned(cur, field);
    if (patch.add_parents?.length) {
      touch("parents");
      parents = assertParents(cur.key, [...cur.parents, ...patch.add_parents], classIndex(all)).filter((p) => !cur.parents.includes(p));
    }
    if (patch.add_evidence?.length) sets._evidence = JSON.stringify([...cur.evidence, ...patch.add_evidence.map((e, i) => normalizeEvidence(e, `add_evidence[${i}]`))]);
    if (patch.description !== undefined) {
      touch("description");
      sets._description = normalizeClass({ ...cur, description: patch.description }).description;
    }
    if (patch.rows_are_nodes !== undefined) {
      touch("rows_are_nodes");
      sets._rows_are_nodes = normalizeClass({ ...cur, rows_are_nodes: patch.rows_are_nodes }).rows_are_nodes;
    }
    if (patch.record_table !== undefined) {
      touch("record_table");
      sets._record_table = normalizeClass({ ...cur, record_table: patch.record_table }).record_table;
    }
    if (patch.stages !== undefined) {
      touch("stages");
      sets._stages = normalizeClass({ ...cur, stages: patch.stages }).stages;
      if (sets._stages.length && !mayHaveStages(cur.key, classIndex(all))) throw new ShapeError("stages", "only a class under commitment has stages");
    }
  } catch (e) {
    throw refuse(e);
  }
  const keys = Object.keys(sets);
  if (keys.length) await adbCommand(`UPDATE ${cur.rid} SET ${keys.map((k) => `${k} = :${k}`).join(", ")}`, "sql", sets);
  if (parents.length) await linkParents(cur.rid, parents, all, actor.user);
  const moved = await settleHomes();
  return { class: (await allClasses()).find((c) => c.key === cur.key), moved };
}

/**
 * A person corrects a class (R11): it is kept on the class, applied now, and respected by every later
 * run. `person`: the identity's user. Returns the class and any homes that moved.
 */
export async function correctClass(name, raw, person) {
  const all = await allClasses();
  const cur = all.find((c) => c.key === classKey(name));
  if (!cur) throw Object.assign(new Error(`no class ${name}`), { status: 404 });
  let c;
  try {
    c = normalizeCorrection({ ...raw, by: person, from: cur.name }, { positions: positionMap });
    if (SEEDED_KEYS.includes(cur.key) && c.kind !== "description") throw new ShapeError("class", `${cur.name} is one of the four primitives or seeded under event (R1): only its description changes`);
    if (c.kind === "rename" && classKey(c.value) !== cur.key && all.some((x) => x.key === classKey(c.value))) throw new ShapeError("value", `a class called ${c.value} exists already`);
    if (c.kind === "parents") c.value = assertParents(cur.key, c.value, classIndex(all));
    if (c.kind === "stages" && c.value.length && !mayHaveStages(cur.key, classIndex(all))) throw new ShapeError("value", "only a class under commitment has stages");
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

/** instances per class (for the tree report) */
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
/** is this entry a part of a discovery run (a task entry marked with its run): the run's id, or null */
export async function discoveryRunOf(rid) {
  if (!RID_RE.test(String(rid ?? ""))) return null;
  if (discoveryEntries.has(rid)) return discoveryEntries.get(rid);
  const run = (await adbQuery(`SELECT _discovery_run FROM ${rid}`).catch(() => []))[0]?._discovery_run ?? null;
  discoveryEntries.set(rid, run);
  return run;
}

/** mark a task entry as a part of a run, so its worker is held to the discovery tools */
export async function markDiscoveryEntry(rid, run) {
  await adbCommand(`UPDATE ${rid} SET _discovery_run = :run`, "sql", { run });
  discoveryEntries.set(rid, run);
}

/** the run an identity acts in: the orchestrator's claim, or its worker entry's mark; null outside a run */
export async function runOf(identity) {
  if (identity?.role?.discovery && identity.role.run) return String(identity.role.run);
  if (identity?.role?.kind === "worker") return discoveryRunOf(identity.role.entry);
  return null;
}
