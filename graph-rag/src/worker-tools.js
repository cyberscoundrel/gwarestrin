/**
 * A worker thread's own tools. The claim-shaped reconciliation tools (confirm_claim, record_conflict,
 * resolve_subject, mark_need_met, and enter_data by claim id) went with atomic claims (R2). The filing stream
 * builds what replaces them: filing a record piece by piece with the four outcomes (model/filing.js), the
 * worker's account of what it did, and requests of the orchestrator for anything not low stakes (R10, R11).
 * A write to a source goes through data-entry.js; the map chooses Filed or Proposed (model/class-map.js).
 *
 * The filing stream owns this module.
 */
import { z } from "zod";
import { raiseQuestion } from "./worker-pool.js";

/** a worker writes no entries: the section is on record as its person put it */
export async function workerUpsert() {
  throw new Error("A worker writes no entries: the record is on record as its person put it. Ask (raise_question) if something needs settling.");
}

/** the tools of a worker thread, registered on the MCP server built for that identity (see createServer) */
export function registerWorkerTools(server, { identity, need }) {
  server.tool(
    "raise_question",
    `Ask something you can't settle from the graph or your sources. Give options when there are clear
choices, and why you're asking. Then END YOUR TURN with a short report: you're resumed with the answer
later, in this same conversation.`,
    { question: z.string().min(8).max(600), options: z.array(z.string().max(200)).max(6).optional(), why: z.string().max(600).optional() },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await raiseQuestion(identity, args)) }] };
    },
  );
}

/** for tests and the integrator: the tools a worker has now, and the ones earlier designs had */
export const WORKER_TOOLS = ["raise_question"];
export const REMOVED_WORKER_TOOLS = [
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
