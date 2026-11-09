import assert from "node:assert/strict";
import { test } from "node:test";
import { surveyBrief } from "../src/pool.js";
import { draftClasses, fileDraftSql, parseDigest, patternClasses, reportDigest } from "../src/discovery.js";

test("the survey brief drafts classes through its report and never confirms one", () => {
  const b = surveyBrief("mssql", "production");
  assert.match(b, /5\. Draft the commitment classes/);
  assert.match(b, /dbo_Job columns: <its columns, comma-separated>/);
  assert.match(b, /dbo_Job rows: <the count>/);
  assert.match(b, /dbo_Job <its status column> values: /);
  assert.match(b, /graph-rag_propose_class[^\n]*record_table "mssql:<table>"/);
  assert.match(b, /You only draft\. A person confirms, renames or retires classes in Organization settings/);
  assert.match(b, /master-data tables|Master-data tables \(customers, employees, vendors, work centers, materials\) are actors or resources/i);
  // the survey's other steps
  assert.match(b, /mssql: dbo_Customer \(customers\)/);
  assert.match(b, /Stay within roughly 150 tool calls/);
});

test("the tag the brief asks for in a pattern entry is the one discovery reads", () => {
  const b = surveyBrief("mssql");
  const tag = /\[class: [^\]]+\]/.exec(b)[0];
  const got = patternClasses([{ name: "mssql: hiring (pattern)", text: `Hiring happens outside the ERP. ${tag}` }], "mssql");
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "hires");
  assert.deepEqual(got[0].stages, ["opened", "interviewing", "offered", "hired", "declined"]);
  assert.equal(got[0].record_table, null);
  assert.equal(got[0].description, "a hire: a commitment of a position to a person");
});

test("the lines the brief asks a report for are the digest grammar, and nothing else in a report reads as a table", () => {
  const report = [
    "mssql: dbo_Job (jobs): one row is a production job, key JobID, 31,400 rows. Its rows are commitments (a class).",
    "- Jobs: 31k open, most on CNC",
    "Seeded: dbo_Vendor (61 of 61).",
    "dbo_Job columns: JobID, Status, MachineID, DueDate",
    "- dbo_Job rows: 31,400",
    "`dbo_Job Status values: Planned, Running, Paused, Done`",
  ].join("\n");
  assert.equal(reportDigest(report), "dbo_Job columns: JobID, Status, MachineID, DueDate\ndbo_Job rows: 31,400\ndbo_Job Status values: Planned, Running, Paused, Done");
  const { tables } = parseDigest(reportDigest(report), "mssql");
  assert.deepEqual(tables.map((x) => x.name), ["dbo_Job"]);
  const { drafts } = draftClasses({ system: "mssql", tables });
  assert.equal(drafts[0].name, "jobs");
  assert.deepEqual(drafts[0].stages, ["planned", "running", "paused", "done"]);
  assert.equal(drafts[0].record_table, "mssql:dbo_Job");
  assert.equal(drafts[0].status, "proposed");
  // the filing carries what its row holds, and a filing counted by section starts at that section
  assert.match(fileDraftSql({ ...drafts[0], occurrences: ["document:x"] }), /occurrences = \['document:x'\]/);
});
