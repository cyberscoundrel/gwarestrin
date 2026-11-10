import assert from "node:assert/strict";
import { test } from "node:test";
import { fromStatements, NEW_TYPES, parseKey, parseStatement, parseTable, recordKey, statements, TYPES } from "../src/model/schema.js";

test("the DDL is idempotent and parses back into the exported shapes", () => {
  const list = statements();
  for (const s of list) assert.match(s, /IF NOT EXISTS/, s);
  const back = fromStatements(list);
  for (const [name, t] of Object.entries(TYPES)) {
    assert.equal(back[name].kind, t.kind, name);
    assert.deepEqual(back[name].properties, t.properties, `${name} properties`);
    assert.deepEqual(back[name].indexes, t.indexes, `${name} indexes`);
  }
  assert.deepEqual(Object.keys(back).sort(), Object.keys(TYPES).sort());
  assert.deepEqual(statements(), list, "the same list every time");
});

test("new types come before their properties; Entity is only extended", () => {
  const list = statements();
  for (const name of NEW_TYPES) {
    const decl = list.findIndex((s) => parseStatement(s).op === "type" && parseStatement(s).name === name);
    const firstProp = list.findIndex((s) => s.startsWith(`CREATE PROPERTY ${name}.`));
    assert.ok(decl >= 0, `${name} declared`);
    if (firstProp >= 0) assert.ok(decl < firstProp, `${name} declared before its properties`);
  }
  assert.ok(!list.some((s) => /CREATE (VERTEX|EDGE|DOCUMENT) TYPE Entity\b/.test(s)), "Entity exists already");
  for (const t of ["SUBCLASS_OF", "INSTANCE_OF", "DEPENDS_ON", "ABOUT"]) assert.ok(list.includes(`CREATE EDGE TYPE ${t} IF NOT EXISTS`), t);
  for (const t of ["FilingEntry", "WorkerRequest", "BriefLog"]) assert.ok(list.includes(`CREATE DOCUMENT TYPE ${t} IF NOT EXISTS`), t);
  assert.ok(list.includes("CREATE INDEX IF NOT EXISTS ON Entity (_class_key) UNIQUE"), "class names are unique");
});

test("what the rulings removed is not declared", () => {
  const list = statements().join("\n");
  for (const gone of ["CLAIMS", "SourceRef", "REFERS_TO", "AuditEvent", "WROTE", "CommitmentClass", "Entity._class "]) assert.ok(!list.includes(gone), gone);
});

test("no property is named by, a reserved word in ArcadeDB SQL", () => {
  for (const s of statements()) assert.doesNotMatch(s, /\.by IF NOT EXISTS/, s);
});

test("record keys and tables parse; a class's row key is its table plus the row", () => {
  assert.deepEqual(parseKey("mssql:dbo_Job:4471"), { key: "mssql:dbo_Job:4471", system: "mssql", table: "dbo_Job", row_key: "4471" });
  assert.equal(parseKey("dbo_Job:4471"), null);
  assert.deepEqual(parseTable("mssql:dbo_Order"), { system: "mssql", table: "dbo_Order" });
  assert.equal(recordKey({ record_table: "mssql:dbo_Order" }, "9001"), "mssql:dbo_Order:9001");
  assert.equal(recordKey({ record_table: null }, "1"), null);
});

test("parseStatement refuses anything the module would not emit", () => {
  assert.throws(() => parseStatement("DROP TYPE Entity"), /not a schema statement/);
});
