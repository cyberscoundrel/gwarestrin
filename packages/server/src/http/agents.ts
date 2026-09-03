import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CreateAgentInput, PatchAgentInput } from "@gwarestrin/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentManager } from "../agents/manager.js";
import { dirsFor } from "../agents/scaffold.js";
import { runAnalysisAgent } from "../analyze/analysis-agent.js";
import type { ServerConfig } from "../config.js";
import { scoped } from "../util/log.js";

const log = scoped("agents-http");

const createAgentSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64 }),
    model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
    providers: Type.Optional(Type.Array(Type.String())),
    enabledModels: Type.Optional(Type.Array(Type.String())),
    thinkingLevel: Type.Optional(Type.String()),
    mcpServers: Type.Optional(Type.Array(Type.String())),
    gondolin: Type.Optional(Type.Object({})),
    firstPrompt: Type.Optional(Type.String({ maxLength: 8000 })),
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
    const input = req.body as CreateAgentInput;
    try {
      const record = await manager.createAgent(input);

      // chat-first creation: pre-session graph analysis → context injection → start
      let analysis: "skipped" | "ok" | "failed" = "skipped";
      if (input.firstPrompt) {
        const llm = manager.defaultLlmEndpoint();
        const mcpUrl = manager.mcpServerUrl("neo4j") ?? process.env.GWARESTRIN_NEO4J_MCP_URL ?? "http://neo4j-mcp:8000/mcp/";
        const ragUrl = manager.mcpServerUrl("graph-rag") ?? process.env.GWARESTRIN_GRAPH_RAG_URL;
        if (llm) {
          log.info(`running pre-session analysis for ${record.name}`);
          const block = await runAnalysisAgent(input.firstPrompt, {
            llmUrl: llm.url,
            llmKey: llm.key,
            model: llm.model,
            mcpUrl,
            ...(ragUrl ? { ragUrl } : {}),
            timeoutMs: 90_000,
          });
          if (block) {
            const dirs = dirsFor(config.stateDir, record);
            await writeFile(path.join(dirs.home, "context-injection.md"), block + "\n", "utf8");
            analysis = "ok";
            log.info(`analysis injected for ${record.name} (${block.length} chars)`);
          } else {
            analysis = "failed";
          }
        }
        const runtime = await manager.start(record.id);
        return reply.code(201).send({ agent: record, runtime, analysis });
      }

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

  /** download the agent's conversation trace (newest session jsonl) */
  app.get("/api/agents/:id/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = manager.store.get(id);
    if (!record) return reply.code(404).send({ error: "not found" });
    const dirs = dirsFor(config.stateDir, record);
    let file: string | null = record.sessionFile ?? null;
    if (!file) {
      // fall back to the newest session jsonl on disk
      const entries = await readdir(dirs.sessions).catch(() => [] as string[]);
      const jsonls = entries.filter((f) => f.endsWith(".jsonl"));
      if (jsonls.length > 0) {
        const withMtime = await Promise.all(
          jsonls.map(async (f) => ({ f, m: (await stat(path.join(dirs.sessions, f))).mtimeMs })),
        );
        withMtime.sort((a, b) => b.m - a.m);
        file = path.join(dirs.sessions, withMtime[0]!.f);
      }
    }
    if (!file) return reply.code(404).send({ error: "no session trace yet" });
    const safe = record.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return reply
      .header("content-type", "application/jsonl")
      .header("content-disposition", `attachment; filename="${safe}-trace.jsonl"`)
      .send(createReadStream(file));
  });
}
