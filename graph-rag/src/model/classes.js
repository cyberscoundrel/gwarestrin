// Classes, instances and dependency, as plain shapes (docs/ORGANIZATION-MODEL.md, "Classes, subclasses
// and instances" and "Dependency and timeline"). Pure: no database, no model calls.
//
//   class:      { name, key, parents: [name], home, description, evidence: [evidence], rows_are_nodes,
//                 record_table, stages, status }   stored as an Entity with _kind 'class' (schema.js)
//   instance:   any Entity with an INSTANCE_OF edge to a class ("instances should be an entity that has
//               an instance relationship to a class"); one edge per class, an instance may have several
//   dependency: a DEPENDS_ON edge between instances, stated by a person, a record or an agent (R1)
//
// Rulings: four primitives are the only roots (R1); a class may have several parents and where parents
// conflict the strictest rule wins (R9, class-map.js); a class is scoped by home like any other node
// (earlier ruling); what a class holds (R11); whether a class's rows become nodes is its own setting (R3).
import { ancestors, commonAncestor, effectiveHome, EVERYONE } from "../positions.js";
import { clip, isoDate, nonEmpty, ShapeError, snakeCase } from "./text.js";
import { parseKey, parseTable, TABLE_RE } from "./schema.js";

export const CLASS_KIND = "class";
/** the four primary primitives, the only roots (R1; "agent" is the user's word, replacing actor) */
export const PRIMITIVES = ["agent", "commitment", "event", "resource"];
/** a class is in use or retired; a retired class never returns on its own (R11) */
export const CLASS_STATUSES = ["active", "retired"];
/** who states a dependency (R1) */
export const STATED_AS = ["person", "record", "agent"];
/**
 * what a piece of evidence for a class is; rows are cited by key, never copied.
 * NEEDS A RULING (evidence kinds): R11 lists evidence among what a class holds and names no kinds.
 * Smallest choice: this closed list of five, which home from evidence (R11) knows how to read.
 */
export const EVIDENCE_KINDS = ["table", "columns", "rows", "notes", "correction"];

/** a class name as an identity: "Leased building", "leased_building" and "Leased-Building" are one class */
export const classKey = snakeCase;

/**
 * NEEDS A RULING (class names): a name is unique per home (by `classKey`), not in the whole organization.
 * Classes are scoped by home (earlier ruling), so a name taken at a home a writer can't see must neither
 * block it nor tell it that the class exists (the reviewer's item 11 on ba583bc). Two classes of one name
 * at different homes are different classes; where a reader sees both, each is named `name@home`.
 */
export const NAMES_UNIQUE = "per home";

/** "warehouse@ops" -> { key: "warehouse", home: "ops" }; "warehouse" -> { key: "warehouse", home: null } */
export function parseClassRef(ref) {
  const s = String(ref ?? "").trim();
  const at = s.lastIndexOf("@");
  return at > 0 ? { key: classKey(s.slice(0, at)), home: s.slice(at + 1).trim() || null } : { key: classKey(s), home: null };
}

/** one piece of evidence: { kind, ref?, note? } where ref is a table, a record key or a section id */
export function normalizeEvidence(raw, field = "evidence") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ShapeError(field, "must be an object");
  const kind = String(raw.kind ?? "").trim();
  if (!EVIDENCE_KINDS.includes(kind)) throw new ShapeError(`${field}.kind`, `must be one of ${EVIDENCE_KINDS.join(", ")}`);
  const ref = nonEmpty(raw.ref) ? clip(raw.ref, 200) : null;
  const note = nonEmpty(raw.note) ? clip(raw.note, 600) : null;
  if (!ref && !note) throw new ShapeError(field, "needs a ref (table, record key or section) or a note");
  return { kind, ref, note };
}

/**
 * One class, normalized; throws ShapeError naming the field. `positions` (a parsed position map)
 * checks the home. Parents are names; whether they exist and close no cycle is `assertParents`.
 * A primitive is a root and has no parents; every other class has at least one parent.
 */
