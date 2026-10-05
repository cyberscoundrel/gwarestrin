import { SdkError } from "@nvidia/openshell-sdk";
import { describe, expect, it } from "vitest";
import { PiProcess } from "../src/agents/pi-process.js";
import { OpenShellRuntime, type SandboxApi, openShellTransport, sandboxNameFor } from "../src/runtime/openshell.js";

type Ev = { stream: "stdout" | "stderr"; data: Buffer } | { type: "exit"; exitCode: number };

/** Controllable stand-in for an ExecInteractiveSessionControl. */
function fakeSession() {
  const queue: Ev[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let failWith: unknown;
  const written: string[] = [];
  const calls: string[] = [];
  const pump = () => {
    wake?.();
    wake = undefined;
  };
  const session = {
    output: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          if (failWith) throw failWith;
          if (ended) return;
          await new Promise<void>((r) => (wake = r));
        }
      },
    },
    write: (b: Buffer) => written.push(b.toString("utf8")),
    resize: () => {},
    close: () => {},
    closeInput: () => {
      calls.push("closeInput");
    },
    cancel: () => {
      calls.push("cancel");
    },
    done: Promise.resolve(0),
    exitCode: undefined as number | undefined,
  };
  return {
    session,
    written,
    calls,
    stdout: (s: string) => (queue.push({ stream: "stdout", data: Buffer.from(s) }), pump()),
    stderr: (s: string) => (queue.push({ stream: "stderr", data: Buffer.from(s) }), pump()),
    exit: (code: number) => (queue.push({ type: "exit", exitCode: code }), (ended = true), pump()),
    end: () => ((ended = true), pump()),
    fail: (err: unknown) => ((failWith = err), pump()),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

function procOver(fake: ReturnType<typeof fakeSession>, opts: { delayMs?: number; reject?: unknown } = {}) {
  const execArgs: unknown[][] = [];
  const client = {
    execInteractive: (...args: unknown[]) => {
      execArgs.push(args);
      if (opts.reject) return Promise.reject(opts.reject);
      return new Promise((r) => setTimeout(() => r(fake.session), opts.delayMs ?? 0));
    },
  } as unknown as Parameters<typeof openShellTransport>[0];
  const proc = new PiProcess({
    requestTimeoutMs: 500,
    transport: openShellTransport(client, "gw-a", ["node", "rpc-entry.js"], { workdir: "/sandbox", environment: { A: "1" } }),
  });
  return { proc, execArgs };
}

describe("openShellTransport", () => {
  it("execs with tty off and correlates RPC responses", async () => {
    const fake = fakeSession();
    const { proc, execArgs } = procOver(fake);
    const pending = proc.send("get_state");
    await new Promise((r) => setTimeout(r, 5));
    expect(execArgs[0]![0]).toBe("gw-a");
    expect(execArgs[0]![2]).toMatchObject({ tty: false, noLoginShell: true, workdir: "/sandbox", environment: { A: "1" } });
    const id = JSON.parse(fake.written[0]!).id;
    fake.stdout(`{"type":"response","id":"${id}","command":"get_state","success":true}\n`);
    await expect(pending).resolves.toMatchObject({ success: true });
    expect(proc.pid).toBeUndefined();
  });

  it("delivers writes issued before the session opens", async () => {
    const fake = fakeSession();
    const { proc } = procOver(fake, { delayMs: 30 });
    void proc.send("get_state").catch(() => {});
    expect(fake.written).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.written).toHaveLength(1);
  });

  it("forwards stderr and reports a clean exit as not crashed", async () => {
    const fake = fakeSession();
    const { proc } = procOver(fake);
    const exits: unknown[] = [];
    proc.on("exit", (i) => exits.push(i));
    await tick();
    fake.stderr("warn\n");
    fake.exit(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(proc.lastStderr).toBe("warn\n");
    expect(exits).toEqual([{ code: 0, signal: null, crashed: false }]);
  });

  it("SIGTERM closes stdin and reports the signal (manager treats it as a stop)", async () => {
    const fake = fakeSession();
    const { proc } = procOver(fake);
    const exits: unknown[] = [];
    proc.on("exit", (i) => exits.push(i));
    await new Promise((r) => setTimeout(r, 5));
    proc.kill("SIGTERM");
    await tick();
    expect(fake.calls).toEqual(["closeInput"]);
    fake.exit(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(exits).toEqual([{ code: 0, signal: "SIGTERM", crashed: true }]);
  });

  it("SIGKILL cancels the exec", async () => {
    const fake = fakeSession();
    const { proc } = procOver(fake);
    await new Promise((r) => setTimeout(r, 5));
    proc.kill("SIGKILL");
    await tick();
    expect(fake.calls).toEqual(["cancel"]);
  });

  it("a dropped stream is a crash with the reason in stderr", async () => {
    const fake = fakeSession();
    const { proc } = procOver(fake);
    const exits: unknown[] = [];
    proc.on("exit", (i) => exits.push(i));
    await new Promise((r) => setTimeout(r, 5));
    fake.fail(new Error("stream reset"));
    await new Promise((r) => setTimeout(r, 5));
    expect(exits).toEqual([{ code: null, signal: null, crashed: true }]);
    expect(proc.lastStderr).toContain("stream reset");
  });

  it("a failed exec start rejects pending requests", async () => {
    const fake = fakeSession();
    const { proc } = procOver(fake, { reject: new Error("sandbox gone") });
    await expect(proc.send("get_state")).rejects.toThrow(/exited/);
    expect(proc.lastStderr).toContain("sandbox gone");
  });
});

describe("OpenShellRuntime", () => {
  function fakeApi(existing: boolean) {
    const calls: Array<[string, unknown]> = [];
    const api = {
      get: async (name: string, opts: unknown) => {
        calls.push(["get", { name, opts }]);
        if (!existing) throw new SdkError("not_found", "no such sandbox");
        return {};
      },
      create: async (spec: unknown) => (calls.push(["create", spec]), {}),
      waitReady: async (name: string, secs: number) => (calls.push(["waitReady", { name, secs }]), {}),
      delete: async (name: string, opts: unknown) => (calls.push(["delete", { name, opts }]), {}),
      execInteractive: async () => {
        throw new Error("unused");
      },
    } as unknown as SandboxApi;
    return { api, calls };
  }

  it("creates a missing sandbox idling on sleep, then waits for ready", async () => {
    const { api, calls } = fakeApi(false);
    const rt = new OpenShellRuntime(api, { workspace: "alice", image: "gwarestrin-agent:dev" });
    const name = await rt.ensureSandbox("1b2c", { providers: ["or-alice"], environment: { X: "1" } });
    expect(name).toBe("gw-1b2c");
    expect(calls.map((c) => c[0])).toEqual(["get", "create", "waitReady"]);
    expect(calls[1]![1]).toMatchObject({
      name: "gw-1b2c",
      workspace: "alice",
      image: "gwarestrin-agent:dev",
      command: ["sleep", "infinity"],
      providers: ["or-alice"],
      environment: { X: "1" },
      labels: { "gwarestrin.agent": "1b2c" },
    });
  });

  it("reuses an existing sandbox", async () => {
    const { api, calls } = fakeApi(true);
    const rt = new OpenShellRuntime(api, { image: "img" });
    await rt.ensureSandbox("1b2c");
    expect(calls.map((c) => c[0])).toEqual(["get", "waitReady"]);
  });

  it("deletes tolerantly", async () => {
    const { api, calls } = fakeApi(true);
    await new OpenShellRuntime(api, { image: "img" }).deleteSandbox("1b2c");
    expect(calls[0]).toEqual(["delete", { name: "gw-1b2c", opts: { allowMissing: true } }]);
  });

  it("rejects ids that cannot be sandbox names", () => {
    expect(() => sandboxNameFor("../x")).toThrow();
    expect(sandboxNameFor("3f2a9c1e-0000-4000-8000-123456789abc")).toBe("gw-3f2a9c1e-0000-4000-8000-123456789abc");
  });
});
