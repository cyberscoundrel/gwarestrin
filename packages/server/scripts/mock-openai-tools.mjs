// OpenAI-compatible SSE mock WITH tool-call support, for M3 e2e:
//   round 1 (no tool result yet) -> emits a bash tool_call
//   round 2 (conversation contains tool output) -> echoes what the tool saw
// Usage: node scripts/mock-openai-tools.mjs [port]
import http from "node:http";

const port = Number(process.argv[2] ?? 0);
const CHECK_CMD = "pwd && head -1 /etc/os-release";

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
        // round 1: request the sandbox check
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
                      id: "call_vmcheck",
                      type: "function",
                      function: { name: "bash", arguments: JSON.stringify({ command: CHECK_CMD }) },
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
        // round 2: report what the tool saw
        const content = String(toolResults.at(-1)?.content ?? "");
        const text = content.includes("/workspace") && /Alpine/i.test(content)
          ? `VM_CHECK_PASS ${content.replace(/\s+/g, " ").slice(0, 120)}`
          : `VM_CHECK_UNEXPECTED ${content.replace(/\s+/g, " ").slice(0, 200)}`;
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

const host = process.argv[3] ?? "127.0.0.1";
server.listen(port, host, () => {
  console.log("mock-openai-tools listening on", server.address().port);
});