export function normalizeClass(raw, { positions, index } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ShapeError("class", "must be an object");
  if (!nonEmpty(raw.name)) throw new ShapeError("name", "needs a name");
  const name = clip(raw.name, 80);
  const key = classKey(name);
  if (!key) throw new ShapeError("name", `no name in "${raw.name}"`);
  const root = PRIMITIVES.includes(key);
  const parents = raw.parents === undefined || raw.parents === null ? [] : raw.parents;
  if (!Array.isArray(parents)) throw new ShapeError("parents", "must be a list of class names");
  const parentKeys = [...new Set(parents.map((p, i) => {
    if (!nonEmpty(p)) throw new ShapeError(`parents[${i}]`, "must be a class name");
    return classKey(p);
  }))];
  if (root && parentKeys.length) throw new ShapeError("parents", `${name} is a primitive: it has no parents`);
  if (!root && !parentKeys.length) throw new ShapeError("parents", "needs at least one parent: every class sits under the four primitives");
  if (parentKeys.includes(key)) throw new ShapeError("parents", "a class can't be its own parent");
  const home = nonEmpty(raw.home) ? String(raw.home).trim() : null;
  if (!home) throw new ShapeError("home", "needs a home: a class is scoped like any node");
  if (positions && home !== EVERYONE && !positions.positions[home]) throw new ShapeError("home", `unknown position: ${home}`);
  const recordTable = nonEmpty(raw.record_table) ? String(raw.record_table).trim() : null;
  if (recordTable && !TABLE_RE.test(recordTable)) throw new ShapeError("record_table", `not system:table: ${recordTable}`);
  const evidence = raw.evidence === undefined || raw.evidence === null ? [] : raw.evidence;
  if (!Array.isArray(evidence)) throw new ShapeError("evidence", "must be a list");
  const stages = raw.stages === undefined || raw.stages === null ? [] : raw.stages;
  if (!Array.isArray(stages) || stages.some((s) => !nonEmpty(s))) throw new ShapeError("stages", "must be a list of stage names");
  // stages belong to commitment classes only (R11): checked against the tree (`index`, the seeded classes
  // when none is given); a parent the tree doesn't know leaves it undecidable, so it is refused
  if (stages.length && !root) {
    const tree = index ?? classIndex([]);
    const unknown = parentKeys.filter((p) => !tree.has(p));
    if (unknown.length) throw new ShapeError("stages", `can't tell whether ${name} is under commitment: ${unknown.join(", ")} isn't in the class tree given`);
    if (!mayHaveStages(key, new Map([...tree, [key, { key, parents: parentKeys, status: "active" }]]))) throw new ShapeError("stages", "only a class under commitment has stages (R11)");
  }
  if (raw.rows_are_nodes !== undefined && typeof raw.rows_are_nodes !== "boolean") throw new ShapeError("rows_are_nodes", "must be true or false");
  const status = raw.status === undefined || raw.status === null ? "active" : String(raw.status);
  if (!CLASS_STATUSES.includes(status)) throw new ShapeError("status", `must be one of ${CLASS_STATUSES.join(", ")}`);
  return {
    name,
    key,
    parents: parentKeys,
    home,
    description: nonEmpty(raw.description) ? clip(raw.description, 1000) : null,
    evidence: evidence.map((e, i) => normalizeEvidence(e, `evidence[${i}]`)),
    // NEEDS A RULING (default for rows_are_nodes): unset means rows stay in the source, a node only when
    // the graph must say something the source can't hold (R3). Discovery sets it from evidence.
    rows_are_nodes: raw.rows_are_nodes === true,
    record_table: recordTable,
    stages: stages.map((s) => clip(s, 60)),
    status,
  };
}

/** the four roots as classes. NEEDS A RULING (roots' home): smallest choice, everyone sees them */
export const rootClasses = () => PRIMITIVES.map((name) => ({ name, key: name, parents: [], home: EVERYONE, description: null, evidence: [], rows_are_nodes: false, record_table: null, stages: [], status: "active" }));

/** decisions and actions are subclasses of event (R1); seeded with the roots, at the roots' home */
export const SEEDED_SUBCLASSES = [
  { name: "decision", parents: ["event"] },
  { name: "action", parents: ["event"] },
];

