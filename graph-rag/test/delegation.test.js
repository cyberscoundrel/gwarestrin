import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgentToken, signAgentToken } from "../src/delegation.js";
import { parsePositionMap } from "../src/positions.js";

const map = parsePositionMap({
  root: "org",
  positions: {
    org: { name: "Organization" },
    ops: { name: "Ops manager", parent: "org" },
    floor: { name: "Production floor", parent: "ops" },
    sales: { name: "Sales", parent: "org" },
  },
});
const KEY = "k".repeat(64);
const entries = {
  alice: { user: "alice", delegationKey: KEY, caps: { read: true, write: "queued", approve: true, raw: true }, positions: ["ops"] },
  admin: { user: "admin", delegationKey: "a".repeat(64), caps: { read: true, write: "direct", approve: true, raw: true }, positions: ["org"] },
  nokey: { user: "nokey", caps: { read: true }, positions: ["ops"] },
};
const entryFor = (u) => entries[u];

test("an agent placed lower sees from there, and never approves or runs raw queries", () => {
  const id = resolveAgentToken(signAgentToken(KEY, { u: "alice", a: "agent-1234567890", p: ["floor"], iat: 1 }), entryFor, map);
  assert.deepEqual(id.positions, ["floor"]);
  assert.equal(id.user, "alice/agent:agent-12");
  assert.equal(id.key, "alice/agent:agent-1234567890", "read tracking uses the full agent id");
  assert.equal(id.caps.write, "queued");
  assert.equal(id.caps.approve, false);
  assert.equal(id.caps.raw, false);
});

test("no positions in the profile: the agent stands where its user stands", () => {
  const id = resolveAgentToken(signAgentToken(KEY, { u: "alice", a: "a1", p: [], iat: 1 }), entryFor, map);
  assert.deepEqual(id.positions, ["ops"]);
});

test("positions beyond the user's reach are dropped, even with a valid signature", () => {
  const id = resolveAgentToken(signAgentToken(KEY, { u: "alice", a: "a1", p: ["sales", "org", "floor"], iat: 1 }), entryFor, map);
  assert.deepEqual(id.positions, ["floor"]);
  const none = resolveAgentToken(signAgentToken(KEY, { u: "alice", a: "a1", p: ["sales"], iat: 1 }), entryFor, map);
  assert.deepEqual(none.positions, [], "nothing left = sees nothing (not the user's view)");
});

test("the root may place an agent anywhere", () => {
  const id = resolveAgentToken(signAgentToken("a".repeat(64), { u: "admin", a: "a1", p: ["sales"], iat: 1 }), entryFor, map);
  assert.deepEqual(id.positions, ["sales"]);
});

test("forged, foreign, tampered, keyless and expired tokens are refused", () => {
  const good = signAgentToken(KEY, { u: "alice", a: "a1", p: ["floor"], iat: 1 });
  assert.equal(resolveAgentToken(signAgentToken("x".repeat(64), { u: "alice", a: "a1", p: [], iat: 1 }), entryFor, map), null);
  assert.equal(resolveAgentToken(signAgentToken(KEY, { u: "admin", a: "a1", p: [], iat: 1 }), entryFor, map), null, "alice's key can't sign for admin");
  const [, body, sig] = good.split(".");
  const tampered = `gwa1.${Buffer.from(JSON.stringify({ u: "alice", a: "a1", p: ["ops"], iat: 1 })).toString("base64url")}.${sig}`;
  assert.equal(resolveAgentToken(tampered, entryFor, map), null);
  assert.equal(resolveAgentToken(`gwa1.${body}.${sig}.x`, entryFor, map), null);
  assert.equal(resolveAgentToken(signAgentToken("n".repeat(64), { u: "nokey", a: "a1", p: [], iat: 1 }), entryFor, map), null);
  assert.equal(resolveAgentToken(signAgentToken(KEY, { u: "alice", a: "a1", p: [], iat: 1, exp: 10 }), entryFor, map, 20_000), null);
  assert.equal(resolveAgentToken("not-a-token", entryFor, map), null);
});

test("without a position map an agent with a placement sees nothing", () => {
  const id = resolveAgentToken(signAgentToken(KEY, { u: "alice", a: "a1", p: ["floor"], iat: 1 }), entryFor, null);
  assert.deepEqual(id.positions, []);
});

test("graph worker roles: only the organization's admin can give them; anyone else's claim is ignored", () => {
  const job = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const w = resolveAgentToken(signAgentToken("a".repeat(64), { u: "admin", a: "worker-1234567", p: ["floor"], r: "worker", j: job, e: "#12:3", iat: 1 }), entryFor, map);
  assert.deepEqual(w.role, { kind: "worker", job, entry: "#12:3" });
  assert.equal(w.user, "admin/worker:worker-1");
  assert.deepEqual(w.positions, ["org"], "a worker sees the whole graph, whatever it asked for");
  assert.equal(w.caps.write, "queued", "its writes are proposals");
  assert.equal(w.caps.approve, false);
  assert.equal(w.caps.raw, true, "read-only raw queries (raw writes queue like any other)");
  const l = resolveAgentToken(signAgentToken("a".repeat(64), { u: "admin", a: "l1", p: [], r: "liaison", iat: 1 }), entryFor, map);
  assert.deepEqual(l.role, { kind: "liaison" });
  assert.equal(l.caps.write, "deny");
  assert.equal(l.caps.approve, true);
  // alice isn't the root: her claim gives an ordinary agent
  const a = resolveAgentToken(signAgentToken(KEY, { u: "alice", a: "a1", p: [], r: "worker", j: job, e: "#12:3", iat: 1 }), entryFor, map);
  assert.equal(a.role, undefined);
  assert.equal(a.caps.approve, false);
  assert.equal(a.caps.raw, false);
  const al = resolveAgentToken(signAgentToken(KEY, { u: "alice", a: "a1", p: [], r: "liaison", iat: 1 }), entryFor, map);
  assert.equal(al.role, undefined);
  // a malformed job or entry: no role
  const bad = resolveAgentToken(signAgentToken("a".repeat(64), { u: "admin", a: "a1", p: [], r: "worker", j: "x", e: "DROP", iat: 1 }), entryFor, map);
  assert.equal(bad.role, undefined);
});
