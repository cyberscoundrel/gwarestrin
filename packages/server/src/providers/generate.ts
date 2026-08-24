import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderRegistry } from "./registry.js";

/**
 * File consumed by the provider-bridge pi extension (registerProvider for
 * each entry). Contains NO key material — keys are injected as env vars
 * (GWARESTRIN_KEY_<ID>) into the pi child process at spawn time.
 */
export interface GeneratedProviderEntry {
  type: string;
  baseUrl: string;
  apiKeyEnv: string;
  headers?: Record<string, string> | undefined;
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    input: string[];
    contextWindow: number;
    maxTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }>;
}

export interface GeneratedProvidersFile {
  defaultProvider: string | null;
  defaultModel: string | null;
  providers: Record<string, GeneratedProviderEntry>;
}

export function envVarForProviderKey(providerId: string): string {
  const normalized = providerId.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  return `GWARESTRIN_KEY_${normalized}`;
}

export function buildGeneratedProviders(registry: ProviderRegistry, allow?: string[]): GeneratedProvidersFile {
  const providers: Record<string, GeneratedProviderEntry> = {};
  for (const p of registry.forAgent(allow)) {
    providers[p.id] = {
      type: p.type,
      baseUrl: p.baseUrl,
      apiKeyEnv: envVarForProviderKey(p.id),
      ...(registry.resolveHeaders(p.id) ? { headers: registry.resolveHeaders(p.id) } : {}),
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        input: m.input,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        cost: m.cost,
      })),
    };
  }
  const defaults = registry.forAgent(allow);
  const defaultProvider =
    registry.defaultProvider && providers[registry.defaultProvider]
      ? registry.defaultProvider
      : (defaults[0]?.id ?? null);
  let defaultModel = registry.defaultModel;
  if (defaultProvider && defaultModel) {
    const inProvider = providers[defaultProvider]?.models.some((m) => m.id === defaultModel);
    if (!inProvider) defaultModel = providers[defaultProvider]?.models[0]?.id ?? null;
  } else {
    defaultModel = defaultProvider ? (providers[defaultProvider]?.models[0]?.id ?? null) : null;
  }
  return { defaultProvider, defaultModel, providers };
}

export async function writeGeneratedProviders(
  destPath: string,
  file: GeneratedProvidersFile,
): Promise<void> {
  await writeFile(destPath, JSON.stringify(file, null, 2) + "\n", "utf8");
}

export function generatedProvidersPath(agentHomeDir: string): string {
  return path.join(agentHomeDir, "providers.gen.json");
}
