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

// the whole document is the contract's to judge (model/claims.js validateDocument: every problem named by
// field, the same answer ingest_document gives); a stricter shape here refuses what the contract takes
export const documentShape = z.object({}).passthrough();

export function registerRecordTools(server, { identity, scope, need }) {
  server.tool(
    RECORD_TOOL,
    `Put a condensed section of an on-record conversation into the knowledge graph as a document with claims
(see "On record" in your workspace instructions). document: {title, description, reason, sections:
[{heading, text, claims: [{kind, subject, class, attribute, value, valid_from, valid_until, at}]}]};
recorded_by, position and recorded_at are set here from your token, whatever the document says. A claim's
class must be a confirmed commitment class and a stage value one of its stages; a section with no claims is
stored and graded as free text. The reply names every field that is wrong, or says on_record with the
sections and claims written (queued for approval when the claims lie with a higher authority); sending the
same document again changes nothing and says already_on_record. Only what the person meant for the record
goes in.`,
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
