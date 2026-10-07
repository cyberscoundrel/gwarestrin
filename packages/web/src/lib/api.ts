import type { AgentRecord, AgentRuntimeSummary, ModelView, ProfileRecord, ProviderView } from "@gwarestrin/shared";

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

export interface PositionView {
  id: string;
  name: string;
  parent: string | null;
  description?: string;
}
export interface PositionsView {
  /** false: the knowledge graph isn't divided into positions */
  scoped: boolean;
  root?: string;
  /** positions the user holds */
  held: string[];
  /** positions the user reaches (theirs and below) */
  positions: PositionView[];
  /** the whole tree's names (grants may go anywhere in it) */
  tree?: Array<{ id: string; name: string; parent: string | null }>;
  /** the user holds the root: may grant standing access */
  canGrantStanding?: boolean;
}

export interface OrgPolicy {
  maxGrantDays: number;
  defaultShareDays: number;
  standingGrants: "root" | "nobody";
  peopleShareDirectly: boolean;
  gradingEnabled: boolean;
  gradingConfidence: number;
  derivedWindowHours: number;
}

export interface PolicyView {
  policy: OrgPolicy;
  defaults: OrgPolicy;
  updated_by: string | null;
  updated_at: string | null;
  canEdit: boolean;
  history: Array<{ changed_at: string; changed_by: string; prev_json: string; next_json: string }>;
  infra: { scoped: boolean; positions: number; graderModel: string | null; embedModel: string };
}

export interface GrantView {
  id: string;
  kind: "entity" | "subtree";
  /** entity name, or the position whose branch is shared */
  target: string;
  target_home: string;
  to: string;
  reason: string;
  granted_by: string;
  expires_at: string | null;
  direction: "outgoing" | "incoming";
}

export interface NewGrant {
  entities?: Array<{ name: string; home?: string }>;
  subtree?: string;
  to: string;
  reason: string;
  until?: string;
}

/** per target: granted at once, or proposed (queued for a person to approve) */
export interface GrantResult {
  results: Array<{ target: string; to: string; granted?: boolean; proposed?: boolean; expires_at?: string | null }>;
}

export const api = {
  async me(): Promise<{ username: string; authed: boolean }> {
    return json(await fetch("/api/me"));
  },
  async listAgents(): Promise<AgentWithRuntime[]> {
    const r = await json<{ agents: AgentWithRuntime[] }>(await fetch("/api/agents"));
    return r.agents;
  },
  async createAgent(input: {
    name: string;
    profileId?: string;
    model?: { provider: string; modelId: string } | null;
    mcpServers?: string[];
    firstPrompt?: string;
  }): Promise<{ agent: AgentWithRuntime; runtime?: AgentRuntimeSummary; analysis?: string }> {
    return json(
      await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },
  exportUrl(id: string): string {
    return `/api/agents/${id}/export`;
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
  // ---------- knowledge-graph positions ----------
  /** positions this workspace's user reaches (theirs and below) */
  async positions(): Promise<PositionsView> {
    return json(await fetch("/api/positions"));
  },
  async policy(): Promise<PolicyView> {
    return json(await fetch("/api/policy"));
  },
  async savePolicy(changes: Partial<OrgPolicy>): Promise<{ policy: OrgPolicy }> {
    return json(await fetch("/api/policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(changes) }));
  },
  async grants(): Promise<{ grants: GrantView[]; canGrantStanding: boolean }> {
    return json(await fetch("/api/grants"));
  },
  async createGrant(input: NewGrant): Promise<GrantResult> {
    return json(
      await fetch("/api/grants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
    );
  },
  async revokeGrant(id: string): Promise<void> {
    await json(await fetch(`/api/grants/${encodeURIComponent(id)}/revoke`, { method: "POST" }));
  },
  /** entities the user owns (by home), for picking what to share */
  async ownedEntities(q: string): Promise<Array<{ name: string; home?: { id: string; name: string } }>> {
    const r = await json<{ entities: Array<{ name: string; home?: { id: string; name: string } }> }>(
      await fetch(`/api/knowledge/entities?q=${encodeURIComponent(q)}`),
    );
    return r.entities;
  },
  // ---------- agent profiles ----------
  async listProfiles(): Promise<ProfileRecord[]> {
    const r = await json<{ profiles: ProfileRecord[] }>(await fetch("/api/profiles"));
    return r.profiles;
  },
  async saveProfile(id: string, input: Partial<ProfileRecord> & { name: string; mcpServers: string[] | "all" }): Promise<ProfileRecord> {
    const r = await json<{ profile: ProfileRecord }>(
      await fetch(`/api/profiles/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    return r.profile;
  },
  async deleteProfile(id: string): Promise<void> {
    const res = await fetch(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) await json(res);
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
  /** liveness probe per registry server (server-side, so container-network urls work) */
  async status(): Promise<Record<string, { reachable: boolean | null; httpStatus?: number; ms?: number }>> {
    const r = await json<{ servers: Array<{ name: string; reachable: boolean | null; httpStatus?: number; ms?: number }> }>(
      await fetch("/api/mcp/status"),
    );
    return Object.fromEntries(r.servers.map((s) => [s.name, s]));
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
