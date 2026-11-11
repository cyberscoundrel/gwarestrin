// How a worker names a section: the short id its brief gives (s1, s2 ...), or the record id beside it; what models
// actually sent in the first real run ("1", "Section #1:4104", the piece's text) resolves, or is refused with the ids.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSectionRef, shortSectionId } from "../src/model/brief.js";
import { taskBrief } from "../src/pool.js";

const two = ["#1:4104", "#1:4105"];

test("sections: the short id, the record id, a number or § number, with or without 'Section ' in front", () => {
  assert.equal(shortSectionId(0), "s1");
  for (const v of ["s1", "S1", "#1:4104", "1", "§1", "§ 1", "Section s1", "section #1:4104", "Section #1:4104", "Section 1", " s1 "]) assert.equal(resolveSectionRef(v, two), "#1:4104", v);
  for (const v of ["s2", "2", "Section #1:4105", "#1:4105: Customer credit"]) assert.equal(resolveSectionRef(v, two), "#1:4105", v);
});

test("sections: with two sections, a value that names neither resolves to nothing (the tool then lists the ids)", () => {
  for (const v of ["s3", "0", "Customer credit §1", "document_section_1", "#1:9999", "", undefined, null, "the forklift is booked Thursday for the Toro move"]) assert.equal(resolveSectionRef(v, two), null, String(v));
});

test("sections: with one section, a missing or unmatched value means that one (the piece's text written into the field, say)", () => {
  const one = ["#1:4123"];
  for (const v of ["s1", "#1:4123", undefined, "", "document_section_1", "Swapped the Hyd-Mech blade; the old one goes back to Breskund for resharpening.".repeat(20)]) assert.equal(resolveSectionRef(v, one), "#1:4123", String(v).slice(0, 30));
  // but a value naming another section is never taken as this one: a worker can't file another record's section
  for (const v of ["#1:9999", "Section #1:9999", "s2", "2", "§3"]) assert.equal(resolveSectionRef(v, one), null, v);
});

