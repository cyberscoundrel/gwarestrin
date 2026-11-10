import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTOR_TYPES,
  CLAIM_KINDS,
  fromStatements,
  NEW_TYPES,
  parseKey,
  parseStatement,
  parseTable,
  recordKey,
  statements,
  TYPES,
} from "../src/model/schema.js";

test("the DDL is idempotent and parses back into the exported shapes", () => {
  const list = statements();
  assert.ok(list.length > 30);
  for (const s of list) assert.match(s, /IF NOT EXISTS/, s);
  const back = fromStatements(list);
  for (const [name, t] of Object.entries(TYPES)) {
    assert.equal(back[name].kind, t.kind, name);
    assert.deepEqual(back[name].properties, t.properties, `${name} properties`);
    assert.deepEqual(back[name].indexes, t.indexes, `${name} indexes`);
  }
  assert.deepEqual(Object.keys(back).sort(), Object.keys(TYPES).sort());
});

test("new types are declared before their properties; Entity is only extended", () => {
  const list = statements();
  for (const name of NEW_TYPES) {
    const decl = list.findIndex((s) => parseStatement(s).op === "type" && parseStatement(s).name === name);
    const firstProp = list.findIndex((s) => s.startsWith(`CREATE PROPERTY ${name}.`));
    assert.ok(decl >= 0, `${name} declared`);
    if (firstProp >= 0) assert.ok(decl < firstProp, `${name} declared before its properties`);
  }
  assert.ok(!list.some((s) => /CREATE (VERTEX|EDGE) TYPE Entity\b/.test(s)), "Entity exists already: never redeclared");
  assert.ok(list.includes("CREATE PROPERTY Entity._class IF NOT EXISTS STRING"));
  assert.ok(list.includes("CREATE PROPERTY Entity._on_record IF NOT EXISTS BOOLEAN"));
  assert.ok(list.includes("CREATE EDGE TYPE CLAIMS IF NOT EXISTS"));
  assert.ok(list.includes("CREATE INDEX IF NOT EXISTS ON SourceRef (key) UNIQUE"));
  assert.ok(list.includes("CREATE INDEX IF NOT EXISTS ON CLAIMS (class, attribute) NOTUNIQUE"));
});

test("the statement shapes match what server.js emits today", () => {
  assert.deepEqual(parseStatement("CREATE EDGE TYPE SOURCED_FROM IF NOT EXISTS"), { op: "type", kind: "edge", name: "SOURCED_FROM" });
  assert.deepEqual(parseStatement("CREATE PROPERTY Entity._keys IF NOT EXISTS LIST"), { op: "property", type: "Entity", name: "_keys", dataType: "LIST" });
  assert.deepEqual(parseStatement("CREATE INDEX IF NOT EXISTS ON ReadMark (who, pos) UNIQUE"), { op: "index", type: "ReadMark", properties: ["who", "pos"], unique: true });
  assert.throws(() => parseStatement("DROP TYPE Entity"), /not a schema statement/);
  assert.throws(() => parseStatement("CREATE PROPERTY Entity.x STRING"), /not a schema statement/, "nothing without IF NOT EXISTS");
});

test("a claim carries every field the design names, a class its stages and record table", () => {
  for (const f of ["kind", "class", "attribute", "value", "valid_from", "valid_until", "recorded_at", "recorded_by"]) assert.ok(f in TYPES.CLAIMS.properties, f);
  for (const f of ["name", "stages", "record_table", "confirmed_by", "confirmed_at"]) assert.ok(f in TYPES.CommitmentClass.properties, f);
  for (const f of ["key", "system", "table", "row_key", "last_seen"]) assert.ok(f in TYPES.SourceRef.properties, f);
  for (const f of ["key", "authorized_by", "position", "at", "change"]) assert.ok(f in TYPES.AuditEvent.properties, f);
  for (const f of ["_recorded_by", "_record_position", "_record_reason"]) assert.ok(f in TYPES.Entity.properties, f);
  assert.deepEqual(CLAIM_KINDS, ["commitment", "event", "state", "observation"]);
  assert.ok(ACTOR_TYPES.includes("person") && ACTOR_TYPES.includes("position"));
});

test("record keys follow the _keys convention: system:table:row", () => {
  assert.deepEqual(parseKey("mssql:dbo_Customer:TORO"), { key: "mssql:dbo_Customer:TORO", system: "mssql", table: "dbo_Customer", row_key: "TORO" });
  assert.equal(parseKey("mssql:dbo_Job:4471").row_key, "4471");
  assert.equal(parseKey("Job 4471"), null);
  assert.equal(parseKey("mssql:dbo_Job"), null, "a table is not a row");
  assert.deepEqual(parseTable("mssql:dbo_Job"), { system: "mssql", table: "dbo_Job" });
  assert.equal(parseTable("mssql:dbo_Job:4471"), null);
  assert.equal(recordKey({ record_table: "mssql:dbo_Job" }, 4471), "mssql:dbo_Job:4471");
  assert.equal(recordKey({ record_table: null }, 4471), null, "a class with no record table keys nothing");
  assert.equal(recordKey({ record_table: "mssql:dbo_Job" }, " "), null);
});
