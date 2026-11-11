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
