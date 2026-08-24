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
  async createAgent(input: {
    name: string;
    model?: { provider: string; modelId: string } | null;
    mcpServers?: string[];
  }): Promise<AgentWithRuntime> {
    const r = await json<{ agent: AgentWithRuntime }>(
      await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    return r.agent;
  },
  async patchAgent(
    id: string,
    patch: Partial<{
      name: string;
      model: { provider: string; modelId: string } | null;
      providers: string[];
      enabledModels: string[];
      thinkingLevel: string;
      mcpServers: string[];
    }>,
  ): Promise<AgentWithRuntime> {
    const r = await json<{ agent: AgentWithRuntime }>(
      await fetch(`/api/agents/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
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

export interface FileEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: string;
  mode: number;
}

export const filesApi = {
  async list(agentId: string, path = ""): Promise<FileEntry[]> {
    const r = await json<{ entries: FileEntry[] }>(
      await fetch(`/api/agents/${agentId}/files?path=${encodeURIComponent(path)}`),
    );
    return r.entries;
  },
  downloadUrl(agentId: string, path: string): string {
    return `/api/agents/${agentId}/files/download?path=${encodeURIComponent(path)}`;
  },
  async upload(agentId: string, dir: string, files: FileList | File[]): Promise<void> {
    const fd = new FormData();
    for (const f of files) fd.append("file", f, f.name);
    const res = await fetch(`/api/agents/${agentId}/files/upload?path=${encodeURIComponent(dir)}`, {
      method: "POST",
      body: fd,
    });
    await json(res);
  },
  async remove(agentId: string, path: string): Promise<void> {
    const res = await fetch(`/api/agents/${agentId}/files?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    if (res.status !== 204) await json(res);
  },
  async mkdir(agentId: string, path: string): Promise<void> {
    const res = await fetch(`/api/agents/${agentId}/files/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    await json(res);
  },
};

export interface McpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  bearerTokenEnv?: string;
  description?: string;
  disabled?: boolean;
}

export const mcpApi = {
  async list(): Promise<Record<string, McpServerDef>> {
    const r = await json<{ servers: Record<string, McpServerDef> }>(await fetch("/api/mcp"));
    return r.servers;
  },
  async put(name: string, def: McpServerDef): Promise<Record<string, McpServerDef>> {
    const r = await json<{ servers: Record<string, McpServerDef> }>(
      await fetch(`/api/mcp/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(def),
      }),
    );
    return r.servers;
  },
  async remove(name: string): Promise<Record<string, McpServerDef>> {
    const r = await json<{ servers: Record<string, McpServerDef> }>(
      await fetch(`/api/mcp/${encodeURIComponent(name)}`, { method: "DELETE" }),
    );
    return r.servers;
  },
};
