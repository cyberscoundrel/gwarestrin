// The organization model's storage shape (docs/ORGANIZATION-MODEL.md): the
// ArcadeDB types and edges as data, and the idempotent DDL that declares
// them. Nothing here talks to a database; a stream runs `statements()`
// through its own `adbCommand` at startup, the way server.js declares the
// types it owns today (`CREATE ... IF NOT EXISTS`, every statement safe to
// repeat).
//
// It extends what exists rather than duplicating it:
//   Entity (vertex)   the one entry type: entries, documents, sections,
//                     things (`_kind`), keyed (name, _origin); things carry
//                     `_keys` (system:table:row, e.g. mssql:dbo_Job:4471)
//   PART_OF, NEXT, SOURCED_FROM (edges)   documents.js
//   ABOUT, RELATES (edges)                things.js
// New here:
//   Class (vertex)             a kind the organization recognizes, of anything; the four primitives are its roots
//   SUBCLASS_OF (edge)         class -> parent class: one tree under the four roots
//   INSTANCE_OF (edge)         entity -> Class: the only record of what an instance is
//   CLAIMS (edge)              section or entry -> subject, one primitive with an interval
//   SourceRef (vertex)         a row in a source system, by key, never copied
//   REFERS_TO (edge)           instance -> SourceRef
//   AuditEvent (vertex)        an agent's write to a source system
//   WROTE (edge)               AuditEvent -> SourceRef
//   Entity._on_record ...      the on-record marker on a document
// Going away (the code still uses them until the writers and readers move;
// see "The instance rule" in docs/ORGANIZATION-MODEL.md):
//   CommitmentClass (vertex)   becomes Class; planInstanceMigration copies its rows
//   Entity._class              becomes the INSTANCE_OF edge
//   Entity._thing_type         becomes the INSTANCE_OF edge (declared by worker-pool.js, not here)
//   ACTOR_TYPES                goes: a person is an instance of a class a person confirmed

/** the four primitives: the only roots of the class tree, and the only classes nobody confirms */
export const PRIMITIVES = ["actor", "commitment", "event", "resource"];
/** the kinds of claim */
export const CLAIM_KINDS = ["commitment", "event", "state", "observation"];
/** who "confirmed" a root: no person, by design */
export const BUILTIN = "built-in";
/** going away: the code still validates a subject's `actor` against this until the writers move; nothing new uses it */
export const ACTOR_TYPES = ["person", "position", "customer", "supplier", "agent"];
/** a class's life: proposed by discovery or a worker, confirmed by a person, retired by one */
export const CLASS_STATUSES = ["proposed", "confirmed", "retired"];
/** the edge that makes an entity an instance, the class vertex it points at, and the edge that makes one class a kind of another */
export const INSTANCE_EDGE = "INSTANCE_OF";
export const SUBCLASS_EDGE = "SUBCLASS_OF";
export const CLASS_TYPE = "Class";
/** an edge to a class in one of these makes an instance. A retired class admits no new one and takes none away. An edge to a proposed class is held: see planInstanceMigration */
export const INSTANCE_CLASS_STATUSES = ["confirmed", "retired"];
/** why a claim's subject stayed a value on the claim (CLAIMS.unresolved) */
export const UNRESOLVED_REASONS = ["no-class", "no-row", "ambiguous"];
/** what became of an agent's write to a source system; "attempted": started, its end not yet recorded */
export const AUDIT_OUTCOMES = ["applied", "proposed", "refused", "failed", "attempted"];
/** the attribute that says which of its class's stages an instance is at; a class with no stages up its chain takes none */
export const STAGE_ATTRIBUTE = "stage";

/**
 * A connected-system key, as things.js `_keys` holds them: `system:table:row`
 * (`mssql:dbo_Customer:TORO`). A class's `record_table` is the first two parts
 * (`mssql:dbo_Order`); an instance's record key is that plus its row key.
 */
export const KEY_RE = /^([a-z0-9_-]{1,40}):([^\s:][^\n:]{0,120}):([^\s][^\n]{0,160})$/i;
export const TABLE_RE = /^([a-z0-9_-]{1,40}):([^\s:][^\n:]{0,120})$/i;

/** "mssql:dbo_Job:4471" -> { key, system, table, row_key } or null */
export function parseKey(key) {
  const m = KEY_RE.exec(String(key ?? "").trim());
  return m ? { key: m[0], system: m[1], table: m[2], row_key: m[3] } : null;
}