/** what discovery seeds before it reads anything: the four roots, and decision and action under event (R1) */
export const seedClasses = () => [
  ...rootClasses(),
  ...SEEDED_SUBCLASSES.map(({ name, parents }) => ({ name, key: name, parents, home: EVERYONE, description: null, evidence: [], rows_are_nodes: false, record_table: null, stages: [], status: "active" })),
];
export const SEEDED_KEYS = seedClasses().map((c) => c.key);

/** classes by key: a list of normalized classes, with the seeded ones added when missing */
export function classIndex(classes) {
  const out = new Map(seedClasses().map((c) => [c.key, c]));
  for (const c of classes ?? []) if (c?.key) out.set(c.key, c);
  return out;
}

/** every ancestor of a class (several parents: a set, nearest first), not the class itself */
export function ancestorsOf(key, index) {
  const out = [];
  const seen = new Set([key]);
  const queue = [...(index.get(key)?.parents ?? [])];
  while (queue.length) {
    const k = queue.shift();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    queue.push(...(index.get(k)?.parents ?? []));
  }
  return out;
}

/** every class below this one (subclasses at any depth) */
export function descendantsOf(key, index) {
  const out = [];
  const seen = new Set([key]);
  const queue = [key];
  while (queue.length) {
    const k = queue.shift();
    for (const c of index.values()) {
      if (!seen.has(c.key) && c.parents.includes(k)) {
        seen.add(c.key);
        out.push(c.key);
        queue.push(c.key);
      }
    }
  }
  return out;
}

/** the primitives a class reaches (a class with several parents can reach more than one) */
export const primitivesOf = (key, index) => (PRIMITIVES.includes(key) ? [key] : ancestorsOf(key, index).filter((k) => PRIMITIVES.includes(k)));

/**
 * Can `key` have these parents: every parent exists, none is retired, none is the class or below it
 * (a cycle), and the class reaches a primitive. Throws ShapeError; returns the parents' keys.
 */
export function assertParents(key, parents, index) {
  const list = [...new Set(parents.map(classKey))];
  if (!list.length && !PRIMITIVES.includes(key)) throw new ShapeError("parents", "needs at least one parent");
  const below = new Set(descendantsOf(key, index));
  for (const p of list) {
    const c = index.get(p);
    if (!c) throw new ShapeError("parents", `no class ${p}`);
    // NEEDS A RULING (a retired parent): R11 says only that a retired class never returns on its own.
    // Smallest choice: nothing new goes under it either.
    if (c.status === "retired") throw new ShapeError("parents", `${p} is retired`);
    if (p === key || below.has(p)) throw new ShapeError("parents", `${p} is ${p === key ? "the class itself" : "below it"}: a cycle`);
  }
  const trial = new Map(index);
  trial.set(key, { ...(index.get(key) ?? { key, status: "active" }), key, parents: list });
  if (!primitivesOf(key, trial).length) throw new ShapeError("parents", `${key} reaches none of the four primitives`);
  return list;
}

/** stages belong to commitment classes only (R11): is this class under commitment */
export const mayHaveStages = (key, index) => primitivesOf(key, index).includes("commitment");

/** an INSTANCE_OF edge's fields, normalized: { instance, class, added_by, at } (rids as strings, class as key) */
export function normalizeInstanceEdge(raw) {
  if (!raw || typeof raw !== "object") throw new ShapeError("instance", "must be an object");
  if (!nonEmpty(raw.instance)) throw new ShapeError("instance", "needs the instance's record id");
  if (!nonEmpty(raw.class)) throw new ShapeError("class", "needs the class");
  if (!nonEmpty(raw.added_by)) throw new ShapeError("added_by", "needs who related it");
  const at = isoDate(raw.at ?? Date.now());
  if (!at) throw new ShapeError("at", `not a date: ${raw.at}`);
  return { instance: String(raw.instance).trim(), class: classKey(raw.class), added_by: clip(raw.added_by, 120), at };
}

