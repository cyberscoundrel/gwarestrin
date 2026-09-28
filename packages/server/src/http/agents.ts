import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CreateAgentInput, PatchAgentInput, UpsertProfileInput } from "@gwarestrin/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentManager } from "../agents/manager.js";
import { dirsFor } from "../agents/scaffold.js";
import { runContextEngine, type ContextEngineInput } from "../analyze/engines.js";
import { getInstanceMetadata } from "../instance/metadata.js";
import type { ServerConfig } from "../config.js";
import { scoped } from "../util/log.js";

const log = scoped("agents-http");

const createAgentSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64 }),
    profileId: Type.Optional(Type.String({ minLength: 1 })),
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
      const record = await manager.createAgent({ ...input, profileId: input.profileId });
      const profile = manager.profiles.resolve(record.profileId);
      const engine = profile.contextEngine;

      // profile context engine: runs at agent creation time (blocking),
      // producing the standing context block the graph-context extension
      // injects on every turn. No engine configured = skipped.
      let context: "skipped" | "ok" | "failed" = "skipped";
      if (engine && (engine.prompt || input.firstPrompt)) {
        const llm = manager.defaultLlmEndpoint();
        const mcpUrl = manager.mcpServerUrl("graph-rag") ?? process.env.GWARESTRIN_GRAPH_MCP_URL ?? "http://graph-rag:8000/mcp";
        const values = getInstanceMetadata()?.values as Record<string, { token?: string }> | undefined;
        const graphToken = values?.graph?.token;
        if (!llm) {
          context = "failed";
          log.warn(`no llm endpoint for context engine (${record.name})`);
        } else {
          log.info(`running context engine '${engine.type}' for ${record.name}`);
          const engineInput: ContextEngineInput = {
            ...(input.firstPrompt ? { firstPrompt: input.firstPrompt } : {}),
            ...(engine.prompt ? { profilePrompt: engine.prompt } : {}),
            agentName: record.name,
          };
          const result = await runContextEngine(
            { ...engine, includeFirstPrompt: engine.includeFirstPrompt ?? true },
            engineInput,
            { llm: { llmUrl: llm.url, llmKey: llm.key, model: llm.model }, mcpUrl, ...(graphToken ? { mcpToken: graphToken } : {}) },
          );
          context = result.status;
          if (result.status === "ok" && result.block) {
            const dirs = dirsFor(config.stateDir, record);
            await writeFile(path.join(dirs.home, "context-injection.md"), result.block + "\n", "utf8");
            log.info(`context injected for ${record.name} (${result.block.length} chars)`);
          } else if (result.detail) {
            log.warn(`context engine ${engine.type} for ${record.name}: ${result.detail}`);
          }
        }
      }
      if (record.contextStatus === undefined) {
        record.contextStatus = context;
        manager.store.setContextStatus(record.id, context);
      }

      const runtime = await manager.start(record.id);
      return reply.code(201).send({ agent: record, runtime, analysis: context });
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

  /** debug: the standing context generated for this agent at creation */
  app.get("/api/agents/:id/context", async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = manager.store.get(id);
    if (!record) return reply.code(404).send({ error: "not found" });
    const profile = manager.profiles.resolve(record.profileId);
    const dirs = dirsFor(config.stateDir, record);
    const block = await readFile(path.join(dirs.home, "context-injection.md"), "utf8").catch(() => null);
    return {
      agentId: id,
      profileId: profile.id,
      profileName: profile.name,
      engine: profile.contextEngine ?? null,
      status: record.contextStatus ?? (block ? "ok" : "skipped"),
      block,
    };
  });

  // ---------- agent profiles ----------

  const upsertProfileSchema = Type.Object(
    {
      name: Type.String({ minLength: 1, maxLength: 64 }),
      description: Type.Optional(Type.String({ maxLength: 500 })),
      defaults: Type.Optional(
        Type.Object({
          tier: Type.Optional(Type.String()),
          model: Type.Optional(Type.Union([Type.Object({ provider: Type.String(), modelId: Type.String() }), Type.Null()])),
          thinkingLevel: Type.Optional(Type.String()),
          namePrefix: Type.Optional(Type.String({ maxLength: 32 })),
        }),
      ),
      mcpServers: Type.Union([Type.Array(Type.String()), Type.Literal("all")]),
      contextEngine: Type.Optional(
        Type.Object({
          type: Type.String(),
          prompt: Type.Optional(Type.String({ maxLength: 4000 })),
          includeFirstPrompt: Type.Optional(Type.Boolean()),
          maxRounds: Type.Optional(Type.Number()),
          timeoutMs: Type.Optional(Type.Number()),
          maxChars: Type.Optional(Type.Number()),
        }),
      ),
      sharedTools: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );

  app.get("/api/profiles", async () => {
    return { profiles: manager.profiles.list() };
  });

  app.get("/api/profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const profile = manager.profiles.get(id);
    if (!profile) return reply.code(404).send({ error: "not found" });
    return { profile };
  });

  app.put("/api/profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!Value.Check(upsertProfileSchema, req.body)) {
      return reply.code(400).send({ error: "invalid profile payload" });
    }
    const profile = manager.profiles.upsert(id === "new" ? undefined : id, req.body as UpsertProfileInput);
    return { profile };
  });

  app.delete("/api/profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const removed = manager.profiles.remove(id);
      if (!removed) return reply.code(404).send({ error: "not found" });
      return { removed: removed.id };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
