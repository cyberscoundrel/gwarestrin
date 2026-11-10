// The declarations' store (sources.js), and the synthetic test database's data agreeing with the 62 notes
// (test-sql/data.mjs; R9: the notes stay as test input).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { forgetSources, loadSources, testDeclaration } from "../src/sources.js";
import { writable } from "../src/model/sources.js";
import { parseKey } from "../src/model/schema.js";
import { DATABASE, SERVER, TABLES, WRITABLE, entityOf, keyColumn } from "../../test-sql/data.mjs";
import { accessSql, schemaSql } from "../../test-sql/seed.mjs";
import { readConfig, writeConfig } from "../../test-sql/render-dab.mjs";

const stored = (json) => ({ async adbQuery(sql) { return sql.includes("'sources'") && json !== undefined ? [{ json: JSON.stringify(json) }] : []; } });
const ENV = { DAB_SYSTEM: "mssql", DAB_READ_URL: "http://dab:5000/mcp" };

test.beforeEach(() => forgetSources());

test("with nothing stored, the environment declares one source: read only unless a write URL is given", async () => {
  const s = await loadSources(stored(undefined), { env: ENV });
  assert.deepEqual(Object.keys(s), ["mssql"]);
  assert.equal(s.mssql.read.url, "http://dab:5000/mcp");
  assert.equal(s.mssql.read.home, null, "the root");
  assert.equal(s.mssql.commit.via, "none");
  forgetSources();
  const w = await loadSources(stored(undefined), { env: { ...ENV, DAB_WRITE_URL: "http://dab-write:5000/mcp", DAB_WRITE_TABLES: "dbo_Job, dbo_Maintenance", DAB_GUARD_SERVER: "s", DAB_GUARD_DATABASE: "d" } });
  assert.deepEqual(w.mssql.commit.tables, ["dbo_Job", "dbo_Maintenance"]);
  assert.deepEqual([w.mssql.commit.guard.server, w.mssql.commit.guard.database], ["s", "d"]);
});

test("stored declarations win over the environment's, whole: a list, or keyed by system", async () => {
  const decl = testDeclaration();
  const a = await loadSources(stored([decl]), { env: ENV });
  assert.equal(a.mssql.commit.url, "http://dab-write:5000/mcp");
  assert.equal(a.mssql.read.home, "everyone");
  forgetSources();
  const b = await loadSources(stored({ mssql: decl }), { env: ENV });
  assert.deepEqual(b.mssql, a.mssql);
});

test("the older stored shape { system: { read, write } } still loads, with no tables named and no guard", async () => {
  const s = await loadSources(stored({ mssql: { read: "http://r/mcp", write: "http://w/mcp" } }), { env: ENV });
  assert.equal(s.mssql.commit.url, "http://w/mcp");
  assert.equal(s.mssql.commit.guard, null, "no guard: the write adapter writes nothing");
});

test("a stored declaration that doesn't hold leaves that source undeclared, never the environment's in its place", async () => {
  const s = await loadSources(stored([{ system: "mssql", read: { via: "dab-mcp", url: "not a url" } }]), { env: ENV });
  assert.equal(s.mssql, undefined);
});

test("cached a minute; forgetSources reads again", async () => {
  let reads = 0;
  const db = { async adbQuery() { reads++; return []; } };
  await loadSources(db, { env: ENV, now: 1000 });
  await loadSources(db, { env: ENV, now: 2000 });
  assert.equal(reads, 1);
  await loadSources(db, { env: ENV, now: 2000, ttlMs: 0 });
  assert.equal(reads, 2);
});

test("the test declaration: home everyone (test configuration only), the synthetic names in the guard, only the writable tables", () => {
  const d = testDeclaration();
  assert.equal(d.read.home, "everyone");
  assert.deepEqual(d.commit.guard, { server: SERVER, database: DATABASE, login: "gwsynth_write" });
  assert.deepEqual(d.commit.tables.sort(), Object.keys(WRITABLE).map(entityOf).sort());
  assert.equal(writable({ ...d, commit: { ...d.commit, actions: ["create", "update"] } }, "dbo_Customer"), false);
});

// ---- the synthetic database ----