/**
 * A DEPENDS_ON edge, from the instance that depends to the one it depends on: stated by a person, a
 * record or an agent (R1), and a timeline is read from times plus dependency (R1).
 * NEEDS A RULING (dependency times): which times an edge carries. Smallest choice: when it was stated,
 * and optionally from and until when it holds; the instances' own times are theirs.
 */
export function normalizeDependency(raw) {
  if (!raw || typeof raw !== "object") throw new ShapeError("dependency", "must be an object");
  for (const k of ["from", "to"]) if (!nonEmpty(raw[k])) throw new ShapeError(k, "needs an instance's record id");
  if (String(raw.from).trim() === String(raw.to).trim()) throw new ShapeError("to", "an instance can't depend on itself");
  const statedAs = String(raw.stated_as ?? "").trim();
  if (!STATED_AS.includes(statedAs)) throw new ShapeError("stated_as", `must be one of ${STATED_AS.join(", ")}`);
  if (!nonEmpty(raw.stated_by)) throw new ShapeError("stated_by", "needs who stated it (the person, the record's id, or the agent)");
  const date = (k, required = false) => {
    if (raw[k] === undefined || raw[k] === null || raw[k] === "") {
      if (required) throw new ShapeError(k, "needs a date");
      return null;
    }
    const d = isoDate(raw[k]);
    if (!d) throw new ShapeError(k, `not a date: ${raw[k]}`);
    return d;
  };
  const statedAt = date("stated_at") ?? new Date().toISOString();
  const validFrom = date("valid_from");
  const validUntil = date("valid_until");
  if (validFrom && validUntil && validUntil < validFrom) throw new ShapeError("valid_until", "ends before it starts");
  return {
    from: String(raw.from).trim(),
    to: String(raw.to).trim(),
    stated_as: statedAs,
    stated_by: clip(raw.stated_by, 160),
    source: nonEmpty(raw.source) ? clip(raw.source, 200) : null,
    note: nonEmpty(raw.note) ? clip(raw.note, 600) : null,
    stated_at: statedAt,
    valid_from: validFrom,
    valid_until: validUntil,
  };
}

/** R11: a dependency edge is visible only to someone who can see both ends (`sees`: instance -> boolean) */
export const dependencyVisible = (edge, sees) => Boolean(sees(edge.from) && sees(edge.to));

/* ---------------------------------------------------------------------------------------------------
 * Home from evidence (R11: "A class from a table gets the home of the connection that can read that
 * table; from notes, the strictest home among them; wider only if wider evidence independently supports
 * it"). Computed here, never chosen by a model. Unknown anything fails upward to the root.
 * ------------------------------------------------------------------------------------------------- */

/** is `a` at or above `b` in the tree (everyone sits below every position) */
const atOrAbove = (positions, a, b) => a === b || (a !== EVERYONE && (b === EVERYONE || ancestors(positions, b).includes(a)));

/**
 * The widest of several homes, each of which independently supports the class.
 * NEEDS A RULING (evidence on different branches): when the homes lie on one chain the deepest wins
 * (`everyone` beats every position); when they sit on different branches neither is wider, so their
 * common ancestor, the strictest choice, wins.
 */
export function widestHome(positions, homes) {
  const list = [...new Set(homes.map((h) => effectiveHome(positions, h)))];
  if (!list.length) return positions.root;
  if (list.includes(EVERYONE)) return EVERYONE;
  const chain = list.every((a) => list.every((b) => atOrAbove(positions, a, b) || atOrAbove(positions, b, a)));
  if (!chain) return commonAncestor(positions, list);
  return list.sort((a, b) => ancestors(positions, b).length - ancestors(positions, a).length)[0];
}

/** the strictest of several homes: the deepest point at or above all of them (positions.commonAncestor) */
export const strictestHome = (positions, homes) => commonAncestor(positions, homes);

/** the system a piece of evidence reads from: a table (`system:table`) or a row (`system:table:row`) */
export const evidenceSystem = (e) => parseTable(e?.ref)?.system ?? parseKey(e?.ref)?.system ?? null;

