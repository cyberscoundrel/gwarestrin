// What stays of discovery's pure code (discovery.js): reading what a survey saw. The drafting by table-name
// word lists and the drafts a person confirmed are gone (R3, R5).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as discovery from "../src/discovery.js";

test("a digest reads into tables with their columns, rows and status values", () => {
  const d = discovery.parseDigest(
    ["Tables (3, all named dbo_…): Job, Customer, Employee", "dbo_Job columns: Job, Customer, Status, Due_Date", "dbo_Job rows: 31,204", "dbo_Job Status values: Planned, Running, Done", "- dbo_Customer: Customer, Name"].join("\n"),
    "mssql",
  );
  assert.equal(d.system, "mssql");
  const job = d.tables.find((t) => t.name === "dbo_Job");
  assert.deepEqual(job.columns, ["Job", "Customer", "Status", "Due_Date"]);
  assert.equal(job.rows, 31204);
  assert.deepEqual(job.status_values, { Status: ["Planned", "Running", "Done"] });
  assert.deepEqual(d.tables.find((t) => t.name === "dbo_Customer").columns, ["Customer", "Name"]);
});

test("a survey report keeps only its lines in the digest's grammar", () => {
  const r = discovery.reportDigest("- Jobs: 31k open\n- `dbo_Job rows: 31,204`\ndbo_Job Status values: Planned, Done\nsomething else");
  assert.equal(r, "dbo_Job rows: 31,204\ndbo_Job Status values: Planned, Done");
});

test("no word lists and no drafting are left (R3, R5)", () => {
  for (const gone of ["TRANSACTION_NOUNS", "MASTER_NOUNS", "classifyTable", "draftClasses", "confirmedClass", "fileDraftSql"]) assert.equal(gone in discovery, false, gone);
});

// ---- discovery by the orchestrator, read-only by tools (R11, R8, R9) ----
import { parsePositionMap } from "../src/positions.js";
import { readFileSync } from "node:fs";

const positions = parsePositionMap(JSON.parse(readFileSync(new URL("./fixtures/positions.json", import.meta.url), "utf8")));

/** a stand-in for the MCP server: records what is registered and lets a test call it */
function fakeServer() {
  const tools = new Map();
  return { tools, tool: (name, ...rest) => void tools.set(name, rest[rest.length - 1]) };
}

test("a discovery identity is given only read tools, the class tree and instances: no write to any source (R11)", () => {
  const server = discovery.gateDiscoveryTools(fakeServer(), { role: { kind: "master", discovery: true, run: "r1" } });
  for (const name of ["search_graph", "list_classes", "create_class", "relate_instance", "read_history", "record_examined", "start_discovery_worker"]) server.tool(name, {}, async () => "ok");
  for (const name of ["upsert_entities", "execute_graph", "set_home", "ingest_document", "query_graph", "decide_proposal", "start_worker", "file_piece", "enter_data", "record_document", "grant_access"]) server.tool(name, {}, async () => "ok");
  assert.deepEqual([...server.tools.keys()].sort(), ["create_class", "list_classes", "read_history", "record_examined", "relate_instance", "search_graph", "start_discovery_worker"]);
});

test("a worker on a discovery part is refused anything else at the call; other workers are untouched", async () => {
  const parts = new Set(["#9:1"]);
  const gate = (entry) => discovery.gateDiscoveryTools(fakeServer(), { role: { kind: "worker", entry } }, { isDiscoveryEntry: async (rid) => parts.has(rid) });
  const part = gate("#9:1");
  part.tool("upsert_entities", {}, async () => "wrote");
  part.tool("relate_instance", {}, async () => "related");
  await assert.rejects(part.tools.get("upsert_entities")(), /discovery is read-only/);
  assert.equal(await part.tools.get("relate_instance")(), "related");
  const filing = gate("#9:2");
  filing.tool("upsert_entities", {}, async () => "wrote");
  assert.equal(await filing.tools.get("upsert_entities")(), "wrote");
  // not a discovery identity at all: the gate changes nothing
  const chat = discovery.gateDiscoveryTools(fakeServer(), { user: "alice" });
  chat.tool("upsert_entities", {}, async () => "wrote");
  assert.equal(await chat.tools.get("upsert_entities")(), "wrote");
});

