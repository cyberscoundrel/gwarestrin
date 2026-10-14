import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRecord } from "@gwarestrin/shared";
import { describe, expect, it } from "vitest";
import { readToolsFrom } from "../src/agents/connection-digest.js";
import { scaffoldAgent, STANDING_INSTRUCTIONS_FILE } from "../src/agents/scaffold.js";
import { buildStandingInstructions } from "../src/agents/standing-instructions.js";
import { McpRegistryStore } from "../src/mcp/registry-store.js";
import { ProviderRegistry } from "../src/providers/registry.js";

const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "w1",
  name: "graph · x",
  createdAt: "",
  status: "stopped",
  model: null,
  mcpServers: ["graph-rag", "mssql"],
  gondolin: { allowedHosts: ["example.com"], secrets: {} },
  graphRole: { kind: "worker", job: "0f8fad5b-d9cb-469f-a165-70867728950e", entry: "#1:2", title: "x" },
  ...over,
});

describe("graph worker tools", () => {
  it("read tools: the organization's list, then the server's hints, then known ones; none = none", () => {
    const dab = [{ name: "describe_entities" }, { name: "read_records" }, { name: "create_record" }, { name: "delete_record" }];
    expect(readToolsFrom(dab)).toEqual(["describe_entities", "read_records"]);
    expect(readToolsFrom(dab, ["read_records", "not_there"])).toEqual(["read_records"]);
    expect(readToolsFrom([{ name: "q", annotations: { readOnlyHint: true } }, { name: "w" }])).toEqual(["q"]);
    expect(readToolsFrom([{ name: "run_sql" }])).toEqual([]);
  });

  it("a worker's MCP config: the graph in full, unknown connections left out, no scripting, no internet", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "gw-worker-"));
    const mcp = new McpRegistryStore(stateDir);
    await mcp.load();
    await mcp.put("graph-rag", { url: "http://graph-rag:8000/mcp" });
    await mcp.put("mssql", { url: "http://127.0.0.1:9/mcp" }); // unreachable: its read tools are unknown
    const dirs = await scaffoldAgent(stateDir, agent(), new ProviderRegistry(), stateDir, mcp, { graphWorker: true });
    const cfg = JSON.parse(await readFile(path.join(dirs.workspace, ".mcp.json"), "utf8"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["graph-rag"]);
    expect(cfg.mcpServers["graph-rag"].includeTools).toBeUndefined();
    expect(cfg.settings).toEqual({ scriptMode: false });
    const agentCfg = JSON.parse(await readFile(path.join(dirs.home, "agent-config.json"), "utf8"));
    expect(agentCfg.gondolin?.allowedHosts ?? agentCfg.vm?.allowedHosts ?? JSON.stringify(agentCfg)).not.toContain("example.com");
    const instructions = await readFile(path.join(dirs.home, STANDING_INSTRUCTIONS_FILE), "utf8");
    expect(instructions).toMatch(/You are a graph worker/);
  });

  it("the liaison's and worker's instructions: their own preamble, sources read-only, the profile's guidance", () => {
    const w = buildStandingInstructions({ graph: true, connections: [{ name: "mssql", description: "the ERP" }], profileInstructions: "Customers go by ERP code.", graphRole: "worker" });
    expect(w).toMatch(/mssql \(read-only\): the ERP/);
    expect(w).toMatch(/graph-rag_raise_question/);
    expect(w).toMatch(/propose: true/);
    expect(w).toMatch(/Customers go by ERP code/);
    expect(w).not.toMatch(/Sharing knowledge/);
    const l = buildStandingInstructions({ graph: true, connections: [], graphRole: "liaison" });
    expect(l).toMatch(/liaison/);
    expect(l).toMatch(/Only ever on the admin's word/);
  });
});
