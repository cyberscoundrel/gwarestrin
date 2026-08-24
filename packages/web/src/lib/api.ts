import type { AgentRecord, AgentRuntimeSummary, ModelView, ProviderView } from "@gwarestrin/shared";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface AgentWithRuntime extends AgentRecord {
  runtime?: AgentRuntimeSummary | undefined;
}

export const api = {
  async listAgents(): Promise<AgentWithRuntime[]> {
    const r = await json<{ agents: AgentWithRuntime[] }>(await fetch("/api/agents"));
    return r.agents;
  },
  async createAgent(input: { name: string; model?: { provider: string; modelId: string } | null }): Promise<AgentWithRuntime> {
    const r = await json<{ agent: AgentWithRuntime }>(
      await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    return r.agent;
  },
  async deleteAgent(id: string, purge: boolean): Promise<void> {
    const res = await fetch(`/api/agents/${id}?purge=${purge}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `delete failed: ${res.status}`);
    }
  },
  async startAgent(id: string): Promise<AgentRuntimeSummary> {
    const r = await json<{ runtime: AgentRuntimeSummary }>(await fetch(`/api/agents/${id}/start`, { method: "POST" }));
    return r.runtime;
  },
  async stopAgent(id: string): Promise<void> {
    await fetch(`/api/agents/${id}/stop`, { method: "POST" });
  },
  async providers(): Promise<{ providers: ProviderView[]; defaultProvider: string | null; defaultModel: string | null }> {
    return json(await fetch("/api/providers"));
  },
  async modelsFor(provider: ProviderView): Promise<ModelView[]> {
    return provider.models;
  },
};
