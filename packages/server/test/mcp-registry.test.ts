import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpSubset, validateMcpServerDef, type McpRegistry } from "@gwarestrin/shared";
import { McpRegistryStore } from "../src/mcp/registry-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "gw-mcp-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("McpRegistryStore", () => {
  it("starts empty when file is absent", async () => {
    const s = new McpRegistryStore(dir);
    await s.load();
    expect(s.list()).toEqual({});
  });

  it("put persists and reload round-trips", async () => {
    const s = new McpRegistryStore(dir);
    await s.load();
    await s.put("docs", { command: "npx", args: ["-y", "@acme/docs-mcp"], description: "docs search" });
    const raw = JSON.parse(await readFile(path.join(dir, "mcp-registry.json"), "utf8"));
    expect(raw.servers.docs.command).toBe("npx");

    const s2 = new McpRegistryStore(dir);
    await s2.load();
    expect(s2.get("docs")?.description).toBe("docs search");
  });

  it("put rejects defs without exactly one transport", async () => {
    const s = new McpRegistryStore(dir);
    await s.load();
    await expect(s.put("bad", {})).rejects.toThrow(/exactly one/);
    await expect(s.put("bad", { command: "x", url: "http://y" })).rejects.toThrow(/exactly one/);
  });

  it("remove deletes existing and reports missing", async () => {
    const s = new McpRegistryStore(dir);
    await s.load();
    await s.put("a", { url: "http://localhost:9000/mcp" });
    expect(await s.remove("a")).toBe(true);
    expect(await s.remove("a")).toBe(false);
    expect(s.list()).toEqual({});
  });
});

describe("validateMcpServerDef", () => {
  it("accepts stdio and http defs", () => {
    expect(validateMcpServerDef({ command: "uvx", args: ["mcp-server"] })).toBeNull();
    expect(validateMcpServerDef({ url: "http://x/mcp", headers: { a: "b" } })).toBeNull();
  });
  it("rejects cross-transport keys", () => {
    expect(validateMcpServerDef({ command: "x", headers: { a: "b" } })).toMatch(/headers/);
    expect(validateMcpServerDef({ url: "http://x", args: ["y"] })).toMatch(/args\/env\/cwd/);
  });
});

describe("mcpSubset", () => {
  const registry: McpRegistry = {
    docs: { command: "npx", args: ["docs-mcp"], description: "internal docs" },
    remote: { url: "http://mcp.local/sse", bearerTokenEnv: "MCP_TOKEN" },
  };

  it("picks requested names and strips metadata", () => {
    const sub = mcpSubset(registry, ["docs"]);
    expect(Object.keys(sub)).toEqual(["docs"]);
    expect(sub.docs).not.toHaveProperty("description");
    expect(sub.docs).toMatchObject({ command: "npx" });
  });

  it("ignores unknown names", () => {
    const sub = mcpSubset(registry, ["docs", "gone"]);
    expect(Object.keys(sub)).toEqual(["docs"]);
  });

  it("preserves adapter-native fields", () => {
    const sub = mcpSubset(registry, ["remote"]);
    expect(sub.remote).toMatchObject({ url: "http://mcp.local/sse", bearerTokenEnv: "MCP_TOKEN" });
  });
});