/** "mssql:dbo_Job" -> { system, table } or null */
export function parseTable(table) {
  const m = TABLE_RE.exec(String(table ?? "").trim());
  return m ? { system: m[1], table: m[2] } : null;
}

/** the record key of one row of a class's record table; null when the class has no record table */
export function recordKey(cls, rowKey) {
  const t = parseTable(cls?.record_table);
  const row = String(rowKey ?? "").trim();
  if (!t || !row) return null;
  const key = `${t.system}:${t.table}:${row}`;
  return parseKey(key) ? key : null;
}

/**
 * The types, as data. `kind`: vertex | edge | property-set (properties added
 * to a type that already exists). `properties`: name -> ArcadeDB type. Edge
 * types list their `from` and `to` as documentation; ArcadeDB does not
 * constrain them. Indexes: `unique` or not, over the named properties.
 */
export const TYPES = {
  Class: {
    kind: "vertex",
    doc: "a kind the organization recognizes, of anything: its own internal symbols. The four primitives are the roots; every other class has one parent (SUBCLASS_OF)",
    properties: {
      name: "STRING", // unique; what claims and policy use
      description: "STRING",
      stages: "LIST", // of STRING, in order; its own list, or empty to take the nearest up the chain
      record_table: "STRING", // system:table, or null when no source system records it
      status: "STRING", // CLASS_STATUSES
      proposed_by: "STRING", // discovery, a worker, a person, or the migration
      confirmed_by: "STRING", // the person (BUILTIN for a root); null until confirmed
      confirmed_at: "STRING", // ISO
      attributes: "LIST", // of STRING: what can be claimed about it; a subclass has its ancestors' too
      occurrences: "LIST", // of STRING: the sections a draft was seen in
      reasons: "LIST", // of STRING: why it was drafted, and what became of it
    },
    indexes: [{ properties: ["name"], unique: true }, { properties: ["status"], unique: false }],
  },
  SUBCLASS_OF: {
    kind: "edge",
    doc: "a class is a kind of its parent: out = the class, in = its parent. A person confirms each link; one confirmed parent, and at most one proposed in its place. Reading it: outE('SUBCLASS_OF')[status = 'confirmed'].inV(), since out(...)[...] filters on the class's own status",
    from: ["Class"],
    to: ["Class"],
    properties: {
      child: "STRING", // the class's rid; with status, what the unique index holds to one parent per status
      status: "STRING", // proposed | confirmed; a move is a proposed link replacing the confirmed one
      proposed_by: "STRING",
      confirmed_by: "STRING", // the person
      confirmed_at: "STRING", // ISO
      reason: "STRING", // why the class is a kind of this parent
    },
    indexes: [{ properties: ["child", "status"], unique: true }],
  },
  INSTANCE_OF: {
    kind: "edge",
    doc: "the instance relationship: out = the entity, in = a class it is an instance of; the only record of what an instance is. An entity may have several, one per class",
    from: ["Entity:thing"],
    to: ["Class"],
    properties: {
      instance: "STRING", // the entity's rid
      class_rid: "STRING", // the class's rid; with instance, what the unique index holds to one edge per pair
      migrated: "BOOLEAN", // written by the boot migration, not by a mint
    },
    indexes: [{ properties: ["instance", "class_rid"], unique: true }],
  },
  CommitmentClass: {
    kind: "vertex",
    doc: "going away: the rows move to Class (planInstanceMigration)",
    properties: {
      name: "STRING", // unique; the class name claims and policy use
      description: "STRING",
      stages: "LIST", // of STRING, in order
      record_table: "STRING", // system:table, or null when no source system records it
      status: "STRING", // CLASS_STATUSES
      proposed_by: "STRING", // discovery, a worker, or a person
      confirmed_by: "STRING", // the person; null until confirmed
      confirmed_at: "STRING", // ISO
    },
    indexes: [{ properties: ["name"], unique: true }, { properties: ["status"], unique: false }],
  },
  Entity: {
    kind: "property-set",
    doc: "what the model adds to the existing entry type: instances and the on-record marker",
    properties: {
      _class: "STRING", // going away: the INSTANCE_OF edge replaces it
      _on_record: "BOOLEAN", // on a document: a person put it on record
      _recorded_by: "STRING", // that person (an agent's record counts as the person it acts for)
      _recorded_at: "STRING", // ISO
      _record_position: "STRING", // the position the record was made under
      _record_reason: "STRING", // why it is on record
    },
    indexes: [{ properties: ["_class"], unique: false }],
  },
  CLAIMS: {
    kind: "edge",
    doc: "one primitive bound to a subject with an interval; out = the section or entry it was extracted from, in = the instance, the class itself (scope: class), or the section again when the subject stayed a value",
    from: ["Entity:section", "Entity:entry"],
    to: ["Entity:thing", "Class", "Entity:section"],
    properties: {
      id: "STRING", // unique
      kind: "STRING", // CLAIM_KINDS
      class: "STRING", // Class.name: the class the claim bears on, which is not the subject's class (a pay claim about Tomas is hires/pay; Tomas is a person)
      attribute: "STRING", // snake_case
      value: "STRING", // as stated; numbers and booleans JSON-encoded
      value_num: "DOUBLE", // the number when the value is one
      valid_from: "STRING", // ISO
      valid_until: "STRING", // ISO, or null while open
      recorded_at: "STRING", // ISO
      recorded_by: "STRING", // the person
      closed_by: "STRING", // the id of the claim that closed this one's interval
      _home: "STRING", // seen from here: no lower than the section, raised to the authority position
      subject: "STRING", // JSON, the subject as written; only while it stayed a value
      subject_norm: "STRING", // its name normalized: how a later instance finds the claims waiting for it
      unresolved: "STRING", // UNRESOLVED_REASONS: why it stayed a value
    },
    indexes: [
      { properties: ["id"], unique: true },
      { properties: ["class", "attribute"], unique: false },
      { properties: ["subject_norm"], unique: false },
    ],
  },
  SourceRef: {
    kind: "vertex",
    doc: "a row in a source system, by key; the graph never copies the row",
    properties: {
      key: "STRING", // unique: system:table:row
      system: "STRING",
      table: "STRING",
      row_key: "STRING",
      last_seen: "STRING", // ISO: when a worker last confirmed the row exists
      seen_by: "STRING", // which identity
    },
    indexes: [{ properties: ["key"], unique: true }],
  },
  REFERS_TO: {
    kind: "edge",
    doc: "an instance to the row it stands for",
    from: ["Entity:thing"],
    to: ["SourceRef"],
    properties: {},
    indexes: [],
  },
  AuditEvent: {
    kind: "vertex",
    doc: "an agent's write to a source system, which the source system will not record",
    properties: {
      id: "STRING", // unique
      key: "STRING", // the row written: a SourceRef key
      authorized_by: "STRING", // the person the agent acted for
      acted_by: "STRING", // the agent identity (user/agent:id)
      position: "STRING", // the position the write was made under
      at: "STRING", // ISO
      change: "STRING", // JSON: { before, after } or the statement
      outcome: "STRING", // AUDIT_OUTCOMES
      pending_id: "STRING", // the PendingWrite when proposed
    },
    indexes: [
      { properties: ["id"], unique: true },
      { properties: ["key"], unique: false },
    ],
  },
  WROTE: {
    kind: "edge",
    doc: "an audit event to the row it touched",
    from: ["AuditEvent"],
    to: ["SourceRef"],
    properties: {},
    indexes: [],
  },
};

