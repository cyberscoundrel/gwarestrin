import type { FastifyInstance } from "fastify";
import { mcpServerDefSchema, type McpServerDef } from "@gwarestrin/shared";
import { Value } from "typebox/value";
import type { McpRegistryStore } from "../mcp/registry-store.js";

const nameRe = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export async function registerMcpRoutes(app: FastifyInstance, registry: McpRegistryStore): Promise<void> {
  app.get("/api/mcp", async () => ({ servers: registry.list() }));

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
