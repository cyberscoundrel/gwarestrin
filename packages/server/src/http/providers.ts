import type { FastifyInstance } from "fastify";
import { instanceSettings, modelAllowed, modelLabel, modelLabels, providerAllowed } from "../instance/settings.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ServerConfig } from "../config.js";

export async function registerProviderRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  registry: ProviderRegistry,
): Promise<void> {
  // only the providers this workspace allows (instance settings), and only labeled models, with their labels
  const view = () => {
    const labels = modelLabels();
    const providers = registry
      .list()
      .filter((p) => providerAllowed(p.id))
      .map((p) => ({
        ...p,
        models: p.models.filter((m) => modelAllowed(p.id, m.id, labels)).map((m) => ({ ...m, ...(modelLabel(p.id, m.id, labels) ? { label: modelLabel(p.id, m.id, labels) } : {}) })),
      }))
      .filter((p) => labels === null || p.models.length > 0);
    const shown = (pid: string | null) => providers.find((p) => p.id === pid);
    const defaultProvider = shown(registry.defaultProvider) ? registry.defaultProvider : (providers[0]?.id ?? null);
    const fixed = registry.defaultModel && defaultProvider === registry.defaultProvider && shown(defaultProvider)?.models.some((m) => m.id === registry.defaultModel);
    return { providers, defaultProvider, defaultModel: fixed ? registry.defaultModel : (shown(defaultProvider)?.models[0]?.id ?? null) };
  };
  app.get("/api/providers", async () => view());

  app.put("/api/providers/reload", async (_req, reply) => {
    try {
      await registry.load(config.providersFile);
      return view();
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/system", async () => ({
    providersReady: registry.list().length,
    providersDegraded: registry.list().filter((p) => p.degraded).map((p) => p.id),
    maxAgents: instanceSettings().maxAgents ?? config.maxAgents,
  }));
}
