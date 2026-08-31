/**
 * Minimal MCP streamable-HTTP client — just enough for the analysis agent's
 * single read tool. Handles: initialize (+ optional Mcp-Session-Id header),
 * notifications/initialized, tools/call.
 *
 * Streamable-HTTP servers answer SSE-framed responses on a stream that may
 * stay open — never await full body completion; parse messages incrementally
 * and resolve on the first payload matching the request id.
 */
export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;

  constructor(private url: string) {}

  private async post(body: Record<string, unknown>, expectMessage = true): Promise<Record<string, unknown> | null> {
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
    if (!expectMessage) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json") && !ct.includes("event-stream")) {
      return (await res.json()) as Record<string, unknown>;
    }
    return this.readSseMessage(res, typeof body.id === "number" ? body.id : undefined);
  }

  /** read SSE lines until a JSON payload with the wanted id arrives */
  private async readSseMessage(res: Response, wantedId?: number): Promise<Record<string, unknown> | null> {
    if (!res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (wantedId === undefined || msg.id === wantedId) {
            await reader.cancel().catch(() => {});
            return msg;
          }
        }
      }
    } catch (err) {
      throw new Error(`mcp stream read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
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
