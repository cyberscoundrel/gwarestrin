import { EventEmitter } from "node:events";
import type { AgentRecord, GraphRole } from "@gwarestrin/shared";
import { describe, expect, it } from "vitest";
import { GraphPool, threadName, type GraphCall } from "../src/agents/graph-pool.js";
import type { AgentManager } from "../src/agents/manager.js";

// a manager that runs no pi: agents "settle" as soon as they're prompted
function fakeManager(opts: { settle?: "ok" | "never" | "stop"; levelModels?: Record<string, { provider: string; modelId: string }> } = {}) {
  const records = new Map<string, AgentRecord>();
  const running = new Map<string, EventEmitter>();
  const prompts: Array<[string, string]> = [];
  let n = 0;
  const m = {
    profiles: { graphWorker: () => ({ id: "worker-profile", graphWorker: { model: "ds-flash", ...(opts.levelModels ? { levelModels: opts.levelModels } : {}) } }) },
    store: { get: (id: string) => records.get(id), list: () => [...records.values()] },
    async createAgent(input: { name: string; profileId: string; model?: { provider: string; modelId: string } }, internal: { graphRole?: GraphRole }) {
      const r = { id: `a${++n}`, name: input.name, profileId: input.profileId, createdAt: new Date().toISOString(), status: "stopped", model: input.model ?? null, mcpServers: [], gondolin: { allowedHosts: [], secrets: {} }, graphRole: internal.graphRole } as AgentRecord;
      records.set(r.id, r);
      return r;
    },
    async start(id: string) {
      running.set(id, new EventEmitter());
    },
    async stop(id: string) {
      running.get(id)?.emit("closed");
      running.delete(id);
    },
    async releaseAgent(id: string) {
      running.get(id)?.emit("closed");
      running.delete(id);
    },
    async deleteAgent(id: string) {
      records.delete(id);
    },
    getRunning: (id: string) => running.get(id),
    runningCount: () => running.size,
    async promptAgent(id: string, message: string) {
      prompts.push([id, message]);
      const ev = running.get(id)!;
      if (opts.settle === "ok" || opts.settle === undefined) setTimeout(() => ev.emit("event", { type: "agent_settled" }), 5);
      if (opts.settle === "stop") setTimeout(() => ev.emit("closed"), 5);
    },
    waitSettled(id: string, ms: number) {
      const ev = running.get(id)!;
      return new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), ms);
        ev.on("event", (e: { type: string }) => e.type === "agent_settled" && (clearTimeout(t), resolve()));
        ev.on("closed", () => (clearTimeout(t), reject(new Error("the agent stopped"))));
      });
    },
    async lastAssistantText() {
      return "Linked it to Toro (customer).";
    },
    async abortAgent() {},
    compacted: 0,
    async compactAgent() {
      (m as { compacted: number }).compacted++;
    },
  };
  return { manager: m as unknown as AgentManager, records, prompts, running, compacted: () => (m as { compacted: number }).compacted };
}

function fakeGraph(threads: Array<Record<string, unknown>>, status: Record<string, unknown> = { pool: { poolSize: 2, keepDays: 14 } }) {
  const calls: Array<[string, unknown]> = [];
  const call: GraphCall = async (path, init) => {
    calls.push([path, init?.body]);
    if (path === "/api/worker") return { status: 200, body: status };
    if (path === "/api/worker/threads/claim") return { status: 200, body: { threads: threads.splice(0, (init?.body as { limit: number }).limit) } };
    if (path === "/api/worker/threads") return { status: 200, body: { threads: [] } };
    return { status: 200, body: {} };
  };
  return { call, calls };
}

const thread = (job: string, over: Record<string, unknown> = {}) => ({ job, entry: "#12:3", name: "Toro PO 4471 plating", agent_id: null, minutes: 1, message: "A new queue entry for you.", ...over });
const flush = () => new Promise((r) => setTimeout(r, 40));

