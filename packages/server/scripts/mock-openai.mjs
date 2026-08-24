// Minimal OpenAI-compatible SSE mock for manual/e2e runs:
//   node scripts/mock-openai.mjs [port]
import http from "node:http";


const port = Number(process.argv[2] ?? 0);

function reply(res, text) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const words = ["GWARE", "STRIN_", "OK"];
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", content: words[0] }, finish_reason: null }] },
    ...words.slice(1).map((w) => ({ choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  for (const chunk of chunks) res.write(`data: ${JSON.stringify({ id: "cmpl-1", object: "chat.completion.chunk", ...chunk })}\n\n`);
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
    req.on("end", () => reply(res, body));
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
  console.log("mock-openai listening on", server.address().port);
});