/** the types this module declares from nothing (not the property sets on existing ones) */
export const NEW_TYPES = Object.entries(TYPES)
  .filter(([, t]) => t.kind !== "property-set")
  .map(([name]) => name);

/**
 * The DDL, in order, every statement idempotent (`IF NOT EXISTS`), so a
 * stream can run the whole list at every start the way server.js does.
 */
export function statements(types = TYPES) {
  const out = [];
  for (const [name, t] of Object.entries(types)) {
    if (t.kind === "vertex") out.push(`CREATE VERTEX TYPE ${name} IF NOT EXISTS`);
    else if (t.kind === "edge") out.push(`CREATE EDGE TYPE ${name} IF NOT EXISTS`);
    for (const [prop, type] of Object.entries(t.properties)) out.push(`CREATE PROPERTY ${name}.${prop} IF NOT EXISTS ${type}`);
    for (const ix of t.indexes) out.push(`CREATE INDEX IF NOT EXISTS ON ${name} (${ix.properties.join(", ")}) ${ix.unique ? "UNIQUE" : "NOTUNIQUE"}`);
  }
  return out;
}

const TYPE_RE = /^CREATE (VERTEX|EDGE) TYPE ([A-Za-z_]\w*) IF NOT EXISTS$/;
const PROP_RE = /^CREATE PROPERTY ([A-Za-z_]\w*)\.([A-Za-z_]\w*) IF NOT EXISTS (STRING|BOOLEAN|DOUBLE|INTEGER|LONG|LIST|MAP)$/;
const INDEX_RE = /^CREATE INDEX IF NOT EXISTS ON ([A-Za-z_]\w*) \(([A-Za-z_]\w*(?:, [A-Za-z_]\w*)*)\) (UNIQUE|NOTUNIQUE)$/;

