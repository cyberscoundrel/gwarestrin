/**
 * Wire envelope between browser and server over /ws.
 *
 * kind:
 *  - "cmd":        whitelisted pi RPC command passthrough (browser -> server)
 *  - "event":      pi RPC event fanned out to subscribed sockets (server -> browser)
 *  - "ui_request": extension_ui_request needing a response (server -> browser)
 *  - "ui_response": browser's answer to a ui_request (browser -> server)
 *  - "agent_state": manager-level runtime summary (server -> browser)
 *  - "error":      bridge error (server -> browser)
 */

/** RPC commands the bridge is allowed to forward to pi stdin. */
export const RPC_COMMAND_ALLOWLIST = [
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "new_session",
  "get_state",
  "get_messages",
  "set_model",
  "cycle_model",
  "get_available_models",
  "set_thinking_level",
  "cycle_thinking_level",
  "get_available_thinking_levels",
  "set_steering_mode",
  "set_follow_up_mode",
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "abort_bash",
  "get_session_stats",
  "export_html",
  "switch_session",
  "fork",
  "clone",
  "get_fork_messages",
  "get_entries",
  "get_tree",
  "get_last_assistant_text",
  "set_session_name",
  "get_commands",
] as const;

export type AllowedRpcCommand = (typeof RPC_COMMAND_ALLOWLIST)[number];

export interface WsCommand {
  v: 1;
  agentId: string;
  kind: "cmd";
  /** correlation id chosen by the browser; echoed on the response */
  id?: string;
  type: AllowedRpcCommand;
  [key: string]: unknown;
}

export interface WsEvent {
  v: 1;
  agentId: string;
  kind: "event";
  event: Record<string, unknown> & { type: string };
}

export interface WsUiRequest {
  v: 1;
  agentId: string;
  kind: "ui_request";
  request: {
    type: "extension_ui_request";
    id: string;
    method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
    [key: string]: unknown;
  };
}

export interface WsUiResponse {
  v: 1;
  agentId: string;
  kind: "ui_response";
  response: {
    type: "extension_ui_response";
    id: string;
    value?: unknown;
    confirmed?: boolean;
    cancelled?: boolean;
  };
}

export interface WsAgentState {
  v: 1;
  agentId: string;
  kind: "agent_state";
  state: import("./api-types.js").AgentRuntimeSummary;
}

export interface WsError {
  v: 1;
  agentId: string;
  kind: "error";
  message: string;
}

export type WsServerMessage = WsEvent | WsUiRequest | WsAgentState | WsError;
export type WsClientMessage = WsCommand | WsUiResponse;

export function isAllowedRpcCommand(type: string): type is AllowedRpcCommand {
  return (RPC_COMMAND_ALLOWLIST as readonly string[]).includes(type);
}
