import type { WsServerMessage } from "@gwarestrin/shared";
import type { Agent, AgentEvent, AgentMessage, AgentState, ContentBlock, ModelInfo } from "./agent-types.js";
import { ws } from "./ws-client.js";

/** static tool descriptors so web-ui renderers can label tool calls */
const TOOL_STUBS = ["read", "write", "edit", "bash", "mcp", "mcpScript"].map((n) => ({
  name: n,
  label: n.charAt(0).toUpperCase() + n.slice(1),
  description: `${n} tool`,
}));

interface Attachment {
  id?: string;
  type: string;
  fileName?: string;
  mimeType?: string;
  content?: string;
}

function emptyState(): AgentState {
  return {
    systemPrompt: "",
    model: null,
    thinkingLevel: "off",
    tools: [...TOOL_STUBS],
    messages: [],
    isStreaming: false,
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
    errorMessage: undefined,
  };
}

/**
 * Browser-side Agent implementation bridging pi RPC over the gwarestrin WS.
 *
 * Event flow (rpc.md):
 *  - message_start/message_end: append/finalize messages
 *  - message_update: assistantMessageEvent deltas assembled by contentIndex
 *    (thinking_delta / text_delta / toolcall_delta; toolcall_start gives
 *    id+name; message_end.message is authoritative)
 *  - tool_execution_*: pendingToolCalls set + live toolResult updates
 *  - turn_end: appends assistant message + toolResults (authoritative)
 *  - agent_start/agent_settled: isStreaming
 */
export class RpcAgentAdapter implements Agent {
  readonly agentId: string;
  state: AgentState = emptyState();
  streamFn: unknown = function gwarestrinServerStream() {
    throw new Error("streaming is server-side");
  };
  getApiKey = async () => "managed-by-server";

  private listeners = new Set<(ev: AgentEvent) => void>();
  private offWs: () => void;
  private offStatus: () => void;
  private partial: AgentMessage | null = null;
  private blocks: ContentBlock[] = [];
  private disposed = false;
  private bootstrapped = false;

  constructor(agentId: string) {
    this.agentId = agentId;
    this.offWs = ws.onMessage((msg) => {
      if (msg.agentId !== this.agentId) return;
      this.onServerMessage(msg);
    });
    // retry bootstrap when the socket (re)connects if it never succeeded
    this.offStatus = ws.onStatus((s) => {
      if (s === "open" && !this.bootstrapped && !this.disposed) void this.bootstrap();
    });
    void this.bootstrap();
  }

  dispose(): void {
    this.disposed = true;
    this.offWs();
    this.offStatus();
    this.listeners.clear();
  }

