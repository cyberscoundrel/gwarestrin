import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { discoverIncremental, draftClasses } from "../src/discovery.js";
import { UX_DIGEST, UX_PATTERNS } from "./discovery-digest.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const confirmed = read("classes.json").classes.map((c) => ({ ...c, status: "confirmed" }));

test("a new table in the digest is one discovery event: one new draft, not a re-run", () => {
  const r = discoverIncremental(confirmed, { system: "mssql", table: { name: "dbo_Quote", columns: ["QuoteID", "CustomerID", "Status", "Price", "ValidUntil"], status_values: { Status: ["Sent", "Accepted", "Declined"] } } });
  assert.ok(r.draft, r.reason);
  assert.equal(r.draft.name, "quotes");
  assert.equal(r.draft.status, "proposed");
  assert.equal(r.draft.record_table, "mssql:dbo_Quote");
  assert.deepEqual(r.draft.stages, ["sent", "accepted", "declined"]);
  assert.deepEqual(r.draft.attributes, ["stage", "customer", "price", "valid_until"]);
  assert.match(r.draft.reasons.at(-1), /a new table since the last discovery pass/);
});

test("a table already recorded, retired or master data gives no draft, and says why", () => {
  const known = discoverIncremental(confirmed, { system: "mssql", table: "dbo_Order" });
  assert.equal(known.draft, null);
  assert.match(known.reason, /already the record table of "orders"/);
  assert.deepEqual(known.existing, { name: "orders", status: "confirmed" });
  const retired = discoverIncremental(
    confirmed.map((c) => (c.name === "orders" ? { ...c, status: "retired" } : c)),
    { system: "mssql", table: "dbo_Order" },
  );
  assert.equal(retired.draft, null);
  assert.match(retired.reason, /retired the class for mssql:dbo_Order; it is not drafted again/);
  const master = discoverIncremental(confirmed, { system: "mssql", table: { name: "dbo_Customer", columns: ["CustomerID", "Name"] } });
  assert.equal(master.draft, null);
  assert.match(master.reason, /master data: customers are actors/);
  assert.equal(master.skipped.role, "actor");
  // the same noun in a second system: the name is taken, a person decides
  const twin = discoverIncremental(confirmed, { system: "erp2", table: { name: "Orders", columns: ["Id", "State"] } });
  assert.equal(twin.draft, null);
  assert.match(twin.reason, /"orders" exists already \(mssql:dbo_Order\); a person decides whether erp2:Orders records it too/);
});

test("a proposed class a worker filed becomes a draft once, by that worker, never confirmed; a known name or table is declined", () => {
  const r = discoverIncremental(confirmed, { filed: { name: "shift swap", stages: ["asked", "agreed", "done"], reason: "three notes this week trade shifts with no row behind them" }, by: "worker:j1" });
  assert.ok(r.draft, r.reason);
  assert.equal(r.draft.name, "shift_swaps");
  assert.equal(r.draft.status, "proposed");
  assert.equal(r.draft.proposed_by, "worker:j1");
  assert.equal(r.draft.record_table, null);
  assert.equal(r.draft.confirmed_by, null);
  assert.deepEqual(r.draft.stages, ["asked", "agreed", "done"]);
  assert.match(r.draft.reasons.join(" | "), /filed by worker:j1.*three notes this week.*no source system records it/);
  const dup = discoverIncremental(confirmed, { filed: { name: "jobs" }, by: "worker:j2" });
  assert.equal(dup.draft, null);
  assert.match(dup.reason, /"jobs" is already confirmed/);
  const byTable = discoverIncremental(confirmed, { filed: { name: "work orders", record_table: "mssql:dbo_Job" }, by: "worker:j2" });
  assert.equal(byTable.draft, null);
  assert.match(byTable.reason, /mssql:dbo_Job is already the record table of "jobs"/);
  const again = discoverIncremental([...confirmed, { name: "shift_swaps", status: "retired", record_table: null }], { filed: { name: "shift swaps" }, by: "worker:j3" });
  assert.equal(again.draft, null);
  assert.match(again.reason, /retired "shift_swaps"; a worker filing it again changes nothing/);
  assert.equal(discoverIncremental(confirmed, { filed: {} }).reason, "a filed class needs a name");
  assert.match(discoverIncremental(confirmed, {}).reason, /nothing to discover/);
});

test("the first pass then one event: the event's draft is exactly what a re-run would add", () => {
  const first = draftClasses(UX_DIGEST, UX_PATTERNS).drafts;
  const quote = { name: "dbo_Quote", columns: ["QuoteID", "CustomerID", "Status"], status_values: { Status: ["Sent", "Accepted"] } };
  const rerun = draftClasses({ ...UX_DIGEST, tables: [...UX_DIGEST.tables, quote] }, UX_PATTERNS).drafts;
  const event = discoverIncremental(first, { system: "mssql", table: quote }).draft;
  const added = rerun.find((d) => !first.some((f) => f.name === d.name));
  assert.equal(added.name, event.name);
  assert.deepEqual(added.stages, event.stages);
  assert.deepEqual(added.attributes, event.attributes);
  assert.equal(added.record_table, event.record_table);
  // every other draft the first pass made is a no-op event
  for (const t of UX_DIGEST.tables) {
    const r = discoverIncremental(first, { system: "mssql", table: t });
    assert.equal(r.draft, null, `${t.name} again gives nothing`);
  }
});
