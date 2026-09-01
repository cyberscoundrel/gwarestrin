import type { FastifyInstance } from "fastify";
import { mcpServerDefSchema, type McpServerDef } from "@gwarestrin/shared";
import { Value } from "typebox/value";
import type { McpRegistryStore } from "../mcp/registry-store.js";

const nameRe = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export async function registerMcpRoutes(app: FastifyInstance, registry: McpRegistryStore): Promise<void> {
  app.get("/api/mcp", async () => ({ servers: registry.list() }));

  // liveness probe per registry server: any HTTP response (even 4xx) means
  // the endpoint is up; network/timeout errors mean it is not. stdio servers
  // have no url and report reachable: null.
  app.get("/api/mcp/status", async () => {
    const entries = Object.entries(registry.list());
    const servers = await Promise.all(
      entries.map(async ([name, def]) => {
        if (!def.url) return { name, reachable: null };
        const started = Date.now();
        try {
          const res = await fetch(def.url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "gwarestrin-probe", version: "0.0.0" },
              },
            }),
            signal: AbortSignal.timeout(4000),
          });
          return { name, reachable: res.status < 500, httpStatus: res.status, ms: Date.now() - started };
        } catch {
          return { name, reachable: false, ms: Date.now() - started };
        }
      }),
    );
    return { servers };
  });

  app.put("/api/mcp/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!nameRe.test(name)) return reply.code(400).send({ error: "invalid server name" });
    if (!Value.Check(mcpServerDefSchema, req.body)) {
      return reply.code(400).send({ error: "invalid server definition" });
    }
    try {
      await registry.put(name, req.body as McpServerDef);
      return { servers: registry.list() };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/mcp/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const removed = await registry.remove(name);
    if (!removed) return reply.code(404).send({ error: "not found" });
    return { servers: registry.list() };
  });
}
