// Model clients for the evaluation driver: `complete({ system, messages, tools })` -> { text, toolCalls, usage }.
//
//   openaiClient   any OpenAI-compatible chat-completions endpoint with tools (OpenRouter, OpenAI, a LiteLLM proxy).
//                  The key comes from the environment the run was started with; this never prints or logs it.
//   fakeClient     the dry run's stand-in: a fixed, naive policy per role that exercises every tool path. It reads
//                  only what it is sent (its prompt and the tools' answers), never the labels, the dataset or anything
//                  a report scores, so a dry run proves the wiring and says nothing about how models do.
//
// Messages, inside the driver: { role: "user", content } | { role: "assistant", content, toolCalls: [{ id, name, args }] }
// | { role: "tool", toolCallId, name, content }.

/**
 * DeepSeek's own tool-call markup (DSML: "<｜DSML｜parameter name=...>") sometimes comes back inside an argument's
 * value, the provider's parser having missed it. Each string value is cut at the first marker; what was cut is
 * returned so the driver logs it and the report counts it as the model's failure (harness handling, not a fix).
 */
export const DSML_RE = /<\/?｜DSML｜|｜DSML｜/;
export function cutDsml(args) {
  const cut = [];
  const walk = (v, path) => {
    if (typeof v === "string") {
      const m = DSML_RE.exec(v);
      if (!m) return v;
      cut.push({ path, raw: v.slice(0, 2000) });
      return v.slice(0, m.index).trimEnd();
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k)]));
    return v;
  };
  return { args: walk(args, ""), cut };
}

