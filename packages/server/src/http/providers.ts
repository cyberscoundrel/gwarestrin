import type { FastifyInstance } from "fastify";
import { instanceSettings, providerAllowed } from "../instance/settings.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ServerConfig } from "../config.js";

export async function registerProviderRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  registry: ProviderRegistry,
): Promise<void> {
  // only the providers this workspace allows (instance settings)
  const view = () => {
    const providers = registry.list().filter((p) => providerAllowed(p.id));
    const defaultProvider = registry.defaultProvider && providerAllowed(registry.defaultProvider) ? registry.defaultProvider : (providers[0]?.id ?? null);
    return { providers, defaultProvider, defaultModel: defaultProvider === registry.defaultProvider ? registry.defaultModel : (providers[0]?.models[0]?.id ?? null) };
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
