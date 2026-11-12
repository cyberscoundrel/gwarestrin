// The evaluation driver's agent loop: one agent (the orchestrator, a worker, a discovery part) taking turns with a
// model over MCP tools, as the workspace's pi agents do (packages/server/src/agents/graph-pool.ts), but run from a
// script so a filing run needs graph-rag and its sources only. The model is any client with
// `complete({ system, messages, tools })` (models.mjs): a real OpenAI-compatible one, or the dry run's fake.
//
// Tools are named as agents see them: `graph-rag_<name>` for graph-rag's, `<connection>_<name>` for a source
// connection's read tools (pi-mcp-adapter's naming, which the instruction texts already use).

let rpcId = 1;

/** one MCP endpoint, as a bearer token sees it: tools/list and tools/call (a tool's error comes back as text) */
export function mcpSession(url, token = null, { fetch: f = globalThis.fetch, timeoutMs = 120_000 } = {}) {
  let session = null;
  let ready = false;
  const rpc = async (method, params) => {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    session = res.headers.get("mcp-session-id") ?? session;
    const text = await res.text();
    if (!res.ok) throw new Error(`${method}: ${res.status} ${text.slice(0, 300)}`);
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text || "{}");
  };
  const init = async () => {
    if (ready) return;
    await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gr-eval-driver", version: "1" } }).catch(() => {});
    ready = true;
  };
  return {
    async list() {
      await init();
      const msg = await rpc("tools/list", {});
      return msg.result?.tools ?? [];
    },
    /** the tool's text, and whether it was an error; never throws for a tool's own refusal */
    async call(name, args) {
      await init();
      const msg = await rpc("tools/call", { name, arguments: args ?? {} });
      if (msg.error) return { text: `error: ${msg.error.message ?? JSON.stringify(msg.error)}`, error: true };
      const text = (msg.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return { text, error: Boolean(msg.result?.isError) };
    },
  };
}

/**
 * The tools an agent gets, from MCP sessions: [{ prefix, session, only? }] -> [{ name, description, schema, call }].
 * `only`: the bare tool names to keep from that session (a source connection gives read tools only).
 */
export async function toolsFrom(sources) {
  const out = [];
  for (const { prefix, session, only } of sources) {
    for (const t of await session.list()) {
      if (only && !only.includes(t.name)) continue;
      out.push({ name: `${prefix}_${t.name}`, description: t.description ?? "", schema: t.inputSchema ?? { type: "object", properties: {} }, call: (args) => session.call(t.name, args) });
    }
  }
  return out;
}

/** a graph-rag answer's outcome (filed, not_filed, held ...), for the log: I-50's corrections are counted from it */
function outcomeOf(text) {
  try {
    const o = JSON.parse(String(text ?? ""))?.outcome;
    return typeof o === "string" ? { outcome: o.slice(0, 20) } : {};
  } catch {
    return {};
  }
}

/**
 * Run one agent: the system text, the first user message, and turns until the model answers with no tool call or
 * `maxTurns` is spent. Returns { text, turns, calls, usage, messages, stopped } where stopped says why it ended early.
 * `history`: the conversation a resumed thread had, continued with `prompt`.
 * `log(event)` sees every call (name, args, whether it errored), never the model's credentials.
 */

export async function runAgent({ client, system, prompt, tools, maxTurns = 40, log = () => {}, history = null }) {
  // a resumed thread goes on with its own conversation, as the workspace wakes the agent it had (graph-pool.ts)
  const messages = [...(history ?? []), { role: "user", content: prompt }];
  const byName = new Map(tools.map((t) => [t.name, t]));
  // sentChars: what every request carries (system, tool definitions, the history so far), summed over the turns;
  // with a fake model it is the measure a cost estimate starts from (about four characters a token)
  const usage = { input: 0, output: 0, calls: 0, sentChars: 0, outChars: 0, dsml: 0, markup: 0, providers: {}, blank: 0, blank_retries: 0 };
  const toolChars = JSON.stringify(tools.map((t) => ({ n: t.name, d: t.description, s: t.schema }))).length;
  let calls = 0;
  for (let turn = 1; turn <= maxTurns; turn++) {
    usage.sentChars += system.length + toolChars + JSON.stringify(messages).length;
    let r;
    // a blank reply (no text, no tool call) that says it stopped is asked once more (harness handling, counted and
    // reported); a reply with text or a tool call is never retried
    const blank = (x) => !String(x?.text ?? "").trim() && !(x?.toolCalls ?? []).length;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await client.complete({ system, messages, tools });
      } catch (e) {
        return { text: "", turns: turn, calls, usage, messages, stopped: `the model failed: ${String(e?.message ?? e).slice(0, 300)}` };
      }
      // every reply, blank or not: who served it, why it ended, how many tool calls
      log({ turn, reply: String(r.text ?? "").slice(0, 2000), provider: r.provider ?? null, finish: r.finish ?? null, tool_calls: (r.toolCalls ?? []).length, ...(blank(r) ? { blank: true } : {}), ...(attempt ? { retry: attempt } : {}) });
      // every request counts, a retried blank one too
      usage.input += r.usage?.input ?? 0;
      usage.output += r.usage?.output ?? 0;
      usage.calls++;
      if (r.provider) usage.providers[r.provider] = (usage.providers[r.provider] ?? 0) + 1;
      if (blank(r)) usage.blank++;
      if (!(blank(r) && r.finish === "stop" && attempt === 0)) break;
      usage.blank_retries++;
    }
    // DSML markup cut out of tool arguments (models.mjs cutDsml): logged with the raw value, counted as a failure
    for (const tc of r.toolCalls ?? []) for (const c of tc.dsml ?? []) (usage.dsml++, log({ turn, dsml: true, tool: tc.name, path: c.path, provider: r.provider ?? null, raw: c.raw }));
    if (r.dsmlInText) (usage.dsml++, log({ turn, dsml: true, tool: null, path: "content", provider: r.provider ?? null, raw: String(r.text ?? "").slice(0, 2000) }));
    // GLM's arg markup split back into arguments (models.mjs repairArgMarkup): logged apart, with who served it (I-56)
    for (const tc of r.toolCalls ?? []) for (const m of tc.markup ?? []) (usage.markup++, log({ turn, markup: true, tool: tc.name, key: m.key, into: m.into, provider: r.provider ?? null }));
    messages.push({ role: "assistant", content: r.text ?? "", toolCalls: (r.toolCalls ?? []).map(({ dsml, markup, ...tc }) => tc) });
    // the model's own words each turn (the run's trace of why it did what it did)
    usage.outChars += String(r.text ?? "").length + JSON.stringify(r.toolCalls ?? []).length;
    // why the model's turn ended ("stop", or "length" at the output cap), for the trace
    if (!r.toolCalls?.length) return { text: r.text ?? "", turns: turn, calls, usage, messages, stopped: null, finish: r.finish ?? null };
    for (const tc of r.toolCalls) {
      calls++;
      const tool = byName.get(tc.name);
      const res = tool ? await tool.call(tc.args ?? {}).catch((e) => ({ text: `error: ${String(e?.message ?? e)}`, error: true })) : { text: `error: no tool ${tc.name}`, error: true };
      // a refused call's own text, for the report's commonest errors (graph-rag's and the source's words, never a key)
      log({ tool: tc.name, args: tc.args, error: res.error, ...(res.error ? { errorText: String(res.text).slice(0, 500) } : outcomeOf(res.text)) });
      messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: String(res.text).slice(0, 20_000) });
    }
  }
  return { text: "", turns: maxTurns, calls, usage, messages, stopped: `no answer within ${maxTurns} turns` };
}