/** an OpenAI-compatible client; `apiKey` is read once and kept in this closure only */
export function openaiClient({ baseUrl, apiKey, model, maxTokens = 4096, temperature = null, fetch: f = globalThis.fetch, timeoutMs = 300_000, headers = {} }) {
  if (!baseUrl || !model) throw new Error("a model client needs a base URL and a model");
  if (!apiKey) throw new Error(`no API key for ${model} (it is read from the run's env file)`);
  const url = `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;
  const toWire = (system, messages) => [
    { role: "system", content: system },
    ...messages.map((m) =>
      m.role === "assistant"
        ? { role: "assistant", content: m.content || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })) } : {}) }
        : m.role === "tool"
          ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
          : { role: "user", content: m.content },
    ),
  ];
  return {
    model,
    async complete({ system, messages, tools }) {
      // no sampling parameter unless asked: current Claude models (Opus 5.5, Sonnet 5.5) reject one with a 400,
      // and no forced tool choice either (rejected the same way): the model calls tools on "auto"
      const body = {
        model,
        ...(temperature === null ? {} : { temperature }),
        max_tokens: maxTokens,
        messages: toWire(system, messages),
        ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: String(t.description).slice(0, 1024), parameters: t.schema } })) } : {}),
      };
      let res;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await f(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        if (res.status !== 429 && res.status < 500) break;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
      const text = await res.text();
      // an error answer may quote the request back; never the key, which isn't in the body
      if (!res.ok) throw new Error(`${model}: ${res.status} ${text.slice(0, 300)}`);
      const j = JSON.parse(text);
      const msg = j.choices?.[0]?.message ?? {};
      const toolCalls = (msg.tool_calls ?? []).map((t) => {
        let args = {};
        try {
          args = JSON.parse(t.function?.arguments || "{}");
        } catch {
          args = { _unparsed: String(t.function?.arguments ?? "").slice(0, 500) };
        }
        const { args: clean, cut } = cutDsml(args);
        return { id: t.id, name: t.function?.name, args: clean, ...(cut.length ? { dsml: cut } : {}) };
      });
      // which upstream served it (OpenRouter names its provider; litellm passes it through)
      return { text: msg.content ?? "", toolCalls, provider: j.provider ?? null, dsmlInText: DSML_RE.test(String(msg.content ?? "")), usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 } };
    },
  };
}

// ---- the fake ----

const lastTool = (messages) => messages.filter((m) => m.role === "tool");
const toolResults = (messages, name) => lastTool(messages).filter((m) => m.name === name).map((m) => m.content);
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
let fakeId = 1;
const call = (name, args) => ({ id: `fake-${fakeId++}`, name, args });
const has = (tools, name) => tools.some((t) => t.name === name);
const turnsSoFar = (messages) => messages.filter((m) => m.role === "assistant").length;

/** discovery: list the connection's tables, make one class per table under resource, record each examined, then report */
function discoveryPolicy({ messages, tools }) {
  const conn = tools.find((t) => t.name.endsWith("_describe_entities"))?.name;
  const n = turnsSoFar(messages);
  if (n === 0 && conn) return { toolCalls: [call(conn, {})] };
  if (n === 1) {
    const described = parse(toolResults(messages, conn)[0] ?? "") ?? {};
    const tables = (described.entities ?? []).map((e) => e.name).filter((t) => !/GwConnectionIdentity/.test(t));
    const calls = [];
    for (const t of tables) {
      const name = t.replace(/^dbo_/, "").replace(/_/g, " ");
      calls.push(call("graph-rag_create_class", { name, parents: ["resource"], evidence: [{ kind: "table", ref: `mssql:${t}` }], record_table: `mssql:${t}`, rows_are_nodes: false }));
    }
    if (has(tools, "graph-rag_record_examined") && tables.length) calls.push(call("graph-rag_record_examined", { system: "mssql", tables }));
    return { toolCalls: calls };
  }
  return { text: "Fake discovery: one class per table, under resource. Nothing seeded." };
}

/** the orchestrator on its signals: start a worker per batched record, keep every request, check every account */
function orchestratorPolicy({ messages }) {
  const prompt = messages[0].content;
  const n = turnsSoFar(messages);
  if (n === 0) {
    const calls = [];
    for (const m of prompt.matchAll(/^- record (\S+)/gm)) calls.push(call("graph-rag_start_worker", { record: m[1].replace(/:$/, "") }));
    for (const m of prompt.matchAll(/^REQUEST (\S+) /gm)) calls.push(call("graph-rag_answer_request", { request: m[1], decision: "keep" }));
    for (const m of prompt.matchAll(/^DONE worker (\S+) /gm)) calls.push(call("graph-rag_check_account", { job: m[1] }));
    if (calls.length) return { toolCalls: calls };
  }
  if (n === 1) {
    const calls = [];
    for (const r of toolResults(messages, "graph-rag_check_account").map(parse).filter(Boolean)) {
      for (const e of r.entries ?? []) if (!e.verdict && e.suggested?.result) calls.push(call("graph-rag_record_verdict", { entry: e.entry, result: e.suggested.result, note: "fake: the suggested verdict" }));
    }
    if (calls.length) return { toolCalls: calls };
  }
  return { text: "Fake orchestrator: done with these signals." };
}

/** the sections a worker's brief carries: [{ rid, text }] */
export function briefSections(brief) {
  const out = [];
  const parts = String(brief).split(/\n----------\n/);
  for (const p of parts) {
    // "section s1 (#1:23): heading" (the short id a tool takes), or the older "Section #1:23: heading"
    const m = /^section (s\d+) \((#\d+:\d+)\)(?::[^\n]*)?\n([\s\S]*)$/i.exec(p.trim()) ?? /^Section (#\d+:\d+)(?::[^\n]*)?\n([\s\S]*)$/.exec(p.trim());
    if (m) out.push(m.length === 4 ? { rid: m[1], text: m[3].trim() } : { rid: m[1], text: m[2].trim() });
  }
  return out;
}

/** the entry ids a worker's filing tools gave back so far (each answers { outcome, entry: "<id>" }) */
const entriesSoFar = (messages) =>
  lastTool(messages)
    .map((m) => parse(m.content))
    .filter(Boolean)
    .map((r) => (typeof r.entry === "string" ? r.entry : r.entry?.id))
    .filter((x) => typeof x === "string" && x.length >= 8);

/** a filing worker: look names up; Kept where a visible instance is found, a stated shipment Filed, the rest Held */
function workerPolicy({ messages }) {
  // resumed: graph-rag asks for what a thread owes (its account); give it from the entries this conversation holds
  const latest = [...messages].reverse().find((m) => m.role === "user");
  if (latest !== messages[0]) {
    const since = messages.slice(messages.lastIndexOf(latest));
    if (/account/i.test(latest.content) && !since.some((m) => m.role === "tool" && m.name === "graph-rag_give_account")) {
      const entries = [...new Set(entriesSoFar(messages))];
      if (entries.length) return { toolCalls: [call("graph-rag_give_account", { pieces: entries.map((entry) => ({ entry, said: "fake: did what the entry says" })) })] };
    }
    return { text: "Fake worker: nothing more." };
  }
  const brief = messages[0].content;
  const sections = briefSections(brief);
  const jobClass = /^- (\S+)[^\n]*, table mssql:dbo_Job\b/m.exec(brief)?.[1] ?? null;
  const n = turnsSoFar(messages);
  if (n === 0) {
    const calls = [];
    for (const s of sections) {
      const names = [...new Set((s.text.match(/\b(?:[A-Z][a-zA-Z-]+(?: [A-Z][a-zA-Z-]+)?|\d{4,7})\b/g) ?? []).slice(0, 4))];
      for (const name of names) calls.push(call("graph-rag_resolve_name", { name }));
    }
    return { toolCalls: calls.length ? calls : [call("graph-rag_resolve_name", { name: "x" })] };
  }
  if (n === 1) {
    const seen = toolResults(messages, "graph-rag_resolve_name").map(parse).filter(Boolean).flatMap((r) => (r.instances ?? []).map((i) => i.rid ?? i.id)).filter(Boolean);
    const calls = [];
    for (const s of sections) {
      const piece = s.text.slice(0, 200);
      const job = /\bjob (\d{4,7})\b/i.exec(s.text)?.[1];
      if (/\bshipped\b/i.test(s.text) && job && jobClass) calls.push(call("graph-rag_file_to_source", { section: s.rid, piece, said: `set job ${job}'s status to Shipped`, class: jobClass, key: `mssql:dbo_Job:${job}`, fields: { Status: "Shipped" }, says_change: true }));
      else if (seen.length) calls.push(call("graph-rag_keep_piece", { section: s.rid, piece, instances: [seen[0]] }));
      else calls.push(call("graph-rag_hold_piece", { section: s.rid, piece, question: "Which record does this section mean?", table: "mssql:dbo_Job" }));
    }
    return { toolCalls: calls };
  }
  if (n === 2) {
    const entries = [...new Set(entriesSoFar(messages))];
    if (entries.length) return { toolCalls: [call("graph-rag_give_account", { pieces: entries.map((entry) => ({ entry, said: "fake: did what the entry says" })) })] };
  }
  return { text: "Fake worker: filed what it could." };
}

const POLICIES = { discovery: discoveryPolicy, orchestrator: orchestratorPolicy, worker: workerPolicy };

/** the dry run's model for one role: discovery, orchestrator, worker */
export function fakeClient(role) {
  const policy = POLICIES[role];
  if (!policy) throw new Error(`no fake policy for ${role}`);
  return {
    model: `fake-${role}`,
    async complete({ messages, tools }) {
      const r = policy({ messages, tools });
      return { text: r.text ?? "", toolCalls: r.toolCalls ?? [], usage: { input: 0, output: 0 } };
    },
  };
}