/**
 * One statement back into data: { op: "type", kind, name } | { op:
 * "property", type, name, dataType } | { op: "index", type, properties,
 * unique }. Throws on anything this module would not emit.
 */
export function parseStatement(sql) {
  const s = String(sql).trim();
  let m = TYPE_RE.exec(s);
  if (m) return { op: "type", kind: m[1].toLowerCase(), name: m[2] };
  m = PROP_RE.exec(s);
  if (m) return { op: "property", type: m[1], name: m[2], dataType: m[3] };
  m = INDEX_RE.exec(s);
  if (m) return { op: "index", type: m[1], properties: m[2].split(", "), unique: m[3] === "UNIQUE" };
  throw new Error(`not a schema statement: ${s}`);
}

/** the statements folded back into the TYPES shape (property sets come back with kind "property-set") */
export function fromStatements(list) {
  const out = {};
  const at = (name) => (out[name] ??= { kind: "property-set", properties: {}, indexes: [] });
  for (const sql of list) {
    const p = parseStatement(sql);
    if (p.op === "type") at(p.name).kind = p.kind;
    else if (p.op === "property") at(p.type).properties[p.name] = p.dataType;
    else at(p.type).indexes.push({ properties: p.properties, unique: p.unique });
  }
  return out;
}

const ROOT_DESCRIPTIONS = {
  actor: "a person, an organization, a position, or an agent acting for one",
  commitment: "something owed: an order, a quote, a hire, a booking",
  event: "something that happened at a point in time",
  resource: "what the organization owns, uses, moves or consumes: money, parts, buildings, vehicles, software, machine time",
};
const rootRow = (name) => ({ name, description: ROOT_DESCRIPTIONS[name], parent: null, stages: [], record_table: null, status: "confirmed", proposed_by: BUILTIN, confirmed_by: BUILTIN, confirmed_at: null });
const isRoot = (name) => PRIMITIVES.includes(name);
const rowsOf = (classes) => (Array.isArray(classes) ? classes : classes?.classes ? classes.classes : classes instanceof Map ? [...classes.values()] : Object.values(classes ?? {}));

/**
 * The confirmed classes by name, from a list, the fixture's { classes }, a Map
 * or an object. Rows give `parent`, their confirmed parent's name. A row with
 * no status counts as confirmed when a person is named on it. The four roots
 * are always here. A class whose chain doesn't reach a root through confirmed
 * classes is not here: a confirmed link needs a confirmed parent, and a cycle
 * reaches nothing.
 */
export function confirmedClassMap(classes) {
  const rows = new Map();
  for (const c of rowsOf(classes)) {
    if (!c || typeof c.name !== "string" || isRoot(c.name)) continue;
    const confirmed = c.status ? c.status === "confirmed" : Boolean(c.confirmed_by || c.confirmed_at);
    if (confirmed) rows.set(c.name, c);
  }
  const reachesRoot = (name) => {
    const seen = new Set();
    for (let cur = name; !isRoot(cur); cur = rows.get(cur).parent) {
      if (seen.has(cur) || !rows.has(cur)) return false;
      seen.add(cur);
    }
    return true;
  };
  return new Map([...PRIMITIVES.map((p) => [p, rootRow(p)]), ...[...rows].filter(([name]) => reachesRoot(name))]);
}

const chainIn = (name, confirmed) => {
  const out = [];
  for (let cur = name; confirmed.has(cur); cur = confirmed.get(cur).parent) out.push(cur);
  return out;
};

