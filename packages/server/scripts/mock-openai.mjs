// Minimal OpenAI-compatible SSE mock for manual/e2e runs: replies
// "im a mock agent" (plus an echo of the last user message) to everything,
// streaming thinking + text so the chat UI shows live deltas.
//   node scripts/mock-openai.mjs [port] [host]
import http from "node:http";

const port = Number(process.argv[2] ?? 0);
const host = process.argv[3] ?? "127.0.0.1";

function sse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify({ id: "cmpl-1", object: "chat.completion.chunk", ...chunk })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function wordChunks(text, field) {
  const words = text.split(" ");
  return [
    { choices: [{ index: 0, delta: { role: "assistant", [field]: words[0] ?? "" }, finish_reason: null }] },
    ...words.slice(1).map((w) => ({ choices: [{ index: 0, delta: { [field]: " " + w }, finish_reason: null }] })),
  ];
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
      let lastUser = "";
      try {
        const messages = JSON.parse(body).messages ?? [];
        const raw = messages.filter((m) => m.role === "user").at(-1)?.content;
        // content may be a plain string or pi-style content blocks
        lastUser = String(
          Array.isArray(raw) ? raw.map((b) => (typeof b === "string" ? b : (b?.text ?? ""))).join(" ") : (raw ?? ""),
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
      } catch {
        /* ignore */
      }
      const replyText = `im a mock agent${lastUser ? ` (you said: "${lastUser}")` : ""}`;
      sse(res, [
        ...wordChunks("the user is talking to me. i am a mock. i will say so.", "reasoning_content"),
        ...wordChunks(replyText, "content"),
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, host, () => {
  console.log("mock-openai (interactive) listening on", host, server.address().port);
});
