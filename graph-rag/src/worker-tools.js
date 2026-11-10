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
import { createInstance, fileToSource, giveAccount, holdPiece, keepPiece, liveEnv, relateSection, requestOrchestrator, resolveName, sectionKey, stateDependency } from "./filing.js";
import { REQUEST_KINDS } from "./model/filing.js";

/** a worker writes no entries: the record is on record as its person put it */
export async function workerUpsert() {
  throw new Error("A worker writes no entries: the record is on record as its person put it. File its pieces (graph-rag_file_to_source, graph-rag_hold_piece, graph-rag_keep_piece).");
}

const reply = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const sectionId = z.string().min(3).max(40);
const pieceText = z.string().min(3).max(1000);
const refiles = z.string().max(80).optional();

/** the tools of a worker thread, registered on the MCP server built for that identity (see createServer) */
export function registerWorkerTools(server, { identity, need }) {
  const run = (fn, cap) => async (args) => {
    need(cap);
    return reply(await fn(args, identity, await liveEnv()));
  };
  server.tool(
    "resolve_name",
    `Look a name up, read-only: the instances your audience can see by that name, and, given a table
("system:table") and a column, the source rows whose column holds it (at most five).`,
    { name: z.string().min(1).max(200), table: z.string().max(200).optional(), column: z.string().max(80).optional() },
    run(resolveName, "read"),
  );
  server.tool(
    "file_to_source",
    `File one piece of the record into its source row: the row's key ("mssql:dbo_Job:4471"), the columns
to write and their values, and the existing class it falls under. The code decides the outcome: Filed
(written) when the person who put the record on record holds the authority the class map names and
the source takes writes; Proposed otherwise (a person with authority approves it); Held when the row
can't be found or read, or the source already holds a different value (nothing is overwritten:
says_change tells whether the record says something changed). You never pick the outcome.`,
    {
      section: sectionId,
      piece: pieceText,
      class: z.string().min(1).max(80),
      key: z.string().min(5).max(300),
      fields: z.record(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])),
      says_change: z.boolean().optional(),
      question: z.string().max(1000).optional(),
      confirmed_update: z.string().max(80).optional(),
      refiles,
    },
    run(fileToSource, "write"),
  );
  server.tool(
    "hold_piece",
    `Hold a piece a source should hold when it's unclear which record it means: nothing is written, and
your question goes to whoever put the record on record. Name the row's key, or its table, or a class
with a table.`,
    { section: sectionId, piece: pieceText, question: z.string().min(8).max(1000), class: z.string().max(80).optional(), key: z.string().max(300).optional(), table: z.string().max(200).optional(), refiles },
    run(holdPiece, "write"),
  );
  server.tool(
    "keep_piece",
    `Keep a piece no system holds: the document is its source, linked to the instances it is about (by
id). Nothing Kept is deleted; it is re-filed when a fitting class or source appears.`,
    { section: sectionId, piece: pieceText, instances: z.array(z.string().max(40)).max(20).optional(), refiles },
    run(keepPiece, "write"),
  );
  server.tool(
    "create_instance",
    `Make a lasting individual (a person, a machine, a customer, a building) as an instance of an
existing class, with its source key when a source holds it; the section then relates to it. One that
already holds the key, or has that name under that class, is reused. A class whose rows stay in the
source refuses: store the key on the section instead.`,
    { section: sectionId, name: z.string().min(1).max(120), class: z.string().min(1).max(80), key: z.string().max(300).optional() },
    run(createInstance, "write"),
  );
  server.tool(
    "relate_section",
    "Relate one of your sections to an instance your audience can see (by id).",
    { section: sectionId, instance: z.string().min(3).max(40), role: z.string().max(40).optional() },
    run(relateSection, "write"),
  );
  server.tool(
    "section_key",
    "Store a transactional row's key on a section (an order line, an operation, a time punch): the row stays in the source, with no node.",
    { section: sectionId, key: z.string().min(5).max(300) },
    run(sectionKey, "write"),
  );
  server.tool(
    "state_dependency",
    `State that one instance depends on another (from depends on to): each end an instance id or a row's
key (a row earns its node this way). stated_as "record" when the record says so, "agent" when it's
your reading.`,
    { section: sectionId, from: z.string().min(3).max(300), to: z.string().min(3).max(300), stated_as: z.enum(["record", "agent"]), note: z.string().max(600).optional(), valid_from: z.string().max(40).optional(), valid_until: z.string().max(40).optional() },
    run(stateDependency, "write"),
  );
  server.tool(
    "request",
    `Ask the orchestrator instead of resolving something that isn't low stakes: kind "class" when no
existing class fits a piece (say what the piece is and which parents you'd suggest), "conflict" for a
conflict with a source, "other" for anything else you won't settle alone. Keep requests few. Don't file
that piece yourself: carry on with the others; you're resumed with the answer.`,
    { kind: z.enum(REQUEST_KINDS), question: z.string().min(8).max(1000), section: sectionId.optional(), suggestion: z.string().max(600).optional() },
    run(requestOrchestrator, "write"),
  );
  server.tool(
    "give_account",
    `Your account of what you did: for each filing-log entry you wrote (by its id), what you did in a
sentence. Needed before you're done; the orchestrator checks it against the source itself.`,
    { pieces: z.array(z.object({ entry: z.string().min(8).max(80), said: z.string().min(3).max(2000) })).max(100), summary: z.string().max(2000).optional() },
    run(giveAccount, "write"),
  );
}

/** for tests and the integrator: the tools a worker has now, and the ones earlier designs had */
export const WORKER_TOOLS = ["resolve_name", "file_to_source", "hold_piece", "keep_piece", "create_instance", "relate_section", "section_key", "state_dependency", "request", "give_account"];
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