/**
 * A class's home from its evidence (R11). `connectionHome(system)` is the home of the connection that
 * reads a system (null or unknown: the root); `noteHome(ref)` is the home of a note or section (null:
 * unknown, the root). Each table, column or row citation is one independent group, at its connection's
 * home; every note together is one group, at the strictest home among them. The class takes the widest
 * group (widestHome). No usable evidence: the root.
 */
export function homeFromEvidence(evidence, { positions, connectionHome = () => null, noteHome = () => null }) {
  const groups = [];
  const notes = [];
  for (const e of evidence ?? []) {
    if (e.kind === "correction") continue; // a person's correction pins a home itself (corrections below)
    if (e.kind === "notes") {
      notes.push((e.ref && noteHome(e.ref)) || positions.root);
      continue;
    }
    const system = evidenceSystem(e);
    groups.push((system && connectionHome(system)) || positions.root);
  }
  if (notes.length) groups.push(strictestHome(positions, notes));
  return groups.length ? widestHome(positions, groups) : positions.root;
}

/**
 * The home a class is stored at: its own (from evidence, or a person's correction) made no wider than
 * any parent's (R9: where parents conflict the strictest rule wins).
 * NEEDS A RULING (what "strictest rule" covers): smallest choice, the home is inherited strictest-wins,
 * so a class is never seen where one of its parents is not; rows_are_nodes is the class's own and is not
 * inherited.
 */
export const classHome = (ownHome, parentHomes, positions) => strictestHome(positions, [ownHome, ...parentHomes]);

/**
 * Every class's stored home, parents first: `own(c)` gives a class's own home. Returns Map key -> home.
 * The seeded classes keep theirs.
 */
export function treeHomes(index, own, positions) {
  const out = new Map();
  const visit = (key, stack) => {
    if (out.has(key)) return out.get(key);
    const c = index.get(key);
    if (!c || stack.has(key)) return positions.root; // a cycle can't be stored (assertParents); fail upward if one is
    stack.add(key);
    const home = SEEDED_KEYS.includes(key) ? c.home : classHome(own(c), c.parents.map((p) => visit(p, stack)), positions);
    stack.delete(key);
    out.set(key, home);
    return home;
  };
  for (const key of index.keys()) visit(key, new Set());
  return out;
}

/* ---------------------------------------------------------------------------------------------------
 * Corrections (R11: "A person corrects in the admin panel or by telling the orchestrator; corrections
 * are stored and reruns respect them; a retired class never returns on its own"). A correction is kept
 * on the class it corrects; what it set is pinned, and nothing but another correction changes it.
 * ------------------------------------------------------------------------------------------------- */

export const CORRECTION_KINDS = ["retire", "restore", "rename", "parents", "home", "rows_are_nodes", "description", "stages", "record_table", "unrelate"];
/** the field each pinning correction sets */
export const PINS = { rename: "name", parents: "parents", home: "home", rows_are_nodes: "rows_are_nodes", description: "description", stages: "stages", record_table: "record_table" };