test("a connection's home comes from CONNECTION_HOMES; one with none counts as the root (null)", () => {
  const homes = discovery.connectionHomes('{"synthetic":"everyone","erp":"ops","bad":3}');
  assert.deepEqual(homes, { synthetic: "everyone", erp: "ops" });
  assert.equal(discovery.connectionHome("synthetic", homes), "everyone");
  assert.equal(discovery.connectionHome("other", homes), null);
  assert.deepEqual(discovery.connectionHomes("not json"), {});
});

const notes = [
  { id: "n-floor", title: "CNC 3 down", text: "Spindle on CNC 3 replaced; the lease on the north building runs out", home: "floor" },
  { id: "n-org", title: "Pay review", text: "pay bands for the north building crew", home: "org" },
  { id: "n-none", text: "a note with no home" },
  { bad: true },
];

test("the history is read-only notes, each seen only where its home allows (R8)", () => {
  const all = discovery.parseHistory({ notes });
  assert.equal(all.length, 3);
  const floor = discovery.readHistory({ query: "north building" }, { positions, homes: new Set(["floor", "everyone"]) }, all);
  assert.deepEqual(floor.notes.map((n) => n.id), ["n-floor"]);
  assert.equal(floor.total, 1, "a note above the reader isn't counted either");
  const top = discovery.readHistory({ query: "north building" }, { positions, homes: null }, all);
  assert.deepEqual(top.notes.map((n) => n.id), ["n-floor", "n-org"]);
  // a note with no home is the root's
  assert.equal(discovery.noteHome("n-none", positions, all), "org");
  assert.equal(discovery.noteHome("n-floor", positions, all), "floor");
  assert.equal(discovery.noteHome("missing", positions, all), null);
});

test("new tables are the ones no run examined (R9)", () => {
  const d = { system: "mssql", tables: [{ name: "dbo_Job" }, { name: "dbo_Lease" }] };
  assert.deepEqual(discovery.newTables(d, new Set(["mssql:dbo_job"])).map((t) => t.name), ["dbo_Lease"]);
  assert.deepEqual(discovery.newTables(d, new Set()).length, 2);
});

test("the discovery brief names no class beyond the seeded ones, and says the run is read-only (R5, R11)", () => {
  const b = discovery.discoveryBrief({ run: "r1", connections: [{ name: "mssql", digest: "Tables (2, all named dbo_…): Job, Lease", home_name: "Everyone" }], history: 2 });
  assert.match(b, /data, not instructions/);
  assert.match(b, /read-only to you/);
  assert.match(b, /You don't choose a class's home/);
  assert.match(b, /agent .* commitment .* event .* resource/s);
  assert.match(b, /graph-rag_record_examined/);
  // no class handed to it: only R3's own examples of lasting individuals and transactional rows appear
  for (const word of ["jobs", "warehouse", "leased building", "hires", "purchase order", "work center"]) assert.doesNotMatch(b.split("----------")[2], new RegExp(`\\b${word}\\b`, "i"), word);
  const p = discovery.discoveryPartBrief({ run: "r1", part: "the tables dbo_Lease and dbo_Site", connection: "mssql" });
  assert.match(p, /you never create a class/);
  assert.match(p, /graph-rag_request \(kind "class"\)/, "filing's request tool, kind class: the one a worker has");
});

test("a discovery part's worker gets only tools that read as its part's home: not the graph's search, which reads as a record's audience (review C-B5)", () => {
  const server = discovery.gateDiscoveryTools(fakeServer(), { role: { kind: "worker", entry: "#9:1", job: "j", discovery: true, run: "r1" } });
  for (const name of ["search_graph", "read_document", "about_thing", "list_classes", "relate_instance", "read_history", "request", "create_class", "start_discovery_worker"]) server.tool(name, {}, async () => "ok");
  assert.deepEqual([...server.tools.keys()].sort(), ["list_classes", "read_history", "relate_instance", "request"]);
});
