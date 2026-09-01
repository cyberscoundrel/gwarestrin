import type { ModelView } from "@gwarestrin/shared";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "@gwarestrin/shared";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

interface DiscoverOptions {
  baseUrl: string;
  path: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
}

interface OpenAiModelsResponse {
  data?: Array<{ id: string; owned_by?: string; context_length?: number; max_model_len?: number }>;
}

/**
 * One-shot GET returning status + body. Uses agent:false so every call opens
 * a fresh connection — a socket established while WARP routing was unsettled
 * keeps serving an interception page, and keep-alive reuse would pin it.
 */
function getBody(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https:") ? httpsGet : httpGet;
    const req = get(url, { headers: { accept: "application/json", ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
  });
}

/** Probe an OpenAI-style GET /models endpoint. */
export async function discoverModels(opts: DiscoverOptions): Promise<ModelView[]> {
  // append (NOT URL-resolve): a "/models" path against "https://host/api/v1"
  // must yield "https://host/api/v1/models" — URL resolution would discard
  // the /api/v1 base path and hit the site root instead.
  const url = opts.baseUrl.replace(/\/+$/, "") + (opts.path.startsWith("/") ? opts.path : "/" + opts.path);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  const { status, body } = await getBody(url, headers, opts.timeoutMs ?? 10_000);
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status} from ${url}`);
  }
  let parsed: OpenAiModelsResponse;
  try {
    parsed = JSON.parse(body) as OpenAiModelsResponse;
  } catch {
    // common culprit: an interception/block page (HTML) instead of JSON
    throw new Error(`non-JSON response from ${url} (${body.slice(0, 60)})`);
  }
  if (!Array.isArray(parsed.data)) throw new Error("response missing data[]");
  return parsed.data
    .filter((m) => typeof m.id === "string" && m.id.length > 0)
    // gateway/catalog convention: embedding models are never chat-selectable.
    // LiteLLM aliases use the `embed-*` prefix; hosted catalogs (openrouter)
    // carry "embedding"/"embed" in the id itself.
    .filter((m) => !/embed/i.test(m.id))
    .map((m) => ({
      id: m.id,
      name: m.id,
      reasoning: /think|reason|r1|qwq/i.test(m.id),
      input: ["text"],
      contextWindow: m.context_length ?? m.max_model_len ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      source: "discovered" as const,
    }));
}