describe("graph worker pool", () => {
  it("claims within the pool and the agent limit, makes a worker per entry, prompts it, reports, stops it", async () => {
    const { manager, records, prompts, running } = fakeManager();
    const { call, calls } = fakeGraph([thread("0f8fad5b-0000-0000-0000-000000000001"), thread("0f8fad5b-0000-0000-0000-000000000002"), thread("0f8fad5b-0000-0000-0000-000000000003")]);
    const pool = new GraphPool(manager, call, () => 8);
    expect((await pool.tick()).started).toBe(2);
    await flush();
    const agents = [...records.values()];
    expect(agents).toHaveLength(2);
    expect(agents[0]!.graphRole).toEqual({ kind: "worker", job: "0f8fad5b-0000-0000-0000-000000000001", entry: "#12:3", title: "Toro PO 4471 plating" });
    expect(agents[0]!.name).toBe(threadName("Toro PO 4471 plating", "0f8fad5b-0000-0000-0000-000000000001"));
    expect(prompts.map(([, m]) => m)).toEqual(["A new queue entry for you.", "A new queue entry for you."]);
    const finishes = calls.filter(([p]) => p.endsWith("/finish"));
    expect(finishes.map(([, b]) => b)).toEqual([
      { status: "done", summary: "Linked it to Toro (customer)." },
      { status: "done", summary: "Linked it to Toro (customer)." },
    ]);
    expect(calls.filter(([p]) => p.endsWith("/agent"))).toHaveLength(2);
    expect(running.size).toBe(0);
  });

  it("a resumed thread wakes its own agent", async () => {
    const { manager, records } = fakeManager();
    const first = fakeGraph([thread("0f8fad5b-0000-0000-0000-00000000000a")]);
    await new GraphPool(manager, first.call, () => 8).tick();
    await flush();
    const id = [...records.keys()][0]!;
    const again = fakeGraph([thread("0f8fad5b-0000-0000-0000-00000000000a", { agent_id: id, message: "Your question was answered." })]);
    await new GraphPool(manager, again.call, () => 8).tick();
    await flush();
    expect(records.size).toBe(1);
  });

  it("a thread that stops or never ends its turn is reported failed", async () => {
    const { manager } = fakeManager({ settle: "stop" });
    const { call, calls } = fakeGraph([thread("0f8fad5b-0000-0000-0000-00000000000b")]);
    await new GraphPool(manager, call, () => 8).tick();
    await flush();
    expect(calls.find(([p]) => p.endsWith("/finish"))?.[1]).toEqual({ status: "failed", summary: "the agent stopped" });
  });

  it("no room, no profile, or not the root: nothing is claimed", async () => {
    const { manager } = fakeManager();
    const busy = fakeGraph([thread("0f8fad5b-0000-0000-0000-00000000000c")]);
    expect((await new GraphPool(manager, busy.call, () => 0).tick()).started).toBe(0);
    expect(busy.calls.some(([p]) => p.endsWith("/claim"))).toBe(false);
    const notRoot: GraphCall = async () => ({ status: 403, body: {} });
    expect((await new GraphPool(manager, notRoot, () => 8).tick()).started).toBe(0);
  });

  it("the liaison appears when questions wait, once", async () => {
    const { manager, records } = fakeManager();
    const { call } = fakeGraph([], { pool: { poolSize: 0, keepDays: 14 }, open_questions: 2 });
    const pool = new GraphPool(manager, call, () => 8);
    await pool.tick();
    await pool.tick();
    const liaisons = [...records.values()].filter((a) => a.graphRole?.kind === "liaison");
    expect(liaisons).toHaveLength(1);
  });
});