  subscribe(listener: (ev: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: AgentEvent): void {
    for (const l of [...this.listeners]) l(ev);
  }

  async prompt(input: string | AgentMessage, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    let message = "";
    let promptImages: Array<{ type: "image"; data: string; mimeType: string }> | undefined = images;

    if (typeof input === "string") {
      message = input;
    } else if (input && typeof input === "object" && "content" in input) {
      message = String((input as { content: unknown }).content ?? "");
      const atts = (input as { attachments?: Attachment[] }).attachments;
      if (atts?.length) {
        promptImages = (promptImages ?? []).concat(
          atts
            .filter((a) => a.type === "image" && a.content && a.mimeType)
            .map((a) => ({ type: "image" as const, data: a.content!, mimeType: a.mimeType! })),
        );
      }
    }

    // optimistic local append for BOTH input paths (server message_end
    // replaces the tail duplicate); pi-web-ui renders only from state.messages
    const withAttachments = input && typeof input === "object";
    const atts = withAttachments ? (input as { attachments?: Attachment[] }).attachments : undefined;
    const userMsg = {
      role: withAttachments && (input as { role?: string }).role === "user-with-attachments"
        ? "user-with-attachments"
        : "user",
      content: message,
      timestamp: Date.now(),
      ...(atts?.length ? { attachments: atts } : {}),
    } as AgentMessage;
    this.state = { ...this.state, messages: [...this.state.messages, userMsg] };
    this.emit({ type: "message_end", message: userMsg });

    const payload: Record<string, unknown> = { message };
    if (this.state.isStreaming) payload.streamingBehavior = "steer";
    if (promptImages?.length) payload.images = promptImages;

    const res = (await ws.rpc(this.agentId, "prompt", payload)) as { success?: boolean; error?: string };
    if (res.success === false) {
      this.state = { ...this.state, errorMessage: res.error };
      throw new Error(res.error ?? "prompt failed");
    }
  }

  abort(): void {
    void ws.rpc(this.agentId, "abort").catch(() => {});
  }

  /** model setter routed through set_model */
  async setModel(provider: string, modelId: string): Promise<void> {
    const res = (await ws.rpc(this.agentId, "set_model", { provider, modelId })) as {
      success?: boolean;
      data?: { model?: ModelInfo } | ModelInfo;
      error?: string;
    };
    if (!res.success) throw new Error(res.error ?? "set_model failed");
    // pi nests the model either under data.model or directly on data depending
    // on command shape — accept both, and stamp the requested provider (pi's
    // response omits it for custom-registered providers)
    const raw = res.data && "model" in res.data ? (res.data.model as ModelInfo) : (res.data as ModelInfo | undefined);
    if (raw?.id) {
      this.state = { ...this.state, model: { ...raw, provider } };
      this.emit({ type: "model_changed" as never });
    }
  }

  async setThinkingLevel(level: string): Promise<void> {
    await ws.rpc(this.agentId, "set_thinking_level", { level });
    this.state = { ...this.state, thinkingLevel: level as AgentState["thinkingLevel"] };
  }

  async availableModels(): Promise<ModelInfo[]> {
    const res = (await ws.rpc(this.agentId, "get_available_models")) as {
      success?: boolean;
      data?: { models?: ModelInfo[] };
    };
    return res.data?.models ?? [];
  }

  async availableThinkingLevels(): Promise<string[]> {
    const res = (await ws.rpc(this.agentId, "get_available_thinking_levels")) as {
      data?: { levels?: string[] };
    };
    return res.data?.levels ?? ["off"];
  }

  /** re-pull state+messages after the session was replaced server-side
   *  (new_session / fork / clone) — pi does not announce this over events */
  async refreshSession(): Promise<void> {
    this.partial = null;
    this.blocks = [];
    this.state = { ...emptyState(), messages: [] };
    await this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    try {
      const results = (await Promise.all([
        ws.rpc(this.agentId, "get_state"),
        ws.rpc(this.agentId, "get_messages"),
      ])) as Array<{ data?: Record<string, unknown> }>;
      const stateRes = results[0]!;
      const messagesRes = results[1]!;
      const s = (stateRes.data ?? {}) as {
        model?: ModelInfo | null;
        thinkingLevel?: AgentState["thinkingLevel"];
        isStreaming?: boolean;
      };
      const messages = ((messagesRes.data ?? {}) as { messages?: AgentMessage[] }).messages ?? [];
      this.state = {
        ...this.state,
        model: s.model ?? null,
        thinkingLevel: s.thinkingLevel ?? "off",
        isStreaming: Boolean(s.isStreaming),
        messages,
      };
      this.bootstrapped = true;
      this.emit({ type: "bootstrap_complete" as never });
      // pi-web-ui re-renders only on its known events; kick it after the
      // state snapshot lands so history shows without a new prompt
      this.emit({ type: "turn_start" });
    } catch {
      /* agent likely not running / socket down; retried on start or reconnect */
    }
  }

  private onServerMessage(msg: WsServerMessage): void {
    if (msg.kind === "agent_state") {
      // adapter may have been constructed while the agent was stopped
      if (msg.state.status === "running" && !this.bootstrapped) void this.bootstrap();
      this.emit({ type: "runtime_state" as never, ...({ runtime: msg.state } as object) });
      return;
    }
    if (msg.kind !== "event") return;
    this.onRpcEvent(msg.event as Record<string, unknown> & { type: string });
  }

  private onRpcEvent(ev: Record<string, unknown> & { type: string }): void {
    switch (ev.type) {
      case "message_start": {
        const message = ev.message as AgentMessage;
        if (message?.role === "assistant") {
          this.partial = { ...message, content: [] };
          this.blocks = [];
        }
        this.emit({ type: "message_start", message });
        break;
      }
      case "message_update": {
        const delta = ev.assistantMessageEvent as
          | {
              type: string;
              contentIndex?: number;
              delta?: string;
              id?: string;
              toolName?: string;
              toolCall?: unknown;
            }
          | undefined;
        if (!delta || !this.partial) break;
        this.applyDelta(delta);
        this.state = { ...this.state, streamingMessage: { ...this.partial, content: [...this.blocks] } };
        this.emit({
          type: "message_update",
          message: { ...this.partial, content: [...this.blocks] },
          assistantMessageEvent: delta,
        });
        break;
      }
      case "message_end": {
        const message = ev.message as AgentMessage;
        if (message?.role === "assistant") {
          this.appendMessage(message);
          this.partial = null;
          this.blocks = [];
          this.state = { ...this.state, streamingMessage: undefined };
        }
        this.emit({ type: "message_end", message });
        break;
      }
      case "tool_execution_start": {
        const { toolCallId } = ev as unknown as { toolCallId: string };
        const pending = new Set(this.state.pendingToolCalls);
        pending.add(toolCallId);
        this.state = { ...this.state, pendingToolCalls: pending };
        this.emit({ type: "tool_execution_start", toolCallId, toolName: String(ev.toolName), args: ev.args });
        break;
      }
      case "tool_execution_update":
        this.emit({
          type: "tool_execution_update",
          toolCallId: String(ev.toolCallId),
          toolName: String(ev.toolName),
          args: ev.args,
          partialResult: ev.partialResult,
        });
        break;
      case "tool_execution_end": {
        const { toolCallId } = ev as unknown as { toolCallId: string };
        const pending = new Set(this.state.pendingToolCalls);
        pending.delete(toolCallId);
        this.state = { ...this.state, pendingToolCalls: pending };
        this.emit({
          type: "tool_execution_end",
          toolCallId,
          toolName: String(ev.toolName),
          result: ev.result,
          isError: Boolean(ev.isError),
        });
        break;
      }
      case "turn_end": {
        // authoritative: replace trailing assistant message + append results
        const message = ev.message as AgentMessage;
        const toolResults = (ev.toolResults ?? []) as AgentMessage[];
        if (message) {
          this.replaceOrAppend(message);
          for (const tr of toolResults) this.appendMessage(tr);
        }
        this.emit({ type: "turn_end", message, toolResults });
        break;
      }
      case "agent_start":
        this.state = { ...this.state, isStreaming: true, errorMessage: undefined };
        this.emit({ type: "agent_start" });
        break;
      case "agent_settled":
      case "agent_end":
        this.state = { ...this.state, isStreaming: false };
        this.emit(ev as AgentEvent);
        // pi-web-ui finalizes the streaming container on agent_end
        this.emit({ type: "agent_end" });
        break;
      case "queue_update":
        this.emit({ type: "queue_update", steering: ev.steering as string[], followUp: ev.followUp as string[] });
        break;
      default:
        // compaction_*, auto_retry_*, session events pass through untouched
        this.emit(ev as AgentEvent);
        break;
    }
  }

  private applyDelta(delta: { type: string; contentIndex?: number; delta?: string; id?: string; toolName?: string }): void {
    const idx = delta.contentIndex ?? this.blocks.length;
    while (this.blocks.length <= idx) {
      this.blocks.push({ type: "text", text: "" });
    }
    const target = this.blocks[idx]!;
    switch (delta.type) {
      case "text_start":
        this.blocks[idx] = { type: "text", text: "" };
        break;
      case "text_delta":
        this.blocks[idx] = { type: "text", text: (target as { text: string }).text + (delta.delta ?? "") };
        break;
      case "thinking_start":
        this.blocks[idx] = { type: "thinking", thinking: "" };
        break;
      case "thinking_delta":
        this.blocks[idx] = {
          type: "thinking",
          thinking: (target as { thinking: string }).thinking + (delta.delta ?? ""),
        };
        break;
      case "toolcall_start":
        this.blocks[idx] = { type: "toolCall", id: delta.id ?? "", name: delta.toolName ?? "", arguments: "" };
        break;
      case "toolcall_delta": {
        const tc = target as { type: "toolCall"; id: string; name: string; arguments: unknown };
        this.blocks[idx] = { ...tc, arguments: String(tc.arguments ?? "") + (delta.delta ?? "") };
        break;
      }
      default:
        break;
    }
  }

  private appendMessage(m: AgentMessage): void {
    // replace an optimistic duplicate (same role+content at tail)
    const tail = this.state.messages[this.state.messages.length - 1];
    if (tail && tail.role === m.role && tail.content === m.content) {
      const rest = this.state.messages.slice(0, -1);
      this.state = { ...this.state, messages: [...rest, m] };
      return;
    }
    this.state = { ...this.state, messages: [...this.state.messages, m] };
  }

  private replaceOrAppend(m: AgentMessage): void {
    // replace trailing assistant message (streamed copy) with the final one
    const tail = this.state.messages[this.state.messages.length - 1];
    if (tail?.role === "assistant") {
      const rest = this.state.messages.slice(0, -1);
      this.state = { ...this.state, messages: [...rest, m] };
      return;
    }
    this.state = { ...this.state, messages: [...this.state.messages, m] };
  }
}

const adapters = new Map<string, RpcAgentAdapter>();

export function getAdapter(agentId: string): RpcAgentAdapter {
  let a = adapters.get(agentId);
  if (!a) {
    a = new RpcAgentAdapter(agentId);
    adapters.set(agentId, a);
  }
  return a;
}

export function disposeAdapter(agentId: string): void {
  adapters.get(agentId)?.dispose();
  adapters.delete(agentId);
}
