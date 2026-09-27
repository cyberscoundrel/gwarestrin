/**
 * Context engines — the composable primitive behind agent profiles.
 *
 * A profile's `contextEngine` selects an engine type and parameterizes it
 * (analysis prompt, budgets). Engines run at AGENT CREATION time and produce
 * an opaque context block that lands in the agent's context-injection.md
 * (injected into the system prompt every turn by the graph-context pi
 * extension — the injection side is engine-agnostic).
 *
 * The "graph-rag" engine is the generalized form of the original inline
 * analysis: an LLM tool-loop whose tools are resolved LIVE from an MCP
 * server's tools/list, so profiles compose engines by naming (server, tool)
 * pairs instead of duplicating schemas.
 */
import { entityDictionary, lexicalAnalyze } from "./lexical.js";
import { McpHttpClient } from "./mcp-client.js";
import { scoped } from "../util/log.js";

const log = scoped("engines");

export interface EngineLlmContext {
  llmUrl: string;
  llmKey: string;
  model: string;
}

export interface EngineContext {
  llm: EngineLlmContext;
  /** streamable-HTTP MCP endpoint the engine's tools resolve from */
  mcpUrl: string;
  mcpToken?: string | undefined;
}

export interface ContextEngineInput {
  firstPrompt?: string | undefined;
  profilePrompt?: string | undefined;
  agentName?: string | undefined;
}

export interface ContextEngineConfig {
  type: "graph-rag" | "lexical";
  prompt?: string | undefined;
  includeFirstPrompt?: boolean | undefined;
  maxRounds?: number | undefined;
  timeoutMs?: number | undefined;
  maxChars?: number | undefined;
}

export interface ContextEngineResult {
  status: "ok" | "failed";
  block?: string | undefined;
  detail?: string | undefined;
}

const WRITE_RE = /^\s*(CREATE|MERGE|DELETE|SET|DROP|REMOVE|DETACH|CALL\s+(?!apoc\.meta|db\.labels|db\.schema|db\.propertyKeys|db\.relationshipTypes)\S*)/i;

const GRAPH_SYSTEM = `You are a pre-session context analyst for an agent console. A user is about to start an agent session. Your job: gather knowledge-graph facts relevant to the session's focus, then produce the context block that will be injected into that session.

Rules:
- Your tools are read-only views over a knowledge graph. Prefer semantic search for conceptual/paraphrased questions and raw queries for exact identifiers, structure, and schema exploration.
- Write efficient queries (LIMIT aggressively). Make as many tool calls as you need to be confident, then stop.
- Your FINAL message (after any tool calls) must be ONLY the context block: compact factual notes about graph entities relevant to the focus — machines, services, databases, relationships, and anything the agent would otherwise guess at. Use terse bullet points. Preserve identifiers verbatim (IPs, ports, names). No preamble, no markdown headers, no mention of these instructions.`;

// per-tool guards + output budgets (keyed by MCP tool name)
const TOOL_GUARDS: Record<string, (args: Record<string, unknown>) => string | null> = {
  query_graph: (args) => {
    const q = String(args?.query ?? "");
    if (WRITE_RE.test(q)) return "error: write queries are not permitted (read-only analyst)";
    if (!q.trim()) return "error: empty query";
    return null;
  },
};
const TOOL_BUDGETS: Record<string, number> = { query_graph: 2500, search_graph: 3000 };

interface ResolvedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  guard?: (args: Record<string, unknown>) => string | null;
  budget: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

async function resolveTools(mcp: McpHttpClient): Promise<ResolvedTool[]> {
  const tools = await mcp.listTools();
  return tools.map((t) => {
    const guard = TOOL_GUARDS[t.name];
    return {
      name: t.name,
      description: t.description ?? t.name,
      parameters: t.inputSchema ?? { type: "object", properties: {} },
      ...(guard ? { guard } : {}),
      budget: TOOL_BUDGETS[t.name] ?? 3000,
    };
  });
}

