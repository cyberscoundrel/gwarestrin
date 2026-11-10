/**
 * Off record is enforced where the graph's tools are, not in the agent's
 * prompt (docs/ORGANIZATION-MODEL.md, "On record is a deliberate act"):
 * graph-rag refuses every write from a chat agent unless its current thread
 * is on record, and this is how it learns: PUT /api/thread-record, with the
 * instance's own token. The agent has only its delegated token, which that
 * route refuses, so it can't switch itself on.
 */

export interface ThreadRecordPush {
  agent: string;
  thread: string | null;
  on: boolean;
  /** the position the person put the thread on record under: where its sections start (R11.5) */
  position?: string | null | undefined;
}

/** graph-rag's HTTP base is the MCP URL's */
export function threadRecordUrl(mcpUrl: string): string {
  return new URL("/api/thread-record", mcpUrl).toString();
}

/** tell graph-rag what this agent's current thread is; throws when it isn't told, so a switch never looks done when it isn't */
export async function pushThreadRecord(mcpUrl: string, token: string | undefined, body: ThreadRecordPush, fetchFn: typeof fetch = globalThis.fetch): Promise<void> {
  const res = await fetchFn(threadRecordUrl(mcpUrl), {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the knowledge graph didn't take the record state (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

/**
 * A file uploaded on record is a record (R11.12). When a file reaches an agent's workspace while its current
 * thread is on record, the app puts it on record through graph-rag's record_file tool with the agent's own
 * delegated token: graph-rag refuses it unless that thread is on record (the same gate as every write), and
 * stamps the person and the position the thread was put on record under. Off record nothing is sent.
 *
 * NEEDS A RULING (record 4): only text files go on record (no NUL byte, valid UTF-8, under the size limit);
 * anything else stays a file in the workspace, and the reply says why.
 */
export const UPLOAD_MAX_BYTES = 1_500_000;

/** the file's text when it can go on record, else why not */
export function uploadText(bytes: Uint8Array): { text: string } | { refused: string } {
  if (bytes.byteLength > UPLOAD_MAX_BYTES) return { refused: `larger than ${UPLOAD_MAX_BYTES} bytes` };
  if (bytes.includes(0)) return { refused: "not a text file" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { refused: "not a text file (not UTF-8)" };
  }
  if (text.trim().length < 20) return { refused: "no text to put on record" };
  return { text };
}

export interface UploadRecordResult {
  file: string;
  recorded?: Record<string, unknown>;
  refused?: string;
}

/**
 * Put one uploaded file on record for an agent whose thread is on record. `onRecord` false sends nothing.
 * `client` calls graph-rag's MCP tools with the agent's own token.
 */
export async function recordUpload(
  client: { callTool(name: string, args: Record<string, unknown>): Promise<string> },
  input: { file: string; bytes: Uint8Array; onRecord: boolean; reason?: string | null | undefined },
): Promise<UploadRecordResult> {
  if (!input.onRecord) return { file: input.file, refused: "the conversation is off record" };
  const t = uploadText(input.bytes);
  if ("refused" in t) return { file: input.file, refused: t.refused };
  const text = await client.callTool("record_file", { file: input.file, text: t.text, ...(input.reason ? { reason: input.reason } : {}) });
  let recorded: Record<string, unknown>;
  try {
    recorded = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { file: input.file, refused: text.slice(0, 300) };
  }
  return { file: input.file, recorded };
}
