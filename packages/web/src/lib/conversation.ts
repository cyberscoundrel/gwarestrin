import { getAdapter } from "./rpc-agent-adapter.js";
import { ws } from "./ws-client.js";

/**
 * Run a conversation (pi session) command for an agent and, for commands
 * that replace the session server-side, re-pull the transcript (pi does not
 * announce that over events). Shared by the conversation menu and the
 * phone toolbar menu.
 */
export async function conversationAction(agentId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const res = (await ws.rpc(agentId, type, payload)) as { success?: boolean; error?: string };
  if (res.success === false) throw new Error(res.error ?? `${type} failed`);
  if (type === "new_session" || type === "fork" || type === "clone") {
    await getAdapter(agentId).refreshSession();
  }
}
