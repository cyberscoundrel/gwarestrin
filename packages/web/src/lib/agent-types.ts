/**
 * Minimal structural types for the pi-agent-core `Agent` surface consumed by
 * pi-web-ui (verified against web-ui 0.75.3 src): state, subscribe, prompt,
 * abort, streamFn, getApiKey. Kept local so the web bundle never imports
 * node-flavored packages at runtime.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | ToolCall;

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  totalTokens?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface AgentMessage {
  role: string;
  content: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  usage?: Usage;
  api?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  attachments?: unknown[];
  [key: string]: unknown;
}

export interface AgentToolInfo {
  name: string;
  label: string;
  description?: string;
  parameters?: unknown;
}

export interface AgentState {
  systemPrompt: string;
  model: ModelInfo | null;
  thinkingLevel: ThinkingLevel;
  tools: AgentToolInfo[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: AgentMessage | undefined;
  pendingToolCalls: ReadonlySet<string>;
  errorMessage?: string | undefined;
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: AgentMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent?: unknown }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "agent_settled" }
  | { type: string; [key: string]: unknown };

/** the interface pi-web-ui's AgentInterface expects */
export interface Agent {
  state: AgentState;
  streamFn: unknown;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(input: string | AgentMessage, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  abort(): void;
}
