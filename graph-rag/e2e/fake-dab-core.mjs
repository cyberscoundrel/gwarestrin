// A fake DAB's tools, shaped as the pinned DAB 2.0.12 answers them (checked against a running instance's
// tools/list and real calls): the argument names, the error texts, the wrapped results, the cursor. Both
// fake DABs (test/reconcile-data-entry.test.js, e2e/scenarios-reconcile.mjs) call this, so a call the real
// instance would refuse is refused here too.
//
//   tables  { dbo_Job: { primaryKey: ["Job"], rows: [...] } }
//   dabTool(tables, name, args, { write }) -> an MCP tools/call result
//     write: the write-capable instance (the read-only one refuses create and update)

const ok = (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
const err = (toolName, type, message) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ toolName, status: "error", error: { type, message } }) }] });
const needs = (toolName, args, names) => {
  for (const n of names) if (args?.[n] === undefined) return err(toolName, "InvalidArguments", `Missing required argument '${n}'.`);
  return null;
};
const sameKeys = (keys, pk) => Object.keys(keys).length === pk.length && pk.every((c) => c in keys);
const byKey = (keys) => (row) => Object.entries(keys).every(([k, v]) => String(row[k]) === String(v));

/** "Job eq 4471" against the table: a literal must have the column's type, as OData requires */
function filtered(toolName, entity, t, filter) {
  const m = /^(\w+) eq (.+)$/.exec(String(filter));
  if (!m) return { error: err(toolName, "BadRequest", `Could not parse the filter: ${filter}`) };
  const [, col, literal] = m;
  const sample = t.rows[0]?.[col];
  if (!t.rows.some((r) => col in r) && t.rows.length) return { error: err(toolName, "BadRequest", `Could not find a property named '${col}' on type '${entity}'.`) };
  const quoted = /^'.*'$/.test(literal);
  if (t.rows.length && typeof sample === "number" && quoted) return { error: err(toolName, "BadRequest", "A binary operator with incompatible types was detected. Found operand types 'Edm.Int32' and 'Edm.String' for operator kind 'Equal'.") };
  if (t.rows.length && typeof sample === "string" && !quoted) return { error: err(toolName, "BadRequest", "A binary operator with incompatible types was detected. Found operand types 'Edm.String' and 'Edm.Int32' for operator kind 'Equal'.") };
  const v = quoted ? literal.slice(1, -1).replace(/''/g, "'") : literal;
  return { rows: t.rows.filter((r) => String(r[col]) === v) };
}

/** the opaque cursor DAB pages by: base64 JSON naming the primary key columns of the last row returned */
const cursor = (entity, pk, row) => Buffer.from(JSON.stringify(pk.map((c) => ({ EntityName: entity, FieldName: c, FieldValue: row[c], Direction: 0 })))).toString("base64");

export function dabTool(tables, name, args = {}, { write = false } = {}) {
  if (name === "describe_entities") return ok({ entities: Object.keys(tables).map((n) => ({ name: n, description: "", fields: [], permissions: [] })), count: Object.keys(tables).length, status: "success" });
  if (name !== "read_records" && name !== "update_record" && name !== "create_record") return { isError: true, content: [{ type: "text", text: `no tool ${name}` }] };
  const required = needs(name, args, name === "read_records" ? ["entity"] : name === "update_record" ? ["entity", "keys", "fields"] : ["entity", "data"]);
  if (required) return required;
  const t = tables[args.entity];
  if (!t) return err(name, "EntityNotFound", `Entity '${args.entity}' is not defined in the configuration.`);
  if (name === "read_records") {
    if (args.filter !== undefined) {
      const r = filtered(name, args.entity, t, args.filter);
      if (r.error) return r.error;
      return ok({ entity: args.entity, result: { value: r.rows.slice(0, args.first ?? 100) }, message: `Successfully read records for entity '${args.entity}'`, status: "success" });
    }
    const first = args.first ?? 100;
    const page = [...t.rows].sort((a, b) => String(a[t.primaryKey[0]]).localeCompare(String(b[t.primaryKey[0]]))).slice(0, first);
    const result = { value: page };
    if (t.rows.length > first && page.length) result.after = cursor(args.entity, t.primaryKey, page.at(-1));
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
  const key = Object.fromEntries(t.primaryKey.map((c) => [c, args.data[c]]));
  if (t.rows.some(byKey(key))) return err(name, "Error", `Error: Violation of PRIMARY KEY constraint. Cannot insert duplicate key in object '${args.entity}'.`);
  const row = { ...args.data };
  t.rows.push(row);
  return ok({ entity: args.entity, result: { value: [row] }, message: `Successfully created record in entity '${args.entity}'`, status: "success" });
}
