import { type ChildProcess, spawn } from "node:child_process";
import { scoped } from "../util/log.js";

const log = scoped("pi-transport");

export interface PiExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  crashed: boolean;
}

/** Callbacks a transport drives; PiProcess owns framing and correlation. */
export interface PiTransportHandlers {
  stdout(chunk: Buffer): void;
  stdoutEnd(): void;
  stderr(text: string): void;
  exit(info: PiExitInfo): void;
}

/**
 * Byte pipe to one `pi --mode rpc` process, wherever it runs (host child
 * process today; a sandbox exec stream later). No framing here.
 */
export interface PiTransport {
  readonly pid: number | undefined;
  readonly writable: boolean;
  /** Resolves once the data is accepted (honors backpressure). */
  write(data: string): Promise<void>;
  kill(signal: NodeJS.Signals): void;
}

export type PiTransportFactory = (handlers: PiTransportHandlers) => PiTransport;

export interface LocalSpawnOptions {
  cliPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Host child process (`node <cliPath> ...args`). */
export function localTransport(opts: LocalSpawnOptions): PiTransportFactory {
  return (handlers) => {
    const child: ChildProcess = spawn(process.execPath, [opts.cliPath, ...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout!.on("data", (chunk: Buffer) => handlers.stdout(chunk));
    child.stdout!.on("end", () => handlers.stdoutEnd());
    child.stderr!.on("data", (chunk: Buffer) => handlers.stderr(chunk.toString("utf8")));

    child.on("error", (err) => {
      log.error(`spawn error pid=${child.pid}`, err);
      handlers.exit({ code: null, signal: null, crashed: true });
    });
    child.on("exit", (code, signal) => {
      handlers.exit({ code, signal, crashed: code !== 0 && code !== null ? true : signal !== null });
    });

    return {
      pid: child.pid,
      get writable() {
        return child.stdin!.writable;
      },
      async write(data) {
        if (!child.stdin!.write(data)) {
          await new Promise<void>((resolve) => child.stdin!.once("drain", resolve));
        }
      },
      kill(signal) {
        try {
          child.kill(signal);
        } catch {
          /* already dead */
        }
      },
    };
  };
}
