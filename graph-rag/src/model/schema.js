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
//   CommitmentClass (vertex)   a confirmed commitment pattern
//   Entity._class              an instance: a thing of a class, keyed by its record
//   CLAIMS (edge)              section or entry -> subject, one primitive with an interval
//   SourceRef (vertex)         a row in a source system, by key, never copied
//   REFERS_TO (edge)           instance -> SourceRef
//   AuditEvent (vertex)        an agent's write to a source system
//   WROTE (edge)               AuditEvent -> SourceRef
//   Entity._on_record ...      the on-record marker on a document

/** the four primitives a claim can be */
export const CLAIM_KINDS = ["commitment", "event", "state", "observation"];
/** what an actor subject can be (an instance subject names a class instead) */
export const ACTOR_TYPES = ["person", "position", "customer", "supplier", "agent"];
/** a class's life: proposed by discovery or a worker, confirmed by a person, retired by one */
export const CLASS_STATUSES = ["proposed", "confirmed", "retired"];
/** what became of an agent's write to a source system; "attempted": started, its end not yet recorded */
export const AUDIT_OUTCOMES = ["applied", "proposed", "refused", "failed", "attempted"];
/** the attribute every class has: which of its stages an instance is at */
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
  CommitmentClass: {
    kind: "vertex",
    doc: "a confirmed commitment pattern (orders, jobs, hires); the organization's own symbol",
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
      _class: "STRING", // on a thing: the CommitmentClass it is an instance of
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
    doc: "one primitive bound to a subject with an interval; out = the section or entry it was extracted from, in = the subject",
    from: ["Entity:section", "Entity:entry"],
    to: ["Entity:thing"],
    properties: {
      id: "STRING", // unique
      kind: "STRING", // CLAIM_KINDS
      class: "STRING", // CommitmentClass.name
      attribute: "STRING", // snake_case
      value: "STRING", // as stated; numbers and booleans JSON-encoded
      value_num: "DOUBLE", // the number when the value is one
      valid_from: "STRING", // ISO
      valid_until: "STRING", // ISO, or null while open
      recorded_at: "STRING", // ISO
      recorded_by: "STRING", // the person
      closed_by: "STRING", // the id of the claim that closed this one's interval
      _home: "STRING", // seen from here: no lower than the section, raised to the authority position
    },
    indexes: [
      { properties: ["id"], unique: true },
      { properties: ["class", "attribute"], unique: false },
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
    doc: "an instance (or any keyed thing) to the row it stands for",
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
