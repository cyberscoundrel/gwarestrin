// What stays of discovery's pure code (discovery.js): reading what a survey saw. The drafting by table-name
// word lists and the drafts a person confirmed are gone (R3, R5).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as discovery from "../src/discovery.js";

test("a digest reads into tables with their columns, rows and status values", () => {
  const d = discovery.parseDigest(
    ["Tables (3, all named dbo_…): Job, Customer, Employee", "dbo_Job columns: Job, Customer, Status, Due_Date", "dbo_Job rows: 31,204", "dbo_Job Status values: Planned, Running, Done", "- dbo_Customer: Customer, Name"].join("\n"),
    "mssql",
  );
  assert.equal(d.system, "mssql");
  const job = d.tables.find((t) => t.name === "dbo_Job");
  assert.deepEqual(job.columns, ["Job", "Customer", "Status", "Due_Date"]);
  assert.equal(job.rows, 31204);
  assert.deepEqual(job.status_values, { Status: ["Planned", "Running", "Done"] });
  assert.deepEqual(d.tables.find((t) => t.name === "dbo_Customer").columns, ["Customer", "Name"]);
});

test("a survey report keeps only its lines in the digest's grammar", () => {
  const r = discovery.reportDigest("- Jobs: 31k open\n- `dbo_Job rows: 31,204`\ndbo_Job Status values: Planned, Done\nsomething else");
  assert.equal(r, "dbo_Job rows: 31,204\ndbo_Job Status values: Planned, Done");
});

test("no word lists and no drafting are left (R3, R5)", () => {
  for (const gone of ["TRANSACTION_NOUNS", "MASTER_NOUNS", "classifyTable", "draftClasses", "confirmedClass", "fileDraftSql"]) assert.equal(gone in discovery, false, gone);
});
