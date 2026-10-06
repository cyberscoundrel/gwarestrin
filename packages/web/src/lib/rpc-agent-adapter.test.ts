import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "./agent-types.js";

// Fake socket: every rpc() is parked until the test answers it, so we can
// reproduce overlapping bootstraps and snapshot/prompt races deterministically.
type Pending = { type: string; payload: Record<string, unknown>; resolve: (v: Record<string, unknown>) => void };
const fake = vi.hoisted(() => ({
  calls: [] as Pending[],
  statusListeners: new Set<(s: string) => void>(),
}));

vi.mock("./ws-client.js", () => ({
  ws: {
    rpc: (_agentId: string, type: string, payload: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve) => fake.calls.push({ type, payload, resolve })),
    onMessage: () => () => {},
    // like the real client: reports the current status immediately
    onStatus: (l: (s: string) => void) => {
      fake.statusListeners.add(l);
      l("open");
      return () => fake.statusListeners.delete(l);
    },
  },
}));

const { RpcAgentAdapter, mergeSnapshot } = await import("./rpc-agent-adapter.js");

const user = (text: string, content: unknown = text): AgentMessage => ({ role: "user", content, timestamp: 1 });
const assistant = (text: string): AgentMessage => ({ role: "assistant", content: [{ type: "text", text }] });

/** answer every parked get_state/get_messages call with this snapshot */
function answerBootstraps(messages: AgentMessage[]): void {
  for (const c of fake.calls.splice(0)) {
    if (c.type === "get_state") c.resolve({ data: { model: null, thinkingLevel: "off", isStreaming: false } });
    else if (c.type === "get_messages") c.resolve({ data: { messages: structuredClone(messages) } });
    else c.resolve({ success: true });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("RpcAgentAdapter bootstrap", () => {
  beforeEach(() => {
    fake.calls.length = 0;
    fake.statusListeners.clear();
  });

  it("renders an existing conversation once when bootstraps overlap", async () => {
    // constructor + immediate onStatus("open") already start two bootstraps
    const a = new RpcAgentAdapter("agent-1");
    expect(fake.calls.filter((c) => c.type === "get_messages").length).toBeGreaterThanOrEqual(2);
    const history = [user("hi", [{ type: "text", text: "hi" }]), assistant("hello"), user("again"), assistant("sure")];
    answerBootstraps(history);
    await flush();
    expect(a.state.messages).toHaveLength(history.length);

    // a later re-bootstrap (reconnect / agent_state running) must not stack
    for (const l of fake.statusListeners) l("open");
    void a.refreshSession();
    answerBootstraps(history);
    await flush();
    expect(a.state.messages).toHaveLength(history.length);
  });

  it("keeps the optimistic first prompt when the snapshot predates it, then confirms it", async () => {
    const a = new RpcAgentAdapter("agent-2");
    const prompt = a.prompt("list the files").catch(() => {});
    // the server answers get_messages before it has processed the prompt
    answerBootstraps([]);
    await flush();
    expect(a.state.messages.map((m) => m.role)).toEqual(["user"]);
    await prompt;

    // later snapshot contains the processed prompt (as text blocks): no duplicate
    void a.refreshSession();
    answerBootstraps([user("list the files", [{ type: "text", text: "list the files" }]), assistant("done")]);
    await flush();
    expect(a.state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("mergeSnapshot", () => {
  it("returns the snapshot untouched with nothing pending", () => {
    const snap = [user("a"), assistant("b")];
    expect(mergeSnapshot(snap, []).messages).toBe(snap);
  });

  it("appends a pending prompt the snapshot does not have yet", () => {
    const p = user("new");
    const r = mergeSnapshot([user("old"), assistant("x")], [p]);
    expect(r.messages.at(-1)).toBe(p);
    expect(r.stillPending).toEqual([p]);
  });

  it("does not treat an older identical prompt as confirmation", () => {
    // "yes" was said earlier; the new "yes" is not processed yet
    const p = user("yes");
    const snap = [user("yes"), assistant("ok"), user("something else"), assistant("ok")];
    expect(mergeSnapshot(snap, [p]).stillPending).toEqual([p]);
  });
});
