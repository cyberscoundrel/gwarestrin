/**
 * A worker thread's own tools: filing a record piece by piece (filing.js). Each piece ends in one outcome on record,
 * Filed, Proposed, Held or Kept (R2); which of Filed and Proposed is the code's call from the class map and the
 * recorder's standing, never the worker's (R11). The worker decides low-stakes matters itself (relating to existing
 * instances, keeping, asking the recorder) and requests the rest of the orchestrator: a class no existing one fits,
 * a conflict with a source (R10, R11). It ends with its account of what it did (R10).
 *
 * Every tool reads and writes only within the worker's audience: the home of its sections, from its job, never
 * from the model (R7, R11). No tool makes or changes a class (R5, R7).
 *
 * The filing stream owns this module.
 */
import { z } from "zod";
import { createInstance, fileToSource, findText, giveAccount, holdPiece, jobContext, keepPiece, liveEnv, relateSection, requestOrchestrator, resolveName, sectionKey, stateDependency } from "./filing.js";
import { REQUEST_KINDS } from "./model/filing.js";
import { resolveEntryRef, resolveSectionRef, shortSectionId } from "./model/brief.js";

/** a worker writes no entries: the record is on record as its person put it */
export async function workerUpsert() {
  throw new Error("A worker writes no entries: the record is on record as its person put it. File its pieces (graph-rag_file_to_source, graph-rag_hold_piece, graph-rag_keep_piece).");
}

const reply = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
// a section is named by its short id from the brief (s1, s2 ...) or its record id; models also send "1", "§1",
// "Section #1:23" or the piece's text itself, so the field takes any string and is resolved before anything else
// (resolveSectionRef), and only then checked as one of the worker's own sections (filing.js ownSection)
const SECTION_HINT = "the section's id from your brief (s1, s2 …), not its text";
const sectionId = z.string().max(5000).optional().describe(SECTION_HINT);
const pieceText = z.string().min(3).max(1000);
// re-filing (I-41): offered only to a worker with something to re-file (identity.refiling, set per request from
// filing.js refileOffered); a first-time filing has no such argument, and one sent anyway is dropped by the schema
const REFILES = z.string().max(80).optional().describe("only when you re-file: the entry id your brief or the answer named");
const refileArg = (identity) => (identity?.refiling ? { refiles: REFILES } : {});

/** find_rows (I-40): the worker's and the orchestrator's search of a source table, graph-rag doing the text match */
export const FIND_ROWS_HELP = `Find rows of a source table, read-only: text is words that must all appear in a row (any case; in
columns, or in every column when none are named); where narrows by equal values ({ "Status": "Active",
"Job": 3260356 }). Use this, not a filter with contains or startswith, which the source doesn't take.
An unknown table or column is refused with the real ones. More rows: call again with offset: next_offset.`;
export const FIND_ROWS_ARGS = {
  table: z.string().min(1).max(200).describe('"system:table", like mssql:dbo_Customer'),
  text: z.string().max(200).optional(),
  columns: z.array(z.string().max(80)).max(30).optional(),
  where: z.record(z.union([z.string().max(300), z.number(), z.boolean()])).optional(),
  select: z.array(z.string().max(80)).max(30).optional(),
  first: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).max(5000).optional(),
};

