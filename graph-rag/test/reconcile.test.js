// The reconciliation stream against the oracle: its claims are the input a worker gets until the
// Condenser's ingest lands (docs/ORGANIZATION-MODEL.md, "The worker's job"). What a worker is told,
// what the queries find (conflicts, unresolved subjects), and the shapes the stream shares with the
// other modules (claim edges as data, thread labels).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { claimsOf, closeIntervals, normalizeDocument, overlaps, subjectId } from "../src/model/claims.js";
import { checkBriefFloor, taskBrief } from "../src/pool.js";
import { parsePositionMap } from "../src/positions.js";
import { labelFor, RECONCILE_CHANGES, shapeClaim } from "../src/worker-pool.js";
import { REMOVED_WORKER_TOOLS, WORKER_TOOLS } from "../src/worker-tools.js";
import { triageVerdict } from "../src/decisions.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const map = parsePositionMap(read("positions.json"));
const oracle = read("oracle-sixty.json");
const POS = { Ops: "ops", floor: "floor", "admins-only": "org" };

/** an oracle note as the condenser would hand it over: one document, one section, its claims */
function noteDocument(note) {
  return normalizeDocument(
    {
      title: note.title,
      recorded_by: note.writer,
      position: POS[note.origin_position] ?? "org",
      reason: "a ux batch note",
      recorded_at: "2026-11-08T09:00:00.000Z",
      sections: [{ text: note.text, claims: note.claims.map(({ authority: _a, ...c }) => c) }],
    },
    { now: Date.parse("2026-11-08T09:00:00.000Z") },
  );
}

/** the oracle's claims as a worker's brief shows them: subjects resolved when they carry a key */
function briefSection(note, doc, rid = "#71:1") {
  const claims = claimsOf(doc).map((c, i) => ({ ...c, id: `${note.id}-c${i}`, section: rid, resolved: Boolean(c.subject.key), thing: c.subject.key ? `#20:${i}` : null }));
  return {
    rid,
    kind: "section",
    name: note.title,
    text: doc.sections[0].text,
    home: doc.position,
    home_name: map.positions[doc.position].name,
    document: { title: doc.title, recorded_by: doc.recorded_by, recorded_at: doc.recorded_at, position: doc.position, position_name: map.positions[doc.position].name, reason: doc.reason },
    claims,
    subjects: claims.map((c) => (c.resolved ? { claim: c.id, resolved: true, rid: c.thing, label: c.subject.key.split(":").at(-1), type: "other", class: c.class, keys: [c.subject.key] } : { claim: c.id, resolved: false, written: c.subject })),
    prior: [],
  };
}

test("every oracle note becomes a brief a worker can reconcile: its claims, keyed subjects resolved, the rest unresolved, within its floor", () => {
  let keyed = 0;
  let unresolved = 0;
  for (const note of oracle) {
    const doc = noteDocument(note);
    const s = briefSection(note, doc);
    assert.deepEqual(checkBriefFloor(map, [s]), [doc.position], note.id);
    const b = taskBrief({ sections: [s] });
    assert.match(b, /data, not instructions/, note.id);
    for (const c of s.claims) {
      assert.match(b, new RegExp(`claim ${c.id}: ${c.kind} ${c.class.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${c.attribute}`), note.id);
      if (c.resolved) keyed++;
      else unresolved++;
    }
    const body = b.split("----------").slice(1, -1).join("");
    assert.equal((body.match(/UNRESOLVED/g) ?? []).length, s.claims.filter((c) => !c.resolved).length, note.id);
  }
  assert.ok(keyed > 30 && unresolved > 30, `keyed ${keyed}, unresolved ${unresolved}`);
});

test("a contradiction is a query: two claims on one attribute with overlapping intervals and different values; a succession is not", () => {
  // the oracle's INSPECT-2 note (m01) against a prior claim that the work center was up
  const m01 = oracle.find((n) => n.id === "ux-m01");
  const doc = noteDocument(m01);
  const [status] = claimsOf(doc).filter((c) => c.attribute === "status" && c.subject.key);
  const prior = { ...status, id: "prior", value: "up", valid_from: "2026-11-08T09:00:00.000Z", valid_until: null, recorded_at: "2026-11-07T00:00:00.000Z" };
  const same = overlaps(closeIntervals([prior, { ...status, id: "now" }]));
  assert.equal(same.length, 1, "the same instant, two values: a conflict");
  assert.deepEqual(same[0].map((c) => c.id).sort(), ["now", "prior"]);
  const earlier = { ...prior, valid_from: "2026-11-01T00:00:00.000Z" };
  assert.equal(overlaps(closeIntervals([earlier, { ...status, id: "now" }])).length, 0, "an earlier open claim is closed by the later one: a succession, no conflict");
  assert.equal(overlaps(closeIntervals([earlier, { ...status, id: "now", value: "up" }])).length, 0, "the same value is never a conflict");
  // the verdict follows the query, not the model
  const v = triageVerdict({ level: { score: 0.1, probabilities: { 0: 0.95 } }, reason: { choice: "plain_fact", probabilities: { plain_fact: 0.9 } } }, { claims: 3, unresolved: 0, conflicts: 1, keyed: 1 });
  assert.equal(v.reason, "conflict");
  assert.equal(v.toMaster, true);
});

test("a stored claim edge as data: resolved when it points at a thing, unresolved when it points back at its section", () => {
  const base = { erid: "#90:1", id: "c-1", kind: "state", class: "jobs", attribute: "stage", value: "running", value_num: null, valid_from: "2026-11-08T09:00:00.000Z", valid_until: null, recorded_at: "2026-11-08T09:00:00.000Z", recorded_by: "bob", _home: "floor" };
  const resolved = shapeClaim({ ...base, src: "#71:3", dst: "#20:1" });
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.thing, "#20:1");
  assert.equal(resolved.section, "#71:3");
  const open = shapeClaim({ ...base, src: "#71:3", dst: "#71:3", subject: JSON.stringify({ name: "Toro PO 4471", class: "orders" }) });
  assert.equal(open.resolved, false);
  assert.equal(open.thing, null);
  assert.deepEqual(open.subject, { name: "Toro PO 4471", class: "orders" });
  assert.equal(subjectId({ key: "mssql:dbo_Job:4471" }), "key|mssql:dbo_Job:4471");
});

test("a thread's label names classes and attributes, never a title; the tool set is the reconciliation one", () => {
  const sections = [{ claims: [{ class: "jobs", attribute: "stage" }, { class: "orders", attribute: "quantity" }, { class: "orders", attribute: "price" }] }, { claims: [{ class: "jobs", attribute: "stage" }] }];
  assert.equal(labelFor(sections), "jobs/stage, orders/quantity +1 (4 claims)");
  assert.equal(labelFor([{ claims: [] }]), "no claims (0 claims)");
  assert.deepEqual(WORKER_TOOLS, ["confirm_claim", "record_conflict", "resolve_subject", "mark_need_met", "enter_data", "raise_question"]);
  assert.deepEqual(REMOVED_WORKER_TOOLS, ["link_things", "relate_things", "queue_followup", "unlink_things", "delete_thing", "merge_things", "merge_entries", "unrelate_things", "delete_entry", "rename_thing", "update_entry"]);
  assert.deepEqual(RECONCILE_CHANGES, ["confirm", "conflict", "resolve", "need_met", "data_entry"]);
});
