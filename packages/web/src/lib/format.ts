import type { ProviderView } from "@gwarestrin/shared";

/**
 * Human-facing label for a model. Providers may use opaque/path-like ids
 * (e.g. llama.cpp serves the full file path as the id); prefer the
 * catalogue's display name, fall back to the path basename, then the id.
 */
export function modelDisplayName(
  providerId: string,
  modelId: string,
  providers: ProviderView[],
): string {
  const provider = providers.find((p) => p.id === providerId);
  const found = provider?.models.find((m) => m.id === modelId);
  if (found?.name && found.name !== found.id) return found.name;
  const base = modelId.split("/").filter(Boolean).pop();
  return base ?? modelId;
}

/** UI name for a model tier: "On-prem" for self-hosted, "Cloud" otherwise. */
export function tierName(tier: "local" | "cloud"): string {
  return tier === "local" ? "On-prem" : "Cloud";
}

/**
 * Where a provider's models run, for display: "On-prem" for local-tier
 * providers, "Cloud: <provider id>" for hosted ones. Unknown providers are
 * treated as cloud, matching the server's default tier.
 */
export function whereItRuns(
  providerId: string,
  providers: ProviderView[],
): { tier: "local" | "cloud"; label: string } {
  const tier = providers.find((p) => p.id === providerId)?.tier ?? "cloud";
  return { tier, label: tier === "local" ? "On-prem" : `Cloud: ${providerId}` };
}
