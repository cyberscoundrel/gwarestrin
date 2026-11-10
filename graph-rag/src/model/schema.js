// The organization model's storage shape (docs/ORGANIZATION-MODEL.md): the ArcadeDB types and edges as
// data, and the idempotent DDL that declares them. Nothing here talks to a database; server.js runs
// `statements()` through `adbCommand` at every start (each statement `IF NOT EXISTS`, safe to repeat).
//
//   Entity (vertex)        the one node type: documents, sections, instances, classes (`_kind`)
//     _kind 'class'        a class (classes.js): scoped by `_home` like any node (earlier ruling)
//     on-record marker     a document a person put on record (record.js)
//   SUBCLASS_OF (edge)     class -> parent class; a class may have several (R9)
//   INSTANCE_OF (edge)     instance -> class; one per class, an instance may have several
//   DEPENDS_ON (edge)      instance -> the instance it depends on, stated by a person, record or agent (R1)
//   ABOUT (edge)           section -> instance: sections relate to instances (R2)
//   FilingEntry (document) the filing log (filing.js); outside the graph: no edges, no graph read (R9)
//   WorkerRequest (document) a worker's request of the orchestrator (filing.js, R10)
//   BriefLog (document)    every brief as sent to a worker, for the leak gate (docs/build/integrate.md, 2.6)
//   DiscoveryRun (document) a discovery run and the tables it examined (classes.js, R9)
//
// Gone (R2, R3, R9): CLAIMS, SourceRef, REFERS_TO, AuditEvent, WROTE, CommitmentClass.

/**
 * A connected-system key: `system:table:row` (`mssql:dbo_Customer:TORO`). A class's record table is the
 * first two parts (`mssql:dbo_Order`); a row's key is that plus its row key. A section stores a
 * transactional row's key; there are no per-row reference nodes (R3).
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

/** the key of one row of a class's record table; null when the class has no record table */
export function recordKey(cls, rowKey) {
  const t = parseTable(cls?.record_table);
  const row = String(rowKey ?? "").trim();
  if (!t || !row) return null;
  const key = `${t.system}:${t.table}:${row}`;
  return parseKey(key) ? key : null;
}

/**
 * The types, as data. `kind`: vertex | edge | document | property-set (properties added to a type that
 * exists). `properties`: name -> ArcadeDB type. Edge types list `from` and `to` as documentation;
 * ArcadeDB does not constrain them. `by` is a reserved word in ArcadeDB SQL: no property is named so.
 */
