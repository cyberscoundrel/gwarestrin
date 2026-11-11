// R16 conditions 2 and 3 (model/write-conditions.js): the record names the row, and every value written appears in it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { booleanByColumnWords, columnWords, DEFINITIONS, datesIn, hasRun, normText, numbersIn, rowNamed, valueAppears, writeConditions } from "../src/model/write-conditions.js";

const jobs = [
  { Job: 4471, Customer: "TORO", Part_Number: "TORO-SHAFT-7", Order_Quantity: 300, Status: "Active", Promised_Date: "2026-11-24", Certs_Required: false },
  { Job: 3260356, Customer: "EXATRON", Part_Number: "EPP-D98-1-A", Order_Quantity: 800, Status: "Active", Promised_Date: "2026-11-20", Certs_Required: false },
  { Job: 3260357, Customer: "EXATRON", Part_Number: "EPP-D98-2-B", Order_Quantity: 600, Status: "Active", Promised_Date: "2026-12-01", Certs_Required: false },
  { Job: 3260410, Customer: "EXATRON", Part_Number: "EPP-D98-2-B", Order_Quantity: 500, Status: "Planned", Promised_Date: "2026-12-10", Certs_Required: false },
  { Job: 3260372, Customer: "BSE", Part_Number: "BSE-RING-4", Order_Quantity: 120, Status: "Complete", Promised_Date: "2026-11-30", Certs_Required: false },
];
const centers = ["CNC 1", "CNC 3", "CNC 5", "INSPECT-2", "SAW"].map((w) => ({ Work_Center: w, Status: "Up", Status_Note: null }));

test("numbers are compared after their separators go; dates as day and month; text as an exact run of words", () => {
  assert.deepEqual(numbersIn("1,200 pieces at 21.50, job 3260357"), [1200, 21.5, 3260357]);
  assert.deepEqual(numbersIn("EPP-D98 parts"), [], "a digit inside a part number is no number of the note's");
  assert.deepEqual(datesIn("due December 12, or 3 Jan 2027, or 12/24; on 2026-12-15"), [{ month: 12, day: 12 }, { month: 1, day: 3, year: 2027 }, { month: 12, day: 15, year: 2026 }, { month: 12, day: 24 }]);
  assert.deepEqual(datesIn("due mid December, next Monday, today"), []);
  assert.equal(normText("  Down   until\nthe gauge "), "down until the gauge");
  assert.ok(hasRun("inspect-2 is down until the gauge", "down until the gauge"));
  assert.ok(!hasRun("the shipment is downstream", "down"), "a run starts and ends at word edges");
  assert.ok(valueAppears(1200, "Exatron placed the repeat order, 1,200 pieces").ok);
  assert.ok(valueAppears("1200", "1,200 pieces").ok);
  assert.ok(!valueAppears(800, "only job 3260356 shipped Thursday").ok);
  assert.ok(valueAppears("2026-12-12", "moved the due date to December 12").ok);
  assert.ok(!valueAppears("2026-12-12", "due mid December").ok, "no day given");
  assert.ok(!valueAppears("2026-12-12", "due December 12, 2027").ok, "a year given must match");
  assert.ok(valueAppears("Down until the gauge is recalibrated", "Lucas says INSPECT-2 is down until the gauge is recalibrated").ok);
  const reworded = valueAppears("Second shift runs this machine from next Monday. Grazzalt covers setups until the new hire is trained.", "Second shift runs CNC 3 and CNC 5 from next Monday; Grazzalt covers setups until the new hire is trained.");
  assert.deepEqual([reworded.ok, reworded.kind], [false, "text"], "a reworded sentence fails");
  assert.match(reworded.why, /isn't the record's own words/);
  assert.deepEqual([valueAppears(true, "needs certs with the shipment", { column: "Certs_Required" }).ok, valueAppears(true, "x").kind], [false, "boolean"]);
  assert.deepEqual([valueAppears(null, "x").ok, valueAppears(null, "x").kind], [false, "empty"]);
  const closed = valueAppears("Complete", "job 3260356 shipped Thursday", { column: "Status", rows: jobs });
  assert.deepEqual([closed.ok, closed.kind], [false, "closed"], "a Status from a small set is reported apart");
  assert.deepEqual([valueAppears("Down", "INSPECT-2 is down", { column: "Status", rows: [...centers, { Work_Center: "X", Status: "Down" }] }).ok], [true]);
});

