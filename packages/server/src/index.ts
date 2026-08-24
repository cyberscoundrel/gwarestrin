import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { scoped } from "./util/log.js";

const log = scoped("server");

async function main(): Promise<void> {
  const config = loadConfig();
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024 * 1024,
  });

  app.get("/api/health", async () => ({
    status: "ok",
    service: "gwarestrin",
    version: process.env.npm_package_version ?? "0.1.0",
    time: new Date().toISOString(),
  }));

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
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });
  log.info(`listening on ${config.host}:${config.port} (state: ${path.resolve(config.stateDir)})`);
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
