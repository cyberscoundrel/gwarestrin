import type { FastifyInstance, FastifyReply } from "fastify";
import { getInstanceMetadata } from "../instance/metadata.js";
import { resolveMetadataPath } from "@gwarestrin/shared";

/**
 * Review-panel proxy for queued graph writes. Thin pass-through to the
 * graph-rag queue HTTP surface using the instance's identity token (from
 * instance metadata) — the panel itself stays a dumb client and graph-rag
 * enforces the approve capability.
 */
export async function registerGraphQueueRoutes(app: FastifyInstance): Promise<void> {
  const queueConfig = () => {
    const md = getInstanceMetadata();
    const queue = md?.presentation?.queue;
    if (!queue) return null;
    const token = resolveMetadataPath(md, queue.tokenRef);
    if (typeof token !== "string" || !token) return null;
    return { url: queue.url.replace(/\/+$/, ""), label: queue.label ?? "graph write approvals", token };
  };

  const proxy = async (instance: FastifyReply, path: string, method: "GET" | "POST") => {
    const cfg = queueConfig();
    if (!cfg) return instance.code(404).send({ error: "no queue surface configured" });
    const res = await fetch(`${cfg.url}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    return instance.code(res.status).headers({ "content-type": "application/json" }).send(text);
  };

  app.get("/api/graph-queue", async (_req, reply) => {
    const cfg = queueConfig();
    if (!cfg) return reply.send({ enabled: false });
    return proxy(reply, "", "GET");
  });
  app.post("/api/graph-queue/approve", async (req, reply) => {
    const { id } = (req.body ?? {}) as { id?: string };
    if (!id) return reply.code(400).send({ error: "id required" });
    return proxy(reply, `/${encodeURIComponent(id)}/approve`, "POST");
  });
  app.post("/api/graph-queue/reject", async (req, reply) => {
    const { id } = (req.body ?? {}) as { id?: string };
    if (!id) return reply.code(400).send({ error: "id required" });
    return proxy(reply, `/${encodeURIComponent(id)}/reject`, "POST");
  });
}