describe("graph master", () => {
  it("wakes the master with its signals as one message, acks them, compacts after a batch", async () => {
    const { manager, records, prompts, compacted } = fakeManager();
    const calls: Array<[string, unknown]> = [];
    const call: GraphCall = async (path, init) => {
      calls.push([path, init?.body]);
      if (path === "/api/worker/signals") return { status: 200, body: { signals: [{ id: "s1", kind: "batch" }, { id: "s2", kind: "done" }], message: "Signals for you (2)." } };
      return { status: 200, body: {} };
    };
    const pool = new GraphPool(manager, call, () => 8);
    await pool.masterTurn("worker-profile");
    const master = [...records.values()].find((a) => a.graphRole?.kind === "master");
    expect(master?.name).toBe("Graph master");
    expect(prompts).toEqual([[master!.id, "Signals for you (2)."]]);
    expect(calls.find(([p]) => p === "/api/worker/signals/ack")?.[1]).toEqual({ ids: ["s1", "s2"] });
    expect(compacted()).toBe(1);
    await pool.masterTurn("worker-profile");
    expect([...records.values()].filter((a) => a.graphRole?.kind === "master")).toHaveLength(1);
  });

  it("starts each handler, gives it its brief, then leaves it waiting in the rail with its sandbox given back", async () => {
    const { manager, records, prompts, running } = fakeManager();
    const calls: Array<[string, unknown]> = [];
    const call: GraphCall = async (path, init) => {
      calls.push([path, init?.body]);
      if (path === "/api/worker/handlers/claim") return { status: 200, body: { handlers: [{ job: "0f8fad5b-0000-0000-0000-0000000000a1", worker: "w1", title: "Which Toro", message: "A stopped worker needs a decision." }] } };
      return { status: 200, body: {} };
    };
    await new GraphPool(manager, call, () => 8).startHandlers("worker-profile");
    const h = [...records.values()].find((a) => a.graphRole?.kind === "handler");
    expect(h?.name).toMatch(/^handler · Which Toro · 0f8f$/);
    expect(prompts.map(([, m]) => m)).toEqual(["A stopped worker needs a decision."]);
    expect(calls.find(([p]) => p.endsWith("/waiting"))?.[1]).toEqual({ agent_id: h!.id });
    expect(running.size).toBe(0);
  });
});

describe("giving back idle graph agents", () => {
  it("a decided handler is given back; one still waiting on the operator stays", async () => {
    const { manager, records, running } = fakeManager();
    const decided = await manager.createAgent({ name: "h1", profileId: "worker-profile" } as never, { graphRole: { kind: "handler", job: "0f8fad5b-0000-0000-0000-0000000000d1", worker: "w", title: "t" } });
    const open = await manager.createAgent({ name: "h2", profileId: "worker-profile" } as never, { graphRole: { kind: "handler", job: "0f8fad5b-0000-0000-0000-0000000000d2", worker: "w", title: "t" } });
    for (const a of [decided, open]) {
      await manager.start(a.id);
      Object.assign(running.get(a.id)!, { busy: false, idleMs: () => 60_000 });
    }
    const call: GraphCall = async (path) =>
      path === "/api/worker/handlers"
        ? { status: 200, body: { handlers: [{ id: "0f8fad5b-0000-0000-0000-0000000000d1", status: "done" }, { id: "0f8fad5b-0000-0000-0000-0000000000d2", status: "waiting" }] } }
        : { status: 200, body: {} };
    await new GraphPool(manager, call, () => 8).releaseIdle();
    expect(running.has(decided.id)).toBe(false);
    expect(running.has(open.id)).toBe(true);
    expect(records.size).toBe(2);
  });
});

describe("models by level", () => {
  it("a worker runs on its level's model; a level without one uses the profile's", async () => {
    const quick = { provider: "openrouter", modelId: "cheap" };
    const { manager, records } = fakeManager({ levelModels: { "1": quick } });
    const { call } = fakeGraph([thread("0f8fad5b-0000-0000-0000-0000000000e1", { level: 1 }), thread("0f8fad5b-0000-0000-0000-0000000000e2", { level: 2 })]);
    await new GraphPool(manager, call, () => 8).tick();
    await flush();
    const byJob = Object.fromEntries([...records.values()].map((a) => [(a.graphRole as { job: string }).job, a.model]));
    expect(byJob["0f8fad5b-0000-0000-0000-0000000000e1"]).toEqual(quick);
    expect(byJob["0f8fad5b-0000-0000-0000-0000000000e2"]).toBeNull();
  });
});
