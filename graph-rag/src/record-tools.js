/**
 * The record tool: a person's chat agent puts a condensed document on record (R2: the condensed document and its
 * sections are the record), in the contract's shape (model/record.js), and the ingest path stores it
 * (ingest.js recordDocument). No claims and no class vocabulary (R5). Registered by createServer in server.js:
 * `registerRecordTools(server, { identity, scope, need })` for identities that write and hold no graph role.
 * The record stream owns this module.
 */
import { z } from "zod";
import { recordDocument } from "./ingest.js";

/** the tool's name: what the harness looks for in tools/list (/condens|on_record|record_document/) */
export const RECORD_TOOL = "record_document";

// the whole document is the contract's to judge (model/record.js validateDocument: every problem named by
// field, the same answer ingest_document gives); a stricter shape here refuses what the contract takes
export const documentShape = z.object({}).passthrough();

export function registerRecordTools(server, { identity, scope, need }) {
  server.tool(
    RECORD_TOOL,
    `Put a condensed section of an on-record conversation into the knowledge graph as a document (see
"On record" in your workspace instructions). document: {title, description, reason, sections: [{heading, text}]}:
whole sections as text, with the context a reader needs. recorded_by, position and recorded_at are set here
from your token, whatever the document says. The reply names what is wrong, or says on_record with the
sections written (queued for approval when your writes are); sending the same document again changes nothing
and says already_on_record. Only what the person meant for the record goes in.`,
    {
      document: documentShape,
      title: z.string().optional(),
      description: z.string().optional(),
      home: z.string().optional(),
      valid_until: z.string().optional(),
    },
    async (args) => {
      need("write");
      const { document, title, description, home, valid_until } = args;
      const out = await recordDocument(document, identity, scope, { title, description, home, valid_until });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  );
}
