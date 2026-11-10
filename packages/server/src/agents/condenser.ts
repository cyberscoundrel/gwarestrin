/**
 * The condenser's server side. The condensing itself is done by the person's own chat agent, which was in
 * the conversation: whole sections of an on-record conversation condensed into a summary document with relevant
 * context (R2: the condensed document and its sections are the record). The chat agent and the condenser deal in
 * text, not class vocabulary (R5): no class list and no claims reach the agent from here. This module keeps
 *
 *  - the thread's on/off-record state (ThreadRecordState) and its transitions: off by default; the person
 *    switches it on (from now, under their position, for a reason) and may switch it off again, which stops
 *    further recording and unrecords nothing
 *  - the block the agent reads at every turn (<home>/on-record.md, injected by the graph-context extension)
 *  - a document the agent recorded, recognized in its tool events, so the thread view can count them
 *
 * The record stream owns this module.
 */
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ThreadRecordState } from "@gwarestrin/shared";

/** read by graph-context at every turn, beside standing-instructions.md */
export const RECORD_FILE = "on-record.md";

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
 * (who, position, reason, since when, how many documents so far) and what to do
 * about it.
 */
export function recordContext(state: ThreadRecordState): string {
  if (!state.ever) return "";
  const out: string[] = ["On record"];
  const record = `${state.by ?? "the person"} put it on record${state.position ? ` under the position ${state.position}` : ""}, reason: "${state.reason ?? "not given"}"`;
  if (state.on) {
    out.push(
      "",
      `This conversation is ON RECORD since ${when(state.since)}: ${record}. What is said here from that moment on is meant for the organization's knowledge graph: condense each section of it into a document with the context a reader needs (see "On record" in your workspace instructions), at a natural boundary or when the person asks. Use the reason above unless the person gives a better one; who recorded it and under which position are stamped by the graph. A file the person uploads while it is on record is put on record as it is.`,
    );
  } else {
    out.push(
      "",
      `This conversation went OFF RECORD at ${when(state.until)}. It was on record from ${when(state.since)}: ${record}. Nothing said after ${when(state.until)} goes on record, and you have no way to write to the graph from this conversation until the person switches it on again: what was on record and not yet condensed stays unrecorded, tell the person so if it matters.`,
    );
  }
  out.push("", state.documents ? `Documents recorded from this conversation so far: ${state.documents}${state.condensed_at ? ` (the last at ${when(state.condensed_at)})` : ""}.` : "Nothing has been recorded from this conversation yet.");
  return out.join("\n");
}

/** write the block for the agent (the host copy; the manager pushes it into an OpenShell sandbox); "" removes the file */
export async function writeRecordContext(home: string, text: string): Promise<void> {
  const file = path.join(home, RECORD_FILE);
  if (text.trim()) await writeFile(file, `${text.trim()}\n`, "utf8");
  else await rm(file, { force: true });
}

/**
 * A document the agent put on record, seen in its tool events: the end of a
 * graph-rag ingest call whose result says on_record. Null for anything else.
 */
export function condensedFromEvent(event: Record<string, unknown> & { type: string }): { doc_id: string; sections: number | null } | null {
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
      const r = JSON.parse(m[0]) as { on_record?: unknown; doc_id?: unknown; sections?: unknown };
      if (r.on_record === true && typeof r.doc_id === "string") {
        return { doc_id: r.doc_id, sections: typeof r.sections === "number" ? r.sections : null };
      }
    } catch {
      /* not this text */
    }
  }
  return null;
}

/**
 * What graph-rag is told about an agent's current thread (record-gate.ts pushThreadRecord): whether it is on
 * record and, while it is, the position the person put it on record under, where its sections start (R11.5).
 * NEEDS A RULING (record 15): which of a person's positions that is when they hold several. Today it is the agent
 * profile's first-listed position (http/agents.ts), and the person can't choose another at the switch.
 */
export function gatePushOf(agent: string, state: ThreadRecordState): { agent: string; thread: string | null; on: boolean; position?: string } {
  return { agent, thread: state.thread, on: state.on, ...(state.on && state.position ? { position: state.position } : {}) };
}