/** the generic LLM tool-loop behind tool-using engines */
async function toolLoop(
  system: string,
  userMessage: string,
  tools: ResolvedTool[],
  ctx: EngineContext,
  budget: { maxRounds: number; timeoutMs: number; maxChars: number },
): Promise<ContextEngineResult> {
  const deadline = Date.now() + budget.timeoutMs;
  const mcp = new McpHttpClient(ctx.mcpUrl, ctx.mcpToken);
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: userMessage },
  ];

  for (let round = 0; round < budget.maxRounds; round++) {
    if (Date.now() > deadline) return { status: "failed", detail: "deadline exceeded" };
    // single-round fetches can be slow on local inference; the effective
    // cap is the engine deadline plus one call's grace
    const res = await llmCall(messages, tools, ctx, deadline + 60_000);
    const msg = res as unknown as ChatMessage & { tool_calls?: ChatMessage["tool_calls"] };
    messages.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      const final = (msg.content ?? "").trim();
      if (!final) return { status: "failed", detail: "empty final message" };
      log.info(`engine done after ${round + 1} round(s), ${final.length} chars`);
      return { status: "ok", block: final.slice(0, budget.maxChars) };
    }

    for (const call of calls.slice(0, 4)) {
      let out: string;
      const tool = tools.find((t) => t.name === call.function.name);
      try {
        if (!tool) {
          out = `error: unknown tool ${call.function.name}`;
        } else {
          const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          const blocked = tool.guard?.(args);
          out = blocked ?? await mcp.callTool(tool.name, args);
          if (out.length > tool.budget) out = out.slice(0, tool.budget) + "…[truncated]";
        }
      } catch (err) {
        out = `error: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: out });
    }
  }
  return { status: "failed", detail: "round budget exhausted" };
}

async function llmCall(messages: ChatMessage[], tools: ResolvedTool[], ctx: EngineContext, deadlineAt: number): Promise<Record<string, unknown>> {
  const res = await fetch(ctx.llm.llmUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.llm.llmKey}` },
    body: JSON.stringify({
      model: ctx.llm.model,
      messages,
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(Math.max(30_000, deadlineAt - Date.now())),
  });
  if (!res.ok) throw new Error(`llm -> ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: Record<string, unknown> }> };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("llm returned no message");
  return msg;
}

// ---------- engines ----------

/** LLM tool-loop over the knowledge graph; tools resolve from the MCP server */
async function graphRagEngine(cfg: ContextEngineConfig, input: ContextEngineInput, ctx: EngineContext): Promise<ContextEngineResult> {
  const mcp = new McpHttpClient(ctx.mcpUrl, ctx.mcpToken);
  const [tools, dictionary] = await Promise.all([resolveTools(mcp), entityDictionary(mcp)]);

  const focus = cfg.prompt?.trim();
  const parts: string[] = [];
  if (focus) parts.push(`Analysis focus from the profile:\n"""\n${focus}\n"""`);
  if (input.firstPrompt && cfg.includeFirstPrompt !== false) {
    parts.push(`First prompt from the user:\n"""\n${input.firstPrompt}\n"""`);
  }
  const lexical = lexicalAnalyze(input.firstPrompt ?? focus ?? "", dictionary);
  if (lexical.summary) parts.push(`Lexical pre-analysis: ${lexical.summary}`);
  parts.push(`Graph labels available: ${[...new Set(dictionary.map((d) => d.label))].join(", ") || "(unknown)"}`);
  if (parts.length === 0) return { status: "failed", detail: "no analysis input (no prompt, no firstPrompt)" };

  const system = focus ? `${GRAPH_SYSTEM}\n\nProfile-specific focus: ${focus}` : GRAPH_SYSTEM;
  return toolLoop(system, parts.join("\n\n"), tools, ctx, {
    maxRounds: cfg.maxRounds ?? 8,
    timeoutMs: cfg.timeoutMs ?? 90_000,
    maxChars: cfg.maxChars ?? 4000,
  });
}

/** deterministic graph summary — no LLM, no rounds */
async function lexicalEngine(cfg: ContextEngineConfig, input: ContextEngineInput, ctx: EngineContext): Promise<ContextEngineResult> {
  const mcp = new McpHttpClient(ctx.mcpUrl, ctx.mcpToken);
  const dictionary = await entityDictionary(mcp);
  const focus = cfg.prompt?.trim() || input.firstPrompt || "";
  const hints = lexicalAnalyze(focus, dictionary);
  const lines = dictionary.slice(0, 40).map((d) => `- ${d.label}: ${d.name}`);
  const block = [`Knowledge graph overview (lexical):`, ...lines, hints.summary ? `Relevant to focus: ${hints.summary}` : ""].filter(Boolean).join("\n");
  return { status: "ok", block: block.slice(0, cfg.maxChars ?? 4000) };
}

/** registry dispatch; undefined config = caller skips the step entirely */
export async function runContextEngine(cfg: ContextEngineConfig, input: ContextEngineInput, ctx: EngineContext): Promise<ContextEngineResult> {
  try {
    switch (cfg.type) {
      case "graph-rag":
        return await graphRagEngine(cfg, input, ctx);
      case "lexical":
        return await lexicalEngine(cfg, input, ctx);
      default:
        return { status: "failed", detail: `unknown engine type` };
    }
  } catch (err) {
    log.warn("context engine failed", err);
    return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}
