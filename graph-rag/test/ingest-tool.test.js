// The record tool's registration (record-tools.js): its name is what the harness looks for, its schema
// takes the contract's document and refuses what isn't one before the ingest path sees it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { documentShape, RECORD_TOOL, registerRecordTools } from "../src/record-tools.js";

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
  assert.ok(schema.safeParse({ document: { ...doc, sections: [] } }).success === false, "needs a section");
  assert.ok(schema.safeParse({ document: { ...doc, reason: undefined } }).success === false, "needs a reason");
  assert.ok(documentShape.safeParse({ ...doc, sections: [{ text: "free text, no claims" }] }).success, "a section may carry no claims");
  assert.ok(documentShape.safeParse({ ...doc, sections: [{ text: "x", claims: [{ kind: "wish", subject: "a", attribute: "b", value: "c" }] }] }).success === false, "a claim is one of the four primitives");
});