/** one correction, normalized: { kind, value?, from?, instance?, by, at, reason } */
export function normalizeCorrection(raw, { positions } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ShapeError("correction", "must be an object");
  const kind = String(raw.kind ?? "").trim();
  if (!CORRECTION_KINDS.includes(kind)) throw new ShapeError("kind", `must be one of ${CORRECTION_KINDS.join(", ")}`);
  if (!nonEmpty(raw.by)) throw new ShapeError("by", "needs the person who corrected it");
  const at = isoDate(raw.at ?? Date.now());
  if (!at) throw new ShapeError("at", `not a date: ${raw.at}`);
  const out = { kind, by: clip(raw.by, 120), at, reason: nonEmpty(raw.reason) ? clip(raw.reason, 600) : null };
  const v = raw.value;
  if (kind === "rename") {
    if (!nonEmpty(v) || !classKey(v)) throw new ShapeError("value", "needs the new name");
    out.value = clip(v, 80);
    out.from = nonEmpty(raw.from) ? clip(raw.from, 80) : null;
  } else if (kind === "parents") {
    if (!Array.isArray(v) || !v.length || v.some((p) => !nonEmpty(p))) throw new ShapeError("value", "needs the parents' names");
    out.value = [...new Set(v.map(classKey))];
  } else if (kind === "home") {
    if (!nonEmpty(v)) throw new ShapeError("value", "needs a home");
    if (positions && v !== EVERYONE && !positions.positions[v]) throw new ShapeError("value", `unknown position: ${v}`);
    out.value = String(v).trim();
  } else if (kind === "rows_are_nodes") {
    if (typeof v !== "boolean") throw new ShapeError("value", "must be true or false");
    out.value = v;
  } else if (kind === "description") {
    out.value = nonEmpty(v) ? clip(v, 1000) : null;
  } else if (kind === "stages") {
    if (!Array.isArray(v) || v.some((s) => !nonEmpty(s))) throw new ShapeError("value", "must be a list of stage names");
    out.value = v.map((s) => clip(s, 60));
  } else if (kind === "record_table") {
    if (v !== null && (!nonEmpty(v) || !TABLE_RE.test(String(v).trim()))) throw new ShapeError("value", "system:table, or null");
    out.value = v === null ? null : String(v).trim();
  } else if (kind === "unrelate") {
    if (!nonEmpty(raw.instance)) throw new ShapeError("instance", "needs the instance (its record id or record key)");
    out.instance = clip(raw.instance, 200);
  }
  return out;
}

/** the fields corrections pinned on a class, the latest winning: { name?, parents?, home?, ... } */
export function pinned(corrections) {
  const out = {};
  for (const c of corrections ?? []) if (PINS[c.kind]) out[PINS[c.kind]] = c.value;
  return out;
}

/** is the class retired by its corrections (the latest of retire and restore wins) */
export function retiredBy(corrections) {
  let retired = false;
  for (const c of corrections ?? []) {
    if (c.kind === "retire") retired = true;
    if (c.kind === "restore") retired = false;
  }
  return retired;
}

/** the keys a class was known by before a person renamed it */
export const formerKeys = (cls) => (cls.corrections ?? []).filter((c) => c.kind === "rename" && c.from).map((c) => classKey(c.from)).filter((k) => k !== cls.key);

/** the instances a person took out of a class (record ids or keys, lower-cased): nothing puts them back on its own */
export const unrelated = (cls) => new Set((cls.corrections ?? []).filter((c) => c.kind === "unrelate").map((c) => c.instance.toLowerCase()));

/**
 * May the orchestrator create this class (R11: corrections are respected, a retired class never returns
 * on its own)? `classes` are every stored class with their corrections applied. Throws ShapeError naming
 * what it collides with: a retired class by name or table, a class a person renamed, or one that exists.
 * NEEDS A RULING (what "the same class" is on a rerun): smallest choice, the same name (classKey) or the
 * same record table. A name is taken per home (NAMES_UNIQUE), and only classes the writer sees (`sees(home)`)
 * are checked, so a refusal never names a class it can't see.
 */
export function assertCreatable(cls, classes, { sees = () => true } = {}) {
  // a class the writer can't see neither blocks it nor is named to it (NAMES_UNIQUE: per home)
  for (const c of classes.filter((x) => sees(x.home))) {
    const sameName = c.key === cls.key;
    const sameTable = Boolean(cls.record_table && c.record_table && c.record_table.toLowerCase() === cls.record_table.toLowerCase());
    if ((sameName || sameTable) && c.status === "retired") throw new ShapeError(sameName ? "name" : "record_table", `${c.name} was retired by a person: it never returns on its own`);
    if (formerKeys(c).includes(cls.key)) throw new ShapeError("name", `a person renamed ${cls.name} to ${c.name}: use ${c.name}`);
    if (sameName && (!cls.home || c.home === cls.home)) throw new ShapeError("name", `${c.name} exists already${cls.home ? " at that home" : ""}`);
  }
}

/** may the orchestrator change this field of a class: not when it is retired, nor when a person pinned the field */
export function assertUnpinned(cls, field) {
  if (cls.status === "retired") throw new ShapeError("class", `${cls.name} was retired by a person`);
  if (field in pinned(cls.corrections)) throw new ShapeError(field, `a person set ${cls.name}'s ${field}: only a person changes it`);
}

