// Discovery: the first pass over a connected system that drafts commitment
// classes for a person to confirm (docs/ORGANIZATION-MODEL.md, "Classes and
// instances"; the Discovery stream). Classes are discovered, not declared,
// and nothing maps onto one until a person confirms it.
//
// Pure functions over plain objects, no database, no model calls:
//
//   parseDigest(text, system)          the connection digest an agent gets
//                                      (connection-digest.ts) -> tables
//   draftClasses(digest, patterns)     every transaction-shaped table -> a
//                                      `proposed` CommitmentClass in the
//                                      contract's shape; master data -> skipped
//                                      with the reason (actors or resources)
//   discoverIncremental(existing, ...) a new table, or a class a worker
//                                      filed, -> one new draft, or why not
//   classFor(key, classes)             the class a record key maps to:
//                                      confirmed ones only
//
// What the drafts rest on: the digest's table names and column names (never
// row values; a DAB digest declares none), the distinct values of a status-like
// column when the survey read them (`status_values`), and the survey's
// report, which names a class the tables do not record with a tag in its
// text:  [class: hires; stages: opened, interviewing, offered; table: none]
// (the survey brief, pool.js, asks for exactly that; reportDigest takes its
// table lines).
import { CLASS_STATUSES, parseTable, TYPES } from "./model/schema.js";

/** who files a draft: the survey (discovery), a worker, or a person */
export const DISCOVERY = "discovery";

/**
 * The nouns a table name is read against. A transaction table records
 * commitments (one row = one instance); a master-data table records actors or
 * resources (one row = one thing, seeded by key); a lookup table records
 * neither. The bare, singular, lower-cased name is matched (dbo_PurchaseOrder
 * -> "purchase order"), the last word deciding ("sales order" is an order).
 */
export const TRANSACTION_NOUNS = {
  order: "a customer order: a commitment to deliver",
  job: "a production job: a commitment of machine and people time to an order",
  quote: "a quote: a conditional commitment to deliver at a price",
  operation: "an operation: a step of a job committed to a work center",
  po: "a purchase order: a commitment to buy from a vendor",
  "purchase order": "a purchase order: a commitment to buy from a vendor",
  purchase: "a purchase: a commitment to buy from a vendor",
  invoice: "an invoice: a commitment to pay",
  shipment: "a shipment: the delivery a commitment promised",
  delivery: "a delivery: the delivery a commitment promised",
  maintenance: "a maintenance booking: a commitment of a machine's time to a service",
  booking: "a booking: a commitment of time",
  requisition: "a requisition: a commitment to supply internally",
  ticket: "a ticket: a commitment to resolve",
  "work order": "a work order: a commitment of work",
  rma: "a return: a commitment to take goods back",
  return: "a return: a commitment to take goods back",
  hire: "a hire: a commitment of a position to a person",
  contract: "a contract: a standing commitment between parties",
};
/** master data: rows are actors (people, organizations) or resources (what changes hands), seeded as things */
export const MASTER_NOUNS = {
  customer: "actor",
  client: "actor",
  employee: "actor",
  person: "actor",
  worker: "actor",
  operator: "actor",
  user: "actor",
  contact: "actor",
  vendor: "actor",
  supplier: "actor",
  carrier: "actor",
  company: "actor",
  department: "actor",
  team: "actor",
  "work center": "resource",
  workcenter: "resource",
  machine: "resource",
  equipment: "resource",
  tool: "resource",
  part: "resource",
  material: "resource",
  item: "resource",
  product: "resource",
  inventory: "resource",
  location: "resource",
  warehouse: "resource",
  bin: "resource",
  address: "resource",
};
/** lookup and log tables: neither classes nor things */
const LOOKUP_RE = /^(status|state|type|code|category|reason|unit|uom|currency|country|setting|config|log|audit|history|version|sequence|lookup|enum)(es|s)?$/;
/** plural forms that are not the singular plus s */
const UNCOUNTABLE = new Set(["maintenance", "equipment", "inventory", "po", "rma"]);

