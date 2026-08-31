/**
 * Minimal MCP streamable-HTTP client — just enough for the analysis agent's
 * single read tool. Handles: initialize (+ optional Mcp-Session-Id header),
 * notifications/initialized, tools/call, JSON and SSE-framed responses.
 */
export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;

  constructor(private url: string) {}

  private async post(body: Record<string, unknown>, expectJson = true): Promise<Record<string, unknown> | null> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) throw new Error(`mcp ${this.url} -> ${res.status}`);
    if (!expectJson) return null;
    const text = await res.text();
    return parseMaybeSse(text);
  }

  async initialize(): Promise<void> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "gwarestrin-analyzer", version: "0.1.0" },
      },
    });
    if (!res || "error" in res) throw new Error(`initialize failed: ${JSON.stringify(res)}`);
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
    this.initialized = true;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.initialized) await this.initialize();
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (!res) throw new Error("empty tool response");
    if ("error" in res) throw new Error(`tool error: ${JSON.stringify(res.error).slice(0, 300)}`);
    const result = (res as { result?: { content?: Array<{ type: string; text?: string }> } }).result;
    const text = (result?.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");
    return text;
  }
}

/** responses may be bare JSON or SSE (`event: message\ndata: {...}`) */
function parseMaybeSse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  // SSE: collect data: payloads, take the last JSON one
  let last: Record<string, unknown> | null = null;
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      last = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      /* keep scanning */
    }
  }
  return last;
}
