import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnalysisAgent } from "../src/analyze/analysis-agent.js";

// mock OpenAI endpoint: round 1 -> tool call, round 2 -> final block; tracks calls
function mockLlm(opts: { failOn?: number } = {}) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const n = calls.length;
      const parsed = JSON.parse(body);
      const last = parsed.messages.at(-1);
      const isToolAnswer = last?.role === "tool";
      calls.push(isToolAnswer ? `tool:${last.content.slice(0, 40)}` : "chat");
      const fail = opts.failOn !== undefined && n >= opts.failOn;
      if (fail) {
        res.writeHead(500).end("boom");
        return;
      }
      const msg = isToolAnswer
        ? { role: "assistant", content: "thinkcentre hosts gwarestrin, dab, neo4j-mcp [1]" }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "cypher_read", arguments: JSON.stringify({ query: "MATCH (m:Machine) RETURN m.name" }) },
              },
            ],
          };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: msg }] }));
    });
  });
  return { server, calls };
}

// mock MCP streamable-HTTP endpoint
function mockMcp(writeQueries: string[] = []) {
  const queries: string[] = [];
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
      if (msg.method === "tools/call") {
        const q = String(msg.params?.arguments?.query ?? "");
        queries.push(q);
        const isWrite = /^\s*(CREATE|MERGE|DELETE|SET|DROP)/i.test(q);
        if (isWrite) writeQueries.push(q);
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
  return { server, queries };
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

describe("runAnalysisAgent", () => {
  it("runs tool loop and returns the final context block", async () => {
    const llm = mockLlm();
    const mcp = mockMcp();
    servers.push(llm.server, mcp.server);
    const [llmUrl, mcpUrl] = [await listen(llm.server), await listen(mcp.server)];
    const out = await runAnalysisAgent("what depends on thinkcentre?", {
      llmUrl,
      llmKey: "x",
      model: "m",
      mcpUrl,
      timeoutMs: 20_000,
    });
    expect(out).toContain("thinkcentre hosts gwarestrin");
    expect(mcp.queries.length).toBeGreaterThan(0);
    // entity dictionary fetch + the agent's tool call = at least 2 cypher reads
    expect(mcp.queries.length).toBeGreaterThanOrEqual(2);
  });

  it("returns null when the LLM endpoint fails", async () => {
    const llm = mockLlm({ failOn: 1 });
    const mcp = mockMcp();
    servers.push(llm.server, mcp.server);
    const out = await runAnalysisAgent("hi", {
      llmUrl: await listen(llm.server),
      llmKey: "x",
      model: "m",
      mcpUrl: await listen(mcp.server),
      timeoutMs: 20_000,
    });
    expect(out).toBeNull();
  });

  it("never forwards write queries to the graph", async () => {
    const writeQueries: string[] = [];
    const llm = mockLlm();
    const mcp = mockMcp(writeQueries);
    servers.push(llm.server, mcp.server);
    // make the mock LLM emit a write query first
    // (override: patch mock to always emit CREATE — do it by wrapping a custom server)
    const evilLlm = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        const last = parsed.messages.at(-1);
        const msg = last?.role === "tool"
          ? { role: "assistant", content: "final" }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "c1", type: "function", function: { name: "cypher_read", arguments: JSON.stringify({ query: "CREATE (n:X) RETURN n" }) } },
              ],
            };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: msg }] }));
      });
    });
    servers.push(evilLlm);
    const out = await runAnalysisAgent("make a node", {
      llmUrl: await listen(evilLlm),
      llmKey: "x",
      model: "m",
      mcpUrl: await listen(mcp.server),
      timeoutMs: 20_000,
    });
    expect(out).toBe("final");
    expect(writeQueries).toEqual([]);
  });
});
