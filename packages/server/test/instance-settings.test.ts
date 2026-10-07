import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRecord } from "@gwarestrin/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { scaffoldAgent, piEnvFor } from "../src/agents/scaffold.js";
import { AgentStore } from "../src/agents/store.js";
import type { ServerConfig } from "../src/config.js";
import { getInstanceMetadata, startInstanceMetadata } from "../src/instance/metadata.js";
import { instanceSettings, mcpAllowed, providerAllowed } from "../src/instance/settings.js";
import { McpRegistryStore } from "../src/mcp/registry-store.js";
import { buildGeneratedProviders } from "../src/providers/generate.js";
import { ProviderRegistry } from "../src/providers/registry.js";

// one metadata document for the file: this workspace may use only the local
// provider and only the graph tool connection, two agents at a time
let stateDir: string;
let registry: ProviderRegistry;
let mcp: McpRegistryStore;

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "gw-settings-"));
  const md = path.join(stateDir, "instance.json");
  await writeFile(
    md,
    JSON.stringify({
      version: 1,
      instance: { name: "alice" },
      values: { ops: { token: "ops-secret", url: "http://provisioner:8081" } },
      settings: { maxAgents: 2, mcp: ["graph-rag"], providers: ["local"] },
    }),
  );
  startInstanceMetadata({ metadataPath: md, stateDir });
  const providersFile = path.join(stateDir, "providers.json");
  await writeFile(
    providersFile,
    JSON.stringify({
      providers: {
        local: { type: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "local-key", models: [{ id: "qwen" }] },
        cloud: { type: "openai-completions", baseUrl: "https://example.com/v1", apiKey: "cloud-key", models: [{ id: "big" }] },
      },
      defaultProvider: "cloud",
      defaultModel: "big",
    }),
  );
  registry = new ProviderRegistry();
  await registry.load(providersFile);
  mcp = new McpRegistryStore(stateDir);
  await mcp.load();
  await mcp.put("graph-rag", { url: "http://graph-rag:8000/mcp" });
  await mcp.put("mssql", { url: "http://dab:5000/mcp" });
});

const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "a1",
  name: "t",
  createdAt: "",
  status: "stopped",
  model: { provider: "local", modelId: "qwen" },
  mcpServers: ["graph-rag", "mssql"],
  gondolin: { allowedHosts: [], secrets: {} },
  ...over,
});

describe("instance settings", () => {
  it("are read from the metadata", () => {
    expect(getInstanceMetadata()?.settings?.maxAgents).toBe(2);
    expect(instanceSettings()).toEqual({ maxAgents: 2, mcp: ["graph-rag"], providers: ["local"] });
    expect(mcpAllowed("graph-rag")).toBe(true);
    expect(mcpAllowed("mssql")).toBe(false);
    expect(providerAllowed("cloud")).toBe(false);
  });

  it("agents get only allowed tool connections and providers, and no keys for the others", async () => {
    const dirs = await scaffoldAgent(stateDir, agent(), registry, stateDir, mcp);
    const servers = Object.keys(JSON.parse(await readFile(path.join(dirs.workspace, ".mcp.json"), "utf8")).mcpServers);
    expect(servers).toEqual(["graph-rag"]);
    const gen = buildGeneratedProviders(registry);
    expect(Object.keys(gen.providers)).toEqual(["local"]);
    expect(gen.defaultProvider).toBe("local");
    const env = piEnvFor(dirs, registry, agent());
    expect(Object.values(env)).not.toContain("cloud-key");
  });

  it("a disallowed provider is refused at create and at start", async () => {
    const config: ServerConfig = { port: 0, host: "127.0.0.1", stateDir, providersFile: undefined, maxAgents: 8, webDistDir: stateDir };
    const store = new AgentStore(stateDir);
    await store.load();
    const manager = new AgentManager(config, registry, store, mcp);
    await expect(manager.createAgent({ name: "x", model: { provider: "cloud", modelId: "big" }, gondolin: { enabled: false } })).rejects.toThrow(/isn't allowed/);
    const fallback = await manager.createAgent({ name: "y", gondolin: { enabled: false } });
    expect(fallback.model?.provider).toBe("local");
    expect(fallback.mcpServers).toEqual(["graph-rag"]);
    // as if the workspace's allowed providers changed after the agent was made
    store.get(fallback.id)!.model = { provider: "cloud", modelId: "big" };
    await expect(manager.start(fallback.id)).rejects.toThrow(/isn't allowed in this workspace/);
  });
});