/** a class with its corrections applied: pinned fields take the person's value, the status the latest retire or restore */
export function applyCorrections(cls) {
  const p = pinned(cls.corrections);
  const out = { ...cls, ...p };
  if (p.name) out.key = classKey(p.name);
  if ((cls.corrections ?? []).some((c) => c.kind === "retire" || c.kind === "restore")) out.status = retiredBy(cls.corrections) ? "retired" : "active";
  return out;
}

/* ---------------------------------------------------------------------------------------------------
 * What earns a node (R3): "A row earns a node when the graph must say something the source cannot hold
 * (for example a dependency), created by the worker, referring back by key."
 * ------------------------------------------------------------------------------------------------- */

/**
 * May a row of this class's table become an instance node? Yes when the class says its rows are nodes,
 * or the node is made for a dependency.
 * NEEDS A RULING (a row's node for other reasons): smallest choice, also yes with a stated reason of what
 * the graph must hold that the source can't. A class with no record table has no rows: its instances are
 * always nodes.
 */
export function mayMakeNode(cls, { key = null, dependency = false, reason = null } = {}) {
  if (!cls.record_table || cls.rows_are_nodes) return { ok: true };
  const k = parseKey(key);
  if (k && `${k.system}:${k.table}`.toLowerCase() !== cls.record_table.toLowerCase()) return { ok: true };
  if (dependency) return { ok: true, why: "a dependency the source can't hold" };
  if (nonEmpty(reason)) return { ok: true, why: clip(reason, 300) };
  return { ok: false, reason: `${cls.name}'s rows stay in ${cls.record_table}, and a section stores the key: a row gets a node only when the graph must say something the source can't hold (a dependency, or give the reason)` };
}

/* ---------------------------------------------------------------------------------------------------
 * The timeline (R1: "read a timeline from times plus dependency").
 * ------------------------------------------------------------------------------------------------- */

/**
 * Order instances by their times and their dependencies: whatever another depends on comes first, and
 * among those free to come next the earliest time does (no time: after those with one, then by id).
 * `items`: [{ id, at? }]; `deps`: [{ from, to }] (from depends on to). Dependencies on items not given are
 * ignored. A cycle can't be ordered: its members come last, by time, marked `cycle: true`.
 */
export function timeline(items, deps) {
  const before = new Map(items.map((i) => [i.id, new Set()]));
  for (const d of deps ?? []) if (before.has(d.from) && before.has(d.to) && d.from !== d.to) before.get(d.from).add(d.to);
  const cmp = (a, b) => {
    const ta = isoDate(a.at);
    const tb = isoDate(b.at);
    if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
    if (ta && !tb) return -1;
    if (!ta && tb) return 1;
    return String(a.id).localeCompare(String(b.id));
  };
  const done = new Set();
  const out = [];
  for (;;) {
    const next = items.filter((i) => !done.has(i.id) && [...before.get(i.id)].every((d) => done.has(d))).sort(cmp)[0];
    if (!next) break;
    done.add(next.id);
    out.push({ ...next, after: [...before.get(next.id)] });
  }
  for (const i of items.filter((x) => !done.has(x.id)).sort(cmp)) out.push({ ...i, after: [...before.get(i.id)], cycle: true });
  return out;
}

/* ---------------------------------------------------------------------------------------------------
 * The tree, as a person reads it (R5: "measure tree quality on real models early").
 * ------------------------------------------------------------------------------------------------- */

/**
 * One page: each class under its parents (a class with several parents is listed under each, marked),
 * with its home, its table and whether its rows are nodes, its instance count and its evidence, for a
 * person to mark right, wrong or missing. `counts`: Map key -> instances; `homeName(home)` for people.
 */