test("condition 2: the row is named by its key, or is the one row the text matches best; otherwise not", () => {
  assert.deepEqual(rowNamed({ text: "Job 3260372 for BSE needs certs", key: "mssql:dbo_Job:3260372", rows: jobs, primaryKey: "Job" }).how, "named");
  assert.deepEqual(rowNamed({ text: "Second shift runs CNC 3 and CNC 5", key: "mssql:dbo_Work_Center:CNC 3", rows: centers, primaryKey: "Work_Center" }).how, "named");
  assert.equal(rowNamed({ text: "CNC 30 is down", key: "mssql:dbo_Work_Center:CNC 3", rows: centers, primaryKey: "Work_Center" }).ok, false, "CNC 30 doesn't name CNC 3");
  // the Toro shaft job: TORO and its part are in the text, nothing else matches as well
  assert.deepEqual(rowNamed({ text: "Toro wants the TORO-SHAFT-7 order rushed", key: "mssql:dbo_Job:4471", rows: jobs, primaryKey: "Job" }).how, "only match");
  // Exatron's floater job: three Exatron jobs, two with that part: not one row
  const aj02 = rowNamed({ text: "Exatron moved the EPP-D98-2-B due date to December 12", key: "mssql:dbo_Job:3260357", rows: jobs, primaryKey: "Job" });
  assert.equal(aj02.ok, false);
  assert.match(aj02.why, /3260357 and 3260410 match it equally/);
  const none = rowNamed({ text: "the floaters shipped this afternoon", key: "mssql:dbo_Job:3260357", rows: jobs, primaryKey: "Job" });
  assert.match(none.why, /neither its key nor anything of that row is in the text/);
});

test("both together: the first that fails, and one sentence for the recorder", () => {
  const z01 = writeConditions({ text: "Correction: only Exatron job 3260356 shipped Thursday. 3260357 is still waiting on FINAL INSP.", key: "mssql:dbo_Job:3260356", fields: { Shipped_Quantity: 800, Status: "Complete" }, rows: jobs, primaryKey: "Job" });
  assert.deepEqual([z01.ok, z01.failed, z01.row.how], [false, 3, "named"]);
  assert.match(z01.why, /^Not every value is in your words: Shipped_Quantity would be 800, a number the record doesn't give; Status would read "Complete"/);
  const ab05 = writeConditions({ text: "Exatron placed the repeat order for job 3260357, 1,200 pieces, due mid December.", key: "mssql:dbo_Job:3260357", fields: { Order_Quantity: 1200, Promised_Date: "2026-12-12" }, rows: jobs, primaryKey: "Job" });
  assert.deepEqual([ab05.failed, ab05.values.map((v) => v.ok)], [3, [true, false]]);
  const aj02 = writeConditions({ text: "Exatron moved the floater due date to December 12.", key: "mssql:dbo_Job:3260357", fields: { Promised_Date: "2026-12-12" }, rows: jobs, primaryKey: "Job" });
  assert.equal(aj02.failed, 2, "the date appears, but the row isn't named");
  assert.match(aj02.why, /^It isn't clear which row/);
  const m01 = writeConditions({ text: "Lucas says INSPECT-2 is down until the gauge is recalibrated, so Exatron's EPP-D98 parts wait.", key: "mssql:dbo_Work_Center:INSPECT-2", fields: { Status: "Down", Status_Note: "Down until the gauge is recalibrated" }, rows: centers, primaryKey: "Work_Center" });
  assert.deepEqual([m01.ok, m01.failed, m01.why], [true, null, null]);
  // a value the row already holds isn't written, so it isn't tested; a write that changes nothing lands with nothing sent
  const ag03 = writeConditions({ text: "Exatron sent a new order for 500 floaters, job 3260410.", key: "mssql:dbo_Job:3260410", fields: { Customer: "EXATRON", Part_Number: "EPP-D98-2-B", Order_Quantity: 500 }, rows: jobs, primaryKey: "Job", current: jobs[3] });
  assert.deepEqual([ag03.ok, ag03.unchanged], [true, true]);
  const part = writeConditions({ text: "job 3260410, 750 floaters", key: "mssql:dbo_Job:3260410", fields: { Customer: "EXATRON", Order_Quantity: 750 }, rows: jobs, primaryKey: "Job", current: jobs[3] });
  assert.deepEqual([part.ok, part.values.map((v) => v.column)], [true, ["Order_Quantity"]], "only the changing value is tested");
});

test("the boolean treatment the replay proposes: the column's own words in a sentence, negated or not (off until chosen)", () => {
  assert.equal(DEFINITIONS.booleans, null, "not chosen: a boolean doesn't appear");
  assert.deepEqual(columnWords("Certs_Required"), ["certs"]);
  assert.ok(booleanByColumnWords(true, "Job 3260372 for BSE needs certs with the shipment.", "Certs_Required"));
  assert.equal(booleanByColumnWords(true, "Job 3260372 ships without certs.", "Certs_Required"), null);
  assert.ok(booleanByColumnWords(false, "Job 3260372 doesn't need certs after all.", "Certs_Required"));
  assert.equal(booleanByColumnWords(true, "Job 3260372 ships Friday.", "Certs_Required"), null);
  DEFINITIONS.booleans = booleanByColumnWords;
  try {
    assert.ok(valueAppears(true, "Job 3260372 for BSE needs certs with the shipment.", { column: "Certs_Required" }).ok);
  } finally {
    DEFINITIONS.booleans = null;
  }
});