/** the tools of a worker thread, registered on the MCP server built for that identity (see createServer) */
export function registerWorkerTools(server, { identity, need }) {
  const refiles = refileArg(identity);
  // section: "required" or "optional" resolves args.section to the record id the worker means, or refuses with
  // its sections' ids and headings
  // tables: bare table names in table/key resolved to system:table (withTables); every result naming an entry carries
  // its handle (e1, e2 ...) beside the id, which give_account takes back
  const run = (fn, cap, section = null, { tables = false } = {}) => async (args) => {
    need(cap);
    const env = await liveEnv();
    let a = section ? await withSection(args, identity, env, section === "optional") : args;
    if (tables) a = await withTables(a);
    return reply(await withEntryHandle(await fn(a, identity, env), identity, env));
  };
  server.tool(
    "resolve_name",
    `Look a name up, read-only: the instances your audience can see by that name, and, given a table
("system:table") and a column, the source rows whose column holds it (at most five).`,
    { name: z.string().min(1).max(200), table: z.string().max(200).optional(), column: z.string().max(80).optional() },
    run(resolveName, "read", null, { tables: true }),
  );
  server.tool("find_rows", FIND_ROWS_HELP, FIND_ROWS_ARGS, run(findText, "read", null, { tables: true }));
  server.tool(
    "file_to_source",
    `File one piece of the record into its source row: the row's key ("mssql:dbo_Job:4471"), the columns
to write and their values in the record's own words, and the existing class it falls under. graph-rag
decides the outcome (R16): Filed (written, the old value kept so it can be undone) when the person who
put the record on record holds the authority the class map names, the record names the row (or only
that row matches it), every value written is in the record, and the row hasn't changed since it was
read; Proposed when they lack the authority or the source takes no writes; Held, asking them, when any
other condition fails. said is your account of what this piece writes. You never pick the outcome.`,
    {
      section: sectionId,
      piece: pieceText,
      said: z.string().min(3).max(2000),
      class: z.string().min(1).max(80),
      key: z.string().min(5).max(300),
      fields: z.record(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])),
      question: z.string().max(1000).optional(),
      ...refiles,
    },
    run(fileToSource, "write", "required", { tables: true }),
  );
  server.tool(
    "hold_piece",
    `Hold a piece a source should hold when it's unclear which record it means: nothing is written, and
your question goes to whoever put the record on record. Name the row's key, or its table, or a class
with a table.`,
    { section: sectionId, piece: pieceText, question: z.string().min(8).max(1000), class: z.string().max(80).optional(), key: z.string().max(300).optional(), table: z.string().max(200).optional(), ...refiles },
    run(holdPiece, "write", "required", { tables: true }),
  );
  server.tool(
    "keep_piece",
    `Keep a piece no system holds: the document is its source, linked to the instances it is about (by
id, at least one). Nothing Kept is deleted; it is re-filed when a fitting class or source appears.`,
    { section: sectionId, piece: pieceText, instances: z.array(z.string().max(200)).min(1).max(20), ...refiles },
    run(keepPiece, "write", "required"),
  );
  server.tool(
    "create_instance",
    `Make a lasting individual (a person, a machine, a customer, a building) as an instance of an
existing class, with its source key when a source holds it; the section then relates to it. One that
already holds the key, or has that name under that class, is reused. A class whose rows stay in the
source refuses: store the key on the section instead.`,
    { section: sectionId, name: z.string().min(1).max(120), class: z.string().min(1).max(80), key: z.string().max(300).optional() },
    run(createInstance, "write", "required"),
  );
  server.tool(
    "relate_section",
    "Relate one of your sections to an instance your audience can see (by id).",
    { section: sectionId, instance: z.string().min(2).max(200).describe("the instance's id (#12:3); a name is taken when exactly one instance you see has it"), role: z.string().max(40).optional() },
    run(relateSection, "write", "required"),
  );
  server.tool(
    "section_key",
    "Store a transactional row's key on a section (an order line, an operation, a time punch): the row stays in the source, with no node.",
    { section: sectionId, key: z.string().min(5).max(300) },
    run(sectionKey, "write", "required"),
  );
  server.tool(
    "state_dependency",
    `State that one instance depends on another (from depends on to): each end an instance id or a row's
key (a row earns its node this way). stated_as "record" when the record says so, "agent" when it's
your reading.`,
    { section: sectionId, from: z.string().min(3).max(300), to: z.string().min(3).max(300), stated_as: z.enum(["record", "agent"]), note: z.string().max(600).optional(), valid_from: z.string().max(40).optional(), valid_until: z.string().max(40).optional() },
    run(stateDependency, "write", "required"),
  );
  server.tool(
    "request",
    `Ask the orchestrator instead of resolving something that isn't low stakes: kind "class" when no
existing class fits a piece (say what the piece is and which parents you'd suggest), "conflict" for a
conflict with a source, "other" for anything else you won't settle alone. Keep requests few. Don't file
that piece yourself: carry on with the others; you're resumed with the answer.`,
    { kind: z.enum(REQUEST_KINDS), question: z.string().min(8).max(1000), section: sectionId, suggestion: z.string().max(600).optional() },
    run(requestOrchestrator, "write", "optional"),
  );
  server.tool(
    "give_account",
    `Your account of what you did: for each filing-log entry you wrote (by its handle, e1, e2 …, or its id), what you did in a
sentence. Every entry needs one before you're done (a filed piece has the one you gave with it; give it
again to correct it); the orchestrator checks it against the source itself.`,
    { pieces: z.array(z.object({ entry: z.string().max(2000).describe("the entry's handle (e1, e2 …) or id, as your filing tools gave it"), said: z.string().min(3).max(2000) })).max(100), summary: z.string().max(2000).optional() },
    async (args) => {
      need("write");
      const env = await liveEnv();
      return reply(await giveAccount(await withEntries(args, identity, env), identity, env));
    },
  );
}