export function treeReport(index, { counts = new Map(), homeName = (h) => h } = {}) {
  const lines = [];
  const kids = (key) => [...index.values()].filter((c) => c.parents.includes(key) && c.status !== "retired").sort((a, b) => a.key.localeCompare(b.key));
  const walk = (c, depth, via) => {
    const n = counts.get(c.key) ?? 0;
    const facts = [
      `home: ${homeName(c.home)}`,
      c.record_table ? `table ${c.record_table}, rows ${c.rows_are_nodes ? "are" : "are not"} nodes` : null,
      `${n} instance${n === 1 ? "" : "s"}`,
      c.parents.length > 1 ? `also under ${c.parents.filter((p) => p !== via).join(", ")}` : null,
    ].filter(Boolean);
    lines.push(`${"  ".repeat(depth)}- ${c.name} (${facts.join("; ")})`);
    for (const e of c.evidence ?? []) lines.push(`${"  ".repeat(depth + 1)}evidence: ${e.kind}${e.ref ? ` ${e.ref}` : ""}${e.note ? `: ${e.note}` : ""}`);
    for (const k of kids(c.key)) walk(k, depth + 1, c.key);
  };
  for (const p of PRIMITIVES) walk(index.get(p), 0, null);
  const retired = [...index.values()].filter((c) => c.status === "retired");
  if (retired.length) lines.push("", "Retired by a person:", ...retired.map((c) => `- ${c.name}`));
  return lines.join("\n");
}

/* ---------------------------------------------------------------------------------------------------
 * Mirrored under agent: positions as classes with people as their instances (R6: "Positions are
 * mirrored as classes under agent with people as instances (one-way sync from authentik, which keeps
 * granting access)"), and the AI agents as instances (R1: "The AI agents are instances under agent").
 * Only the sync writes these; the orchestrator and corrections leave them alone.
 * ------------------------------------------------------------------------------------------------- */

/**
 * NEEDS A RULING (where the mirror is seen): smallest choice, everyone. Position names are already shown to
 * everyone wherever a home is named, and a position's class nested under its parent's would otherwise be
 * raised to the root by strictest-wins (R9), hiding everyone's own position from them.
 */
export const MIRROR_HOME = EVERYONE;
/** the record-key system the mirror's instances are keyed under: what the one-way sync reads from */
export const MIRROR_SYSTEM = "authentik";

/** the positions of a parsed position map as classes, parents first: the root's under agent, each other under its parent's */
export function positionClasses(map) {
  const out = [];
  const keyOf = (id) => classKey(map.positions[id].name);
  const queue = [map.root];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id) || !map.positions[id]) continue;
    seen.add(id);
    const parent = map.positions[id].parent;
    out.push({ name: clip(map.positions[id].name, 80), key: keyOf(id), parents: [parent && map.positions[parent] ? keyOf(parent) : "agent"], home: MIRROR_HOME, position: id, description: nonEmpty(map.positions[id].description) ? clip(map.positions[id].description, 1000) : null });
    for (const [kid, p] of Object.entries(map.positions)) if (p.parent === id) queue.push(kid);
  }
  return out;
}

/**
 * The people who hold positions, as instances of those positions' classes: `people` is [{ user, positions }]
 * (the token map's people; agents, whose names carry a slash, are left out). Keyed `authentik:user:<user>`.
 */
export function peopleInstances(map, people) {
  const out = [];
  for (const p of people ?? []) {
    const user = String(p?.user ?? "").trim();
    if (!user || user.includes("/")) continue;
    const held = (p.positions ?? []).filter((id) => map.positions[id]);
    if (!held.length) continue;
    out.push({ name: user, key: `${MIRROR_SYSTEM}:user:${user}`, classes: [...new Set(held.map((id) => classKey(map.positions[id].name)))], home: MIRROR_HOME });
  }
  return out;
}

/**
 * The AI agents as instances under agent (R1).
 * NEEDS A RULING (which AI agents): smallest choice, the plan's: one instance for the orchestrator and one per
 * agent profile graph-rag knows of, the Graph worker profile its workers, handlers and liaison run from; not
 * one per thread, since threads don't last.
 */
export const AI_AGENTS = [
  { name: "Orchestrator", key: "graph-rag:agent:orchestrator", classes: ["agent"], home: MIRROR_HOME },
  { name: "Graph worker", key: "graph-rag:agent:graph-worker", classes: ["agent"], home: MIRROR_HOME },
];
