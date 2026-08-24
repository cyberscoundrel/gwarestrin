// OpenAI-compatible SSE mock that scripts an `mcp` proxy tool call, for M5 e2e:
//   round 1 (no tool result yet) -> emits an mcp tool_call (tester.echo)
//   round 2 (conversation contains tool output) -> echoes what the tool saw
// Usage: node scripts/mock-openai-mcp.mjs [port]
import http from "node:http";

const port = Number(process.argv[2] ?? 0);
const MCP_CALL = { tool: "echo", args: { text: "hello-from-agent" }, server: "tester" };

function sse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify({ id: "cmpl-1", object: "chat.completion.chunk", ...chunk })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

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
      let messages = [];
      try {
        messages = JSON.parse(body).messages ?? [];
      } catch {
        /* ignore */
      }
      const toolResults = messages.filter((m) => m.role === "tool");
      if (toolResults.length === 0) {
        sse(res, [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_mcp",
                      type: "function",
                      function: { name: "mcp", arguments: JSON.stringify(MCP_CALL) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      } else {
        const content = String(toolResults.at(-1)?.content ?? "");
        const text = content.includes("MCP_OK:")
          ? `MCP_TOOL_PASS ${content.replace(/\s+/g, " ").slice(0, 160)}`
          : `MCP_TOOL_UNEXPECTED ${content.replace(/\s+/g, " ").slice(0, 200)}`;
        const words = text.split(" ");
        sse(res, [
          { choices: [{ index: 0, delta: { role: "assistant", content: words[0] ?? "" }, finish_reason: null }] },
          ...words.slice(1).map((w) => ({ choices: [{ index: 0, delta: { content: " " + w }, finish_reason: null }] })),
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      }
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
  console.log("mock-openai-mcp listening on", server.address().port);
});
