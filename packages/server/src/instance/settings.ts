import { modelKey, type ModelLabel } from "@gwarestrin/shared";
import { getInstanceMetadata } from "./metadata.js";

/**
 * Per-instance settings from instance metadata (`settings`), set by the
 * organization's admin through the provisioner and enforced here live:
 * - maxAgents: concurrency cap (overrides GWARESTRIN_MAX_AGENTS)
 * - mcp: tool connections this workspace may use ("all" or names)
 * - providers: model providers it may use ("all" or ids), e.g. local only
 * No metadata or no settings: no restriction beyond the server's own.
 */
export interface InstanceSettings {
  maxAgents?: number;
  mcp: "all" | string[];
  providers: "all" | string[];
}

export function instanceSettings(): InstanceSettings {
  const s = getInstanceMetadata()?.settings;
  return {
    ...(typeof s?.maxAgents === "number" ? { maxAgents: s.maxAgents } : {}),
    mcp: s?.mcp ?? "all",
    providers: s?.providers ?? "all",
  };
}

export const mcpAllowed = (name: string, s = instanceSettings()): boolean => s.mcp === "all" || s.mcp.includes(name);
export const providerAllowed = (id: string, s = instanceSettings()): boolean => s.providers === "all" || s.providers.includes(id);

/**
 * The organization's model labels. null = not enforced (legacy metadata
 * without labels, or no metadata). Otherwise only labeled models may run
 * agents: the label is the admin saying "this model is known, and is this".
 */
export function modelLabels(): Record<string, ModelLabel> | null {
  const md = getInstanceMetadata();
  return md?.models ?? null;
}

export const modelLabel = (provider: string, modelId: string, labels = modelLabels()): ModelLabel | undefined => labels?.[modelKey(provider, modelId)];

export const modelAllowed = (provider: string, modelId: string, labels = modelLabels()): boolean => labels === null || modelLabel(provider, modelId, labels) !== undefined;

/** the person-readable reason a model can't run agents here (null = it can) */
export function modelRefusal(provider: string, modelId: string): string | null {
  if (!providerAllowed(provider)) return `model provider ${provider} isn't allowed in this workspace`;
  if (!modelAllowed(provider, modelId)) return `${modelId} (${provider}) has no label yet: an admin labels models in Models before agents can use them`;
  return null;
}
