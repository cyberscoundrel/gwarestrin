import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  type ModelView,
  type ProviderDef,
  type ProvidersFile,
  type ProviderView,
  providersFileSchema,
} from "@gwarestrin/shared";
import { scoped } from "../util/log.js";
import { discoverModels } from "./discover.js";

const log = scoped("providers");

const FIRST_PARTY: Record<string, { type: ProviderDef["type"]; baseUrl: string; keyEnv: string; description: string }> = {
  openai: { type: "openai-completions", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", description: "OpenAI (first-party)" },
  anthropic: { type: "anthropic-messages", baseUrl: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY", description: "Anthropic (first-party)" },
};

/** first-party catalogues are maintained by pi itself; we declare a few known models lazily */
const FIRST_PARTY_MODELS: Record<string, ModelView[]> = {
  openai: [
    { id: "gpt-4o", name: "GPT-4o", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384, cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 }, source: "first-party" },
    { id: "gpt-4o-mini", name: "GPT-4o mini", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384, cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 }, source: "first-party" },
  ],
  anthropic: [
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, source: "first-party" },
    { id: "claude-haiku-4-20250514", name: "Claude Haiku 4", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 8192, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, source: "first-party" },
  ],
};

function staticToView(m: ProviderDef["models"]): ModelView[] {
  return (m ?? []).map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    reasoning: m.reasoning ?? false,
    input: m.input ?? ["text"],
    contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
    cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    source: "static",
  }));
}

export class ProviderRegistry {
  private providers = new Map<string, ProviderView>();
  private defs = new Map<string, ProviderDef>();
  private defaults: { provider: string | null; model: string | null } = { provider: null, model: null };

  get(id: string): ProviderView | undefined {
    return this.providers.get(id);
  }

  list(): ProviderView[] {
    return [...this.providers.values()];
  }

  get defaultProvider(): string | null {
    return this.defaults.provider;
  }

  get defaultModel(): string | null {
    return this.defaults.model;
  }

  /** resolve apiKeyEnv/key at spawn time; returns undefined for keyless */
  resolveKey(id: string): string | undefined {
    const def = this.defs.get(id);
    if (!def) return undefined;
    if (def.apiKeyEnv) return process.env[def.apiKeyEnv];
    return def.apiKey;
  }

  hasKey(id: string): boolean {
    const def = this.defs.get(id);
    if (!def) return false;
    if (def.apiKeyEnv) return Boolean(process.env[def.apiKeyEnv]);
    return Boolean(def.apiKey);
  }

  /** static extra headers from the provider def (never served via API) */
  resolveHeaders(id: string): Record<string, string> | undefined {
    const def = this.defs.get(id);
    if (!def?.headers) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(def.headers)) {
      out[k] = v;
    }
    return out;
  }

  /**
   * Load providers.json (if configured & present) + first-party env providers.
   * Throws only on invalid JSON/schema; missing file is not an error.
   */
  async load(providersFile: string | undefined): Promise<void> {
    this.providers.clear();
    this.defs.clear();

    let file: ProvidersFile | undefined;
    if (providersFile) {
      try {
        const raw = await import("node:fs/promises").then((fs) => fs.readFile(providersFile, "utf8"));
        const parsed: unknown = JSON.parse(raw);
        if (!Value.Check(providersFileSchema, parsed)) {
          const errors = [...Value.Errors(providersFileSchema, parsed)].map((e) => String(e.message));
          throw new Error(`invalid providers file:\n  ${errors.join("\n  ")}`);
        }
        file = parsed;
        log.info(`loaded providers file (${Object.keys(file.providers).length} entries) from ${providersFile}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          log.info(`providers file not found at ${providersFile}; first-party only`);
        } else {
          throw err;
        }
      }
    }

    for (const [id, def] of Object.entries(file?.providers ?? {})) {
      this.defs.set(id, def);
    }

    // first-party env providers (never override file entries)
    for (const [id, fp] of Object.entries(FIRST_PARTY)) {
      if (this.defs.has(id)) continue;
      if (!process.env[fp.keyEnv]) continue;
      this.defs.set(id, {
        type: fp.type,
        baseUrl: fp.baseUrl,
        apiKeyEnv: fp.keyEnv,
        description: fp.description,
      });
    }

    // build views: static models first
    for (const [id, def] of this.defs) {
      this.providers.set(id, {
        id,
        type: def.type,
        baseUrl: def.baseUrl,
        ...(def.description !== undefined ? { description: def.description } : {}),
        hasKey: this.hasKey(id),
        degraded: false,
        autoDiscover: def.autoDiscover?.enabled === true,
        firstParty: Object.hasOwn(FIRST_PARTY, id) && !file?.providers[id],
        tier: def.tier ?? "cloud",
        models: Object.hasOwn(FIRST_PARTY_MODELS, id) && this.defs.get(id)?.apiKeyEnv === FIRST_PARTY[id]?.keyEnv
          ? FIRST_PARTY_MODELS[id]!
          : staticToView(def.models),
      });
    }

    this.defaults = {
      provider: file?.defaultProvider ?? this.pickDefault(),
      model: file?.defaultModel ?? null,
    };

    await this.discoverAll();
  }

  /** probe autoDiscover endpoints; merge over static (static wins on id) */
  async discoverAll(): Promise<void> {
    const targets = this.list().filter((p) => p.autoDiscover);
    await Promise.all(
      targets.map(async (p) => {
        const def = this.defs.get(p.id)!;
        try {
          const models = await discoverModels({
            baseUrl: def.baseUrl,
            path: def.autoDiscover?.path ?? "/models",
            ...(this.resolveKey(p.id) !== undefined ? { apiKey: this.resolveKey(p.id) } : {}),
            ...(def.headers !== undefined ? { headers: def.headers } : {}),
          });
          const staticIds = new Set(p.models.map((m) => m.id));
          const discovered = models.filter((m) => !staticIds.has(m.id));
          p.models = [...p.models, ...discovered];
          p.degraded = false;
          delete p.degradedReason;
          log.info(`discovered ${discovered.length} models on ${p.id} (total ${p.models.length})`);
        } catch (err) {
          p.degraded = true;
          p.degradedReason = err instanceof Error ? err.message : String(err);
          log.warn(`discovery failed for ${p.id}: ${p.degradedReason}`);
        }
      }),
    );
  }

  /** filter to what a given agent may see (undefined = all) */
  forAgent(allow?: string[]): ProviderView[] {
    if (!allow || allow.length === 0) return this.list();
    const set = new Set(allow);
    return this.list().filter((p) => set.has(p.id));
  }

  private pickDefault(): string | null {
    const withKey = this.list().filter((p) => p.hasKey || !p.degraded);
    if (withKey.length === 0) return null;
    return withKey[0]!.id;
  }
}
