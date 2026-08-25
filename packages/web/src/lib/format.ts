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
