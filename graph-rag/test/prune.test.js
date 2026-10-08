import assert from "node:assert/strict";
import { test } from "node:test";
import { createSink, ledgerLine, preview, pruneCutoff, pruneDate, pruneRecord } from "../src/prune.js";

const NOW = Date.parse("2026-10-08T12:00:00Z");

test("the cutoff: entries that ended more than the window ago; 0 = never prune", () => {
  assert.equal(pruneCutoff(30, NOW), "2026-09-08T12:00:00.000Z");
  assert.equal(pruneCutoff(0, NOW), null);
  assert.equal(pruneCutoff(Number.NaN, NOW), null);
  assert.equal(pruneDate("2026-10-16T23:59:59.000Z", 30), "2026-11-15T23:59:59.000Z");
});

test("the discard sink accepts everything and keeps nothing; unknown sinks disable pruning", async () => {
  const sink = createSink();
  assert.equal(sink.name, "discard");
  assert.equal(sink.keeps, false);
  assert.deepEqual(await sink.archive([{ rid: "#1:1" }, { rid: "#1:2" }]), ["#1:1", "#1:2"]);
  assert.equal(createSink("s3-cold"), null, "a sink that isn't built yet must not silently become discard");
});

const row = {
  "@rid": "#12:7",
  "@type": "Entity",
  name: "Sandra visit",
  _home: "ops",
  _origin: "ops",
  _valid_until: "2026-09-01T23:59:59.000Z",
  text_identity: "Sandra visits Friday",
  embed_identity: [0.1, 0.2],
  updated_at: "2026-08-30",
};

test("a sink gets what it needs to restore an entry, without the (recomputable) vectors", () => {
  const r = pruneRecord(row, [{ type: "RELATES", direction: "out", other: "Acme" }], [{ id: "g1", to_user: "bob", expires_at: null }]);
  assert.equal(r.rid, "#12:7");
  assert.equal(r.properties.text_identity, "Sandra visits Friday");
  assert.equal("embed_identity" in r.properties, false);
  assert.deepEqual(r.edges, [{ type: "RELATES", direction: "out", other: "Acme" }]);
  assert.deepEqual(r.grants, [{ id: "g1", to_pos: null, to_user: "bob", expires_at: null }]);
});

test("what stays behind is a line without content", () => {
  const line = ledgerLine(pruneRecord(row), createSink(), NOW);
  assert.deepEqual(line, { name: "Sandra visit", home: "ops", kind: "Entity", valid_until: "2026-09-01T23:59:59.000Z", pruned_at: "2026-10-08T12:00:00.000Z", sink: "discard", kept: false });
  assert.equal(JSON.stringify(line).includes("Friday"), false);
});

test("the preview groups expired entries by the day they go", () => {
  const p = preview([{ valid_until: "2026-09-01T00:00:00.000Z" }, { valid_until: "2026-10-01T10:00:00.000Z" }, { valid_until: "2026-10-01T20:00:00.000Z" }], 30, NOW);
  assert.equal(p.enabled, true);
  assert.equal(p.waiting, 3);
  assert.equal(p.due, 1, "ended Sep 1: past the window already");
  assert.deepEqual(p.days, [{ day: "2026-10-08", count: 1 }, { day: "2026-10-31", count: 2 }]);
  assert.deepEqual(preview([{ valid_until: "2026-09-01T00:00:00.000Z" }], 0, NOW), { enabled: false, waiting: 1, days: [] });
});
