import assert from "node:assert/strict";
import { test } from "node:test";
import { surveyBrief } from "../src/pool.js";
import { draftClasses, fileDraftSql, patternClasses } from "../src/discovery.js";
import { TYPES } from "../src/model/schema.js";
import { UX_DIGEST } from "./discovery-digest.js";

test("the survey brief drafts classes as proposed CommitmentClass vertices through execute_graph, and never confirms one", () => {
  const b = surveyBrief("mssql", "production");
  assert.match(b, /5\. Draft the commitment classes/);
  assert.match(b, /graph-rag_execute_graph/);
  assert.match(b, /INSERT INTO CommitmentClass SET /);
  assert.match(b, /status = 'proposed'/);
  assert.match(b, /record_table = 'mssql:<table>'/);
  assert.match(b, /proposed_by = 'survey:mssql'/);
  assert.match(b, /Never write status = 'confirmed', never set confirmed_by or confirmed_at/);
  assert.match(b, /master-data tables \(customers, employees, vendors, work centers, materials\) are actors or resources/);
  assert.match(b, /a person confirms, renames or retires classes in Organization settings/);
  // the brief's statement names every property the contract gives the class vertex
  const tmpl = /INSERT INTO CommitmentClass SET ([^\n]+)/.exec(b)[1];
  for (const p of Object.keys(TYPES.CommitmentClass.properties)) assert.match(tmpl, new RegExp(`\\b${p} = `), `the brief sets ${p}`);
  // the survey's earlier steps are untouched
  assert.match(b, /mssql: dbo_Customer \(customers\)/);
  assert.match(b, /Stay within roughly 150 tool calls/);
});

test("the tag the brief asks for in a pattern entry is the one discovery reads", () => {
  const b = surveyBrief("mssql");
  const tag = /\[class: [^\]]+\]/.exec(b)[0];
  const got = patternClasses([{ name: "mssql: hiring (pattern)", text: `Hiring happens outside the ERP. ${tag}` }], "mssql");
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "hires");
  assert.deepEqual(got[0].stages, ["opened", "interviewing", "offered", "hired", "declined"]);
  assert.equal(got[0].record_table, null);
  assert.equal(got[0].description, "a hire: a commitment of a position to a person");
});

test("what the brief asks a thread to write is what discovery's own filing writes", () => {
  const b = surveyBrief("mssql");
  const tmpl = /INSERT INTO CommitmentClass SET ([^\n]+)/.exec(b)[1];
  const keys = (s) => [...s.matchAll(/(?:^|, )([a-z_]+) = /g)].map((m) => m[1]).sort();
  const { drafts } = draftClasses(UX_DIGEST);
  assert.deepEqual(keys(fileDraftSql(drafts[0]).replace(/^INSERT INTO CommitmentClass SET /, "")), keys(tmpl));
});