/** for tests and the integrator: the tools a worker has now, and the ones earlier designs had */
export const WORKER_TOOLS = ["resolve_name", "find_rows", "file_to_source", "hold_piece", "keep_piece", "create_instance", "relate_section", "section_key", "state_dependency", "request", "give_account"];
export const REMOVED_WORKER_TOOLS = [
  // asking the admin: Held pieces ask the recorder, and requests go to the orchestrator (R2, R10)
  "raise_question",
  // the claim-shaped reconciliation (R2: atomic claims go)
  "confirm_claim",
  "record_conflict",
  "resolve_subject",
  "mark_need_met",
  "enter_data",
  // the note-reading job before it
  "link_things",
  "relate_things",
  "queue_followup",
  "unlink_things",
  "delete_thing",
  "merge_things",
  "merge_entries",
  "unrelate_things",
  "delete_entry",
  "rename_thing",
  "update_entry",
];

/**
 * The section a worker meant, as its record id, before the tool runs: its short id, record id, number or a value
 * with "Section " or "§" in front; with one section in the brief, a missing or unmatched value is that one. A
 * section that matches none is refused with the worker's own sections, each by id and heading.
 */
async function withSection(args, identity, env, optional) {
  const given = args.section;
  if (optional && (given === undefined || given === null || String(given).trim() === "")) {
    const { section: _, ...rest } = args;
    return rest;
  }
  const ctx = await jobContext(identity, env.db);
  if (!ctx) return args; // not a filing thread: the tool's own refusal says so
  const rid = resolveSectionRef(given, ctx.sections);
  if (rid) return { ...args, section: rid };
  const rows = await env.db.adbQuery(`SELECT @rid AS rid, heading, text_identity FROM [${ctx.sections.join(",")}]`).catch(() => []);
  const label = new Map(rows.map((r) => [String(r.rid), r.heading || String(r.text_identity ?? "").slice(0, 60)]));
  const ids = ctx.sections.map((r, i) => `${shortSectionId(i)} (${r})${label.get(r) ? `: ${label.get(r)}` : ""}`).join("; ");
  throw Object.assign(new Error(`section "${String(given ?? "").slice(0, 60)}" isn't one of yours. section is ${SECTION_HINT}. Yours: ${ids}`), { refused: true });
}

/** a worker's own entries in the order it wrote them: its handles e1, e2 ... */
async function ownEntries(identity, env) {
  const ctx = await jobContext(identity, env.db);
  if (!ctx) return [];
  return (await env.store.entries({ worker: ctx.job })).sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
}
const entryHandle = (i) => `e${i + 1}`;

/** a filing tool's answer naming an entry, with that entry's handle beside its id */
async function withEntryHandle(result, identity, env) {
  if (!result || typeof result.entry !== "string") return result;
  const i = (await ownEntries(identity, env)).findIndex((e) => e.id === result.entry);
  return i >= 0 ? { ...result, handle: entryHandle(i) } : result;
}

/**
 * give_account's entries as ids: each by its handle (e3, 3) or id; with one entry, any value means it. Anything
 * else (a key, a section, another worker's entry) is refused with the worker's own entries, each with a line.
 */
async function withEntries(args, identity, env) {
  const list = await ownEntries(identity, env);
  const ids = list.map((e) => e.id);
  const resolve = (v) => resolveEntryRef(v, ids);
  const pieces = [];
  for (const p of args.pieces ?? []) {
    const id = resolve(p.entry);
    if (!id) {
      const yours = list.length ? list.map((e, i) => `${entryHandle(i)} (${e.outcome}, ${String(e.piece ?? "").slice(0, 60)})`).join("; ") : "none yet";
      throw Object.assign(new Error(`entry "${String(p.entry ?? "").slice(0, 60)}" isn't one of yours: give each entry's handle (e1, e2 …) or id, as your filing tools gave it. Yours: ${yours}`), { refused: true });
    }
    pieces.push({ ...p, entry: id });
  }
  return { ...args, pieces };
}

/**
 * A bare table name where system:table is wanted: in `table`, and as the table of a `key` with no system
 * ("dbo_Job:4471"). The one declared source that has the table (classes.js qualifyTable), or refused with the form.
 */
export async function withTables(args) {
  const { qualifyTable } = await import("./classes.js");
  const out = { ...args };
  try {
    if (typeof out.table === "string" && out.table.trim() && !out.table.includes(":")) out.table = await qualifyTable(out.table, { field: "table" });
    if (typeof out.key === "string") {
      const parts = out.key.trim().split(":");
      if (parts.length === 2 && parts[0] && parts[1]) {
        const { loadSources } = await import("./sources.js");
        const systems = Object.keys(await loadSources().catch(() => ({})));
        if (!systems.includes(parts[0])) out.key = `${await qualifyTable(parts[0], { field: "key" })}:${parts[1]}`;
      }
    }
  } catch (e) {
    throw Object.assign(new Error(String(e?.message ?? e)), { refused: true });
  }
  return out;
}
