// A fake DAB's tools, shaped as the pinned DAB 2.0.12 answers them. They were checked against a running instance's
// tools/list and real calls, last against the synthetic test SQL Server (test-sql/, 2026-11-09): the argument names,
// the error texts, the wrapped results, the cursor, the filter grammar. The unit tests (test/data-entry.test.js)
// and the replay harness call this, so a call the real instance would refuse is refused here too.
//
//   tables  { dbo_Job: { primaryKey: ["Job"], identity?: true, rows: [...] } }
//           identity: the server makes the key (an IDENTITY column), so a create may not give it
//   dabTool(tables, name, args, { write }) -> an MCP tools/call result
//     write: the write-capable instance (the read-only one refuses create and update; neither deletes)
//
// What DAB 2.0.12 does that this keeps:
//   - a filter is `col op literal` joined by `and` / `or`, with op one of eq ne gt ge lt le; no string functions
//     (contains, startswith: "$filter query parameter is not well formed.")
//   - text compares case-insensitively (SQL Server's default collation); a literal must have the column's type
//   - update_record answers with the row itself under `result`; create_record with `result.value: [row]`

const ok = (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
const err = (toolName, type, message) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ toolName, status: "error", error: { type, message } }) }] });
const needs = (toolName, args, names) => {
  for (const n of names) if (args?.[n] === undefined) return err(toolName, "InvalidArguments", `Missing required argument '${n}'.`);
  return null;
};
const sameKeys = (keys, pk) => Object.keys(keys).length === pk.length && pk.every((c) => c in keys);
const byKey = (keys) => (row) => Object.entries(keys).every(([k, v]) => String(row[k]) === String(v));
const NOT_WELL_FORMED = "$filter query parameter is not well formed.";

/** two values in SQL Server's order: numbers by value, text case-insensitively */
function compare(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""), "en", { sensitivity: "base" });
}
const OPS = { eq: (c) => c === 0, ne: (c) => c !== 0, gt: (c) => c > 0, ge: (c) => c >= 0, lt: (c) => c < 0, le: (c) => c <= 0 };

/** one `col op literal`, as a test over a row, or an error result */
function condition(toolName, entity, t, text) {
  const m = /^\s*(\w+)\s+(eq|ne|gt|ge|lt|le)\s+('(?:[^']|'')*'|-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return { error: err(toolName, "BadRequest", NOT_WELL_FORMED) };
  const [, col, op, literal] = m;
  if (t.rows.length && !t.rows.some((r) => col in r)) return { error: err(toolName, "BadRequest", `Could not find a property named '${col}' on type 'default_namespace.${entity}.dbo.${entity.replace(/^dbo_/, "")}'.`) };
  const quoted = literal.startsWith("'");
  const sample = t.rows.find((r) => r[col] !== null && r[col] !== undefined)?.[col];
  if (typeof sample === "number" && quoted) return { error: err(toolName, "BadRequest", "A binary operator with incompatible types was detected. Found operand types 'Edm.Int32' and 'Edm.String' for operator kind 'Equal'.") };
  if (typeof sample === "string" && !quoted) return { error: err(toolName, "BadRequest", "A binary operator with incompatible types was detected. Found operand types 'Edm.String' and 'Edm.Int32' for operator kind 'Equal'.") };
  const v = quoted ? literal.slice(1, -1).replace(/''/g, "'") : Number(literal);
  return { test: (r) => r[col] !== null && r[col] !== undefined && OPS[op](compare(r[col], v)) };
}

/** a filter of conditions joined by `and` and `or` (and binds tighter), as DAB parses its OData subset */
function filtered(toolName, entity, t, filter) {
  const ors = [];
  for (const part of String(filter).split(/\s+or\s+/)) {
    const ands = [];
    for (const c of part.split(/\s+and\s+/)) {
      const r = condition(toolName, entity, t, c);
      if (r.error) return r;
      ands.push(r.test);
    }
    ors.push((row) => ands.every((f) => f(row)));
  }
  return { rows: t.rows.filter((row) => ors.some((f) => f(row))) };
}

/** the opaque cursor DAB pages by: base64 JSON naming the primary key columns of the last row returned */
const cursor = (entity, pk, row) => Buffer.from(JSON.stringify(pk.map((c) => ({ EntityName: entity, FieldName: c, FieldValue: row[c], Direction: 0 })))).toString("base64");

