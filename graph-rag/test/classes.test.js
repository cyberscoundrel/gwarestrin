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
  for (const t of ["list_classes", "relate_instance", "add_dependency", "read_dependencies"]) assert.ok(worker.includes(t), t);
  // the handler and the liaison: neither mints (R7)
  assert.deepEqual(names({ user: "admin/handler:1", role: { kind: "handler" } }), []);
  assert.deepEqual(names({ user: "admin/liaison:1", role: { kind: "liaison" } }), []);
});
