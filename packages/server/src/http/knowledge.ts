import type { FastifyInstance, FastifyReply } from "fastify";
import type { AgentManager } from "../agents/manager.js";
import { getInstanceMetadata } from "../instance/metadata.js";

/**
 * People-facing knowledge-graph access: positions, grants, and the search
 * over entities one owns (for picking what to grant). Pass-through to
 * graph-rag with the instance's own token (the person, not an agent);
 * graph-rag owns the tree and enforces every rule.
 */
export async function registerKnowledgeRoutes(app: FastifyInstance, manager: AgentManager): Promise<void> {
  const target = () => {
    const values = getInstanceMetadata()?.values as Record<string, { token?: unknown }> | undefined;
    const token = typeof values?.graph?.token === "string" ? values.graph.token : undefined;
    const mcpUrl = manager.mcpServerUrl("graph-rag") ?? process.env.GWARESTRIN_GRAPH_MCP_URL;
    return token && mcpUrl ? { token, base: mcpUrl } : null;
  };

  const proxy = async (reply: FastifyReply, path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}) => {
    const t = target();
    if (!t) return reply.code(409).send({ error: "this workspace has no knowledge graph" });
    try {
      const res = await fetch(new URL(path, t.base), {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${t.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      return reply.code(res.status).headers({ "content-type": "application/json" }).send(text);
    } catch (err) {
      return reply.code(502).send({ error: `graph unreachable: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  app.get("/api/positions", async (_req, reply) => {
    if (!target()) return reply.send({ scoped: false, held: [], positions: [], tree: [] });
    return proxy(reply, "/api/positions");
  });
  app.get("/api/grants", async (_req, reply) => proxy(reply, "/api/grants"));
  app.post("/api/grants", async (req, reply) => proxy(reply, "/api/grants", { method: "POST", body: req.body ?? {} }));
  app.post("/api/grants/:id/revoke", async (req, reply) => {
    const { id } = req.params as { id: string };
    return proxy(reply, `/api/grants/${encodeURIComponent(id)}/revoke`, { method: "POST", body: {} });
  });
  app.get("/api/knowledge/entities", async (req, reply) => {
    const q = String((req.query as { q?: string }).q ?? "").slice(0, 80);
    return proxy(reply, `/api/entities?q=${encodeURIComponent(q)}`);
  });
}
