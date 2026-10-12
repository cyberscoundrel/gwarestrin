import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "@gwarestrin/shared";
import { ProviderRegistry } from "../src/providers/registry.js";
import { agentConfigPath, dirsFor, piEnvFor, scaffoldAgent, STANDING_INSTRUCTIONS_FILE } from "../src/agents/scaffold.js";
import { McpRegistryStore } from "../src/mcp/registry-store.js";
import { formatEntities } from "../src/agents/connection-digest.js";

let stateDir: string;
let registry: ProviderRegistry;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "gw-scaffold-"));
  registry = new ProviderRegistry();
  await registry.load(undefined);
});

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-agent",
    name: "test",
    createdAt: new Date().toISOString(),
    status: "stopped",
    model: null,
    mcpServers: [],
    gondolin: {
      allowedHosts: ["api.example.com"],
      secrets: { TOKEN: { hosts: ["api.example.com"], valueEnv: "GWARESTRIN_SECRET_TEST_TOKEN" } },
    },
    ...overrides,
  };
}

describe("scaffoldAgent", () => {
  it("writes gondolin agent-config.json without secret values", async () => {
    const record = agent();
    const dirs = await scaffoldAgent(stateDir, record, registry, path.join(stateDir, "ext"));
    const raw = await readFile(agentConfigPath(dirs.home), "utf8");
    const cfg = JSON.parse(raw) as {
      workspaceDir: string;
      gondolin: { allowedHosts: string[]; secrets: Record<string, { hosts: string[]; valueEnv: string }> };
    };
    expect(cfg.workspaceDir).toBe(dirs.workspace);
    expect(cfg.gondolin.allowedHosts).toEqual(["api.example.com"]);
    // valueEnv only — never the value
    expect(cfg.gondolin.secrets.TOKEN!.valueEnv).toBe("GWARESTRIN_SECRET_TEST_TOKEN");
    expect(raw).not.toContain("GWARESTRIN_AGENT_CONFIG");
  });

  it("disabled gondolin serializes enabled:false (extension becomes a no-op)", async () => {
    const record = agent({ gondolin: { enabled: false, allowedHosts: [], secrets: {} } });
    const dirs = await scaffoldAgent(stateDir, record, registry, path.join(stateDir, "ext"));
    const cfg = JSON.parse(await readFile(agentConfigPath(dirs.home), "utf8")) as { gondolin: { enabled?: boolean } };
    expect(cfg.gondolin.enabled).toBe(false);
  });
});

describe("standing instructions", () => {
  it("every agent learns its sources first, in order; the graph procedures only with the graph", async () => {
    const mcp = new McpRegistryStore(stateDir);
    await mcp.load();
    await mcp.put("graph-rag", { url: "http://graph-rag:8000/mcp" });
    await mcp.put("mssql", { url: "http://127.0.0.1:9/mcp" }); // unreachable: no table summary, no failure
    const withGraph = await scaffoldAgent(stateDir, agent({ id: "a-graph", mcpServers: ["graph-rag", "mssql"] }), registry, stateDir, mcp, {
      profileInstructions: "You help the shop floor plan maintenance.",
    });
    const text = await readFile(path.join(withGraph.home, STANDING_INSTRUCTIONS_FILE), "utf8");
    expect(text.startsWith("Your sources")).toBe(true);
    expect(text).toMatch(/1\. The knowledge graph[\s\S]*2\. mssql[\s\S]*3\. Asking/);
    expect(text).toContain("Never read a whole table to search it");
    expect(text).toContain("You help the shop floor plan maintenance.");
    expect(text).toContain("graph-rag_find_shareable");
    const without = await scaffoldAgent(stateDir, agent({ id: "a-sql", mcpServers: ["mssql"] }), registry, stateDir, mcp);
    const sql = await readFile(path.join(without.home, STANDING_INSTRUCTIONS_FILE), "utf8");
    expect(sql).toContain("1. mssql");
    expect(sql).not.toContain("graph-rag_");
  });

  it("a database's tables become a short map", () => {
    const text = JSON.stringify({ entities: [{ name: "dbo_Customer", fields: [{ name: "Customer" }, { name: "Name" }] }, { name: "dbo_Job", fields: ["Job", "Customer", "Status"] }] });
    expect(formatEntities(text)).toBe("- dbo_Customer: Customer, Name\n- dbo_Job: Job, Customer, Status");
    expect(formatEntities("not json")).toBeNull();
  });
});

describe("piEnvFor", () => {
  it("injects gondolin secret env values and config path", () => {
    process.env.GWARESTRIN_SECRET_TEST_TOKEN = "sk-secret-value";
    try {
      const record = agent();
      const dirs = dirsFor(stateDir, record);
      const env = piEnvFor(dirs, registry, record);
      expect(env.GWARESTRIN_AGENT_CONFIG).toBe(agentConfigPath(dirs.home));
      expect(env.GWARESTRIN_SECRET_TEST_TOKEN).toBe("sk-secret-value");
    } finally {
      delete process.env.GWARESTRIN_SECRET_TEST_TOKEN;
    }
  });

  it("missing secret env does not throw; value simply absent", () => {
    const record = agent();
    const env = piEnvFor(dirsFor(stateDir, record), registry, record);
    expect(env.GWARESTRIN_SECRET_TEST_TOKEN).toBeUndefined();
  });
});
