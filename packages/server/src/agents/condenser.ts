/**
 * The condenser's server side (docs/ORGANIZATION-MODEL.md, "Inputs: on
 * record, condensed, per claim"). The condensing itself is done by the
 * person's own chat agent, which was in the conversation: this module keeps
 * what that agent needs to do it and what the app shows the person.
 *
 *  - the thread's on/off-record state (ThreadRecordState) and its transitions:
 *    off by default; the person switches it on (from now, under their
 *    position, for a reason) and may switch it off again, which stops further
 *    recording and unrecords nothing
 *  - the block the agent reads at every turn (<home>/on-record.md, injected
 *    by the graph-context extension): the state, and the confirmed
 *    commitment classes its claims may name
 *  - the confirmed classes, read from the graph through the existing MCP
 *    tools as this instance (CommitmentClass rows; the Discovery stream's
 *    confirm flow fills them)
 *  - a document the agent recorded, recognized in its tool events, so the
 *    thread view can count them
 */
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ThreadRecordState } from "@gwarestrin/shared";
import { McpHttpClient } from "../analyze/mcp-client.js";

/** read by graph-context at every turn, beside standing-instructions.md */
export const RECORD_FILE = "on-record.md";

/** a confirmed commitment pattern, as CommitmentClass rows hold it (graph-rag/src/model/schema.js) */
export interface ConfirmedClass {
  name: string;
  description?: string | null | undefined;
  stages: string[];
  record_table: string | null;
  attributes?: string[] | undefined;
}

/** a conversation's thread id: its session file's name (no directory, no extension) */
export function threadIdOf(sessionFile: string | null | undefined): string | null {
  if (!sessionFile) return null;
  const base = path.basename(sessionFile);
  return base.replace(/\.jsonl?$/i, "") || null;
}

/** the default: off record, never on */
export function offRecord(thread: string | null): ThreadRecordState {
  return { thread, on: false, since: null, until: null, by: null, position: null, reason: null, documents: 0, condensed_at: null, ever: false };
}

/**
 * The person's switch. On: from now, by them, under their position, for
 * their reason (an earlier switch-off is over). On while on: the reason may
 * be restated, nothing else changes. Off while on: stops recording now and
 * keeps everything (since, by, reason, the documents). Off while off: as it
 * was.
 */
export function switchRecord(
  prev: ThreadRecordState,
  input: { on: boolean; by: string; position?: string | null | undefined; reason?: string | null | undefined },
  now: Date = new Date(),
): ThreadRecordState {
  const at = now.toISOString();
  const reason = input.reason?.trim() || null;
  if (input.on) {
    if (prev.on) return reason && reason !== prev.reason ? { ...prev, reason } : prev;
    return {
      ...prev,
      on: true,
      ever: true,
      since: at,
      until: null,
      by: input.by,
      position: input.position ?? null,
      reason: reason ?? `put on record by ${input.by}`,
    };
  }
  if (!prev.on) return prev;
  return { ...prev, on: false, until: at };
}

const when = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "an unknown time");

/**
 * The block the agent reads at every turn while a conversation is or was on
 * record; "" when it never was (the file is then removed: the standing
 * instructions already say what off record means). It states the record
 * (who, position, reason, since when, how many documents so far), what to do
 * about it, and the confirmed classes the claims may name.
 */
export function recordContext(state: ThreadRecordState, classes: ConfirmedClass[] | null): string {
  if (!state.ever) return "";
  const out: string[] = ["On record"];
  const record = `${state.by ?? "the person"} put it on record${state.position ? ` under the position ${state.position}` : ""}, reason: "${state.reason ?? "not given"}"`;
  if (state.on) {
    out.push(
      "",
      `This conversation is ON RECORD since ${when(state.since)}: ${record}. What is said here from that moment on is meant for the organization's knowledge graph: condense each section of it into a document with claims (see "On record" in your workspace instructions), at a natural boundary or when the person asks. Use these values in the document: recorded_by "${state.by ?? ""}"${state.position ? `, position "${state.position}"` : ""}, reason as above unless the person gives a better one.`,
    );
  } else {
    out.push(
      "",
      `This conversation went OFF RECORD at ${when(state.until)}. It was on record from ${when(state.since)}: ${record}. What was said on record and not yet condensed is still to be condensed, once, at your next opportunity; nothing said after ${when(state.until)} goes on record, and you don't record anything new.`,
    );
  }
  out.push("", state.documents ? `Documents recorded from this conversation so far: ${state.documents}${state.condensed_at ? ` (the last at ${when(state.condensed_at)})` : ""}.` : "Nothing has been recorded from this conversation yet.");
  if (state.on) {
    out.push("", ...classesBlock(classes));
  }
  return out.join("\n");
}