function ordered(rows, t, orderby) {
  const keys = (Array.isArray(orderby) && orderby.length ? orderby : t.primaryKey.map((c) => `${c} asc`)).map((o) => o.trim().split(/\s+/));
  return [...rows].sort((a, b) => {
    for (const [c, dir = "asc"] of keys) {
      const d = compare(a[c], b[c]);
      if (d) return dir.toLowerCase() === "desc" ? -d : d;
    }
    return 0;
  });
}

const selected = (row, select) => (select ? Object.fromEntries(String(select).split(",").map((c) => c.trim()).filter((c) => c in row).map((c) => [c, row[c]])) : { ...row });

export function dabTool(tables, name, args = {}, { write = false } = {}) {
  if (name === "describe_entities") return ok({ entities: Object.keys(tables).map((n) => ({ name: n, description: "", fields: [], permissions: [] })), count: Object.keys(tables).length, status: "success" });
  if (name === "delete_record") return err(name, "PermissionDenied", `Permission denied for delete on entity '${args.entity}'. You do not have permission to perform Delete operation for this entity.`);
  if (name !== "read_records" && name !== "update_record" && name !== "create_record") return { isError: true, content: [{ type: "text", text: `no tool ${name}` }] };
  const required = needs(name, args, name === "read_records" ? ["entity"] : name === "update_record" ? ["entity", "keys", "fields"] : ["entity", "data"]);
  if (required) return required;
  const t = tables[args.entity];
  if (!t) return err(name, "EntityNotFound", `Entity '${args.entity}' is not defined in the configuration.`);
  if (name === "read_records") {
    let rows = t.rows;
    if (args.filter !== undefined && args.filter !== "") {
      const r = filtered(name, args.entity, t, args.filter);
      if (r.error) return r.error;
      rows = r.rows;
    }
    const first = args.first ?? 100;
    const page = ordered(rows, t, args.orderby).slice(0, first);
    const result = { value: page.map((r) => selected(r, args.select)) };
    if (rows.length > first && page.length) result.after = cursor(args.entity, t.primaryKey, page.at(-1));
    return ok({ entity: args.entity, result, message: `Successfully read records for entity '${args.entity}'`, status: "success" });
  }
  if (!write) return err(name, "PermissionDenied", `Permission denied for ${name === "update_record" ? "update" : "create"} on entity '${args.entity}'. You do not have permission to perform ${name === "update_record" ? "Update" : "Create"} operation for this entity.`);
  if (name === "update_record") {
    if (!sameKeys(args.keys, t.primaryKey)) return err(name, "UnexpectedError", "Primary key column(s) provided do not match DB schema.");
    const row = t.rows.find(byKey(args.keys));
    if (!row) return err(name, "InvalidArguments", "No record found with the given key.");
    const bad = Object.keys(args.fields).some((c) => !(c in row) || t.primaryKey.includes(c));
    if (bad) return err(name, "UnexpectedError", "Invalid request body. Either insufficient or extra fields supplied.");
    Object.assign(row, args.fields);
    return ok({ entity: args.entity, result: { ...row }, message: `Successfully updated record in entity '${args.entity}'`, status: "success" });
  }
  if (t.identity) {
    const given = t.primaryKey.find((c) => c in args.data);
    if (given) return err(name, "ValidationFailed", `Request validation failed: Field '${given}' cannot be included in the request body.`);
    const next = Math.max(0, ...t.rows.map((r) => Number(r[t.primaryKey[0]]) || 0)) + 1;
    const row = { [t.primaryKey[0]]: next, ...args.data };
    t.rows.push(row);
    return ok({ entity: args.entity, result: { value: [{ ...row }] }, message: `Successfully created record in entity '${args.entity}'`, status: "success" });
  }
  const key = Object.fromEntries(t.primaryKey.map((c) => [c, args.data[c]]));
  if (t.rows.some(byKey(key))) return err(name, "Error", `Error: Violation of PRIMARY KEY constraint. Cannot insert duplicate key in object '${args.entity}'.`);
  const row = { ...args.data };
  t.rows.push(row);
  return ok({ entity: args.entity, result: { value: [row] }, message: `Successfully created record in entity '${args.entity}'`, status: "success" });
}
