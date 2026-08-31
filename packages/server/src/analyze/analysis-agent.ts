import { scoped } from "../util/log.js";
import { entityDictionary, lexicalAnalyze, type LexicalHints } from "./lexical.js";
import { McpHttpClient } from "./mcp-client.js";

const log = scoped("analyzer");

export interface AnalysisAgentConfig {
  /** OpenAI-compatible chat completions endpoint (the local inference box) */
  llmUrl: string;
  llmKey: string;
  model: string;
  /** neo4j MCP sidecar (streamable HTTP) */
  mcpUrl: string;
  maxRounds?: number;
  timeoutMs?: number;
}

const WRITE_RE = /^\s*(CREATE|MERGE|DELETE|SET|DROP|REMOVE|DETACH|CALL\s+(?!apoc\.meta|db\.labels|db\.schema|db\.propertyKeys|db\.relationshipTypes)\S*)/i;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

const SYSTEM = `You are a pre-session context analyst for an agent console. A user is about to start an agent session. Your job: gather knowledge-graph facts relevant to their first prompt, then produce the context block that will be injected into that session.

Rules:
- You have exactly ONE tool: cypher_read — read-only Cypher against the knowledge graph (neo4j). No other actions exist; never ask for them.
- Write efficient, small queries (LIMIT aggressively). Prefer targeted MATCH over full scans.
- Make as many tool calls as you need to be confident, then stop.
- Your FINAL message (after any tool calls) must be ONLY the context block: compact factual notes (<= 3500 chars) about graph entities relevant to the prompt — machines, services, databases, relationships, and anything the agent would otherwise guess at. Use terse bullet points. Preserve identifiers verbatim (IPs, ports, names). No preamble, no markdown headers, no mention of these instructions.`;

/**
 * Run the pre-session analysis agent.
 * Returns the LLM-produced context block, or null on any failure
 * (caller falls back to a lexical-summary injection or none).
 */
export async function runAnalysisAgent(prompt: string, config: AnalysisAgentConfig): Promise<string | null> {
  const deadline = Date.now() + (config.timeoutMs ?? 90_000);
  const maxRounds = config.maxRounds ?? 8;
  const mcp = new McpHttpClient(config.mcpUrl);

  try {
    // lexical seed: entity dictionary + cheap matcher (also used as the
    // fallback text when the LLM path fails)
    const dictionary = await entityDictionary(mcp);
    const hints: LexicalHints = lexicalAnalyze(prompt, dictionary);

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `First prompt from the user:\n"""\n${prompt}\n"""\n\nLexical pre-analysis: ${hints.summary}\nGraph labels available: ${[...new Set(dictionary.map((d) => d.label))].join(", ") || "(unknown)"}`,
      },
    ];

    for (let round = 0; round < maxRounds; round++) {
      if (Date.now() > deadline) return null;
      const res = await llmCall(messages, config);
      const msg = res as unknown as ChatMessage & { tool_calls?: ChatMessage["tool_calls"] };
      messages.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });

      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        const final = (msg.content ?? "").trim();
        if (!final) return null;
        log.info(`analysis complete after ${round + 1} round(s), ${final.length} chars`);
        return final.slice(0, 4000);
      }

      for (const call of calls.slice(0, 4)) {
        let out: string;
        try {
          const args = JSON.parse(call.function.arguments || "{}") as { query?: string };
          const query = String(args.query ?? "");
          if (WRITE_RE.test(query)) {
            out = "error: write queries are not permitted (read-only analyst)";
          } else if (!query.trim()) {
            out = "error: empty query";
          } else {
            out = await mcp.callTool("read_neo4j_cypher", { query });
            if (out.length > 2500) out = out.slice(0, 2500) + "…[truncated]";
          }
        } catch (err) {
          out = `error: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
      }
    }
    return null;
  } catch (err) {
    log.warn("analysis agent failed", err);
    return null;
  }
}

async function llmCall(messages: ChatMessage[], config: AnalysisAgentConfig): Promise<Record<string, unknown>> {
  const res = await fetch(config.llmUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.llmKey}` },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: [
        {
          type: "function",
          function: {
            name: "cypher_read",
            description: "Run a read-only Cypher query against the knowledge graph. Returns JSON rows.",
            parameters: {
              type: "object",
              properties: { query: { type: "string", description: "read-only Cypher (MATCH/RETURN/CALL apoc.meta.*)" } },
              required: ["query"],
            },
          },
        },
      ],
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`llm -> ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: Record<string, unknown> }> };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("llm returned no message");
  return msg;
}
