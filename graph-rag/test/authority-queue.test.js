// A proposed source-system write (the Reconciliation stream's data_entry) runs through the
// pending-write queue like any other kind: applied on approval by data-entry.js's
// applyProposedEntry, marked refused on rejection by refuseProposedEntry. The module is stubbed
// here (useDataEntry), so this branch needs neither the module nor a database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { executePending, refusePending, useDataEntry } from "../src/write.js";

const calls = [];
useDataEntry({
  applyProposedEntry: async (payload, pendingId, approver) => {
    calls.push(["apply", payload, pendingId, approver]);
    return { outcome: "applied", key: JSON.parse(payload).key };
  },
  refuseProposedEntry: async (pendingId) => {
    calls.push(["refuse", pendingId]);
    return { outcome: "refused" };
  },
});
const payload = JSON.stringify({ kind: "data_entry", key: "mssql:dbo_Job:4471", fields: { Status: "done" }, class: "jobs", attribute: "stage", acts_for: { person: "bob", position: "floor" }, by: "admin/agent:w1" });

test("an approved data_entry proposal is applied by data-entry.js with the payload, its id and the approver", async () => {
  const r = await executePending({ id: "p-1", kind: "data_entry", payload }, "admin", "admin");
  assert.deepEqual(r, { outcome: "applied", key: "mssql:dbo_Job:4471" });
  assert.deepEqual(calls.at(-1), ["apply", payload, "p-1", "admin"]);
  // approved by an agent (no person placed it): the approver is still named
  await executePending({ id: "p-2", kind: "data_entry", payload }, undefined, "admin/agent:h1");
  assert.deepEqual(calls.at(-1), ["apply", payload, "p-2", "admin/agent:h1"]);
});

test("a rejected data_entry proposal is marked refused; other kinds leave nothing to do", async () => {
  await refusePending({ id: "p-3", kind: "data_entry", payload });
  assert.deepEqual(calls.at(-1), ["refuse", "p-3"]);
  const before = calls.length;
  await refusePending({ id: "p-4", kind: "upsert", payload: "{}" });
  await refusePending(undefined);
  assert.equal(calls.length, before);
});

test("a stub that fails on refusal is logged, never thrown (the rejection itself stands)", async () => {
  useDataEntry({ refuseProposedEntry: async () => { throw new Error("audit store down"); } });
  await refusePending({ id: "p-5", kind: "data_entry", payload });
});
