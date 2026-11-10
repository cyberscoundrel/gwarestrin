import assert from "node:assert/strict";
import { test } from "node:test";
import { briefSource, normalizeSource, writable } from "../src/model/sources.js";

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

test("the write endpoint is never the read endpoint, and actions are create and update only", () => {
  assert.throws(() => normalizeSource({ ...sql, commit: { ...sql.commit, url: sql.read.url } }), /must not be the read endpoint/);
  assert.throws(() => normalizeSource({ ...sql, commit: { ...sql.commit, actions: ["delete"] } }), /some of create, update/);
  assert.throws(() => normalizeSource({ ...sql, system: "bad system" }), /system id/);
});

test("a brief says how a source is committed to, never where it is", () => {
  const b = briefSource(normalizeSource(sql));
  assert.deepEqual(b, { system: "mssql", description: null, commits: true, actions: ["create", "update"], tables: ["dbo_Job"] });
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
