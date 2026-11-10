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
import { EVERYONE } from "../positions.js";
import { clip, isoDate, nonEmpty, ShapeError, snakeCase } from "./text.js";
import { TABLE_RE } from "./schema.js";

export const CLASS_KIND = "class";
/** the four primary primitives, the only roots (R1; "agent" is the user's word, replacing actor) */
export const PRIMITIVES = ["agent", "commitment", "event", "resource"];
/** a class is in use or retired; a retired class never returns on its own (R11) */
export const CLASS_STATUSES = ["active", "retired"];
/** who states a dependency (R1) */
export const STATED_AS = ["person", "record", "agent"];
/** what a piece of evidence for a class is; rows are cited by key, never copied */
export const EVIDENCE_KINDS = ["table", "columns", "rows", "notes", "correction"];

/** a class name as an identity: "Leased building", "leased_building" and "Leased-Building" are one class */
export const classKey = snakeCase;

/**
 * NEEDS A RULING (class names): a name is unique in the organization (by `classKey`), whatever the
 * homes. Smallest reversible choice: two homes can't each hold their own class of one name.
 */
export const NAMES_UNIQUE = true;

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
export function normalizeClass(raw, { positions } = {}) {
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

/** classes by key: a list of normalized classes, with the roots added when missing */
export function classIndex(classes) {
  const out = new Map(rootClasses().map((c) => [c.key, c]));
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
