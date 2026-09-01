import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import {
  isAllowedRpcCommand,
  type WsCommand,
  type WsAgentState,
  type WsClientMessage,
  type WsError,
  type WsEvent,
  type WsServerMessage,
  type WsUiRequest,
} from "@gwarestrin/shared";
import type { AgentManager } from "../agents/manager.js";
import type { ServerConfig } from "../config.js";
import { scoped } from "../util/log.js";

const log = scoped("ws");

/** RPC commands the browser may invoke that require extra care */
const LONG_RUNNING = new Set(["compact", "export_html", "get_tree"]);

interface PendingUiRequest {
  agentId: string;
  requestId: string;
  timer: NodeJS.Timeout;
}

/**
 * One WS connection per browser tab. Multiplexes agent traffic:
 *  - subscribes to manager events, forwarding envelopes for ALL agents
 *    (the browser filters by agentId; volume is low at this scale)
 *  - accepts whitelisted cmd passthrough + ui_response
 */
export class WsConnection {
  private socket: WebSocket;
  private manager: AgentManager;
  private pendingUi = new Map<string, PendingUiRequest>();
  private closed = false;
  private offManager: Array<() => void> = [];

  constructor(socket: WebSocket, manager: AgentManager) {
    this.socket = socket;
    this.manager = manager;
    this.attach();
  }

  private attach(): void {
    const onEvent = ({ agentId, event }: { agentId: string; event: Record<string, unknown> & { type: string } }) => {
      this.send({ v: 1, agentId, kind: "event", event } satisfies WsEvent);
    };
    const onUiRequest = ({ agentId, request }: { agentId: string; request: Record<string, unknown> & { type: string } }) => {
      const requestId = String(request.id ?? "");
      const method = String(request.method ?? "");
      // dialog methods require a response; fire-and-forget ones don't
      const needsResponse = ["select", "confirm", "input", "editor"].includes(method);
      if (needsResponse && requestId) {
        const timer = setTimeout(() => {
          // extension-side timeouts handle defaults; our fallback cancels
          this.respondUi(agentId, requestId, { type: "extension_ui_response", id: requestId, cancelled: true });
          this.pendingUi.delete(requestId);
        }, 120_000);
        this.pendingUi.set(requestId, { agentId, requestId, timer });
      }
      this.send({ v: 1, agentId, kind: "ui_request", request: request as WsUiRequest["request"] } satisfies WsUiRequest);
    };
    const onState = (state: import("@gwarestrin/shared").AgentRuntimeSummary) => {
      this.send({ v: 1, agentId: state.id, kind: "agent_state", state } satisfies WsAgentState);
    };

    const m = this.manager;
    m.on("agentEvent", onEvent);
    m.on("agentUiRequest", onUiRequest);
    m.on("agentState", onState);
    this.offManager = [
      () => m.off("agentEvent", onEvent),
      () => m.off("agentUiRequest", onUiRequest),
      () => m.off("agentState", onState),
    ];

    this.socket.on("message", (raw: unknown) => this.onMessage(raw));
    this.socket.on("close", () => this.cleanup());
    this.socket.on("error", () => this.cleanup());

    // initial snapshot of all agents
    for (const s of this.manager.listSummaries()) onState(s);
  }

  private onMessage(raw: unknown): void {
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(String(raw)) as WsClientMessage;
    } catch {
      this.sendError("", "invalid json");
      return;
    }
    if (!msg || msg.v !== 1 || typeof msg.agentId !== "string") {
      this.sendError(msg && "agentId" in msg ? msg.agentId : "", "invalid envelope");
      return;
    }
    if (msg.kind === "ui_response") {
      const r = msg.response;
      const pending = this.pendingUi.get(r.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingUi.delete(r.id);
      }
      this.respondUi(msg.agentId, r.id, r);
      return;
    }
    if (msg.kind === "cmd") {
      void this.onCommand(msg);
      return;
    }
    // unreachable per WsClientMessage's two kinds; defensive
    this.sendError("", `unknown kind ${(msg as { kind: string }).kind}`);
  }

  private async onCommand(msg: WsCommand): Promise<void> {
    const { agentId, type } = msg;
    if (!isAllowedRpcCommand(type)) {
      this.sendError(agentId, `command not allowed: ${type}`);
      return;
    }
    const agent = this.manager.getRunning(agentId);
    if (!agent) {
      this.sendError(agentId, "agent not running");
      return;
    }
    // strip envelope fields; pass the rest through as the RPC payload
    const { v: _v, kind: _k, agentId: _a, type: _t, id: _id, ...payload } = msg;
    try {
      const timeout = LONG_RUNNING.has(type) ? 300_000 : undefined;
      const res = await agent.send(type, payload as Record<string, unknown>, timeout);
      const { id } = msg;
      this.send({ v: 1, agentId, kind: "event", event: { ...res, ...(id !== undefined ? { browserId: id } : {}) } } satisfies WsEvent);
    } catch (err) {
      this.sendError(agentId, err instanceof Error ? err.message : String(err));
    }
  }

  private respondUi(agentId: string, requestId: string, response: Record<string, unknown>): void {
    const agent = this.manager.getRunning(agentId);
    if (!agent) return;
    agent.uiResponse(response);
  }

  private send(msg: WsServerMessage): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(msg));
  }

  private sendError(agentId: string, message: string): void {
    this.send({ v: 1, agentId, kind: "error", message } satisfies WsError);
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pendingUi) {
      clearTimeout(p.timer);
      this.respondUi(p.agentId, p.requestId, { type: "extension_ui_response", id: p.requestId, cancelled: true });
    }
    this.pendingUi.clear();
    for (const off of this.offManager) off();
  }
}

export async function registerWs(app: FastifyInstance, config: ServerConfig, manager: AgentManager): Promise<void> {
  await app.register(websocket);
  app.get("/ws", { websocket: true }, (socket /* , req */) => {
    log.info("ws client connected");
    new WsConnection(socket as WebSocket, manager);
  });
}
