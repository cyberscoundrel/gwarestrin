import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  attributeName,
  bareName,
  classFor,
  classifyTable,
  className,
  classRow,
  confirmedClass,
  draftClasses,
  fileDraftSql,
  parseDigest,
  patternClasses,
  singular,
  stageName,
} from "../src/discovery.js";
import { CLASS_STATUSES, parseTable, TYPES } from "../src/model/schema.js";
import { UX_DIGEST, UX_DIGEST_TEXT, UX_PATTERNS } from "./discovery-digest.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));


test("names: a table's bare noun, its singular, the class name and the attribute names", () => {
  assert.equal(bareName("dbo_PurchaseOrder"), "purchase order");
  assert.equal(bareName("tblWorkCenter"), "work center");
  assert.equal(bareName("SalesOrders"), "sales orders");
  assert.equal(singular("orders"), "order");
  assert.equal(singular("categories"), "category");
  assert.equal(singular("maintenance"), "maintenance");
  assert.equal(singular("status"), "status");
  assert.equal(className("order"), "orders");
  assert.equal(className("purchase order"), "purchase_orders");
  assert.equal(className("maintenance"), "maintenance");
  assert.equal(className("hires"), "hires");
  assert.equal(className("Delivery"), "deliveries");
  assert.equal(attributeName("CustomerID"), "customer");
  assert.equal(attributeName("DueDate"), "due_date");
  assert.equal(attributeName("Qty"), "quantity");
  assert.equal(attributeName("ID"), "id");
  assert.equal(stageName("In Production"), "in_production");
});

test("a table is a class, master data (actors or resources), a lookup, or unknown until a person says", () => {
  assert.equal(classifyTable({ name: "dbo_Order" }).kind, "class");
  assert.equal(classifyTable({ name: "dbo_PurchaseOrder" }).kind, "class");
  assert.equal(classifyTable({ name: "dbo_Quote" }).kind, "class");
  assert.equal(classifyTable({ name: "dbo_Operation" }).kind, "class");
  assert.equal(classifyTable({ name: "dbo_PO" }).kind, "class");
  const cust = classifyTable({ name: "dbo_Customer" });
  assert.equal(cust.kind, "master");
  assert.equal(cust.role, "actor");
  assert.match(cust.reasons[0], /actors, seeded as things by key, not a class/);
  const wc = classifyTable({ name: "dbo_WorkCenter" });
  assert.equal(wc.kind, "master");
  assert.equal(wc.role, "resource");
  assert.equal(classifyTable({ name: "dbo_Employee" }).role, "actor");
  assert.equal(classifyTable({ name: "dbo_Vendor" }).role, "actor");
  assert.equal(classifyTable({ name: "dbo_OrderStatus" }).kind, "lookup");
  // no known noun: a status and a date make it transaction-shaped
  const shaped = classifyTable({ name: "dbo_Zorp", columns: ["ZorpID", "ZorpStatus", "DueDate"] });
  assert.equal(shaped.kind, "class");
  assert.match(shaped.reasons[0], /status column \(ZorpStatus\) and dates \(DueDate\)/);
  assert.equal(classifyTable({ name: "dbo_Zorp", columns: ["ZorpID", "Name"] }).kind, "unknown");
});

