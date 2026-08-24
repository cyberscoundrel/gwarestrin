import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createLfLineSplitter } from "../util/lf-splitter.js";
import { scoped } from "../util/log.js";

const log = scoped("pi-process");

export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type PiLine = Record<string, unknown> & { type: string };

export interface PiProcessEvents {
  line: [line: PiLine];
  response: [response: RpcResponse];
  event: [event: PiLine];
  exit: [info: { code: number | null; signal: NodeJS.Signals | null; crashed: boolean }];
  stderr: [text: string];
}

export interface SpawnOptions {
  cliPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** response timeout per command (ms) */
  requestTimeoutMs?: number;
}

/**
 * Child `pi --mode rpc` process with:
 *  - strict LF-only JSONL framing (rpc.md: readline is non-compliant, it
 *    splits on U+2028/U+2029 which are legal inside JSON strings)
 *  - id-correlated request/response with timeouts
 *  - event emission for non-response stdout lines
 */
export class PiProcess extends EventEmitter<PiProcessEvents> {
  readonly pid: number | undefined;
  private child: ChildProcess;
  private pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private stderrTail = "";
  private exited = false;
  private requestTimeoutMs: number;
  private stdinQueue: string[] = [];
  private stdinBusy = false;

  constructor(opts: SpawnOptions) {
    super();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.child = spawn(process.execPath, [opts.cliPath, ...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pid = this.child.pid;

    const splitter = createLfLineSplitter((line) => this.handleLine(line));
    this.child.stdout!.on("data", (chunk: Buffer) => splitter.feed(chunk));
    this.child.stdout!.on("end", () => splitter.flush());

    this.child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-8192);
      this.emit("stderr", text);
    });

    this.child.on("error", (err) => {
      log.error(`spawn error pid=${this.pid}`, err);
      this.setExited({ code: null, signal: null, crashed: true });
    });
    this.child.on("exit", (code, signal) => {
      this.setExited({ code, signal, crashed: code !== 0 && code !== null ? true : signal !== null });
    });
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get lastStderr(): string {
    return this.stderrTail;
  }

  /** Send an RPC command; resolves with the correlated response. */
  send(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<RpcResponse> {
    if (this.exited) return Promise.reject(new Error("pi process exited"));
    const id = `srv-${this.nextId++}`;
    const line = JSON.stringify({ id, type, ...payload });
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc '${type}' timed out after ${timeoutMs ?? this.requestTimeoutMs}ms`));
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeLine(line);
    });
  }

  /** Fire-and-forget stdin write (extension_ui_response etc). */
  writeRaw(obj: Record<string, unknown>): void {
    this.writeLine(JSON.stringify(obj));
  }

  private writeLine(line: string): void {
    this.stdinQueue.push(line + "\n");
    void this.drainStdin();
  }

  private async drainStdin(): Promise<void> {
    if (this.stdinBusy) return;
    this.stdinBusy = true;
    try {
      while (this.stdinQueue.length > 0) {
        const next = this.stdinQueue[0]!;
        if (this.exited || !this.child.stdin!.writable) {
          this.stdinQueue.length = 0;
          break;
        }
        const ok = this.child.stdin!.write(next);
        if (!ok) {
          await new Promise<void>((resolve) => this.child.stdin!.once("drain", resolve));
        }
        this.stdinQueue.shift();
      }
    } finally {
      this.stdinBusy = false;
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.exited) {
      try {
        this.child.kill(signal);
      } catch {
        /* already dead */
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: PiLine;
    try {
      parsed = JSON.parse(line) as PiLine;
    } catch {
      log.warn(`unparseable stdout line (pid=${this.pid}): ${line.slice(0, 200)}`);
      return;
    }
    if (parsed.type === "response" && typeof parsed.id === "string") {
      const response = parsed as unknown as RpcResponse;
      const entry = this.pending.get(parsed.id);
      if (entry) {
        this.pending.delete(parsed.id);
        clearTimeout(entry.timer);
        entry.resolve(response);
      } else {
        log.warn(`response for unknown id ${parsed.id}`);
      }
      this.emit("response", response);
    } else {
      this.emit("event", parsed);
    }
    this.emit("line", parsed);
  }

  private setExited(info: { code: number | null; signal: NodeJS.Signals | null; crashed: boolean }): void {
    if (this.exited) return;
    this.exited = true;
    const err = new Error(`pi process exited (code=${info.code} signal=${info.signal})`);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    this.emit("exit", info);
  }
}
