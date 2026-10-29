import { EventEmitter } from "node:events";
import type { AgentRecord, GraphRole } from "@gwarestrin/shared";
import { describe, expect, it } from "vitest";
import { GraphPool, isModelOutage, threadName, type GraphCall } from "../src/agents/graph-pool.js";
import type { AgentManager } from "../src/agents/manager.js";

// a manager that runs no pi: agents "settle" as soon as they're prompted
function fakeManager(opts: { settle?: "ok" | "never" | "stop" | "stall"; ended?: string; levelModels?: Record<string, { provider: string; modelId: string }>; levelLimits?: Record<string, number> } = {}) {
  const records = new Map<string, AgentRecord>();
  const running = new Map<string, EventEmitter>();
  const prompts: Array<[string, string]> = [];
  let n = 0;
  const m = {
    profiles: { graphWorker: () => ({ id: "worker-profile", graphWorker: { model: "ds-flash", ...(opts.levelModels ? { levelModels: opts.levelModels } : {}), ...(opts.levelLimits ? { levelLimits: opts.levelLimits } : {}) } }) },
    store: { get: (id: string) => records.get(id), list: () => [...records.values()] },
    async createAgent(input: { name: string; profileId: string; model?: { provider: string; modelId: string } }, internal: { graphRole?: GraphRole }) {
      const r = { id: `a${++n}`, name: input.name, profileId: input.profileId, createdAt: new Date().toISOString(), status: "stopped", model: input.model ?? null, mcpServers: [], gondolin: { allowedHosts: [], secrets: {} }, graphRole: internal.graphRole } as AgentRecord;
      records.set(r.id, r);
      return r;
    },
    async start(id: string) {
      const ev = new EventEmitter() as EventEmitter & { quietMs?: () => number };
      // a stalled request: a run in progress with no events
      if (opts.settle === "stall") ev.quietMs = () => 60_000;
      running.set(id, ev);
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
    async lastTurn() {
      return opts.ended ? { text: "Checking the jobs next.", ended: opts.ended } : { text: "Linked it to Toro (customer).", ended: null };
    },
    aborted: 0,
    async abortAgent(id: string) {
      (m as { aborted: number }).aborted++;
      running.get(id)?.emit("event", { type: "agent_settled" });
    },
    compacted: 0,
    async compactAgent() {
      (m as { compacted: number }).compacted++;
    },
  };
  return { manager: m as unknown as AgentManager, records, prompts, running, compacted: () => (m as { compacted: number }).compacted, aborted: () => (m as { aborted: number }).aborted };
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

  it("a turn that ended on a model error is reported failed (to be tried again), not done", async () => {
    const { manager } = fakeManager({ ended: "the turn ended with an error: Request timed out." });
    const { call, calls } = fakeGraph([thread("0f8fad5b-0000-0000-0000-00000000000d")]);
    await new GraphPool(manager, call, () => 8).tick();
    await flush();
    expect(calls.find(([p]) => p.endsWith("/finish"))?.[1]).toEqual({ status: "failed", summary: "Checking the jobs next.\n\n(the turn ended with an error: Request timed out.)", outage: "the turn ended with an error: Request timed out." });
  });

  it("a turn that died on the model connection is reported as an outage (graph-rag keeps its tries)", async () => {
    const { manager } = fakeManager({ ended: "the turn ended with an error: Connection error." });
    const { call, calls } = fakeGraph([thread("0f8fad5b-0000-0000-0000-00000000000e")]);
    await new GraphPool(manager, call, () => 8).tick();
    await flush();
    expect(calls.find(([p]) => p.endsWith("/finish"))?.[1]).toMatchObject({ status: "failed", outage: "the turn ended with an error: Connection error." });
  });

  it("tells a model outage from the work's own failure", () => {
    for (const e of ["the turn ended with an error: Connection error.", "the turn ended with an error: terminated", "the turn ended with an error: Request timed out.", "the turn ended with an error: 429 Too Many Requests", "the turn ended with an error: 402 insufficient credits", "the turn ended with an error: 503 Service Unavailable"])
      expect(isModelOutage(e), e).toBe(true);
    for (const e of ["the turn was stopped", "the turn ended with an error: 400 context length exceeded", "the turn ended with an error: invalid tool arguments"]) expect(isModelOutage(e), e).toBe(false);
  });

  it("a level on a model with a limit gets no more threads than the limit (levels on one model share it)", async () => {
    const local = { provider: "local-inference", modelId: "qwen" };
    const { manager } = fakeManager({ settle: "never", levelModels: { "1": local, "2": local }, levelLimits: { "1": 2, "2": 3 } });
    const { call, calls } = fakeGraph([1, 2, 3].map((i) => thread(`0f8fad5b-0000-0000-0000-00000000010${i}`, { level: 1 })), { pool: { poolSize: 5, keepDays: 14 } });
    const pool = new GraphPool(manager, call, () => 10);
    await pool.tick();
    // nothing running yet: the local model takes 2 (the lower of its levels' limits); level 3 and unlevelled threads have none
    expect(calls.find(([p]) => p.endsWith("/claim"))?.[1]).toEqual({ limit: 5, groups: [{ levels: [1, 2], room: 2 }] });
    await flush();
    calls.length = 0;
    await pool.tick();
    // three level-1 threads run now (the fake graph ignores the groups): the local model is full
    expect(calls.find(([p]) => p.endsWith("/claim"))?.[1]).toMatchObject({ groups: [{ levels: [1, 2], room: 0 }] });
  });

  it("without limits a claim carries none", async () => {
    const { manager } = fakeManager();
    const { call, calls } = fakeGraph([]);
    await new GraphPool(manager, call, () => 8).tick();
    expect(calls.find(([p]) => p.endsWith("/claim"))?.[1]).toEqual({ limit: 2 });
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

  it("a master request that goes quiet is stopped and told to carry on; after a couple it's given back to start afresh", async () => {
    const { manager, records, prompts, running, aborted } = fakeManager({ settle: "stall" });
    const calls: Array<[string, unknown]> = [];
    const call: GraphCall = async (path, init) => {
      calls.push([path, init?.body]);
      if (path === "/api/worker/signals") return { status: 200, body: { signals: [{ id: "s1", kind: "batch" }], message: "A batch for you." } };
      return { status: 200, body: {} };
    };
    await new GraphPool(manager, call, () => 8, 20).masterTurn("worker-profile");
    const master = [...records.values()].find((a) => a.graphRole?.kind === "master")!;
    expect(prompts.map(([, p]) => p)).toEqual(["A batch for you.", expect.stringMatching(/stalled/), expect.stringMatching(/stalled/)]);
    expect(calls.filter(([p]) => p === "/api/worker/signals/ack")).toHaveLength(1);
    expect(aborted()).toBe(3);
    expect(running.has(master.id)).toBe(false);
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