test("the ux tree's digest drafts the fixture's classes: names, stages, record tables and attributes agree, all proposed, none confirmed", () => {
  const expected = read("classes.json").classes;
  const { drafts, skipped } = draftClasses(UX_DIGEST, UX_PATTERNS);
  assert.deepEqual(
    drafts.map((d) => d.name).sort(),
    expected.map((c) => c.name).sort(),
  );
  for (const c of expected) {
    const d = drafts.find((x) => x.name === c.name);
    assert.deepEqual(d.stages, c.stages, `${c.name} stages`);
    assert.equal(d.record_table, c.record_table, `${c.name} record table`);
    assert.deepEqual(d.attributes, c.attributes, `${c.name} attributes`);
    assert.equal(d.status, "proposed");
    assert.equal(d.confirmed_by, null);
    assert.equal(d.confirmed_at, null);
    assert.equal(d.proposed_by, "discovery");
    assert.ok(d.description, `${c.name} has a description`);
    assert.ok(d.reasons.length >= 2, `${c.name} says why`);
    if (c.record_table) assert.ok(parseTable(d.record_table));
  }
  assert.equal(drafts.find((d) => d.name === "hires").description, "a hire: a commitment of a position to a person; no source system records it");
  assert.match(drafts.find((d) => d.name === "hires").reasons.join(" "), /pattern entry "mssql: hiring \(pattern\)"/);
  assert.match(drafts.find((d) => d.name === "orders").reasons.join(" "), /9,120 rows: instances, referenced by key, never copied/);
  // master data is said to be actors or resources, not classes
  const by = Object.fromEntries(skipped.map((s) => [s.table, s]));
  assert.equal(by.dbo_Customer.role, "actor");
  assert.equal(by.dbo_Employee.role, "actor");
  assert.equal(by.dbo_Vendor.role, "actor");
  assert.equal(by.dbo_WorkCenter.role, "resource");
  assert.equal(by.dbo_Material.role, "resource");
  assert.equal(by.dbo_OrderStatus.kind, "lookup");
  assert.match(by.dbo_Customer.reasons[0], /master data/);
  assert.equal(by.dbo_Customer.record_table, "mssql:dbo_Customer");
});

test("stages wait for a person when the status column's values were not read; two tables for one noun are not two classes", () => {
  const { drafts, skipped } = draftClasses({ system: "erp", tables: [{ name: "dbo_Order", columns: ["OrderID", "Status"] }, { name: "dbo_SalesOrder", columns: ["SalesOrderID", "Status"] }, { name: "dbo_Orders", columns: ["Id"] }] });
  assert.deepEqual(drafts.map((d) => d.name), ["orders", "sales_orders"]);
  assert.deepEqual(drafts[0].stages, []);
  assert.match(drafts[0].reasons.join(" "), /read its distinct values \(aggregate_records, groupby Status\)/);
  assert.equal(skipped[0].kind, "duplicate");
  assert.match(skipped[0].reasons[0], /already drafted from erp:dbo_Order/);
});

test("the connection digest an agent gets parses back into tables, columns, counts and status values", () => {
  const text = [
    "Tables (5, all named dbo_…): Customer, Job, Order, Vendor, OrderStatus",
    "dbo_Job columns: JobID, CustomerID, Status, DueDate, …",
    "dbo_Order columns: OrderID, CustomerID, Status, DueDate",
    "dbo_Order rows: 9,120",
    "dbo_Order Status values: Quoted, Ordered, Shipped",
    "- dbo_Vendor: VendorID, Name",
    "- … and 3 more",
    "something else entirely",
  ].join("\n");
  const d = parseDigest(text, "mssql");
  assert.equal(d.system, "mssql");
  assert.deepEqual(
    d.tables.map((t) => t.name),
    ["dbo_Customer", "dbo_Job", "dbo_Order", "dbo_Vendor", "dbo_OrderStatus"],
  );
  assert.deepEqual(d.tables[1].columns, ["JobID", "CustomerID", "Status", "DueDate"]);
  assert.equal(d.tables[2].rows, 9120);
  assert.deepEqual(d.tables[2].status_values, { Status: ["Quoted", "Ordered", "Shipped"] });
  assert.deepEqual(d.tables[3].columns, ["VendorID", "Name"]);
  const { drafts } = draftClasses(d);
  assert.deepEqual(drafts.map((x) => x.name), ["jobs", "orders"]);
  assert.deepEqual(drafts[1].stages, ["quoted", "ordered", "shipped"]);
  assert.equal(drafts[1].record_table, "mssql:dbo_Order");
});