/** "dbo_PurchaseOrder" -> "purchase order"; "SalesOrders" -> "sales order"; "WorkCenter" -> "work center" */
export function bareName(table) {
  const t = String(table ?? "")
    .replace(/^[a-z0-9]{1,8}_/i, "") // a schema prefix: dbo_, tbl_
    .replace(/^(tbl|tb|t)_?(?=[A-Z])/, "");
  return t
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** "orders" -> "order", "categories" -> "category", "maintenance" -> "maintenance" */
export function singular(word) {
  const w = String(word ?? "").toLowerCase();
  if (UNCOUNTABLE.has(w) || w.length < 4) return w;
  if (/ies$/.test(w)) return w.replace(/ies$/, "y");
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(x|ch|sh|s)es$/.test(w)) return w.replace(/es$/, "");
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** "order" -> "orders", "purchase order" -> "purchase_orders", "maintenance" -> "maintenance" */
export function className(bare) {
  const words = String(bare ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w, i, all) => (i === all.length - 1 ? singular(w) : w));
  if (!words.length) return "";
  const last = words[words.length - 1];
  const plural = UNCOUNTABLE.has(last) ? last : /y$/.test(last) && !/[aeiou]y$/.test(last) ? `${last.slice(0, -1)}ies` : /(s|x|ch|sh)$/.test(last) ? `${last}es` : `${last}s`;
  return [...words.slice(0, -1), plural].join("_").slice(0, 60);
}

/** "DueDate" -> "due_date", "CustomerID" -> "customer", "Qty" -> "quantity" */
export function attributeName(column) {
  const base = String(column ?? "")
    .replace(/_?(id|key|code|no|num|number)$/i, (m, _g, off, s) => (off === 0 ? m : ""))
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return { qty: "quantity", desc: "description", amt: "amount", cust: "customer", emp: "employee" }[base] ?? base.slice(0, 60);
}

