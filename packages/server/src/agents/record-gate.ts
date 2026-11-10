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