test("sections: the brief names each section by its short id with the record id beside it, and says to use the id", () => {
  const brief = {
    audience: "floor",
    record: { id: "doc-1", title: "Shift notes", description: null, home: "floor" },
    sections: [
      { section: "s1", rid: "#1:4104", heading: "Customer credit", text: "Toro's credit is on hold.", home: "floor" },
      { section: "s2", rid: "#1:4105", heading: null, text: "CNC 2 has a worn spindle bearing.", home: "floor" },
    ],
    classes: [],
    instances: [],
    sources: [],
  };
  const b = taskBrief({ brief, refile: [{ entry: "e-1", outcome: "kept", section: "s2", piece: "the bearing" }] });
  assert.match(b, /section s1 \(#1:4104\): Customer credit\nToro's credit is on hold\./);
  assert.match(b, /section s2 \(#1:4105\)\nCNC 2 has/);
  assert.match(b, /Name a section by its id above \(s1, s2\), never by its text/);
  assert.match(b, /entry e-1 \(kept, section s2\)/, "a piece to re-file names its section the same way");
});

test("record_table: a bare table name is the one declared source that has it; otherwise refused with the form and the sources", async () => {
  const { qualifyTable } = await import("../src/classes.js");
  const tables = { mssql: ["dbo_Customer", "dbo_Job"], erp: ["dbo_Job", "Parts"] };
  const opts = (only) => ({ sources: Object.fromEntries((only ?? Object.keys(tables)).map((s) => [s, { system: s, read: { url: `http://${s}` } }])), entitiesOf: async (d) => tables[d.system] });
  assert.equal(await qualifyTable("dbo_Customer", opts()), "mssql:dbo_Customer");
  assert.equal(await qualifyTable("DBO_CUSTOMER", opts()), "mssql:dbo_Customer", "named as the source names it");
  assert.equal(await qualifyTable("parts", opts()), "erp:Parts");
  assert.equal(await qualifyTable("mssql:dbo_Job", opts()), "mssql:dbo_Job", "already system:table: unchanged");
  await assert.rejects(qualifyTable("dbo_Job", opts()), /several sources: name it as system:table, one of mssql:dbo_Job, erp:dbo_Job/);
  await assert.rejects(qualifyTable("dbo_Nope", opts(["mssql"])), /not system:table: dbo_Nope\. Name the table with its source, as system:table \(for example mssql:dbo_Nope; declared sources: mssql\)/);
  await assert.rejects(qualifyTable("dbo_Job", { sources: {}, entitiesOf: async () => [] }), /no source is declared/);
});

test("handles: an entry by e1, 1 or its id among the worker's own; one entry takes any value; another's id or a handle past the list never", async () => {
  const { resolveEntryRef } = await import("../src/model/brief.js");
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const other = "33333333-3333-4333-8333-333333333333";
  for (const [v, want] of [["e1", a], ["E2", b], ["2", b], [a, a], [b, b], ["e3", null], ["0", null], [other, null], ["section_s1", null], ["mssql:dbo_Job:4471", null], ["", null]]) assert.equal(resolveEntryRef(v, [a, b]), want, String(v));
  for (const [v, want] of [["section_s1", a], ["the forklift entry", a], ["", a], ["e1", a], ["e2", null], [other, null]]) assert.equal(resolveEntryRef(v, [a]), want, `one entry: ${v}`);
});

test("class map: the record_table the model set; else its one table in evidence, if the source has it; never written on the class", async () => {
  const { classMapFrom } = await import("../eval/classmap.mjs");
  const MAP = { "mssql:dbo_Job": "floor", "mssql:dbo_Customer": "ops" };
  const tables = new Set(["mssql:dbo_job", "mssql:dbo_customer", "mssql:dbo_vendor"]);
  const ev = (...refs) => JSON.stringify(refs.map((ref) => ({ kind: "table", ref })));
  const rows = [
    { _class_key: "job", _class_name: "Job", _record_table: "mssql:dbo_Job", _evidence: ev("mssql:dbo_Job") },
    { _class_key: "customer", _class_name: "Customer", _record_table: null, _evidence: ev("mssql:dbo_Customer") },
    { _class_key: "deal", _class_name: "Deal", _record_table: null, _evidence: ev("mssql:dbo_Customer", "mssql:dbo_Job") },
    { _class_key: "ghost", _class_name: "Ghost", _record_table: null, _evidence: ev("mssql:dbo_Ghost") },
    { _class_key: "vendor", _class_name: "Vendor", _record_table: null, _evidence: ev("mssql:dbo_Vendor") },
    { _class_key: "talk", _class_name: "Acquisition talk", _record_table: null, _evidence: JSON.stringify([{ kind: "notes", note: "the owners" }]) },
    { _class_key: "odd", _class_name: "Odd", _record_table: "mssql:dbo_Odd", _evidence: "[]" },
  ];
  const m = classMapFrom(rows, tables, MAP);
  assert.deepEqual(m.classes, { job: { authority: "floor" }, customer: { authority: "ops" } });
  assert.deepEqual(m.by_record_table.map((x) => x.class), ["Job"]);
  assert.deepEqual(m.by_evidence.map((x) => x.class), ["Customer"], "one table in evidence, in the source and in M0");
  assert.deepEqual(m.unmapped_with_table.map((x) => x.class), ["Deal", "Ghost", "Vendor"], "two tables, one the source hasn't, one M0 doesn't map: unmapped");
  assert.deepEqual(m.no_table, ["Acquisition talk"]);
  assert.deepEqual(m.record_table_not_in_map.map((x) => x.class), ["Odd"]);
  assert.equal(rows[1]._record_table, null, "nothing is written on the class");
});

test("evidence: a bare table name gets its source, so the class's home is its connection's, not the root", async () => {
  const { qualifyEvidence } = await import("../src/classes.js");
  const { homeFromEvidence, normalizeEvidence } = await import("../src/model/classes.js");
  const { parsePositionMap } = await import("../src/positions.js");
  const positions = parsePositionMap({ root: "org", positions: { org: { name: "Top" }, ops: { name: "Operations", parent: "org" }, floor: { name: "Floor", parent: "ops" } } });
  const opts = { sources: { mssql: { system: "mssql", read: { url: "http://m" } } }, entitiesOf: async () => ["dbo_Job", "dbo_Customer"] };
  const ctx = { positions, connectionHome: (s) => (s === "mssql" ? "floor" : null) };
  const bare = [{ kind: "table", ref: "dbo_Job" }];
  // as B-2's discovery made Job: the bare ref names no connection, so the home fell to the root
  assert.equal(homeFromEvidence(bare.map((e) => normalizeEvidence(e)), ctx), "org");
  const q = await qualifyEvidence(bare, opts);
  assert.deepEqual(q, [{ kind: "table", ref: "mssql:dbo_Job" }]);
  assert.equal(homeFromEvidence(q.map((e) => normalizeEvidence(e)), ctx), "floor", "its connection's home");
  // rows and already-qualified refs, notes left as they are
  assert.deepEqual(await qualifyEvidence([{ kind: "rows", ref: "dbo_Customer:TORO" }, { kind: "table", ref: "mssql:dbo_Job" }, { kind: "notes", note: "the owners" }], opts), [{ kind: "rows", ref: "mssql:dbo_Customer:TORO" }, { kind: "table", ref: "mssql:dbo_Job" }, { kind: "notes", note: "the owners" }]);
  await assert.rejects(qualifyEvidence([{ kind: "table", ref: "dbo_Nope" }], opts), /evidence: not system:table: dbo_Nope|not system:table: dbo_Nope/);
});
