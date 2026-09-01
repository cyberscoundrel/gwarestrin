import type { ModelView } from "@gwarestrin/shared";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "@gwarestrin/shared";

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

/** Probe an OpenAI-style GET /models endpoint. */
export async function discoverModels(opts: DiscoverOptions): Promise<ModelView[]> {
  const url = new URL(opts.path, opts.baseUrl.endsWith("/") ? opts.baseUrl : opts.baseUrl + "/");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url.toString()}`);
    }
    const body = (await res.json()) as OpenAiModelsResponse;
    if (!Array.isArray(body.data)) throw new Error("response missing data[]");
    return body.data
      .filter((m) => typeof m.id === "string" && m.id.length > 0)
      // gateway convention: embedding models are aliased `embed-*` and are not
      // chat-selectable (LiteLLM's /models can't mark modes, so filter by name)
      .filter((m) => !/^embed-/i.test(m.id))
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
  } finally {
    clearTimeout(timer);
  }
}
