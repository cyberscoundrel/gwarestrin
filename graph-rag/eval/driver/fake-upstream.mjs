#!/usr/bin/env node
// The plumbing proof's stand-in for OpenRouter (eval/compose.fake.yml): an OpenAI-compatible chat-completions
// endpoint that answers with the dry run's fake policies (models.mjs fakeClient), so a run through the evaluation's
// litellm goes driver -> litellm -> here and back, with no real model and no key.
//
// It sees only what litellm forwards (the messages and the tools), never the labels or the dataset. The role is told
// from what graph-rag gave the agent: a discovery run's brief opens "Discovery run" (graph-rag's own text; its token
// carries the same master tools as the orchestrator's), the orchestrator has start_worker, and everything else
// (workers, discovery parts) is a worker.
// Token counts in its answers are estimates (four characters a token): what a usage path needs, not a measure.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { fakeClient } from "./models.mjs";

/** the role a request is: from the first message graph-rag composed for it, and the tools it was given */
export function roleOf(toolNames, firstMessage = "") {
  if (/^Discovery run /.test(firstMessage)) return "discovery";
  if (toolNames.includes("graph-rag_start_worker")) return "orchestrator";
  return "worker";
}

/** OpenAI wire messages -> the driver's { system, messages } (a tool answer gets its tool's name back from its call) */
export function fromWire(wire) {
  const names = new Map();
  let system = "";
  const messages = [];
  for (const m of wire ?? []) {
    if (m.role === "system") system += typeof m.content === "string" ? m.content : "";
    else if (m.role === "assistant") {
      const toolCalls = (m.tool_calls ?? []).map((t) => {
        names.set(t.id, t.function?.name);
        let args = {};
        try {
          args = JSON.parse(t.function?.arguments || "{}");
        } catch {}
        return { id: t.id, name: t.function?.name, args };
      });
      messages.push({ role: "assistant", content: textOf(m.content), toolCalls });
    } else if (m.role === "tool") messages.push({ role: "tool", toolCallId: m.tool_call_id, name: names.get(m.tool_call_id) ?? m.name, content: textOf(m.content) });
    else messages.push({ role: "user", content: textOf(m.content) });
  }
  return { system, messages };
}
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : "");

/** one chat-completions request body -> the answer body */
export async function answer(body) {
  const tools = (body.tools ?? []).map((t) => ({ name: t.function?.name, description: t.function?.description ?? "", schema: t.function?.parameters ?? {} }));
  const { system, messages } = fromWire(body.messages);
  const role = roleOf(tools.map((t) => t.name), messages.find((m) => m.role === "user")?.content ?? "");
  const r = await fakeClient(role).complete({ system, messages, tools });
  const toolCalls = r.toolCalls ?? [];
  const sent = JSON.stringify(body.messages ?? []).length + JSON.stringify(body.tools ?? []).length;
  const out = String(r.text ?? "").length + JSON.stringify(toolCalls).length;
  return {
    id: `fake-upstream-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: r.text || null, ...(toolCalls.length ? { tool_calls: toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })) } : {}) },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: Math.ceil(sent / 4), completion_tokens: Math.ceil(out / 4), total_tokens: Math.ceil((sent + out) / 4) },
    fake_role: role,
  };
}

export function serve(port = 4000) {
  let served = 0;
  const server = createServer(async (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && /\/models$/.test(req.url)) return send(200, { object: "list", data: [] });
    if (req.method !== "POST" || !/\/chat\/completions$/.test(req.url)) return send(404, { error: { message: `fake upstream: no ${req.method} ${req.url}` } });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const a = await answer(JSON.parse(raw));
      served++;
      if (served === 1 || served % 50 === 0) console.log(`fake upstream: ${served} answered (latest: ${a.fake_role}, model ${a.model})`);
      send(200, a);
    } catch (e) {
      send(500, { error: { message: `fake upstream: ${String(e?.message ?? e)}` } });
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await serve(Number(process.env.PORT ?? 4000));
  console.log("fake upstream: listening on 4000 (OpenAI-compatible; the dry run's fake policies)");
}
