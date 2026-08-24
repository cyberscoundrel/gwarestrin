import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import { AgentManager } from "./agents/manager.js";
import { AgentStore } from "./agents/store.js";
import { loadConfig } from "./config.js";
import { registerAgentRoutes } from "./http/agents.js";
import { registerProviderRoutes } from "./http/providers.js";
import { ProviderRegistry } from "./providers/registry.js";
import { scoped } from "./util/log.js";
import { registerWs } from "./ws/connection.js";

const log = scoped("server");

async function main(): Promise<void> {
  const config = loadConfig();
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024 * 1024,
  });

  const registry = new ProviderRegistry();
  await registry.load(config.providersFile).catch((err) => {
    log.error("provider registry load failed", err);
    // continue with whatever loaded; first-party only
  });

  const store = new AgentStore(config.stateDir);
  await store.load();

  const manager = new AgentManager(config, registry, store);

  app.get("/api/health", async () => ({
    status: "ok",
    service: "gwarestrin",
    version: process.env.npm_package_version ?? "0.1.0",
    time: new Date().toISOString(),
  }));

  await registerProviderRoutes(app, config, registry);
  await registerAgentRoutes(app, config, manager);
  await registerWs(app, config, manager);

  if (existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: "/",
    });
    app.setNotFoundHandler(async (req, reply) => {
      // SPA fallback: serve index.html for non-API paths
      if (!req.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
    log.info(`serving web bundle from ${config.webDistDir}`);
  } else {
    log.info("no web bundle found; API-only mode");
  }

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    await manager.stopAll().catch(() => {});
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });
  log.info(`listening on ${config.host}:${config.port} (state: ${path.resolve(config.stateDir)})`);
  log.info(
    `providers: ${registry.list().map((p) => `${p.id}${p.degraded ? " (degraded)" : ""}`).join(", ") || "none"}`,
  );
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
