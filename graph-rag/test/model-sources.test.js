import assert from "node:assert/strict";
import { test } from "node:test";
import { briefSource, normalizeSource, tableShape, writable } from "../src/model/sources.js";

const sql = { system: "mssql", read: { via: "dab-mcp", url: "http://dab:5000/mcp" }, commit: { via: "dab-mcp", url: "http://dab-write:5000/mcp", tables: ["dbo_Job"] } };

test("a source declares how it is read and committed to (R2)", () => {
  const s = normalizeSource(sql);
  assert.deepEqual(s.commit.actions, ["create", "update"], "never delete");
  assert.equal(writable(s, "dbo_Job"), true);
  assert.equal(writable(s, "dbo_Employee"), false, "only the tables it grants");
  assert.equal(writable(s, "dbo_Job", "delete"), false);
});

test("a source with no commit is not writable: a clear piece is Proposed", () => {
  const s = normalizeSource({ ...sql, commit: undefined });
  assert.equal(s.commit.via, "none");
  assert.equal(writable(s, "dbo_Job"), false);
});

test("the write endpoint is never the read endpoint; actions are create and update, and delete only beside a table that takes new rows (R19)", () => {
  assert.throws(() => normalizeSource({ ...sql, commit: { ...sql.commit, url: sql.read.url } }), /must not be the read endpoint/);
  assert.throws(() => normalizeSource({ ...sql, commit: { ...sql.commit, actions: ["drop"] } }), /some of create, update, delete/);
  assert.throws(() => normalizeSource({ ...sql, commit: { ...sql.commit, actions: ["create", "update", "delete"] } }), /delete only undoes a row graph-rag added/);
  assert.throws(() => normalizeSource({ ...sql, commit: { ...sql.commit, tables: [{ name: "dbo_M", adds: true }], actions: ["update"] } }), /needs create among the actions/);
  const adds = normalizeSource({ ...sql, commit: { ...sql.commit, tables: ["dbo_Job", { name: "dbo_M", adds: true, columns: { Done: "boolean", Status: { values: ["Open", "Closed"] } }, required: ["Status"] }], actions: ["create", "update", "delete"] } });
  assert.deepEqual(adds.commit.tables, ["dbo_Job", "dbo_M"]);
  assert.deepEqual([writable(adds, "dbo_M", "create"), writable(adds, "dbo_Job", "create"), writable(adds, "dbo_M", "delete"), writable(adds, "dbo_Job", "delete"), writable(adds, "dbo_Job", "update")], [true, false, true, false, true], "create and delete only where the table takes new rows");
  assert.deepEqual(tableShape(adds, "dbo_M").columns, { Done: { type: "boolean" }, Status: { values: ["Open", "Closed"] } });
  assert.deepEqual(tableShape(adds, "dbo_Job"), { name: "dbo_Job", adds: false, columns: {}, required: [], defaults: [] });
  assert.throws(() => normalizeSource({ ...sql, commit: { ...sql.commit, tables: [{ name: "dbo_M", columns: { Status: "fixed" } }] } }), /must be "boolean", \{ values: \[..\] \} or \{ references/);
  assert.throws(() => normalizeSource({ ...sql, system: "bad system" }), /system id/);
});

test("a brief says how a source is committed to, never where it is", () => {
  const b = briefSource(normalizeSource(sql));
  assert.deepEqual(b, { system: "mssql", description: null, commits: true, actions: ["create", "update"], tables: ["dbo_Job"], adds: [] });
  assert.ok(!JSON.stringify(b).includes("http"));
});

test("a connection's home defaults to the root (null), the strictest; a declaration may name one (R11.9)", () => {
  assert.equal(normalizeSource(sql).read.home, null, "no home declared: the root");
  assert.equal(normalizeSource({ ...sql, read: { ...sql.read, home: "everyone" } }).read.home, "everyone");
  assert.throws(() => normalizeSource({ ...sql, read: { ...sql.read, home: "" } }), /read.home/);
  assert.throws(() => normalizeSource({ ...sql, read: { ...sql.read, home: 7 } }), /read.home/);
});

test("a commit side names the server and database its guard expects; a brief never shows them", () => {
  const s = normalizeSource({ ...sql, commit: { ...sql.commit, guard: { server: "gwsynth-sql", database: "GwSynthMfg" } } });
  assert.deepEqual(s.commit.guard, { server: "gwsynth-sql", database: "GwSynthMfg", entity: "dbo_GwConnectionIdentity" });
  assert.equal(normalizeSource(sql).commit.guard, null, "no guard declared: the write adapter writes nothing");
  assert.throws(() => normalizeSource({ ...sql, commit: { ...sql.commit, guard: { server: "x" } } }), /commit.guard.database/);
  assert.throws(() => normalizeSource({ ...sql, commit: { ...sql.commit, guard: { database: "x" } } }), /commit.guard.server/);
  assert.ok(!JSON.stringify(briefSource(s)).includes("gwsynth"), "the guard's names stay out of briefs");
});
