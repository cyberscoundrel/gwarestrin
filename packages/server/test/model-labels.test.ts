import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { AgentStore } from "../src/agents/store.js";
import type { ServerConfig } from "../src/config.js";
import { startInstanceMetadata } from "../src/instance/metadata.js";
import { modelAllowed, modelLabels, modelRefusal } from "../src/instance/settings.js";
import { McpRegistryStore } from "../src/mcp/registry-store.js";
import { buildGeneratedProviders } from "../src/providers/generate.js";
import { ProviderRegistry } from "../src/providers/registry.js";

// the organization labeled one local model and one OpenRouter model (whose id has a slash)
let stateDir: string;
let registry: ProviderRegistry;
let mcp: McpRegistryStore;

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "gw-labels-"));
  const md = path.join(stateDir, "instance.json");
  await writeFile(
    md,
    JSON.stringify({
      version: 1,
      instance: { name: "alice" },
      models: {
        "local/qwen": { tier: "standard", hosting: "on-prem" },
        "router/nvidia/nemotron:free": { tier: "basic", hosting: "public-api", notes: "ignores call limits" },
      },
    }),
  );
  startInstanceMetadata({ metadataPath: md, stateDir });
  const providersFile = path.join(stateDir, "providers.json");
  await writeFile(
    providersFile,
    JSON.stringify({
      providers: {
        local: { type: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", models: [{ id: "qwen" }, { id: "llama-unlabeled" }] },
        router: { type: "openai-completions", baseUrl: "https://example.com/v1", apiKey: "k", models: [{ id: "big-unlabeled" }, { id: "nvidia/nemotron:free" }] },
        other: { type: "openai-completions", baseUrl: "https://example.org/v1", apiKey: "k", models: [{ id: "x" }] },
      },
      defaultProvider: "router",
      defaultModel: "big-unlabeled",
    }),
  );
  registry = new ProviderRegistry();
  await registry.load(providersFile);
  mcp = new McpRegistryStore(stateDir);
  await mcp.load();
});

describe("model labels", () => {
  it("only labeled models are allowed", () => {
    expect(modelLabels()).not.toBeNull();
    expect(modelAllowed("local", "qwen")).toBe(true);
    expect(modelAllowed("router", "nvidia/nemotron:free")).toBe(true);
    expect(modelAllowed("local", "llama-unlabeled")).toBe(false);
    expect(modelRefusal("local", "llama-unlabeled")).toMatch(/no label yet/);
    expect(modelAllowed("legacy", "x", null)).toBe(true);
  });

  it("agents' model list holds only labeled models; unlabeled providers vanish; the default moves", () => {
    const gen = buildGeneratedProviders(registry);
    expect(Object.keys(gen.providers).sort()).toEqual(["local", "router"]);
    expect(gen.providers.local!.models.map((m) => m.id)).toEqual(["qwen"]);
    expect(gen.providers.router!.models.map((m) => m.id)).toEqual(["nvidia/nemotron:free"]);
    expect(gen.defaultProvider).toBe("router");
    expect(gen.defaultModel).toBe("nvidia/nemotron:free");
  });

  it("an unlabeled model is refused at create, patch and start", async () => {
    const config: ServerConfig = { port: 0, host: "127.0.0.1", stateDir, providersFile: undefined, maxAgents: 8, webDistDir: stateDir };
    const store = new AgentStore(stateDir);
    await store.load();
    const manager = new AgentManager(config, registry, store, mcp);
    await expect(manager.createAgent({ name: "x", model: { provider: "local", modelId: "llama-unlabeled" }, gondolin: { enabled: false } })).rejects.toThrow(/no label yet/);
    const ok = await manager.createAgent({ name: "y", gondolin: { enabled: false } });
    expect(ok.model).toEqual({ provider: "router", modelId: "nvidia/nemotron:free" });
    await expect(manager.patchAgent(ok.id, { model: { provider: "router", modelId: "big-unlabeled" } })).rejects.toThrow(/no label yet/);
    // as if the label was removed after the agent was made
    store.get(ok.id)!.model = { provider: "local", modelId: "llama-unlabeled" };
    await expect(manager.start(ok.id)).rejects.toThrow(/no label yet/);
  });
});
