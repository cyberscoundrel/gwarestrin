import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { authorityOf, claimHome, claimHomes, decide, validatePolicy, visible } from "../src/model/authority.js";
import { normalizeDocument, claimsOf } from "../src/model/claims.js";
import { parsePositionMap } from "../src/positions.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const tree = read("positions.json");
const classes = read("classes.json");
//   org (admins only)
//    └ ops (Operations)
//       └ floor (Production floor)
const map = parsePositionMap(tree);
const policy = validatePolicy(read("policy.json"), map);
const { admin, alice, bob } = tree.identities;
const floorAgent = tree.identities["bob/agent:floor"];
// a sibling branch the batches don't have, for the hidden case
const wide = parsePositionMap({ ...tree, positions: { ...tree.positions, sales: { name: "Sales", parent: "org" } } });
const sam = { user: "sam", positions: ["sales"], caps: { write: "direct" } };

test("the policy resolves most specific first: class attribute, attribute, class, default, nothing", () => {
  assert.equal(authorityOf(policy, "orders", "price"), "org");
  assert.equal(authorityOf(policy, "orders", "quantity"), "ops");
  assert.equal(authorityOf(policy, "jobs", "pay"), "org", "pay is admins-only whatever the class");
  assert.equal(authorityOf(policy, "jobs", "shift_cover"), "floor");
  assert.equal(authorityOf(policy, "orders", "balance_due"), "ops", "customer financials are Ops's");
  assert.equal(authorityOf(policy, "visits", "date"), null, "no rule: the writer's own position");
  assert.equal(authorityOf({ ...policy, default: "org" }, "visits", "date"), "org");
  assert.equal(authorityOf(policy, null, "margin"), "org", "an attribute alone still resolves");
  assert.equal(authorityOf(null, "orders", "price"), null);
});

test("the rule: at or above the authority commits, below it proposes, beside it is hidden", () => {
  // a floor worker can promise a shift swap, not a price
  assert.equal(decide(bob, "jobs", "shift_cover", policy, map), "direct");
  assert.equal(decide(bob, "orders", "price", policy, map), "propose");
  assert.equal(decide(bob, "orders", "quantity", policy, map), "propose");
  assert.equal(decide(alice, "orders", "quantity", policy, map), "direct");
  assert.equal(decide(alice, "orders", "price", policy, map), "propose");
  assert.equal(decide(alice, "jobs", "shift_cover", policy, map), "direct", "ancestors always command down");
  assert.equal(decide(admin, "orders", "price", policy, map), "direct");
  assert.equal(decide(admin, "hires", "pay", policy, map), "direct");
  assert.equal(decide(sam, "jobs", "shift_cover", policy, wide), "hidden", "Sales neither commits the floor nor sees its swaps");
  assert.equal(decide(sam, "orders", "balance_due", policy, wide), "hidden");
  assert.equal(decide(sam, "orders", "price", policy, wide), "propose", "but may propose a price to the top");
  assert.equal(decide(bob, "visits", "date", policy, map), "direct", "no rule: anyone's own");
  assert.equal(decide({ positions: [] }, "jobs", "shift_cover", policy, map), "hidden", "no position: nothing");
  assert.equal(decide({ positions: ["ghost"] }, "jobs", "shift_cover", policy, map), "hidden");
  assert.equal(decide(bob, "jobs", "shift_cover", { classes: { jobs: { authority: "deleted" } } }, map), "propose", "an unknown authority fails upward to the root");
});

test("an identity whose writes are queued never commits directly", () => {
  assert.equal(decide(floorAgent, "jobs", "shift_cover", policy, map), "propose");
  assert.equal(decide(floorAgent, "orders", "price", policy, map), "propose");
  assert.equal(decide({ ...admin, caps: { write: "queued" } }, "visits", "date", policy, map), "propose");
  assert.equal(decide(sam, "jobs", "shift_cover", policy, wide), "hidden", "queuing never widens either");
});