/** "In Production" -> "in_production" (a stage, as the contract's claims name them) */
export const stageName = (v) =>
  String(v ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

const STATUS_COL_RE = /(^|_)(status|state|stage|phase|step)(_|$)|(status|state|stage|phase)$/i;
const DATE_COL_RE = /(date|_at|time|due|when|created|closed|shipped|promised)$/i;
const ID_COL_RE = /(id|key|no|num|number|code)$/i;

/** the columns of a table that look like a status, and those that look like a date */
export function statusColumns(columns) {
  return (columns ?? []).filter((c) => STATUS_COL_RE.test(String(c)));
}

/**
 * What kind of table this is, from its name and columns:
 *   { kind: "class" | "master" | "lookup" | "unknown", noun, role?, reasons }
 */
export function classifyTable(table) {
  const bare = bareName(table.name);
  const words = bare.split(" ");
  const last = singular(words[words.length - 1] ?? "");
  const lastTwo = words.length > 1 ? `${words[words.length - 2]} ${last}` : null;
  const reasons = [];
  if (lastTwo && lastTwo in TRANSACTION_NOUNS) return { kind: "class", noun: lastTwo, reasons: [`"${table.name}" names ${lastTwo}s: rows are commitments`] };
  if (lastTwo && lastTwo in MASTER_NOUNS) return { kind: "master", noun: lastTwo, role: MASTER_NOUNS[lastTwo], reasons: [`"${table.name}" is master data: ${lastTwo}s are ${MASTER_NOUNS[lastTwo]}s, seeded as things by key, not a class`] };
  if (last in TRANSACTION_NOUNS) return { kind: "class", noun: last, reasons: [`"${table.name}" names ${UNCOUNTABLE.has(last) ? last : `${last}s`}: rows are commitments`] };
  if (last in MASTER_NOUNS) return { kind: "master", noun: last, role: MASTER_NOUNS[last], reasons: [`"${table.name}" is master data: ${last}s are ${MASTER_NOUNS[last]}s, seeded as things by key, not a class`] };
  if (LOOKUP_RE.test(last)) return { kind: "lookup", noun: last, reasons: [`"${table.name}" is a lookup or log table: neither a class nor a thing`] };
  // no known noun: the columns decide. A status and a date make it transaction-shaped.
  const cols = table.columns ?? [];
  const status = statusColumns(cols);
  const dates = cols.filter((c) => DATE_COL_RE.test(String(c)));
  if (status.length && dates.length) {
    reasons.push(`"${table.name}" has a status column (${status[0]}) and dates (${dates.slice(0, 3).join(", ")}): transaction-shaped`);
    return { kind: "class", noun: last, reasons };
  }
  return { kind: "unknown", noun: last, reasons: [`"${table.name}": no known noun, no status and date columns; left for a person`] };
}

/** the status-like column a class takes its stages from, and the stages when their values are known */
export function draftStages(table) {
  const status = statusColumns(table.columns ?? []);
  if (!status.length) return { column: null, stages: [], reason: "no status-like column: stages to be named by a person" };
  const column = status.find((c) => table.status_values?.[c]?.length) ?? status[0];
  const values = table.status_values?.[column];
  if (!values?.length) return { column, stages: [], reason: `stages come from column ${column}: read its distinct values (aggregate_records, groupby ${column}) to name them` };
  const stages = [];
  for (const v of values) {
    const s = stageName(v);
    if (s && !stages.includes(s)) stages.push(s);
  }
  return { column, stages: stages.slice(0, 20), reason: `stages from the distinct values of ${column}` };
}

/** the attributes a class's claims will carry: stage, then the table's columns, minus its own key and the status column */
export function draftAttributes(table, statusColumn) {
  const own = new Set([String(table.name), bareName(table.name).replace(/\s+/g, ""), singular(bareName(table.name).split(" ").pop() ?? "")].map((s) => s.toLowerCase()));
  const out = ["stage"];
  for (const c of table.columns ?? []) {
    const col = String(c);
    if (col === statusColumn) continue;
    const stem = col.replace(/_?(id|key|no|num|number)$/i, "").toLowerCase();
    if (ID_COL_RE.test(col) && (own.has(stem) || stem === "" || stem === "row" || stem === "record")) continue; // the table's own key
    const a = attributeName(col);
    if (a && !out.includes(a)) out.push(a);
  }
  return out.slice(0, 40);
}

/**
 * The connection digest an agent gets (connection-digest.ts), back into
 * tables. Three line shapes:
 *   Tables (12, all named dbo_…): Customer, Job, Order
 *   dbo_Job columns: JobID, CustomerID, Status, DueDate
 *   - dbo_Customer: Customer, Name, Status, …
 * plus, when the survey counted or read a status column:
 *   dbo_Job rows: 4471
 *   dbo_Job Status values: Planned, Running, Paused, Done
 * Anything else is ignored. `system` is the connection's name (the first
 * part of every key).
 */
export function parseDigest(text, system) {
  const tables = new Map();
  const at = (name) => {
    const n = String(name).trim();
    if (!tables.has(n)) tables.set(n, { name: n, columns: [] });
    return tables.get(n);
  };
  const list = (s) =>
    String(s)
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x && x !== "…" && x !== "...");
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m = /^Tables \((\d+)(?:, all named ([A-Za-z0-9_]+)…?)?\): (.+)$/.exec(line);
    if (m) {
      const prefix = m[2] ?? "";
      for (const n of list(m[3])) at(`${prefix}${n}`);
      continue;
    }
    m = /^([A-Za-z0-9_.]+) columns: (.+)$/.exec(line);
    if (m) {
      at(m[1]).columns = list(m[2]);
      continue;
    }
    m = /^([A-Za-z0-9_.]+) rows: ([\d,]+)$/.exec(line);
    if (m) {
      at(m[1]).rows = Number(m[2].replace(/,/g, ""));
      continue;
    }
    m = /^([A-Za-z0-9_.]+) ([A-Za-z0-9_]+) values: (.+)$/.exec(line);
    if (m) {
      const t = at(m[1]);
      t.status_values = { ...(t.status_values ?? {}), [m[2]]: list(m[3]) };
      if (!t.columns.includes(m[2])) t.columns.push(m[2]);
      continue;
    }
    m = /^- ([A-Za-z0-9_.]+)(?:: (.+))?$/.exec(line);
    if (m && !/^… and \d+ more$/.test(m[1])) {
      const t = at(m[1]);
      if (m[2]) t.columns = list(m[2]);
    }
  }
  return { system: String(system ?? "").trim(), tables: [...tables.values()] };
}

const TAG_RE = /\[class:\s*([^\];]+)(?:;\s*([^\]]*))?\]/gi;

/**
 * The classes a survey's report names: a tag in its text, `[class: hires;
 * stages: opened, interviewing, offered; table: none; description: ...]`.
 * Each becomes a draft the tables could not give (no source system records
 * it), or adds stages and a description to a table's draft of the same name.
 * `patterns` are `{ name, text }`: the report, or entries that carry a tag.
 */