/** a confirmed class and its ancestors, nearest first, ending at its root; empty for anything not confirmed. Inheritance walks this */
export const classChain = (name, classes) => chainIn(name, confirmedClassMap(classes));
/** the root a confirmed class sits under, or null. Derived, so it cannot disagree with the tree when a class moves */
export const primitiveOf = (name, classes) => classChain(name, classes).at(-1) ?? null;
/** a class and everything under it: what a query on the class covers */
export function classAndSubclasses(name, classes) {
  const confirmed = confirmedClassMap(classes);
  return [...confirmed.keys()].filter((c) => chainIn(c, confirmed).includes(name));
}
const nearest = (name, classes, pick) => {
  const confirmed = confirmedClassMap(classes);
  for (const c of chainIn(name, confirmed)) {
    const v = pick(confirmed.get(c));
    if (v) return v;
  }
  return null;
};
/** the stage list in force: the class's own, else the nearest up the chain, else none */
export const effectiveStages = (name, classes) => nearest(name, classes, (c) => (c.stages?.length ? c.stages : null)) ?? [];
/** the record table in force, which a subclass with none of its own shares with its parent */
export const effectiveRecordTable = (name, classes) => nearest(name, classes, (c) => c.record_table ?? null);
/** what can be claimed about it: its own attributes and every ancestor's */
export function effectiveAttributes(name, classes) {
  const confirmed = confirmedClassMap(classes);
  return [...new Set(chainIn(name, confirmed).flatMap((c) => confirmed.get(c).attributes ?? []))];
}

/**
 * The position holding authority over an attribute along a class's chain, or
 * null when no rule applies; the most specific rule first, and on each level
 * the nearest class wins:
 *   1. a rule for the attribute on the class or any ancestor
 *   2. policy.attributes[attribute]
 *   3. a class-wide authority on the class or any ancestor
 *   4. policy.default
 * `attribute` is already normalized. A class moved to a new parent changes its
 * chain, so this answers for the new parent at once. An instance of several
 * classes takes the strictest of each class's answer, which is the caller's
 * to take with positions.commonAncestor.
 */
export function authorityInChain(policy, chain, attribute) {
  const pick = (v) => (typeof v === "string" && v ? v : null);
  const rules = (chain ?? []).map((c) => policy?.classes?.[c]).filter(Boolean);
  if (attribute) {
    for (const r of rules) {
      const v = pick(r.attributes?.[attribute]);
      if (v) return v;
    }
    const v = pick(policy?.attributes?.[attribute]);
    if (v) return v;
  }
  for (const r of rules) {
    const v = pick(r.authority);
    if (v) return v;
  }
  return pick(policy?.default);
}

const tableOwner = (k, confirmed) => {
  for (const c of confirmed.values()) {
    const t = parseTable(c.record_table);
    if (t && t.system === k.system && t.table === k.table) return c;
  }
  return null;
};

/**
 * The gate: no class, no instance. Which confirmed class would make this
 * subject an instance, or why none does. It says nothing about who may mint
 * (a record key, a person or a worker) and looks nothing up: an existing
 * instance found by key or name is already related to its class.
 *
 *   subject   { key?, name?, class?, actor?, scope? }. `class` (or the older
 *             `actor`) is what the subject itself is said to be. A claim's
 *             class is what the claim bears on, and is never defaulted in here.
 *   classes   anything confirmedClassMap reads
 *
 * Returns { class, via: "key" | "class" }, or { class: null, reason, why },
 * reason being "class-subject" (the subject is the class: the claim points at
 * the Class vertex), "no-class" or "no-row" (the last two are what is stored
 * as CLAIMS.unresolved).
 *   key     the confirmed class whose record table holds the key, or the
 *           subclass of it the subject names. Nothing else gives a key a class
 *   class   a confirmed class named for the subject. A root holds no instances
 *           directly. A class with a record table in force needs the row: a
 *           name alone is "no-row" (PO 78912)
 */
