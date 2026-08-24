import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { AgentStore } from "../src/agents/store.js";
import type { ServerConfig } from "../src/config.js";
import { ProviderRegistry } from "../src/providers/registry.js";

/**
 * End-to-end M1 acceptance: registry ingest -> per-agent generation ->
 * scaffold -> spawn pi --mode rpc -> provider-bridge registers the mock
 * provider -> real LLM loop over HTTP (mock OpenAI SSE) -> RPC events flow.
 */

const REPLY = "GWARESTRIN_OK";

function startMockOpenAi(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-1" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunks = [
          { id: "cmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "GWARE" }, finish_reason: null }] },
          { id: "cmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "STRIN_" }, finish_reason: null }] },
          { id: "cmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] },
          { id: "cmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        for (const chunk of chunks) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

describe("integration: pi agent over mock provider", { timeout: 120_000 }, () => {
  let mock: { server: http.Server; port: number };
  let stateDir: string;
  let manager: AgentManager;
  let store: AgentStore;
  let registry: ProviderRegistry;

  beforeAll(async () => {
    mock = await startMockOpenAi();
    stateDir = await mkdtemp(path.join(tmpdir(), "gw-int-"));
    const providersFile = path.join(stateDir, "providers.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      providersFile,
      JSON.stringify({
        providers: {
          mock: {
            type: "openai-completions",
            baseUrl: `http://127.0.0.1:${mock.port}/v1`,
            apiKey: "dummy",
            models: [{ id: "mock-1", name: "Mock 1", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024 }],
          },
        },
        defaultProvider: "mock",
        defaultModel: "mock-1",
      }),
      "utf8",
    );

    registry = new ProviderRegistry();
    await registry.load(providersFile);

    const config: ServerConfig = {
      port: 0,
      host: "127.0.0.1",
      stateDir,
      providersFile,
      maxAgents: 4,
      webDistDir: path.join(stateDir, "no-web"),
    };
    store = new AgentStore(stateDir);
    await store.load();
    manager = new AgentManager(config, registry, store);
  });

  afterAll(async () => {
    await manager.stopAll().catch(() => {});
    mock.server.close();
  });

  it("boots pi, registers mock provider, drives a prompt to completion", async () => {
    const record = await manager.createAgent({ name: "integration" });
    expect(record.model).toBeNull();

    const summary = await manager.start(record.id);
    expect(summary.status).toBe("running");
    const agent = manager.getRunning(record.id)!;

    // provider-bridge registered the mock provider's models
    const models = await agent.send("get_available_models");
    expect(models.success).toBe(true);
    const modelList = (models.data as { models?: Array<{ id?: string; provider?: string }> }).models ?? [];
    expect(modelList.some((m) => m.provider === "mock" && m.id === "mock-1")).toBe(true);

    // drive a prompt; collect events until agent settles
    const events: Array<Record<string, unknown> & { type: string }> = [];
    agent.on("event", (e) => events.push(e));
    const promptRes = await agent.send("prompt", { message: `Reply with exactly: ${REPLY}` });
    expect(promptRes.success).toBe(true);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === "agent_settled")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(events.some((e) => e.type === "agent_settled")).toBe(true);
    expect(events.some((e) => e.type === "message_update")).toBe(true);

    const last = await agent.send("get_last_assistant_text");
    expect((last.data as { text?: string }).text).toContain(REPLY);

    // session file tracked for crash resume
    const state = await agent.send("get_state");
    expect(typeof (state.data as { sessionFile?: string }).sessionFile).toBe("string");
    expect(store.get(record.id)!.sessionFile).toBeTruthy();

    await manager.stop(record.id);
    expect(manager.getRunning(record.id)).toBeUndefined();
  });
});