export const TYPES = {
  Entity: {
    kind: "property-set",
    doc: "what the model adds to the node type: classes and the on-record marker",
    properties: {
      _class_name: "STRING", // a class: its name as given
      _class_key: "STRING", // a class: its name as an identity (classes.js classKey), unique
      _description: "STRING",
      _evidence: "STRING", // JSON: [evidence] (classes.js normalizeEvidence)
      _rows_are_nodes: "BOOLEAN", // R3: does each row of its table become an instance node
      _record_table: "STRING", // system:table, or null when no source holds it
      _stages: "LIST", // commitment classes only, optional (R11)
      _status: "STRING", // active | retired (R11: a retired class never returns on its own)
      _corrections: "STRING", // a class: JSON, the people's corrections kept on it (classes.js, R11)
      _run: "STRING", // a class or instance a discovery run wrote: the run's id, so what a run wrote can be found
      _mirror: "STRING", // a class or instance the store mirrors: position:<id> (R6) or an AI agent's key (R1); only the sync changes it
      _mint: "STRING", // an instance: a token only it has, so the store finds the node it just made (instances.js)
      _discovery_home: "STRING", // a discovery part's task entry: the home its worker reads as (R11.6)
      _discovery_run: "STRING", // a task entry that is a part of a discovery run (its worker is held to the discovery tools)
      _on_record: "BOOLEAN", // a document: a person put it on record
      _recorded_by: "STRING",
      _recorded_at: "STRING",
      _record_position: "STRING", // where its sections start (R11)
      _record_reason: "STRING",
    },
    // a class name is unique in the organization (model/classes.js NAMES_UNIQUE): only the orchestrator, which
    // sees every home, makes classes; the index also keeps concurrent seeding to one copy of each root
    indexes: [{ properties: ["_class_key"], unique: true }],
  },
  SUBCLASS_OF: {
    kind: "edge",
    doc: "a class to one of its parents; several parents allowed (R9)",
    from: ["Entity:class"],
    to: ["Entity:class"],
    properties: { added_by: "STRING", at: "STRING", evidence: "STRING" },
    indexes: [],
  },
  INSTANCE_OF: {
    kind: "edge",
    doc: "an instance to a class it is an instance of; one edge per class",
    from: ["Entity"],
    to: ["Entity:class"],
    properties: { added_by: "STRING", at: "STRING", home: "STRING" }, // home: what states the link (instances.js linkHome)
    indexes: [],
  },
  DEPENDS_ON: {
    kind: "edge",
    doc: "an instance to the instance it depends on (R1); visible only to someone who sees both ends (R11)",
    from: ["Entity"],
    to: ["Entity"],
    properties: { stated_as: "STRING", stated_by: "STRING", source: "STRING", note: "STRING", stated_at: "STRING", valid_from: "STRING", valid_until: "STRING", home: "STRING" },
    indexes: [],
  },
  ABOUT: {
    kind: "edge",
    doc: "a section to an instance it is about (R2: sections relate to instances)",
    from: ["Entity:section"],
    to: ["Entity"],
    properties: { role: "STRING" },
    indexes: [],
  },
  FilingEntry: {
    kind: "document",
    doc: "the filing log: one entry per piece (filing.js normalizeEntry); not part of the graph",
    properties: {
      id: "STRING",
      outcome: "STRING",
      record: "STRING",
      section: "STRING",
      home: "STRING",
      piece: "STRING",
      class: "STRING",
      instances: "LIST",
      target: "STRING", // JSON
      recorder: "STRING",
      worker: "STRING",
      reason: "STRING",
      pending_id: "STRING",
      question: "STRING",
      request: "STRING",
      account: "STRING", // JSON
      verdict: "STRING", // JSON
      refiled_from: "STRING",
      at: "STRING",
    },
    indexes: [
      { properties: ["id"], unique: true },
      { properties: ["record"], unique: false },
      { properties: ["outcome"], unique: false },
    ],
  },
  BriefLog: {
    kind: "document",
    doc: "every brief as it was sent to a worker (brief.js scopeBrief's output, verbatim), so the leak gate can scan it (docs/build/integrate.md, 2.6); not part of the graph",
    properties: {
      id: "STRING",
      record: "STRING", // the document's record id
      audience: "STRING", // the home the brief is for
      worker: "STRING",
      brief: "STRING", // JSON: the brief exactly as sent
      dropped: "STRING", // JSON: scopeBrief's counts of what it left out
      at: "STRING",
    },
    indexes: [
      { properties: ["id"], unique: true },
      { properties: ["record"], unique: false },
    ],
  },
  DiscoveryRun: {
    kind: "document",
    doc: "a discovery run (classes.js): who started it, and every table it examined, so a rerun reads only new ones (R9)",
    properties: { id: "STRING", started_by: "STRING", started_at: "STRING", focus: "STRING", examined: "LIST" },
    indexes: [{ properties: ["id"], unique: true }],
  },
  WorkerRequest: {
    kind: "document",
    doc: "a worker's request of the orchestrator (filing.js normalizeRequest)",
    properties: {
      id: "STRING",
      kind: "STRING",
      record: "STRING",
      section: "STRING",
      home: "STRING",
      worker: "STRING",
      question: "STRING",
      suggestion: "STRING",
      status: "STRING",
      answer: "STRING",
      answered_by: "STRING",
      at: "STRING",
    },
    indexes: [
      { properties: ["id"], unique: true },
      { properties: ["status"], unique: false },
    ],
  },
};

/** the types this module declares from nothing (not the property sets on existing ones) */
export const NEW_TYPES = Object.entries(TYPES)
  .filter(([, t]) => t.kind !== "property-set")
  .map(([name]) => name);

const CREATE = { vertex: "VERTEX", edge: "EDGE", document: "DOCUMENT" };

/** the DDL, in order, every statement idempotent (`IF NOT EXISTS`) */
export function statements(types = TYPES) {
  const out = [];
  for (const [name, t] of Object.entries(types)) {
    if (CREATE[t.kind]) out.push(`CREATE ${CREATE[t.kind]} TYPE ${name} IF NOT EXISTS`);
    for (const [prop, type] of Object.entries(t.properties)) out.push(`CREATE PROPERTY ${name}.${prop} IF NOT EXISTS ${type}`);
    for (const ix of t.indexes) out.push(`CREATE INDEX IF NOT EXISTS ON ${name} (${ix.properties.join(", ")}) ${ix.unique ? "UNIQUE" : "NOTUNIQUE"}`);
  }
  return out;
}

const TYPE_RE = /^CREATE (VERTEX|EDGE|DOCUMENT) TYPE ([A-Za-z_]\w*) IF NOT EXISTS$/;
const PROP_RE = /^CREATE PROPERTY ([A-Za-z_]\w*)\.([A-Za-z_]\w*) IF NOT EXISTS (STRING|BOOLEAN|DOUBLE|INTEGER|LONG|LIST|MAP)$/;
const INDEX_RE = /^CREATE INDEX IF NOT EXISTS ON ([A-Za-z_]\w*) \(([A-Za-z_]\w*(?:, [A-Za-z_]\w*)*)\) (UNIQUE|NOTUNIQUE)$/;

/** one statement back into data; throws on anything this module would not emit */
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
