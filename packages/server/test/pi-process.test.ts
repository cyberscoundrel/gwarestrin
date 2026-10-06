import { describe, expect, it } from "vitest";
import { PiProcess } from "../src/agents/pi-process.js";
import type { PiTransportHandlers } from "../src/agents/pi-transport.js";

function fakeTransport() {
  const written: string[] = [];
  const killed: string[] = [];
  let handlers!: PiTransportHandlers;
  const proc = new PiProcess({
    requestTimeoutMs: 50,
    transport: (h) => {
      handlers = h;
      return {
        pid: 4242,
        writable: true,
        async write(data) {
          written.push(data);
        },
        kill(signal) {
          killed.push(signal);
        },
      };
    },
  });
  const sentIds = () => written.map((l) => JSON.parse(l).id as string);
  return { proc, written, killed, sentIds, h: () => handlers };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("PiProcess over a PiTransport", () => {
  it("writes LF-terminated JSON and resolves the correlated response", async () => {
    const t = fakeTransport();
    const pending = t.proc.send("get_state");
    await tick();
    expect(t.written).toHaveLength(1);
    expect(t.written[0]!.endsWith("\n")).toBe(true);
    const id = t.sentIds()[0];
    t.h().stdout(Buffer.from(`{"type":"response","id":"${id}","command":"get_state","success":true}\n`));
    await expect(pending).resolves.toMatchObject({ success: true, command: "get_state" });
    expect(t.proc.pid).toBe(4242);
  });

  it("emits non-response lines as events, keeping U+2028 inside strings", async () => {
    const t = fakeTransport();
    const events: unknown[] = [];
    t.proc.on("event", (e) => events.push(e));
    const LSEP = String.fromCharCode(0x2028);
    const line = `{"type":"message_update","text":"a${LSEP}b"}\n`;
    // split mid-record across chunks, as a network stream would
    t.h().stdout(Buffer.from(line.slice(0, 10)));
    t.h().stdout(Buffer.from(line.slice(10)));
    expect(events).toEqual([{ type: "message_update", text: `a${LSEP}b` }]);
  });

  it("times out unanswered requests", async () => {
    const t = fakeTransport();
    await expect(t.proc.send("prompt")).rejects.toThrow(/timed out/);
  });

  it("rejects pending requests and refuses new ones after exit", async () => {
    const t = fakeTransport();
    const exits: unknown[] = [];
    t.proc.on("exit", (i) => exits.push(i));
    const pending = t.proc.send("get_state", {}, 5_000);
    t.h().exit({ code: 1, signal: null, crashed: true });
    await expect(pending).rejects.toThrow(/exited/);
    await expect(t.proc.send("get_state")).rejects.toThrow(/exited/);
    expect(t.proc.hasExited).toBe(true);
    expect(exits).toHaveLength(1);
    // duplicate exit reports (error + exit) are collapsed
    t.h().exit({ code: null, signal: null, crashed: true });
    expect(exits).toHaveLength(1);
  });

  it("keeps a stderr tail and forwards kill to the transport", () => {
    const t = fakeTransport();
    t.h().stderr("boom\n");
    expect(t.proc.lastStderr).toBe("boom\n");
    t.proc.kill("SIGTERM");
    expect(t.killed).toEqual(["SIGTERM"]);
    t.h().exit({ code: null, signal: "SIGTERM", crashed: true });
    t.proc.kill("SIGKILL");
    expect(t.killed).toEqual(["SIGTERM"]);
  });
});
