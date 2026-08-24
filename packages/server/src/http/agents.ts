import type { FastifyInstance } from "fastify";
import type { CreateAgentInput, PatchAgentInput } from "@gwarestrin/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentManager } from "../agents/manager.js";
import type { ServerConfig } from "../config.js";

const createAgentSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64 }),
    model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
    providers: Type.Optional(Type.Array(Type.String())),
    enabledModels: Type.Optional(Type.Array(Type.String())),
    thinkingLevel: Type.Optional(Type.String()),
    mcpServers: Type.Optional(Type.Array(Type.String())),
    gondolin: Type.Optional(Type.Object({})),
  },
  { additionalProperties: false },
);

const patchAgentSchema = Type.Object({}, { additionalProperties: true });

export async function registerAgentRoutes(app: FastifyInstance, config: ServerConfig, manager: AgentManager): Promise<void> {
  app.get("/api/agents", async () => {
    const summaries = new Map(manager.listSummaries().map((s) => [s.id, s]));
    return {
      agents: manager.store.list().map((r) => ({
        ...r,
        runtime: summaries.get(r.id) ?? { id: r.id, status: r.status },
      })),
    };
  });

  app.post("/api/agents", async (req, reply) => {
    if (!Value.Check(createAgentSchema, req.body)) {
      return reply.code(400).send({ error: "invalid create payload" });
    }
    try {
      const record = await manager.createAgent(req.body as CreateAgentInput);
      return reply.code(201).send({ agent: record });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = manager.store.get(id);
    if (!record) return reply.code(404).send({ error: "not found" });
    const running = manager.getRunning(id);
    return { agent: { ...record, runtime: running?.summary() ?? { id, status: record.status } } };
  });

  app.patch("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!Value.Check(patchAgentSchema, req.body)) {
      return reply.code(400).send({ error: "invalid patch payload" });
    }
    try {
      const record = await manager.patchAgent(id, req.body as PatchAgentInput);
      return { agent: record };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const purge = (req.query as { purge?: string }).purge === "true";
    try {
      await manager.deleteAgent(id, purge);
      return reply.code(204).send();
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  for (const action of ["start", "stop", "restart", "new-session"] as const) {
    app.post(`/api/agents/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        if (action === "start") return { runtime: await manager.start(id) };
        if (action === "stop") {
          await manager.stop(id);
          return { runtime: { id, status: "stopped" as const } };
        }
        if (action === "restart") return { runtime: await manager.restart(id) };
        // new-session: stop + clear sessionFile + start
        await manager.stop(id);
        manager.store.setSessionFile(id, null);
        return { runtime: await manager.start(id) };
      } catch (err) {
        return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  app.get("/api/agents/:id/models", async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = manager.getRunning(id);
    if (!agent) return reply.code(409).send({ error: "agent not running" });
    const res = await agent.send("get_available_models");
    return { models: (res.data as { models?: unknown[] } | undefined)?.models ?? [], success: res.success };
  });

  app.get("/api/agents/:id/state", async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = manager.getRunning(id);
    if (!agent) return reply.code(409).send({ error: "agent not running" });
    const res = await agent.send("get_state");
    return res;
  });

  app.get("/api/agents/:id/stats", async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = manager.getRunning(id);
    if (!agent) return reply.code(409).send({ error: "agent not running" });
    const res = await agent.send("get_session_stats");
    return res;
  });
}