/** the confirmed classes as a list the agent can copy class names from, or what to do when there are none or they couldn't be read */
export function classesBlock(classes: ConfirmedClass[] | null): string[] {
  if (classes === null) {
    return [
      "The confirmed commitment classes couldn't be read right now. Put sections on record with claims only on classes you know are confirmed; a claim naming an unconfirmed class is refused with its field named, and you resend without it.",
    ];
  }
  if (classes.length === 0) {
    return ["The graph has no confirmed commitment classes yet: put sections on record with no claims (claims: []) and tell the person which classes the sections would need, so an admin can confirm them."];
  }
  return [
    "Confirmed commitment classes (a claim's class, and an instance subject's, must be one of these, written exactly so):",
    ...classes.map((c) => {
      const parts = [c.description ? `: ${c.description}` : ""];
      if (c.stages.length) parts.push(`; stages ${c.stages.join(" → ")}`);
      if (c.record_table) parts.push(`; records in ${c.record_table} (an instance's key is ${c.record_table}:<row key>)`);
      if (c.attributes?.length) parts.push(`; attributes ${c.attributes.join(", ")}`);
      return `- ${c.name}${parts.join("")}`;
    }),
  ];
}

/** write the block for the agent (the host copy; the manager pushes it into an OpenShell sandbox); "" removes the file */
export async function writeRecordContext(home: string, text: string): Promise<void> {
  const file = path.join(home, RECORD_FILE);
  if (text.trim()) await writeFile(file, `${text.trim()}\n`, "utf8");
  else await rm(file, { force: true });
}

/**
 * The confirmed classes, through the existing MCP tools as this instance
 * (query_graph is a root-only raw read, so on an instance below the root
 * this comes back null and the agent is told the classes couldn't be read;
 * the Discovery stream's listing replaces this). Null when unreadable.
 */
export async function fetchConfirmedClasses(mcpUrl: string, token: string | undefined, client: Pick<McpHttpClient, "callTool"> = new McpHttpClient(mcpUrl, token)): Promise<ConfirmedClass[] | null> {
  try {
    const text = await client.callTool("query_graph", {
      language: "sql",
      query: "SELECT name, description, stages, record_table FROM CommitmentClass WHERE status = 'confirmed' ORDER BY name LIMIT 200",
    });
    const parsed = JSON.parse(text) as { rows?: unknown[]; error?: string };
    if (!Array.isArray(parsed.rows)) return null;
    return parsed.rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .filter((r) => typeof r.name === "string" && r.name)
      .map((r) => ({
        name: String(r.name),
        description: typeof r.description === "string" ? r.description : null,
        stages: Array.isArray(r.stages) ? r.stages.map(String) : [],
        record_table: typeof r.record_table === "string" ? r.record_table : null,
      }));
  } catch {
    return null;
  }
}

/**
 * A document the agent put on record, seen in its tool events: the end of a
 * graph-rag ingest call whose result says on_record. Null for anything else.
 */
export function condensedFromEvent(event: Record<string, unknown> & { type: string }): { doc_id: string; sections: number | null; claims: number | null } | null {
  if (event.type !== "tool_execution_end" || event.isError) return null;
  const result = event.result;
  const texts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") texts.push(v);
    else if (v && typeof v === "object") {
      const content = (v as { content?: unknown }).content;
      if (Array.isArray(content)) for (const c of content) if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") texts.push((c as { text: string }).text);
      if (typeof (v as { text?: unknown }).text === "string") texts.push((v as { text: string }).text);
    }
  };
  push(result);
  for (const t of texts) {
    const m = /\{[\s\S]*\}/.exec(t);
    if (!m) continue;
    try {
      const r = JSON.parse(m[0]) as { on_record?: unknown; doc_id?: unknown; sections?: unknown; claims?: unknown };
      if (r.on_record === true && typeof r.doc_id === "string") {
        return { doc_id: r.doc_id, sections: typeof r.sections === "number" ? r.sections : null, claims: typeof r.claims === "number" ? r.claims : null };
      }
    } catch {
      /* not this text */
    }
  }
  return null;
}