export function instanceClass(subject, classes) {
  const confirmed = confirmedClassMap(classes);
  if (subject?.scope === "class") return { class: null, reason: "class-subject", why: "the subject is the class itself" };
  const named = typeof subject?.class === "string" && subject.class.trim() ? subject.class.trim() : typeof subject?.actor === "string" ? subject.actor.trim().toLowerCase() : "";
  const k = parseKey(subject?.key);
  if (k) {
    const owner = tableOwner(k, confirmed);
    if (!owner) return { class: null, reason: "no-class", why: `no confirmed class holds ${k.system}:${k.table}` };
    return { class: named && chainIn(named, confirmed).includes(owner.name) ? named : owner.name, via: "key" };
  }
  if (!named) return { class: null, reason: "no-class", why: "the subject names no class of its own" };
  if (isRoot(named)) return { class: null, reason: "no-class", why: `"${named}" is a primitive: an instance needs a class under it` };
  if (!confirmed.has(named)) return { class: null, reason: "no-class", why: `"${named}" is not a confirmed class` };
  const table = effectiveRecordTable(named, confirmed);
  if (parseTable(table)) return { class: null, reason: "no-row", why: `${named} is recorded in ${table}: a name alone is not a row, it needs the key` };
  return { class: named, via: "class" };
}

/**
 * A class in its contract shape, or a throw naming the field. Lifecycle and
 * uniqueness are the confirm route's; the link is assertSubclassLink's.
 */
export function validateClass(cls) {
  if (typeof cls?.name !== "string" || !cls.name.trim()) throw new Error("name: a class needs one");
  if (isRoot(cls.name)) throw new Error(`name: "${cls.name}" is a primitive, not a class to make`);
  if (typeof cls.parent !== "string" || !cls.parent.trim()) throw new Error("parent: a class sits under exactly one parent, ultimately a primitive");
  const stages = cls.stages ?? [];
  if (!Array.isArray(stages)) throw new Error("stages: must be a list");
  if (cls.record_table !== null && cls.record_table !== undefined && !parseTable(cls.record_table)) throw new Error("record_table: must be system:table, or null");
  return { ...cls, stages };
}

/**
 * Whether `child` may sit under `parent`: when a link is confirmed, and when a
 * class moves. Throws naming what is wrong: a root has no parent, a parent must
 * be confirmed already (a tree is confirmed from the top), and a class can't go
 * under itself or anything under it.
 */
export function assertSubclassLink(child, parent, classes) {
  if (isRoot(child)) throw new Error(`child: "${child}" is a primitive, the root of its tree`);
  const confirmed = confirmedClassMap(classes);
  if (!confirmed.has(parent)) throw new Error(`parent: "${parent}" is not a confirmed class`);
  if (chainIn(parent, confirmed).includes(child)) throw new Error(`parent: "${parent}" is ${child === parent ? "the class itself" : `under "${child}"`}: that would be a cycle`);
  return true;
}

