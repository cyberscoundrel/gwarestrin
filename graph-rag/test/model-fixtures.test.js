import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { authorityOf, validatePolicy } from "../src/model/authority.js";
import { classIndex } from "../src/model/claims.js";
import { CLASS_STATUSES, parseTable, recordKey } from "../src/model/schema.js";
import { parsePositionMap } from "../src/positions.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

test("positions.json is the batches' tree: floor under Ops under admins-only, with identities at each", () => {
  const tree = read("positions.json");
  const map = parsePositionMap(tree);
  assert.equal(map.root, "org");
  assert.equal(map.positions.ops.parent, "org");
  assert.equal(map.positions.floor.parent, "ops");
  for (const [name, id] of Object.entries(tree.identities)) {
    assert.ok(Array.isArray(id.positions) && id.positions.every((p) => map.positions[p]), `${name} holds known positions`);
    assert.ok(["direct", "queued"].includes(id.caps.write), `${name} caps`);
  }
});

test("classes.json: four confirmed classes with ordered stages and parseable record tables", () => {
  const classes = read("classes.json");
  const idx = classIndex(classes);
  assert.deepEqual([...idx.keys()], ["orders", "jobs", "hires", "maintenance"]);
  for (const c of idx.values()) {
    assert.ok(Array.isArray(c.stages) && c.stages.length >= 3, `${c.name} stages`);
    assert.equal(new Set(c.stages).size, c.stages.length, `${c.name} stages unique`);
    assert.ok(c.attributes.includes("stage"), `${c.name} has the stage attribute`);
    assert.ok(c.confirmed_by && c.confirmed_at, `${c.name} confirmed`);
    if (c.record_table !== null) assert.ok(parseTable(c.record_table), `${c.name} record table`);
    assert.ok(!c.status || CLASS_STATUSES.includes(c.status));
  }
  assert.equal(recordKey(idx.get("orders"), "9001"), "mssql:dbo_Order:9001");
  assert.equal(recordKey(idx.get("hires"), "1"), null, "hires have no source system");
});

test("policy.json: pay, dismissal, price and margin are admins-only; customer financials are Ops's; it checks against the tree", () => {
  const map = parsePositionMap(read("positions.json"));
  const policy = validatePolicy(read("policy.json"), map);
  for (const a of ["pay", "dismissal", "price", "margin"]) assert.equal(authorityOf(policy, "orders", a), "org", a);
  for (const a of ["credit_limit", "balance_due", "payment_terms"]) assert.equal(authorityOf(policy, "orders", a), "ops", a);
  const classes = classIndex(read("classes.json"));
  for (const c of Object.keys(policy.classes)) assert.ok(classes.has(c), `policy class ${c} is a confirmed class`);
});
