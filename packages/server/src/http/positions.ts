import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agents/manager.js";
import { getInstanceMetadata } from "../instance/metadata.js";

/**
 * Knowledge-graph positions this instance's user reaches (theirs and below):
 * what an agent profile may place its agents at. Pass-through to graph-rag
 * with the instance token; graph-rag owns the tree and enforces it.
 */
export async function registerPositionRoutes(app: FastifyInstance, manager: AgentManager): Promise<void> {
  app.get("/api/positions", async (_req, reply) => {
    const values = getInstanceMetadata()?.values as Record<string, { token?: unknown }> | undefined;
    const token = typeof values?.graph?.token === "string" ? values.graph.token : undefined;
    const mcpUrl = manager.mcpServerUrl("graph-rag") ?? process.env.GWARESTRIN_GRAPH_MCP_URL;
    if (!token || !mcpUrl) return reply.send({ scoped: false, held: [], positions: [] });
    try {
      const res = await fetch(new URL("/api/positions", mcpUrl), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      return reply.code(res.status).headers({ "content-type": "application/json" }).send(text);
    } catch (err) {
      return reply.code(502).send({ error: `graph unreachable: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
