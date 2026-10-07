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
