/**
 * The record tools: a person's chat agent puts a condensed document on record (R2: the condensed document and its
 * sections are the record), in the contract's shape (model/record.js), and a file uploaded on record becomes a
 * record (R11.12). The ingest path stores both (ingest.js recordDocument, recordFile). No claims and no class
 * vocabulary (R5). Registered by createServer in server.js: `registerRecordTools(server, { identity, scope, need })`
 * for identities that write and hold no graph role. Off record, a chat agent is refused both at the call
 * (record-state.js gateOffRecordTools): neither is a read.
 * The record stream owns this module.
 */
import { z } from "zod";
import { recordDocument, recordFile } from "./ingest.js";

/** the tool's name: what the harness looks for in tools/list (/condens|on_record|record_document/) */
export const RECORD_TOOL = "record_document";
/** a file uploaded on record: its text is the record */
export const FILE_TOOL = "record_file";

// the whole document is the contract's to judge (model/record.js validateDocument: every problem named by
// field, the same answer ingest_document gives); a stricter shape here refuses what the contract takes
export const documentShape = z.object({}).passthrough();

export function registerRecordTools(server, { identity, scope, need }) {
  server.tool(
    RECORD_TOOL,
    `Put a condensed section of an on-record conversation into the knowledge graph as a document (see
"On record" in your workspace instructions). document: {title, description, reason, sections: [{heading, text}]}:
whole sections as text, in the person's words where they matter, with the context a reader needs.
recorded_by, position and recorded_at are set here from your token and the position the person
put the conversation on record under, whatever the document says. The reply names what is wrong, or says
on_record with the sections written (queued for approval when your writes are); sending the same document
again changes nothing and says already_on_record. Only what the person meant for the record goes in.`,
    {
      document: documentShape,
      title: z.string().optional(),
      description: z.string().optional(),
      valid_until: z.string().optional(),
    },
    async (args) => {
      need("write");
      const { document, title, description, valid_until } = args;
      const out = await recordDocument(document, identity, scope, { title, description, valid_until });
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  );
  server.tool(
    FILE_TOOL,
    `Put a file on record: a file uploaded while the conversation is on record is a record. text: the file's whole
text (text files only), file: its name. Its text is stored as it is, in sections, each checked for who may see
it, then a worker files it. title defaults to the file name; reason: why it is on record, in the person's words.
Sending the same file again changes nothing and says already_on_record.`,
    {
      file: z.string().min(1).max(260),
      text: z.string(),
      title: z.string().max(200).optional(),
      description: z.string().max(1000).optional(),
      reason: z.string().max(300).optional(),
      valid_until: z.string().optional(),
    },
    async (args) => {
      need("write");
      const out = await recordFile(args, identity, scope);
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  );
}
