import assert from "node:assert/strict";
import { test } from "node:test";
import { auditEvent, ensureAuditSchema, ensureSourceRef, listAuditEvents, recordAuditEvent, referTo, settleAuditEvent, sourceRef } from "../src/audit.js";

// SourceRef rows are written by the Admission stream's sourceref.js; a checkout without it skips what stores them
export const storing = await import("../src/sourceref.js").then(() => false, () => "needs sourceref.js (the Admission stream's) in src");
import { AUDIT_OUTCOMES } from "../src/model/schema.js";

/** a fake ArcadeDB: SourceRef and AuditEvent rows, WROTE edges, the statements it saw */
export function fakeDb() {
  const refs = [];
  const events = [];
  const edges = [];
  const statements = [];
  let rid = 1;
  const db = {
    refs,
    events,
    edges,
    statements,
    async adbCommand(sql, _lang, params = {}) {
      statements.push(sql);
      // SourceRef rows as sourceref.js (the Admission stream's) writes them
      if (sql.startsWith("CREATE VERTEX SourceRef")) {
        refs.push({ rid: `#10:${rid++}`, key: params.key, system: params.system, table: params.table, row_key: params.row_key, last_seen: params.last_seen, seen_by: params.seen_by });
        return [{ count: 1 }];
      }
      if (sql.startsWith("UPDATE SourceRef")) {
        const r = refs.find((x) => x.key === params.k);
        if (r) Object.assign(r, { last_seen: params.last_seen, seen_by: params.seen_by });
        return [{ count: r ? 1 : 0 }];
      }
      if (sql.startsWith("CREATE VERTEX AuditEvent")) {
        if (db.failCreate?.(params)) throw new Error("audit store down");
        events.push({ rid: `#11:${rid++}`, id: params.id, key: params.key, authorized_by: params.auth, acted_by: params.acted, position: params.pos, at: params.at, change: params.change, outcome: params.outcome, pending_id: params.pending });
        return [{ count: 1 }];
      }
      if (sql.startsWith("UPDATE AuditEvent SET outcome")) {
        if (db.failSettle?.(sql, params)) throw new Error("audit store down");
        // a settle by id (the attempt's own end), a proposal's rejection, or a proposal taken on by its approver
        if (params.id) {
          const hit = events.filter((e) => e.id === params.id);
          for (const e of hit) Object.assign(e, { outcome: params.o, change: params.c });
          return [{ count: hit.length }];
        }
        const hit = events.filter((e) => e.pending_id === params.p && e.outcome === "proposed");
        for (const e of hit) Object.assign(e, sql.includes("'attempted'") ? { outcome: "attempted", authorized_by: params.auth, position: params.pos, change: params.c } : { outcome: params.o });
        return [{ count: hit.length }];
      }
      if (sql.startsWith("UPDATE PendingWrite")) return [{ count: 1 }];
      if (sql.startsWith("CREATE EDGE")) {
        const m = /CREATE EDGE (\w+) FROM (#\d+:\d+) TO (#\d+:\d+)/.exec(sql);
        edges.push({ type: m[1], from: m[2], to: m[3] });
        return [{ count: 1 }];
      }
      return [{ count: 0 }];
    },
    async adbQuery(sql, params = {}) {
      if (/FROM SourceRef WHERE key = :k/.test(sql)) return refs.filter((r) => r.key === params.k).map((r) => ({ ...r }));
      const byRid = /^SELECT key, last_seen, seen_by FROM (#\d+:\d+)$/.exec(sql);
      if (byRid) return refs.filter((r) => r.rid === byRid[1]).map((r) => ({ key: r.key, last_seen: r.last_seen, seen_by: r.seen_by }));
      if (sql.startsWith("SELECT @rid AS rid FROM AuditEvent")) return events.filter((e) => e.id === params.id).map((e) => ({ rid: e.rid }));
      if (sql.includes("FROM AuditEvent")) {
        let rows = [...events];
        if (params.key) rows = rows.filter((e) => e.key === params.key);
        if (params.p) rows = rows.filter((e) => e.pending_id === params.p);
        const lit = /outcome = '(\w+)'/.exec(sql);
        if (lit) rows = rows.filter((e) => e.outcome === lit[1]);
        if (params.outcome) rows = rows.filter((e) => e.outcome === params.outcome);
        if (params.auth) rows = rows.filter((e) => e.authorized_by === params.auth);
        if (params.since) rows = rows.filter((e) => e.at >= params.since);
        if (params.table) rows = rows.filter((e) => new RegExp("^" + params.table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")).test(e.key));
        rows.sort((a, b) => b.at.localeCompare(a.at));
        const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 50);
        return rows.slice(0, limit).map(({ rid: _r, ...e }) => e);
      }
      if (sql.includes("outE('REFERS_TO')")) {
        const from = /FROM (#\d+:\d+)\)/.exec(sql)?.[1];
        return edges.filter((e) => e.type === "REFERS_TO" && e.from === from).map((e) => ({ dst: e.to }));
      }
      if (sql.includes("FROM OrgPolicy")) return db.policyRows?.(params, sql) ?? [];
      return [];
    },
  };
  return db;
}

test("an audit event names the row, the person, the agent, the position and what became of it", () => {
  const ev = auditEvent({ key: "mssql:dbo_Job:4471", authorized_by: "bob", acted_by: "admin/worker:ab12", position: "floor", change: { fields: { Status: "running" } }, outcome: "applied", at: "2026-11-08T10:00:00Z" });
  assert.match(ev.id, /^[0-9a-f-]{36}$/);
  assert.equal(ev.key, "mssql:dbo_Job:4471");
  assert.equal(ev.at, "2026-11-08T10:00:00.000Z");
  assert.deepEqual(JSON.parse(ev.change), { fields: { Status: "running" } });
  assert.equal(ev.pending_id, null);
  assert.throws(() => auditEvent({ key: "4471", authorized_by: "bob", acted_by: "a", position: "floor", outcome: "applied" }), /not a record key/);
  assert.throws(() => auditEvent({ key: "mssql:dbo_Job:4471", authorized_by: "bob", acted_by: "a", position: "floor", outcome: "done" }), /outcome: must be one of applied, proposed, refused, failed, attempted/);
  assert.throws(() => auditEvent({ key: "mssql:dbo_Job:4471", authorized_by: "", acted_by: "a", position: "floor", outcome: "applied" }), /authorized_by: needs a value/);
  assert.throws(() => auditEvent({ key: "mssql:dbo_Job:4471", authorized_by: "bob", acted_by: "a", position: "floor", outcome: "proposed" }), /pending_id/);
  assert.deepEqual(AUDIT_OUTCOMES, ["applied", "proposed", "refused", "failed", "attempted"]);
});

test("a source reference is the key split, never the row", () => {
  assert.deepEqual(sourceRef("mssql:dbo_Customer:TORO"), { key: "mssql:dbo_Customer:TORO", system: "mssql", table: "dbo_Customer", row_key: "TORO", last_seen: null, seen_by: null });
  assert.throws(() => sourceRef("TORO"), /not a record key/);
});

test("a reference is made once through sourceref.js, seen only when confirmed, and an instance refers to it once", { skip: storing }, async () => {
  const db = fakeDb();
  const a = await ensureSourceRef("mssql:dbo_Job:4471", { seen_by: "admin/worker:1", seen: false }, db);
  assert.equal(db.refs.length, 1);
  assert.equal(db.refs[0].last_seen, null, "nothing confirmed the row yet");
  assert.equal(db.refs[0].seen_by, null);
  assert.equal(await ensureSourceRef("mssql:dbo_Job:4471", { seen_by: "admin/worker:1", seen: false }, db), a, "the same reference");
  assert.equal(db.refs[0].last_seen, null, "an unconfirmed look leaves it as it was");
  assert.equal(await ensureSourceRef("mssql:dbo_Job:4471", { seen_by: "admin/worker:2", seen: true }, db), a);
  assert.ok(db.refs[0].last_seen, "seen now");
  assert.equal(db.refs[0].seen_by, "admin/worker:2");
  const seenAt = db.refs[0].last_seen;
  assert.equal(db.statements.filter((s) => s.startsWith("CREATE VERTEX SourceRef")).length, 1, "one writer, one row");
  assert.equal(await referTo("#20:1", a, db), true, "the edge is new");
  assert.equal(await referTo("#20:1", a, db), false, "and made once");
  assert.deepEqual(db.edges, [{ type: "REFERS_TO", from: "#20:1", to: a }]);
  assert.equal(db.refs[0].last_seen, seenAt, "referring to a row is not seeing it");
  assert.equal(db.refs[0].seen_by, "admin/worker:2");
  assert.equal(await referTo("Toro", a, db), false, "not a record id");
  assert.equal(await referTo("#20:1", "#10:99", db), false, "no such reference");
  await assert.rejects(ensureSourceRef("4471", {}, db), /not a record key/);
});

test("recording an event makes the row's SourceRef once, WROTE to it, and marks the row seen only when the write applied", { skip: storing }, async () => {
  const db = fakeDb();
  const a = await recordAuditEvent({ key: "mssql:dbo_Job:4471", authorized_by: "bob", acted_by: "admin/worker:1", position: "floor", change: { fields: { Status: "running" } }, outcome: "proposed", pending_id: "p1" }, db);
  assert.equal(db.refs.length, 1);
  assert.equal(db.refs[0].last_seen, null, "a proposal confirms nothing about the row");
  const b = await recordAuditEvent({ key: "mssql:dbo_Job:4471", authorized_by: "admin", acted_by: "admin/worker:2", position: "org", change: { fields: { Status: "done" } }, outcome: "applied" }, db);
  assert.equal(db.refs.length, 1, "one SourceRef per row");
  assert.ok(db.refs[0].last_seen, "an applied write saw the row");
  assert.equal(db.refs[0].seen_by, "admin/worker:2");
  assert.deepEqual(db.edges.map((e) => e.type), ["WROTE", "WROTE"]);
  assert.ok(db.edges.every((e) => e.to === db.refs[0].rid));
  // the proposal was decided: its event follows
  assert.equal(await settleAuditEvent("p1", "applied", db), 1);
  assert.equal(await settleAuditEvent("p1", "applied", db), 0, "settled once");
  await assert.rejects(settleAuditEvent("p1", "nope", db), /outcome: must be one of/);
  const all = await listAuditEvents({ key: "mssql:dbo_Job:4471" }, db);
  assert.deepEqual(all.map((e) => e.id).sort(), [a.id, b.id].sort());
  assert.deepEqual(all.find((e) => e.id === a.id).change, { fields: { Status: "running" } }, "change comes back parsed");
  assert.equal((await listAuditEvents({ outcome: "applied" }, db)).length, 2);
  assert.equal((await listAuditEvents({ authorized_by: "bob" }, db)).length, 1);
  assert.equal((await listAuditEvents({ table: "mssql:dbo_Job" }, db)).length, 2);
  assert.equal((await listAuditEvents({ table: "mssql:dbo_Order" }, db)).length, 0);
  await assert.rejects(listAuditEvents({ since: "yesterday" }, db), /since: not a date/);
  await assert.rejects(listAuditEvents({ outcome: "lost" }, db), /outcome: must be one of/);
});

test("the schema is the contract's own statements, each safe to repeat", async () => {
  const db = fakeDb();
  await ensureAuditSchema(db);
  await ensureAuditSchema(db);
  const made = db.statements.filter((s) => s.startsWith("CREATE VERTEX TYPE") || s.startsWith("CREATE EDGE TYPE"));
  assert.deepEqual([...new Set(made)].sort(), ["CREATE EDGE TYPE REFERS_TO IF NOT EXISTS", "CREATE EDGE TYPE WROTE IF NOT EXISTS", "CREATE VERTEX TYPE AuditEvent IF NOT EXISTS", "CREATE VERTEX TYPE SourceRef IF NOT EXISTS"]);
  assert.ok(db.statements.every((s) => s.includes("IF NOT EXISTS")));
});