export function patternClasses(patterns, system = "") {
  const out = [];
  for (const p of patterns ?? []) {
    const text = typeof p === "string" ? p : `${p?.text ?? ""}\n${p?.facets?.identity ?? ""}`;
    for (const m of text.matchAll(TAG_RE)) {
      const name = className(m[1].trim());
      if (!name) continue;
      const fields = {};
      let rest = m[2] ?? "";
      // the description comes last and may hold semicolons and colons of its own
      const di = rest.search(/\bdescription\s*:/i);
      if (di >= 0) {
        fields.description = rest.slice(di).replace(/^description\s*:/i, "").trim();
        rest = rest.slice(0, di);
      }
      for (const part of rest.split(";")) {
        const [k, ...v] = part.split(":");
        if (v.length) fields[k.trim().toLowerCase()] = v.join(":").trim();
      }
      const attributes = (fields.attributes ?? "")
        .split(",")
        .map(attributeName)
        .filter(Boolean);
      const stages = (fields.stages ?? "")
        .split(/,|\bor\b/)
        .map(stageName)
        .filter(Boolean);
      const tableField = fields.table && !/^(none|null|-|no)$/i.test(fields.table) ? fields.table : null;
      const record_table = tableField ? (parseTable(tableField) ? tableField : system && parseTable(`${system}:${tableField}`) ? `${system}:${tableField}` : null) : null;
      out.push({
        name,
        description: fields.description ?? null,
        stages: [...new Set(stages)],
        attributes: attributes.length ? ["stage", ...attributes.filter((a) => a !== "stage")] : null,
        record_table,
        source: typeof p === "string" ? null : (p?.name ?? null),
      });
    }
  }
  return out;
}

/** one draft in the contract's shape (schema.js CommitmentClass), status proposed, with its reasons */
export function makeDraft({ name, description, stages, record_table, attributes, proposed_by, reasons }) {
  return {
    name: String(name).slice(0, 60),
    description: description ? String(description).slice(0, 400) : null,
    stages: Array.isArray(stages) ? stages.map(stageName).filter(Boolean).filter((s, i, a) => a.indexOf(s) === i).slice(0, 20) : [],
    record_table: record_table && parseTable(record_table) ? record_table : null,
    status: "proposed",
    proposed_by: proposed_by || DISCOVERY,
    confirmed_by: null,
    confirmed_at: null,
    attributes: Array.isArray(attributes) && attributes.length ? attributes : ["stage"],
    reasons: Array.isArray(reasons) ? reasons.slice(0, 12) : [],
  };
}

/**
 * The first discovery pass over one connected system: a draft class per
 * transaction-shaped table, the master-data tables named as actors or
 * resources, and the classes the survey's pattern entries name that no table
 * records. `digest` is `{ system, tables: [{ name, columns, rows?,
 * status_values? }] }` (parseDigest gives one). Returns `{ drafts, skipped }`;
 * every draft has `status: "proposed"` and nothing here confirms one.
 */
export function draftClasses(digest, patterns = [], { proposed_by = DISCOVERY } = {}) {
  const system = String(digest?.system ?? "").trim();
  const drafts = [];
  const skipped = [];
  const byName = new Map();
  for (const table of digest?.tables ?? []) {
    if (!table?.name) continue;
    const c = classifyTable(table);
    const record_table = system ? `${system}:${table.name}` : null;
    if (c.kind !== "class") {
      skipped.push({ table: table.name, record_table, kind: c.kind, ...(c.role ? { role: c.role } : {}), reasons: c.reasons });
      continue;
    }
    const name = className(bareName(table.name));
    if (byName.has(name)) {
      skipped.push({ table: table.name, record_table, kind: "duplicate", reasons: [`"${table.name}" would also be "${name}", already drafted from ${byName.get(name).record_table}; a person decides which records it`] });
      continue;
    }
    const st = draftStages(table);
    const reasons = [...c.reasons, st.reason];
    if (table.rows !== undefined) reasons.push(`${Number(table.rows).toLocaleString("en-US")} rows: instances, referenced by key, never copied`);
    if (!record_table) reasons.push("the digest names no connection, so the record table is unknown");
    const draft = makeDraft({
      name,
      description: TRANSACTION_NOUNS[c.noun] ?? `${bareName(table.name)}: a commitment recorded in ${table.name}`,
      stages: st.stages,
      record_table,
      attributes: draftAttributes(table, st.column),
      proposed_by,
      reasons,
    });
    drafts.push(draft);
    byName.set(name, draft);
  }
  for (const p of patternClasses(patterns, system)) {
    const have = byName.get(p.name);
    if (have) {
      if (!have.stages.length && p.stages.length) {
        have.stages = p.stages;
        have.reasons.push(`stages from the survey's pattern entry${p.source ? ` "${p.source}"` : ""}`);
      }
      if (!have.description && p.description) have.description = p.description;
      if (p.attributes) for (const a of p.attributes) if (!have.attributes.includes(a)) have.attributes.push(a);
      continue;
    }
    const draft = makeDraft({
      name: p.name,
      description: p.description ?? TRANSACTION_NOUNS[singular(p.name.split("_").pop())] ?? null,
      stages: p.stages,
      record_table: p.record_table,
      attributes: p.attributes ?? ["stage"],
      proposed_by,
      reasons: [
        `named by the survey's pattern entry${p.source ? ` "${p.source}"` : ""}`,
        p.record_table ? `recorded in ${p.record_table}` : "no source system records it: instances are keyed by name, like any thing",
      ],
    });
    drafts.push(draft);
    byName.set(p.name, draft);
  }
  return { drafts, skipped };
}

