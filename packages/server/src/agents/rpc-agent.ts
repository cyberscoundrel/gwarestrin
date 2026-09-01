import { EventEmitter } from "node:events";
import type { AgentRecord, AgentRuntimeSummary } from "@gwarestrin/shared";
import { scoped } from "../util/log.js";
import type { PiProcess, RpcResponse } from "./pi-process.js";

const log = scoped("rpc-agent");

export interface RpcAgentEvents {
  event: [event: Record<string, unknown> & { type: string }];
  uiRequest: [request: Record<string, unknown> & { type: string }];
  state: [state: AgentRuntimeSummary];
  sessionFile: [file: string];
  closed: [];
}

/** Typed facade over a running PiProcess for one agent. */
export class RpcAgent extends EventEmitter<RpcAgentEvents> {
  readonly agentId: string;
  readonly pid: number | undefined;
  private proc: PiProcess;
  private closed = false;
  private vm: AgentRuntimeSummary["vm"];
  private restarts = 0;
  private lastError?: string;

  constructor(agentId: string, proc: PiProcess) {
    super();
    this.agentId = agentId;
    this.proc = proc;
    this.pid = proc.pid;

    proc.on("event", (ev) => {
      if (ev.type === "extension_ui_request") this.emit("uiRequest", ev);
      else this.emit("event", ev);
    });
    proc.on("exit", () => {
      this.closed = true;
      this.emit("closed");
    });
    proc.on("stderr", (text) => {
      // keep notable stderr for error surfaces; pi writes logs here
      const trimmed = text.trim();
      if (trimmed) log.debug(`[${agentId}] ${trimmed.slice(0, 300)}`);
    });
  }

  get exited(): boolean {
    return this.closed;
  }

  summary(): AgentRuntimeSummary {
    return {
      id: this.agentId,
      status: this.closed ? "error" : "running",
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      ...(this.vm ? { vm: this.vm } : {}),
      ...(this.restarts ? { restarts: this.restarts } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  noteRestart(): void {
    this.restarts++;
  }

  noteError(message: string): void {
    this.lastError = message;
  }

  noteVm(state: NonNullable<AgentRuntimeSummary["vm"]>): void {
    this.vm = state;
    this.emit("state", this.summary());
  }

  lastStderr(): string {
    return this.proc.lastStderr;
  }

  async send(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<RpcResponse> {
    const res = await this.proc.send(type, payload, timeoutMs);
    // session-replacing commands move the transcript to a new file; re-pull so
    // the manager persists it and the next restart resumes the right session
    if (res.success && (type === "new_session" || type === "fork" || type === "clone")) {
      try {
        const st = await this.proc.send("get_state", {}, 10_000);
        const file = (st.data as { sessionFile?: string } | undefined)?.sessionFile;
        if (file) this.emit("sessionFile", file);
      } catch {
        /* best-effort */
      }
    }
    return res;
  }

  /** browser-originated ui_response goes straight to stdin */
  uiResponse(response: Record<string, unknown>): void {
    this.proc.writeRaw(response);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.proc.kill(signal);
  }

  async waitIdle(): Promise<void> {
    // best-effort: wait until isStreaming is false
    for (let i = 0; i < 100; i++) {
      const res = await this.send("get_state");
      const state = res.data as { isStreaming?: boolean } | undefined;
      if (!state?.isStreaming) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export function toRuntimeStatus(record: AgentRecord): AgentRuntimeSummary {
  return { id: record.id, status: record.status };
}
