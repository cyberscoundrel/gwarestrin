import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getInstanceMetadata } from "../instance/metadata.js";

/**
 * Workspaces (instances) of the organization and their settings: a
 * pass-through to the provisioner's operations API. Only an instance whose
 * metadata carries the operations credential (values.ops, issued to
 * admin-tier instances; never substituted into agent config) can use it.
 */
export async function registerInstanceRoutes(app: FastifyInstance): Promise<void> {
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
  app.put("/api/instances/:name/settings", async (req, reply) => {
    const { name } = req.params as { name: string };
    return proxy(reply, req, `/instances/${encodeURIComponent(name)}/settings`, "PUT", req.body ?? {});
  });
}
