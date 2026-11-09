import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { pushThreadRecord, threadRecordUrl } from "../src/agents/record-gate.js";
import { AgentStore } from "../src/agents/store.js";
import type { ServerConfig } from "../src/config.js";
import { ProviderRegistry } from "../src/providers/registry.js";

/** the off-record gate's server half: graph-rag is told before the person is told */
describe("record gate", () => {
  it("puts the state on graph-rag's HTTP base with the instance's token", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await pushThreadRecord("http://graph-rag:8000/mcp", "instance-token", { agent: "a1", thread: "t1", on: true }, fetchFn as typeof fetch);
    expect(threadRecordUrl("http://graph-rag:8000/mcp")).toBe("http://graph-rag:8000/api/thread-record");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://graph-rag:8000/api/thread-record");
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer instance-token");
    expect(JSON.parse(String(init.body))).toEqual({ agent: "a1", thread: "t1", on: true });
  });

  it("a refusal is an error, so a switch never looks done when it isn't", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 403 }));
    await expect(pushThreadRecord("http://g/mcp", "t", { agent: "a", thread: "t", on: false }, fetchFn as typeof fetch)).rejects.toThrow(/403/);
  });

  async function managerForSwitch(push: (url: string, init: RequestInit) => Promise<Response>) {
    const stateDir = await mkdtemp(path.join(tmpdir(), "gw-gate-"));
    const providersFile = path.join(stateDir, "providers.json");
    await writeFile(providersFile, JSON.stringify({ providers: { mock: { type: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "dummy", models: [{ id: "m" }] } }, defaultProvider: "mock", defaultModel: "m" }));
    const registry = new ProviderRegistry();
    await registry.load(providersFile);
    const config: ServerConfig = { port: 0, host: "127.0.0.1", stateDir, providersFile, maxAgents: 2, webDistDir: path.join(stateDir, "web") };
    const store = new AgentStore(stateDir);
    await store.load();
    const manager = new AgentManager(config, registry, store);
    const internals = manager as unknown as { running: Map<string, unknown>; mcpServerUrl: () => string };
    internals.mcpServerUrl = () => "http://graph-rag:8000/mcp";
    const record = await manager.createAgent({ name: "on-record", gondolin: { enabled: false } });
    store.setSessionFile(record.id, "/sessions/thread-1.jsonl");
    internals.running.set(record.id, {});
    vi.stubGlobal("fetch", ((url: string, init: RequestInit) => push(url, init)) as unknown as typeof fetch);
    return { manager, store, id: record.id };
  }

  it("a thread change: a turn waits for graph-rag, and an off-record thread gets none until it has been told", async () => {
    let release: (r: Response) => void = () => {};
    let mode: "hold" | "fail" | "ok" = "hold";
    const { manager, store, id } = await managerForSwitch(async (url) => {
      if (!url.endsWith("/api/thread-record")) return new Response("{}", { status: 404 });
      if (mode === "fail") return new Response("down", { status: 503 });
      if (mode === "ok") return new Response("{}", { status: 200 });
      return new Promise<Response>((r) => { release = r; });
    });
    const internals = manager as unknown as { threadChanged: (id: string) => Promise<void> };
    const settled = vi.fn();
    try {
      store.setSessionFile(id, "/sessions/thread-2.jsonl");
      void internals.threadChanged(id);
      const turn = manager.recordGateRefusal(id).then((r) => (settled(), r));
      await new Promise((r) => setTimeout(r, 20));
      expect(settled).not.toHaveBeenCalled();
      release(new Response("{}", { status: 200 }));
      await expect(turn).resolves.toBeNull();

      mode = "fail";
      store.setSessionFile(id, "/sessions/thread-3.jsonl");
      void internals.threadChanged(id);
      await expect(manager.recordGateRefusal(id)).resolves.toMatch(/off record/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the switch reaches graph-rag before it is stored; a failed push changes nothing", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    let fail = false;
    const { manager, store, id } = await managerForSwitch(async (url, init) => {
      if (!url.endsWith("/api/thread-record")) return new Response("{}", { status: 404 }); // the confirmed-classes lookup
      if (fail) return new Response("down", { status: 503 });
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    });
    try {
      const on = await manager.setOnRecord(id, { on: true, reason: "for the record", by: "bob" });
      expect(on.on).toBe(true);
      expect(calls).toEqual([{ url: "http://graph-rag:8000/api/thread-record", body: { agent: id, thread: "thread-1", on: true } }]);

      // graph-rag can't be told: the person is told so, and nothing changed here
      fail = true;
      await expect(manager.setOnRecord(id, { on: false, by: "bob" })).rejects.toThrow(/503/);
      expect(store.threadRecord(id, "thread-1").on).toBe(true);

      fail = false;
      const off = await manager.setOnRecord(id, { on: false, by: "bob" });
      expect(off.on).toBe(false);
      expect(calls.at(-1)?.body).toEqual({ agent: id, thread: "thread-1", on: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
