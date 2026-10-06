import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runContextEngine } from "../src/analyze/engines.js";

// mock OpenAI endpoint: round 1 -> tool call, round 2 -> final block
function mockLlm(opts: { toolName?: string; toolArgs?: Record<string, unknown>; fail?: boolean } = {}) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (opts.fail) {
        res.writeHead(500).end("boom");
        return;
      }
      const parsed = JSON.parse(body);
      const last = parsed.messages.at(-1);
      const msg =
        last?.role === "tool"
          ? { role: "assistant", content: "thinkcentre hosts gwarestrin, dab, arcadedb" }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: opts.toolName ?? "query_graph", arguments: JSON.stringify(opts.toolArgs ?? { query: "MATCH (m:Machine) RETURN m.name" }) },
                },
              ],
            };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: msg }] }));
    });
  });
  return { server };
}

// mock MCP streamable-HTTP endpoint: initialize, tools/list, tools/call
const TOOL_DEFS: Record<string, { name: string; description: string; inputSchema: Record<string, unknown> }> = Object.fromEntries(
  ["query_graph", "search_graph", "schema_graph", "upsert_entities", "approve_write"].map((name) => [
    name,
    { name, description: name, inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  ]),
);

function mockMcp(opts: { tools?: string[] } = {}) {
  const state = { calls: [] as Array<{ name: string; query: string }> };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "0" } } }));
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: opts.tools
                ? opts.tools.map((t) => TOOL_DEFS[t])
                : [
                    { name: "query_graph", description: "read-only openCypher", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
                    { name: "search_graph", description: "semantic search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
                  ],
            },
          }),
        );
        return;
      }
      if (msg.method === "tools/call") {
        const name = String(msg.params?.name ?? "");
        if (opts.tools && !opts.tools.includes(name)) {
          // like graph-rag for an identity the tool isn't listed for
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Tool ${name} not found` } }));
          return;
        }
        const query = String(msg.params?.arguments?.query ?? "");
        state.calls.push({ name, query });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: JSON.stringify([{ name: "thinkcentre" }]) }] },
          }),
        );
        return;
      }
      res.writeHead(400).end();
    });
  });
  return { server, state };
}

let servers: Server[] = [];
beforeEach(() => (servers = []));
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

async function listen(s: Server): Promise<string> {
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe("runContextEngine (graph-rag)", () => {
  it("resolves tools from tools/list, runs the loop, returns the block", async () => {
    const llm = mockLlm();
    const mcp = mockMcp();
    servers.push(llm.server, mcp.server);
    const result = await runContextEngine(
      { type: "graph-rag" },
      { firstPrompt: "what depends on thinkcentre?" },
      { llm: { llmUrl: await listen(llm.server), llmKey: "x", model: "m" }, mcpUrl: await listen(mcp.server) },
    );
    expect(result.status).toBe("ok");
    expect(result.block).toContain("thinkcentre hosts gwarestrin");
    // tools/list + entity dictionary + the agent's tool call
    expect(mcp.state.calls.length).toBeGreaterThanOrEqual(2);
    expect(mcp.state.calls.every((c) => c.name === "query_graph")).toBe(true);
  });

  it("never forwards write queries to the graph", async () => {
    const llm = mockLlm({ toolName: "query_graph", toolArgs: { query: "CREATE (n:X) RETURN n" } });
    const mcp = mockMcp();
    servers.push(llm.server, mcp.server);
    const result = await runContextEngine(
      { type: "graph-rag" },
      { firstPrompt: "make a node" },
      { llm: { llmUrl: await listen(llm.server), llmKey: "x", model: "m" }, mcpUrl: await listen(mcp.server) },
    );
    expect(result.status).toBe("ok");
    expect(result.block).toBe("thinkcentre hosts gwarestrin, dab, arcadedb");
    expect(mcp.state.calls.every((c) => !/^\s*CREATE/i.test(c.query))).toBe(true);
  });

  it("offers only read tools and works for identities without raw queries", async () => {
    const llm = mockLlm({ toolName: "search_graph", toolArgs: { query: "thinkcentre" } });
    const offered: string[][] = [];
    const llmServer = llm.server;
    llmServer.prependListener("request", (req) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => offered.push((JSON.parse(b).tools ?? []).map((t: { function: { name: string } }) => t.function.name)));
    });
    const mcp = mockMcp({ tools: ["search_graph", "schema_graph", "upsert_entities", "approve_write"] });
    servers.push(llmServer, mcp.server);
    const result = await runContextEngine(
      { type: "graph-rag" },
      { firstPrompt: "what depends on thinkcentre?" },
      { llm: { llmUrl: await listen(llmServer), llmKey: "x", model: "m" }, mcpUrl: await listen(mcp.server) },
    );
    expect(result.status).toBe("ok");
    expect(offered[0]).toEqual(["search_graph", "schema_graph"]);
    expect(mcp.state.calls.map((c) => c.name)).toEqual(["search_graph"]);
  });

  it("reports failed when the llm endpoint is down", async () => {
    const llm = mockLlm({ fail: true });
    const mcp = mockMcp();
    servers.push(llm.server, mcp.server);
    const result = await runContextEngine(
      { type: "graph-rag" },
      { firstPrompt: "hi" },
      { llm: { llmUrl: await listen(llm.server), llmKey: "x", model: "m" }, mcpUrl: await listen(mcp.server) },
    );
    expect(result.status).toBe("failed");
  });
});

describe("runContextEngine (lexical)", () => {
  it("produces a deterministic block without any llm", async () => {
    const mcp = mockMcp();
    servers.push(mcp.server);
    const result = await runContextEngine(
      { type: "lexical" },
      { firstPrompt: "what is thinkcentre?" },
      { llm: { llmUrl: "http://127.0.0.1:1", llmKey: "x", model: "m" }, mcpUrl: await listen(mcp.server) },
    );
    expect(result.status).toBe("ok");
    expect(result.block).toContain("Knowledge graph overview");
  });
});