/** classes as a list, whatever shape they were loaded in (a fixture, a map, rows) */
export function classList(classes) {
  const list = Array.isArray(classes) ? classes : classes?.classes ? classes.classes : Object.values(classes ?? {});
  return list.filter((c) => c && typeof c.name === "string");
}

/** the class a record key or table maps to, among those given: confirmed ones only, by record table */
export function classFor(keyOrTable, classes) {
  const t = parseTable(keyOrTable) ?? (() => {
    const parts = String(keyOrTable ?? "").split(":");
    return parts.length >= 2 ? parseTable(`${parts[0]}:${parts[1]}`) : null;
  })();
  if (!t) return null;
  const table = `${t.system}:${t.table}`;
  return classList(classes).find((c) => c.record_table === table && isConfirmed(c)) ?? null;
}

/** a class by name, confirmed only (what claims and policy may use) */
export function confirmedClass(name, classes) {
  return classList(classes).find((c) => c.name === name && isConfirmed(c)) ?? null;
}

/** a fixture class with no status counts as confirmed when it says who confirmed it */
export const isConfirmed = (c) => c?.status === "confirmed" || (!c?.status && Boolean(c?.confirmed_by));

/**
 * Discovery after the first pass is an event, not a re-run: one new table in
 * the digest, or one `proposed` class a worker filed, gives one new draft, or
 * the reason there is none. `existing` are every class known (any status).
 *   discoverIncremental(existing, { table, system, patterns? })
 *   discoverIncremental(existing, { filed: { name, stages?, record_table?, description?, reasons? }, by })
 * Returns `{ draft }` or `{ draft: null, reason, existing? }`.
 */