test("reading 1, visibility: a claim is seen by those whose authority covers its class", () => {
  // a pay claim on the floor's own note is not the floor's to see
  assert.equal(visible(bob, "hires", "pay", policy, map), false);
  assert.equal(visible(alice, "hires", "pay", policy, map), false);
  assert.equal(visible(admin, "hires", "pay", policy, map), true);
  // customer financials: Ops and above
  assert.equal(visible(bob, "orders", "balance_due", policy, map), false);
  assert.equal(visible(alice, "orders", "balance_due", policy, map), true);
  assert.equal(visible(sam, "orders", "balance_due", policy, wide), false);
  // the floor's own work is the floor's to see, and its managers'
  assert.equal(visible(bob, "jobs", "machine", policy, map), true);
  assert.equal(visible(alice, "jobs", "machine", policy, map), true);
  assert.equal(visible(floorAgent, "jobs", "machine", policy, map), true, "seeing is by position, not by write capability");
});

test("reading 2, proposals: an agent proposes when it lacks authority to commit", () => {
  // the worker acting for alice enters an order quantity directly, proposes a price change
  const forAlice = { ...alice, user: "alice/agent:worker" };
  assert.equal(decide(forAlice, "orders", "quantity", policy, map), "direct");
  assert.equal(decide(forAlice, "orders", "price", policy, map), "propose");
  assert.equal(decide(forAlice, "hires", "dismissal", policy, map), "propose");
  // bob's agent, whose writes are queued, proposes even a shift cover; a person at the floor enters it
  assert.equal(decide(floorAgent, "jobs", "shift_cover", policy, map), "propose");
  assert.equal(decide(bob, "jobs", "shift_cover", policy, map), "direct");
});

test("reading 3, grading: a note is restricted where its claims commit or reveal above the writer", () => {
  const doc = normalizeDocument(
    {
      title: "Floor note",
      recorded_by: "bob",
      position: "floor",
      reason: "handover",
      recorded_at: "2026-11-04T14:00:00Z",
      sections: [
        {
          text: "Tomas covers nights on 4471. Toro's quote went to 18.50 a unit. Tomas's rate goes up to 24.",
          claims: [
            { kind: "commitment", subject: { key: "mssql:dbo_Job:4471", class: "jobs" }, attribute: "shift_cover", value: "Tomas, nights" },
            { kind: "state", subject: { key: "mssql:dbo_Order:9001", class: "orders" }, attribute: "price", value: 18.5 },
            { kind: "state", subject: { name: "Tomas", actor: "person" }, class: "hires", attribute: "pay", value: 24 },
            { kind: "state", subject: { key: "mssql:dbo_Order:9001", class: "orders" }, attribute: "quantity", value: 120 },
          ],
        },
      ],
    },
    { classes },
  );
  const claims = claimsOf(doc);
  // three claims at three sensitivities, not one blob
  assert.deepEqual(claimHomes(claims, "floor", policy, map), ["floor", "org", "org", "ops"]);
  assert.deepEqual(claims.map((c) => decide(bob, c.class, c.attribute, policy, map)), ["direct", "propose", "propose", "propose"]);
  // the section carrying them is homed no lower than its most restricted claim: the caller takes the strictest
  assert.equal(claimHome(map, "floor", null), "floor", "no rule: provenance alone");
  assert.equal(claimHome(wide, "sales", "floor"), "org", "a sales note about a floor matter is held where both are seen");
  assert.equal(claimHome(map, "ops", "floor"), "ops", "an ops note about floor work stays at ops: never below its writer");
});

test("the policy is checked against the tree, naming the field", () => {
  assert.throws(() => validatePolicy({ attributes: { pay: "board" } }, map), /attributes\.pay: unknown position board/);
  assert.throws(() => validatePolicy({ classes: { orders: { authority: "everyone" } } }, map), /classes\.orders\.authority: everyone holds no authority/);
  assert.throws(() => validatePolicy({ classes: { orders: { attributes: { price: "" } } } }, map), /classes\.orders\.attributes\.price: must name a position/);
  assert.throws(() => validatePolicy({ classes: { orders: { owner: "ops" } } }, map), /classes\.orders\.owner: unknown field/);
  assert.throws(() => validatePolicy({ topics: [] }, map), /topics: unknown field/);
  assert.throws(() => validatePolicy([], map), /policy: must be an object/);
  assert.deepEqual(validatePolicy({}, map), { classes: {}, attributes: {} });
  assert.deepEqual(validatePolicy(read("policy.json"), map), read("policy.json"), "the fixture is already normal");
});
