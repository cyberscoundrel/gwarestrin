/**
 * The record tool (docs/ORGANIZATION-MODEL.md, "Inputs: on record, condensed, per claim"): a person's chat
 * agent puts a condensed document on record, in the contract's shape (model/README.md), and the ingest path
 * stores it with its claims (ingest.js recordDocument). Registered by createServer in server.js the way the
 * worker's tools are: `registerRecordTools(server, { identity, scope, need })` for identities that write
 * and hold no graph role. Until it is wired, ingest_document with the document as JSON in `text` takes the
 * same path.
 */
import { z } from "zod";
import { recordDocument } from "./ingest.js";

/** the tool's name: what the harness looks for in tools/list (/condens|on_record|record_document/) */
export const RECORD_TOOL = "record_document";

const claim = z
  .object({
    kind: z.enum(["commitment", "event", "state", "observation"]),
    subject: z.union([z.string(), z.object({}).passthrough()]),
    class: z.string().optional(),
    attribute: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
    valid_from: z.string().optional(),
    valid_until: z.string().nullable().optional(),
    at: z.string().optional(),
  })
  .passthrough();

const section = z.object({ heading: z.string().optional(), text: z.string().min(1), claims: z.array(claim).optional() }).passthrough();

export const documentShape = z
  .object({
    title: z.string().min(3).max(200).optional(),
    description: z.string().max(500).optional(),
    recorded_by: z.string().optional(),
    position: z.string().optional(),
    reason: z.string().min(1).max(300),
    recorded_at: z.string().optional(),
    sections: z.array(section).min(1),
  })
  .passthrough();

export function registerRecordTools(server, { identity, scope, need }) {
  server.tool(
    RECORD_TOOL,
    `Put a condensed section of an on-record conversation into the knowledge graph as a document with claims
(see "On record" in your workspace instructions). document: {title, description, reason, sections:
[{heading, text, claims: [{kind, subject, class, attribute, value, valid_from, valid_until, at}]}]};
recorded_by and position are the person's and the position your token holds (given values are checked
against them), recorded_at is stamped here. A claim's class must be a confirmed commitment class and a stage
value one of its stages; a section with no claims is stored and graded as free text. The reply names every
field that is wrong, or says on_record with the sections and claims written (queued for approval when the
claims lie with a higher authority). Only what the person meant for the record goes in.`,
    {
      document: documentShape,
      home: z.string().optional(),
      valid_until: z.string().optional(),
    },
    async (args) => {
      need("write");
      const { document, home, valid_until } = args;
      const out = await recordDocument(document, identity, scope, { title: document.title, description: document.description, home, valid_until });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  );
}