const notes = JSON.parse(readFileSync(new URL("./fixtures/oracle-sixty.json", import.meta.url), "utf8"));
const keysIn = (n) => [n.instance, ...(n.claims ?? []).map((c) => c.subject)].map(parseKey).filter(Boolean);

test("every source key the 62 notes name is a row of the synthetic database", () => {
  const keys = notes.flatMap(keysIn);
  assert.ok(keys.length >= 10, "the notes name keys");
  for (const k of keys) {
    assert.equal(k.system, "mssql", k.key);
    const table = k.table.replace(/^dbo_/, "");
    assert.ok(TABLES[table], `${k.key}: no table ${table}`);
    const col = keyColumn(table);
    assert.ok(TABLES[table].rows.some((r) => String(r[col]) === k.row_key), `${k.key}: no such row`);
  }
});

test("the cases filing should meet are in the data: two Dieps, two forklifts, job 4471 is Toro's PO 4471, 3260357's quantity differs from ux-ab05", () => {
  const dieps = TABLES.Employee.rows.filter((r) => r.First_Name === "Diep");
  assert.deepEqual(dieps.map((r) => [r.Employee, r.Status]).sort(), [["NGDT", "Inactive"], ["NGUD", "Active"]]);
  assert.equal(TABLES.Equipment.rows.filter((r) => /forklift/i.test(r.Description)).length, 2);
  const j4471 = TABLES.Job.rows.find((r) => r.Job === 4471);
  assert.equal(j4471.Customer, "TORO");
  assert.equal(TABLES.Sales_Order.rows.find((r) => r.Sales_Order === j4471.Sales_Order).Customer_PO, "4471");
  assert.notEqual(TABLES.Job.rows.find((r) => r.Job === 3260357).Order_Quantity, 1200);
  for (const name of ["Darrin", "Corvane", "Kayla", "Andre"]) assert.ok(!JSON.stringify(TABLES).includes(name), `${name} has no row`);
});

test("every row holds its table's columns, keys are unique, and nullable columns are the only ones left empty", () => {
  for (const [name, t] of Object.entries(TABLES)) {
    const key = keyColumn(name);
    assert.equal(new Set(t.rows.map((r) => r[key])).size, t.rows.length, `${name}: duplicate key`);
    for (const r of t.rows) {
      assert.deepEqual(Object.keys(r).sort(), t.columns.map((c) => c.name).sort(), `${name}: ${JSON.stringify(r)}`);
      for (const c of t.columns) if (!c.nullable) assert.notEqual(r[c.name], null, `${name}.${c.name} is not nullable`);
    }
  }
});

test("the seed SQL holds no password, and the write login is granted create and update on chosen tables, never delete", () => {
  const access = accessSql();
  assert.ok(!/DELETE/i.test(access.replace(/DROP VIEW/g, "")), "no DELETE grant");
  assert.match(access, /\$\(GWSYNTH_READ_PASSWORD\)/, "the password comes from the container's environment");
  assert.match(access, /GRANT SELECT, UPDATE ON dbo\.\[Job\] TO \[gwsynth_write\]/);
  assert.ok(!/ON dbo\.\[Customer\] TO \[gwsynth_write\]/.test(access));
  assert.throws(() => accessSql(DATABASE, { Job: ["delete"] }), /only create and update/);
  assert.throws(() => accessSql("x]; DROP DATABASE y; --"), /not a plain SQL name/);
  assert.match(schemaSql(), /CREATE TABLE dbo\.\[Job\]/);
});

test("the DAB configs carry no credentials; the write one exposes only the writable tables and the guard's view, never delete", () => {
  const w = writeConfig();
  assert.equal(w["data-source"]["connection-string"], "@env('GWSYNTH_DAB_CONNECTION')");
  assert.deepEqual(Object.keys(w.entities).sort(), [...Object.keys(WRITABLE).map(entityOf), "dbo_GwConnectionIdentity"].sort());
  for (const e of Object.values(w.entities)) assert.ok(!e.permissions[0].actions.some((a) => a.action === "delete"));
  assert.deepEqual(readConfig().autoentities["all-dbo"].permissions[0].actions, [{ action: "read" }]);
});
