import type { FastifyInstance } from "fastify";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ServerConfig } from "../config.js";

export async function registerProviderRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  registry: ProviderRegistry,
): Promise<void> {
  app.get("/api/providers", async () => ({
    providers: registry.list(),
    defaultProvider: registry.defaultProvider,
    defaultModel: registry.defaultModel,
  }));

  app.put("/api/providers/reload", async (_req, reply) => {
    try {
      await registry.load(config.providersFile);
      return { providers: registry.list(), defaultProvider: registry.defaultProvider, defaultModel: registry.defaultModel };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/system", async () => ({
    providersReady: registry.list().length,
    providersDegraded: registry.list().filter((p) => p.degraded).map((p) => p.id),
    maxAgents: config.maxAgents,
    runningAgents: registry ? undefined : undefined,
  }));
}