test("a pattern entry's tag names a class, its stages, its table and its attributes; prose without a tag names nothing", () => {
  const got = patternClasses([{ name: "p1", text: "Quotes go out and come back. [class: quote; stages: sent, accepted or declined; table: dbo_Quote]" }, { name: "p2", text: "TORO is the biggest customer." }], "mssql");
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "quotes");
  assert.deepEqual(got[0].stages, ["sent", "accepted", "declined"]);
  assert.equal(got[0].record_table, "mssql:dbo_Quote");
  assert.equal(got[0].attributes, null);
  assert.equal(got[0].source, "p1");
  // a tag for a table already drafted adds to that draft rather than making a second class
  const { drafts } = draftClasses({ system: "mssql", tables: [{ name: "dbo_Quote", columns: ["QuoteID", "Status", "Price"] }] }, [{ name: "p1", text: "[class: quotes; stages: sent, accepted, declined]" }]);
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].stages, ["sent", "accepted", "declined"]);
  assert.match(drafts[0].reasons.join(" "), /stages from the survey's pattern entry "p1"/);
});

test("a record key maps to a class only once a person confirmed it", () => {
  const { drafts } = draftClasses(UX_DIGEST, UX_PATTERNS);
  assert.equal(classFor("mssql:dbo_Order:9001", drafts), null, "a proposed class maps nothing");
  assert.equal(confirmedClass("orders", drafts), null);
  const confirmed = drafts.map((d) => (d.name === "orders" ? { ...d, status: "confirmed", confirmed_by: "admin", confirmed_at: "2026-11-08T00:00:00.000Z" } : d));
  assert.equal(classFor("mssql:dbo_Order:9001", confirmed)?.name, "orders");
  assert.equal(classFor("mssql:dbo_Order", confirmed)?.name, "orders", "a table maps too");
  assert.equal(classFor("mssql:dbo_Job:4471", confirmed), null, "jobs is still proposed");
  assert.equal(confirmedClass("orders", confirmed)?.confirmed_by, "admin");
  const retired = drafts.map((d) => (d.name === "orders" ? { ...d, status: "retired" } : d));
  assert.equal(classFor("mssql:dbo_Order:9001", retired), null, "a retired class maps nothing");
  // the fixture's classes, with no status but a confirmer, count as confirmed
  assert.equal(classFor("mssql:dbo_Job:4471", read("classes.json"))?.name, "jobs");
  assert.equal(classFor("not a key", confirmed), null);
});

test("a draft becomes a CommitmentClass row with the contract's properties, and files as one SQL statement that never confirms", () => {
  const { drafts } = draftClasses(UX_DIGEST, UX_PATTERNS);
  const row = classRow(drafts.find((d) => d.name === "orders"));
  for (const p of Object.keys(TYPES.CommitmentClass.properties)) assert.ok(p in row, `row has ${p}`);
  assert.ok(CLASS_STATUSES.includes(row.status));
  assert.equal(row.status, "proposed");
  assert.throws(() => classRow({ ...drafts[0], status: "approved" }), /status must be one of/);
  const sql = fileDraftSql({ ...drafts.find((d) => d.name === "orders"), status: "confirmed", confirmed_by: "someone", description: "it's an order" });
  assert.match(sql, /^INSERT INTO CommitmentClass SET /);
  assert.match(sql, /status = 'proposed'/);
  assert.match(sql, /confirmed_by = null/);
  assert.match(sql, /description = 'it\\'s an order'/);
  assert.match(sql, /stages = \['quoted', 'ordered', 'in_production', 'shipped', 'invoiced', 'paid'\]/);
  assert.match(sql, /record_table = 'mssql:dbo_Order'/);
  assert.ok(!sql.includes(";"), "one statement");
});

test("the loader: the digest text an agent gets drafts the same classes as the structured digest", () => {
  const fromText = draftClasses(parseDigest(UX_DIGEST_TEXT, "mssql"), UX_PATTERNS).drafts;
  const fromData = draftClasses(UX_DIGEST, UX_PATTERNS).drafts;
  assert.deepEqual(
    fromText.map((d) => [d.name, d.stages, d.record_table, d.attributes]),
    fromData.map((d) => [d.name, d.stages, d.record_table, d.attributes]),
  );
});
