import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { modelKey } from "@gwarestrin/shared";
import { getInstanceMetadata } from "../instance/metadata.js";
import type { ProviderRegistry } from "../providers/registry.js";

/**
 * Workspaces (instances) of the organization and their settings: a
 * pass-through to the provisioner's operations API. Only an instance whose
 * metadata carries the operations credential (values.ops, issued to
 * admin-tier instances; never substituted into agent config) can use it.
 */
export async function registerInstanceRoutes(app: FastifyInstance, registry: ProviderRegistry): Promise<void> {
  const ops = () => {
    const v = (getInstanceMetadata()?.values as Record<string, { token?: unknown; url?: unknown }> | undefined)?.ops;
    return typeof v?.token === "string" && typeof v?.url === "string" ? { token: v.token, url: v.url.replace(/\/+$/, "") } : null;
  };
  /** the person making the change, for the provisioner's log */
  const actor = (req: FastifyRequest) => {
    const h = req.headers["x-authentik-username"];
    return (Array.isArray(h) ? h[0] : h) ?? getInstanceMetadata()?.owner?.displayName ?? "unknown";
  };
  const proxy = async (reply: FastifyReply, req: FastifyRequest, path: string, method: "GET" | "PUT", body?: unknown) => {
    const o = ops();
    if (!o) return reply.code(404).send({ error: "this workspace doesn't manage the organization's workspaces" });
    try {
      const res = await fetch(`${o.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${o.token}`,
          "x-gw-actor": actor(req),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      return reply.code(res.status).headers({ "content-type": "application/json" }).send(await res.text());
    } catch (err) {
      return reply.code(502).send({ error: `provisioner unreachable: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  app.get("/api/instances", async (req, reply) => {
    if (!ops()) return reply.send({ enabled: false, instances: [] });
    return proxy(reply, req, "/instances", "GET");
  });
  // what each tool connection is for (the organization's words; every workspace's agents get them)
  app.put("/api/instances/connections", async (req, reply) => proxy(reply, req, "/connections", "PUT", req.body ?? {}));

  // Models: every model the providers offer, with the organization's labels.
  // Only labeled models run agents (in every workspace), so this is where an
  // admin admits a model, and says what tier it is and where its prompts go.
  app.get("/api/models/catalog", async (_req, reply) => {
    if (!ops()) return reply.code(404).send({ error: "only the organization's admins label models" });
    const labels = getInstanceMetadata()?.models ?? {};
    const seen = new Set<string>();
    const providers = registry.list().map((p) => ({
      id: p.id,
      description: p.description ?? null,
      tier: p.tier,
      degraded: p.degraded,
      models: p.models.map((m) => {
        const key = modelKey(p.id, m.id);
        seen.add(key);
        return { key, id: m.id, name: m.name, contextWindow: m.contextWindow, source: m.source, label: labels[key] ?? null };
      }),
    }));
    // labeled, but no provider offers it right now (renamed, removed, or the provider is down)
    const missing = Object.entries(labels)
      .filter(([k]) => !seen.has(k))
      .map(([key, label]) => ({ key, label }));
    return { enforced: getInstanceMetadata()?.models !== undefined, providers, missing };
  });
  app.put("/api/models/labels", async (req, reply) => proxy(reply, req, "/models", "PUT", req.body ?? {}));
  app.put("/api/instances/:name/settings", async (req, reply) => {
    const { name } = req.params as { name: string };
    return proxy(reply, req, `/instances/${encodeURIComponent(name)}/settings`, "PUT", req.body ?? {});
  });
}
