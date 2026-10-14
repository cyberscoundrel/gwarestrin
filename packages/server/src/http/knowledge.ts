import type { FastifyInstance, FastifyReply } from "fastify";
import type { AgentManager } from "../agents/manager.js";
import { getInstanceMetadata } from "../instance/metadata.js";

/**
 * People-facing knowledge-graph access: positions, grants, and the search
 * over entities one owns (for picking what to grant). Pass-through to
 * graph-rag with the instance's own token (the person, not an agent);
 * graph-rag owns the tree and enforces every rule.
 */
/** graph-rag as this instance's own person (not an agent); null when the workspace has no knowledge graph */
export async function graphRag(manager: AgentManager, path: string, init: { method?: "GET" | "PUT" | "POST"; body?: unknown } = {}): Promise<{ status: number; body: unknown } | null> {
  const values = getInstanceMetadata()?.values as Record<string, { token?: unknown }> | undefined;
  const token = typeof values?.graph?.token === "string" ? values.graph.token : undefined;
  const base = manager.mcpServerUrl("graph-rag") ?? process.env.GWARESTRIN_GRAPH_MCP_URL;
  if (!token || !base) return null;
  const res = await fetch(new URL(path, base), {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** only the organization's root may configure the graph worker (graph-rag decides) */
export async function canSetGraphWorker(manager: AgentManager): Promise<boolean> {
  return (await graphRag(manager, "/api/worker").catch(() => null))?.status === 200;
}

/**
 * Push the Graph worker profile (model + instructions) to graph-rag, or clear
 * it when no profile holds the role any more. Only the root's instance can.
 */
export async function syncGraphWorker(manager: AgentManager): Promise<{ error?: string }> {
  try {
    const current = await graphRag(manager, "/api/worker");
    if (current?.status !== 200) return {};
    const p = manager.profiles.graphWorker();
    const had = (current.body as { profile?: string | null }).profile;
    if (!p && !had) return {};
    const r = await graphRag(manager, "/api/worker", {
      method: "PUT",
      body: p ? { profile: p.name, model: p.graphWorker?.model ?? "", instructions: p.instructions ?? "", enabled: true } : { profile: null, model: "", instructions: "" },
    });
    return r?.status === 200 ? {} : { error: `graph-rag didn't take the graph worker settings (${r?.status ?? "unreachable"})` };
  } catch (e) {
    return { error: `graph-rag unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function registerKnowledgeRoutes(app: FastifyInstance, manager: AgentManager): Promise<void> {
  const target = () => {
    const values = getInstanceMetadata()?.values as Record<string, { token?: unknown }> | undefined;
    const token = typeof values?.graph?.token === "string" ? values.graph.token : undefined;
    const mcpUrl = manager.mcpServerUrl("graph-rag") ?? process.env.GWARESTRIN_GRAPH_MCP_URL;
    return token && mcpUrl ? { token, base: mcpUrl } : null;
  };

  const proxy = async (reply: FastifyReply, path: string, init: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {}) => {
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
  // a share one of this person's agents proposed (the chat's confirmation card)
  app.get("/api/grants/proposals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    return proxy(reply, `/api/grants/proposals/${encodeURIComponent(id)}`);
  });
  app.post("/api/grants/proposals/:id/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    return proxy(reply, `/api/grants/proposals/${encodeURIComponent(id)}/confirm`, { method: "POST", body: req.body ?? {} });
  });
  app.post("/api/grants/proposals/:id/decline", async (req, reply) => {
    const { id } = req.params as { id: string };
    return proxy(reply, `/api/grants/proposals/${encodeURIComponent(id)}/decline`, { method: "POST", body: {} });
  });
  // requests for access: the asker's card, and the owners' side in Shared access
  app.get("/api/requests", async (_req, reply) => proxy(reply, "/api/requests"));
  app.get("/api/requests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    return proxy(reply, `/api/requests/${encodeURIComponent(id)}`);
  });
  for (const action of ["confirm", "withdraw", "answer", "dismiss"] as const) {
    app.post(`/api/requests/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      return proxy(reply, `/api/requests/${encodeURIComponent(id)}/${action}`, { method: "POST", body: action === "answer" ? (req.body ?? {}) : {} });
    });
  }
  // the organization's data-scoping policy (graph-rag lets only a root person change it)
  app.get("/api/policy", async (_req, reply) => proxy(reply, "/api/policy"));
  app.put("/api/policy", async (req, reply) => proxy(reply, "/api/policy", { method: "PUT", body: req.body ?? {} }));
  // the graph worker's backlog and settings (root only), the models it can use, a backfill
  app.get("/api/graph-worker", async (_req, reply) => proxy(reply, "/api/worker"));
  app.get("/api/graph-worker/models", async (_req, reply) => proxy(reply, "/api/worker/models"));
  app.post("/api/graph-worker/backfill", async (_req, reply) => proxy(reply, "/api/worker/backfill", { method: "POST", body: {} }));
  // the worker pool: its settings, its threads (audit), and what waits on the admin
  app.put("/api/graph-worker/pool", async (req, reply) => proxy(reply, "/api/worker", { method: "PUT", body: { pool: req.body ?? {} } }));
  app.get("/api/graph-worker/threads", async (_req, reply) => proxy(reply, "/api/worker/threads"));
  app.post("/api/graph-worker/survey", async (req, reply) => proxy(reply, "/api/worker/survey", { method: "POST", body: req.body ?? {} }));
  app.get("/api/graph-worker/questions", async (req, reply) => {
    const status = (req.query as { status?: string }).status;
    return proxy(reply, `/api/worker/questions${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  });
  app.post("/api/graph-worker/questions/answer", async (req, reply) => proxy(reply, "/api/worker/questions/answer", { method: "POST", body: req.body ?? {} }));
  app.get("/api/graph-worker/proposals", async (_req, reply) => proxy(reply, "/api/worker/proposals"));
  app.post("/api/graph-worker/proposals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    return proxy(reply, `/api/worker/proposals/${encodeURIComponent(id)}`, { method: "POST", body: req.body ?? {} });
  });
  // what pruning removed (graph-rag shows it only to the root), and pruning now
  app.get("/api/pruned", async (_req, reply) => proxy(reply, "/api/pruned"));
  app.post("/api/pruned/run", async (_req, reply) => proxy(reply, "/api/pruned/run", { method: "POST", body: {} }));
  app.get("/api/knowledge/entities", async (req, reply) => {
    const q = String((req.query as { q?: string }).q ?? "").slice(0, 80);
    return proxy(reply, `/api/entities?q=${encodeURIComponent(q)}`);
  });
}