export function discoverIncremental(existing, event) {
  const known = classList(existing);
  const byTable = (t) => (t ? known.find((c) => c.record_table === t) : null);
  const byName = (n) => known.find((c) => c.name === n);
  const decline = (reason, match) => ({ draft: null, reason, ...(match ? { existing: { name: match.name, status: match.status ?? (match.confirmed_by ? "confirmed" : "proposed") } } : {}) });

  if (event?.table) {
    const table = typeof event.table === "string" ? { name: event.table, columns: [] } : event.table;
    const system = String(event.system ?? "").trim();
    const record_table = system ? `${system}:${table.name}` : null;
    const have = byTable(record_table);
    if (have) return decline(have.status === "retired" ? `a person retired the class for ${record_table}; it is not drafted again` : `${record_table} is already the record table of "${have.name}"`, have);
    const { drafts, skipped } = draftClasses({ system, tables: [table] }, event.patterns ?? [], { proposed_by: event.by || DISCOVERY });
    if (!drafts.length) return { draft: null, reason: skipped[0]?.reasons?.[0] ?? `${table.name} is not a class`, skipped: skipped[0] ?? null };
    const draft = drafts[0];
    const same = byName(draft.name);
    if (same) {
      if (same.status === "retired") return decline(`a person retired "${same.name}"; it is not drafted again`, same);
      return decline(`"${draft.name}" exists already (${same.record_table ?? "no record table"}); a person decides whether ${record_table} records it too`, same);
    }
    draft.reasons.push("a new table since the last discovery pass");
    return { draft };
  }

  if (event?.filed) {
    const f = event.filed;
    const name = className(f.name ?? "");
    if (!name) return { draft: null, reason: "a filed class needs a name" };
    const shape = classifyTable({ name: name.replace(/_/g, " ") });
    if (shape.kind === "master") return { draft: null, reason: `"${name}" names ${shape.role}s: master data is seeded as things by key, never a class` };
    const same = byName(name);
    if (same) return decline(same.status === "retired" ? `a person retired "${name}"; a worker filing it again changes nothing` : `"${name}" is already ${same.status ?? "confirmed"}`, same);
    const record_table = f.record_table && parseTable(f.record_table) ? f.record_table : null;
    const have = byTable(record_table);
    if (have) return decline(`${record_table} is already the record table of "${have.name}"`, have);
    const by = event.by ? String(event.by) : "worker";
    return {
      draft: makeDraft({
        name,
        description: f.description ?? null,
        stages: f.stages ?? [],
        record_table,
        attributes: f.attributes ?? ["stage"],
        proposed_by: by,
        reasons: [`filed by ${by}: a recurring commitment pattern the graph had not seen`, ...(Array.isArray(f.reasons) ? f.reasons.map(String) : f.reason ? [String(f.reason)] : []), record_table ? `recorded in ${record_table}` : "no source system records it"],
      }),
    };
  }
  return { draft: null, reason: "nothing to discover: give a new table or a filed class" };
}

/**
 * A row of the CommitmentClass vertex (schema.js TYPES.CommitmentClass) from a
 * draft, as the store writes it: the contract's properties, plus `reasons`
 * and `attributes`, which the draft carries and the contract has no property
 * for yet (see the Discovery stream's report). Status is checked against the
 * contract's list.
 */
export function classRow(draft) {
  if (!CLASS_STATUSES.includes(draft.status)) throw new Error(`status must be one of ${CLASS_STATUSES.join(", ")}`);
  const props = Object.keys(TYPES.CommitmentClass.properties);
  const row = {};
  for (const p of props) row[p] = draft[p] === undefined ? null : draft[p];
  row.attributes = Array.isArray(draft.attributes) ? draft.attributes : ["stage"];
  row.reasons = Array.isArray(draft.reasons) ? draft.reasons : [];
  row.occurrences = Array.isArray(draft.occurrences) ? draft.occurrences : [];
  return row;
}

/**
 * The SQL that files one draft as a CommitmentClass vertex, one statement, the
 * way a survey thread writes it through execute_graph (its raw writes are
 * proposals, which an admin applies; that is the filing of a draft, not its
 * confirmation). Status is always 'proposed'.
 */
export function fileDraftSql(draft) {
  const row = classRow({ ...draft, status: "proposed", confirmed_by: null, confirmed_at: null });
  return `INSERT INTO CommitmentClass SET ${Object.entries(row)
    .map(([k, v]) => `${k} = ${sqlLiteral(v)}`)
    .join(", ")}`;
}

/** a value as an ArcadeDB SQL literal: null, a quoted string, or a list of them */
export const sqlLiteral = (v) => (v === null || v === undefined ? "null" : Array.isArray(v) ? `[${v.map(sqlLiteral).join(", ")}]` : `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);

/** the properties this stream adds to the class vertex beyond the contract's: the draft's attributes, its reasons, and the sections that named it (when it came from one at a time) */
export const EXTRA_CLASS_PROPERTIES = { attributes: "LIST", reasons: "LIST", occurrences: "LIST" };

/**
 * The lines of a survey's report that describe a table in the digest's own
 * grammar (parseDigest): columns, row count, a status column's values. Only
 * those: a report's free bullets ("- Jobs: 31k open") would read as tables.
 */
const REPORT_TABLE_LINE = /^[A-Za-z0-9_.]+ (?:columns: .+|rows: [\d,]+|[A-Za-z0-9_]+ values: .+)$/;
export function reportDigest(report) {
  return String(report ?? "")
    .split("\n")
    .map((l) => l.trim().replace(/^[-*]\s+/, "").replace(/`/g, "").trim())
    .filter((l) => REPORT_TABLE_LINE.test(l))
    .join("\n");
}
