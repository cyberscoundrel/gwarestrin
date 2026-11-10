// Who gets the class tools (R5, R7): the orchestrator makes classes, a worker relates instances to the ones
// that exist, a person's chat agent deals in text and gets none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerClassTools } from "../src/routes-classes.js";

function names(identity) {
  const got = [];
  registerClassTools({ tool: (name) => void got.push(name) }, { identity, scope: { homes: null }, need: () => {} });
  return got.sort();
}

test("a person's chat agent gets no class tools: classes are never negotiated in a conversation (R5)", () => {
  assert.deepEqual(names({ user: "alice/agent:1", agent: "1" }), []);
  assert.deepEqual(names({ user: "alice" }), []);
});

test("only the orchestrator creates or changes classes (R5, R7)", () => {
  const master = names({ user: "admin/master:1", role: { kind: "master" } });
  assert.ok(master.includes("create_class") && master.includes("update_class") && master.includes("start_discovery_worker"));
  const worker = names({ user: "admin/worker:1", role: { kind: "worker", entry: "#1:1", job: "j" } });
  assert.ok(!worker.includes("create_class") && !worker.includes("update_class") && !worker.includes("start_discovery_worker"));
  // the handler and the liaison: neither mints (R7)
  assert.deepEqual(names({ user: "admin/handler:1", role: { kind: "handler" } }), []);
  assert.deepEqual(names({ user: "admin/liaison:1", role: { kind: "liaison" } }), []);
});

test("a filing worker gets reads only here: filing's own tools make its instances and dependencies, through instances.js (review C-B7)", () => {
  const worker = names({ user: "admin/worker:1", role: { kind: "worker", entry: "#1:1", job: "j" } });
  assert.deepEqual(worker, ["list_classes", "read_dependencies"]);
});

test("a discovery part's worker, by its token's claim, relates instances and reads the history; the orchestrator does both and makes classes", () => {
  const part = names({ user: "admin/worker:2", role: { kind: "worker", entry: "#1:2", job: "j", discovery: true, run: "r1" } });
  assert.deepEqual(part, ["add_dependency", "list_classes", "new_tables", "read_dependencies", "read_history", "record_examined", "relate_instance"]);
  const master = names({ user: "admin/master:1", role: { kind: "master" } });
  for (const t of ["create_class", "update_class", "relate_instance", "add_dependency", "start_discovery_worker"]) assert.ok(master.includes(t), t);
});

test("a worker on a discovery part's entry acts in its run though its token carries no claim (re-review of c1323a3, non-blocking 3)", async () => {
  const { withDiscoveryRole } = await import("../src/classes.js");
  const parts = { "#7:1": { run: "run-1", home: "floor" } };
  const partOf = async (rid) => parts[rid] ?? null;
  const part = await withDiscoveryRole({ user: "admin/worker:1", role: { kind: "worker", job: "j", entry: "#7:1" } }, { partOf });
  assert.deepEqual(part.role, { kind: "worker", job: "j", entry: "#7:1", discovery: true, run: "run-1" });
  // its tools follow: a part's, listed
  const got = [];
  registerClassTools({ tool: (name) => void got.push(name) }, { identity: part, scope: { homes: null }, need: () => {} });
  assert.ok(got.includes("relate_instance") && got.includes("read_history"));
  // a filing worker's entry isn't a part: nothing changes; nor for the orchestrator or a person
  const filing = await withDiscoveryRole({ user: "admin/worker:2", role: { kind: "worker", job: "j", entry: "#7:2" } }, { partOf });
  assert.equal(filing.role.discovery, undefined);
  const master = await withDiscoveryRole({ user: "admin/master:1", role: { kind: "master" } }, { partOf });
  assert.deepEqual(master.role, { kind: "master" });
  assert.equal((await withDiscoveryRole({ user: "alice" }, { partOf })).role, undefined);
});
