// The record tool's registration (record-tools.js): its name is what the harness looks for, its schema
// takes the contract's document and refuses what isn't one before the ingest path sees it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { documentShape, RECORD_TOOL, registerRecordTools } from "../src/record-tools.js";
import { prepareRecord, recordId } from "../src/documents.js";
import { applyThreadRecord, gateOffRecordTools, isOffRecord, OFF_RECORD_TOOLS } from "../src/record-state.js";

test("the record stamp: who, where and when are the server's, whatever the document or a claim says", () => {
  const raw = { title: "T", recorded_by: "admin", position: "org", recorded_at: "2020-01-01T00:00:00Z", reason: "r", sections: [{ text: "x", claims: [{ kind: "state", subject: { name: "a", class: "jobs" }, attribute: "stage", value: "planned", recorded_by: "admin", recorded_at: "2020-01-01T00:00:00Z" }] }] };
  const stamped = prepareRecord(raw, { now: Date.parse("2026-11-09T10:00:00Z"), stamp: { recorded_by: "bob", position: "floor", recorded_at: "2026-11-09T10:00:00.000Z" } });
  assert.equal(stamped.recorded_by, "bob");
  assert.equal(stamped.position, "floor");
  assert.equal(stamped.recorded_at, "2026-11-09T10:00:00.000Z");
  assert.equal(stamped.sections[0].claims[0].recorded_by, "bob");
  assert.equal(stamped.sections[0].claims[0].recorded_at, "2026-11-09T10:00:00.000Z");
  // without a stamp (open mode, and what the oracle tests feed) the document's word stands
  assert.equal(prepareRecord(raw, {}).position, "org");
});

test("a document's id: the same re-send is the same record, a different document or person isn't", () => {
  const doc = { title: "T", recorded_at: "2026-11-09T10:00:00Z", sections: [{ text: "x", claims: [{ kind: "state", attribute: "a", value: 1 }] }] };
  const same = { sections: [{ text: "x", claims: [{ value: 1, attribute: "a", kind: "state", recorded_by: "someone", recorded_at: "2099-01-01T00:00:00Z" }] }], title: "T", recorded_at: "2099-01-01T00:00:00Z" };
  const at = { person: "bob", home: "floor", title: "T" };
  assert.equal(recordId(doc, at), recordId(same, at), "key order and the server's stamps don't change it");
  assert.notEqual(recordId(doc, at), recordId({ ...doc, sections: [{ text: "y", claims: [] }] }, at), "another text is another document");
  assert.notEqual(recordId(doc, at), recordId(doc, { ...at, person: "alice" }), "another person's identical note is theirs");
});

test("off record: a chat agent is refused until its thread is on record; only chat agents are gated", () => {
  const chat = { agent: "a1", key: "admin/agent:a1", caps: { write: "direct" } };
  assert.equal(isOffRecord(chat), true, "never heard of: off record");
  applyThreadRecord("admin", "a1", { on: true, thread: "t1" });
  assert.equal(isOffRecord(chat), false);
  applyThreadRecord("admin", "a1", { on: false, thread: "t1" });
  assert.equal(isOffRecord(chat), true, "switched off: refused again");
  assert.equal(isOffRecord({ agent: "w", key: "admin/agent:w", role: { kind: "worker" } }), false, "a worker isn't a conversation");
  assert.equal(isOffRecord({ user: "bob", caps: {} }), false, "a person's own token isn't an agent's");
  assert.equal(isOffRecord({ agent: "a1", key: "other/agent:a1", caps: {} }), true, "another tenant's state is another thread");
});

test("off record, a tool no one has classified is refused at the call; a read isn't; a worker's tools aren't wrapped", async () => {
  const calls = [];
  const fakeServer = () => ({ handlers: {}, tool(name, ...rest) { this.handlers[name] = rest.at(-1); } });
  const chat = { agent: "gate-1", key: "admin/agent:gate-1", caps: { write: "direct" } };
  const s = gateOffRecordTools(fakeServer(), chat);
  s.tool("a_new_write_tool", "d", {}, async (a) => (calls.push(a), "done"));
  s.tool("search_graph", "d", {}, async () => "read");
  await assert.rejects(s.handlers.a_new_write_tool({ x: 1 }), /off record/);
  assert.equal(calls.length, 0, "the handler is never reached");
  assert.equal(await s.handlers.search_graph({}), "read");
  assert.ok(!OFF_RECORD_TOOLS.has("request_access"), "a question goes into the graph");
  applyThreadRecord("admin", "gate-1", { on: true, thread: "t" });
  assert.equal(await s.handlers.a_new_write_tool({ x: 1 }), "done", "the same registration, the thread on record: it runs");
  applyThreadRecord("admin", "gate-1", { on: false, thread: "t" });
  await assert.rejects(s.handlers.a_new_write_tool({ x: 2 }), /off record/, "switched off with the same server: refused");
  const worker = gateOffRecordTools(fakeServer(), { agent: "w", key: "admin/agent:w", role: { kind: "worker" } });
  worker.tool("a_new_write_tool", "d", {}, async () => "worker");
  assert.equal(await worker.handlers.a_new_write_tool({}), "worker");
});

test("record_document registers with a name the harness recognizes and a document schema in the contract's shape", () => {
  const tools = [];
  registerRecordTools({ tool: (name, description, shape, handler) => tools.push({ name, description, shape, handler }) }, { identity: {}, scope: {}, need: () => {} });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, RECORD_TOOL);
  assert.match(tools[0].name, /condens|on_record|record_document/);
  assert.match(tools[0].description, /On record/);
  const schema = z.object(tools[0].shape);
  const doc = {
    title: "Thursday handover",
    reason: "handover",
    sections: [{ heading: "Job 4471", text: "Job 4471 is running.", claims: [{ kind: "state", subject: "mssql:dbo_Job:4471", class: "jobs", attribute: "stage", value: "running" }] }],
  };
  assert.ok(schema.safeParse({ document: doc }).success);
  assert.ok(schema.safeParse({ document: "a string isn't a document" }).success === false, "a document is an object");
  assert.ok(documentShape.safeParse({ ...doc, sections: [{ text: "free text, no claims" }] }).success, "a section may carry no claims");
});

test("record_document takes what the contract takes, null dates included, and the contract names what it refuses", () => {
  const tools = [];
  registerRecordTools({ tool: (name, description, shape, handler) => tools.push({ name, shape }) }, { identity: {}, scope: {}, need: () => {} });
  const schema = z.object(tools[0].shape);
  const withNulls = { title: "Note", reason: "r", sections: [{ text: "Press 3 is down.", claims: [{ kind: "state", subject: { name: "press 3", class: "jobs" }, attribute: "condition", value: "down", valid_from: null, valid_until: null, at: null, heading: null }] }] };
  assert.ok(schema.safeParse({ document: withNulls }).success, "the schema does not refuse the oracle's null dates");
  assert.equal(prepareRecord(withNulls, { recorded_by: "bob", position: "floor", now: Date.parse("2026-11-04T12:00:00Z") }).sections[0].claims[0].valid_from, "2026-11-04T12:00:00.000Z");
  assert.throws(() => prepareRecord({ title: "T", reason: "r", recorded_by: "bob", position: "floor", sections: [{ text: "x", claims: [{ kind: "wish", subject: "a", attribute: "b", value: "c" }] }] }, {}), /sections\[0\]\.claims\[0\]\.kind/, "what the contract refuses names its field, at the tool as well as ingest_document");
});