const sqlText = (v) => `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** the four roots, safe to run at every start */
export function rootClassStatements() {
  return PRIMITIVES.map((p) => `UPDATE ${CLASS_TYPE} SET description = ${sqlText(ROOT_DESCRIPTIONS[p])}, stages = [], status = 'confirmed', proposed_by = ${sqlText(BUILTIN)}, confirmed_by = ${sqlText(BUILTIN)} UPSERT WHERE name = ${sqlText(p)}`);
}

const RID = /^#\d+:\d+$/;

/**
 * An entity's edge to one class, for an entity and class that exist (a boot
 * migration, a person or worker adding a class), by rids. Repeating it changes
 * nothing. A mint doesn't use this: it creates the vertex and the edge in one
 * transaction.
 */
export function instanceEdgeSql(entityRid, classRid, { migrated = false } = {}) {
  for (const r of [entityRid, classRid]) if (!RID.test(String(r))) throw new Error(`not a rid: ${r}`);
  return `CREATE EDGE ${INSTANCE_EDGE} FROM ${entityRid} TO ${classRid} IF NOT EXISTS SET instance = '${entityRid}', class_rid = '${classRid}'${migrated ? ", migrated = true" : ""}`;
}

/** the root a class proposed for a legacy `_thing_type` goes under (a person corrects it at confirm) */
const LEGACY_TYPE_ROOT = { person: "actor", position: "actor", customer: "actor", supplier: "actor", agent: "actor", team: "actor", machine: "resource", part: "resource", place: "resource", order: "commitment", project: "commitment" };

/**
 * What one boot's migration does, as data (the caller runs it; nothing here
 * touches a database). Idempotent: an entity that has an edge is left alone,
 * and a class that exists is not made again.
 *
 *   things         [{ rid, label?, _thing_type?, _class?, _keys?, classed? }],
 *                  `classed` true when the entity already has an edge
 *   classes        rows of Class (none on the first boot)
 *   legacyClasses  rows of CommitmentClass
 *
 * Each entity gets one class, surest signal first. A `_class` was stamped from
 * a claim's class, so it only counts where nothing better says what the thing
 * is:
 *   1. a key in the record table of a confirmed class
 *   2. a `_thing_type` that was an actor type (a person stays a person, whatever `_class` says)
 *   3. `_class`, on an entity with a key (its `_thing_type` was only guessed from the table's name)
 *   4. any other `_thing_type` but "thing" and "class"
 *   5. `_class`
 * A `_thing_type` of "class" is the placeholder a class-scope claim was
 * pointed at: its claims move to the Class vertex (`classSubjects`), and it
 * gets no edge. With nothing to go on an entity is `unclassified`, left for a
 * person.
 *
 * Returns { classes, edges, classSubjects, unclassified }. `classes`: new
 * Class rows, CommitmentClass copies with their status under `commitment`, and
 * `proposed` ones for any other name the things use. A migration never
 * confirms a class. An edge whose class is not confirmed is `held: true`: a
 * held entity is not an instance until a person confirms the class.
 * `discarded` on an edge names a signal that lost.
 */
export function planInstanceMigration({ things = [], classes = [], legacyClasses = [] } = {}) {
  const known = new Map(PRIMITIVES.map((p) => [p, rootRow(p)]));
  for (const c of classes) if (c?.name) known.set(c.name, c);
  const added = [];
  const add = (row) => {
    added.push(row);
    known.set(row.name, row);
  };
  for (const c of legacyClasses) {
    if (!c?.name || known.has(c.name)) continue;
    add({ ...c, parent: c.parent ?? "commitment", stages: c.stages ?? [], status: c.status ?? (c.confirmed_by ? "confirmed" : "proposed") });
  }
  const confirmed = confirmedClassMap([...known.values()]);
  const proposedFor = (name, parent) => {
    if (!known.has(name)) add({ name, parent, stages: [], record_table: null, status: "proposed", proposed_by: "migration", reasons: ["named by things already in the graph before classes covered them"] });
    return name;
  };
  const edges = [];
  const classSubjects = [];
  const unclassified = [];
  for (const t of things) {
    if (!t?.rid || t.classed) continue;
    const type = typeof t._thing_type === "string" ? t._thing_type.trim() : "";
    const stamp = typeof t._class === "string" ? t._class.trim() : "";
    if (type === "class") {
      classSubjects.push({ rid: t.rid, class: stamp || null });
      continue;
    }
    const keys = Array.isArray(t._keys) ? t._keys : [];
    const owner = keys.map(parseKey).filter(Boolean).map((k) => tableOwner(k, confirmed)).find(Boolean);
    const usableType = type && type !== "thing";
    let name = null;
    let via = null;
    let lost = [];
    if (owner) {
      name = owner.name;
      via = "key";
      lost = [stamp && stamp !== name ? `_class ${stamp}` : null, usableType && type !== name ? `_thing_type ${type}` : null];
    } else if (ACTOR_TYPES.includes(type)) {
      name = proposedFor(type, "actor");
      via = "type";
      lost = [stamp && stamp !== name ? `_class ${stamp}` : null];
    } else if (stamp && keys.length) {
      name = proposedFor(stamp, "commitment");
      via = "class";
      lost = [usableType && type !== stamp ? `_thing_type ${type}` : null];
    } else if (usableType) {
      name = proposedFor(type, LEGACY_TYPE_ROOT[type] ?? "commitment");
      via = "type";
      lost = [stamp && stamp !== type ? `_class ${stamp}` : null];
    } else if (stamp) {
      name = proposedFor(stamp, "commitment");
      via = "class";
    }
    if (!name) {
      unclassified.push({ rid: t.rid, label: t.label ?? null, reason: "no key, class or type says what it is" });
      continue;
    }
    const discarded = lost.filter(Boolean);
    edges.push({ rid: t.rid, class: name, via, held: !INSTANCE_CLASS_STATUSES.includes(known.get(name)?.status), ...(discarded.length ? { discarded } : {}) });
  }
  return { classes: added, edges, classSubjects, unclassified };
}
