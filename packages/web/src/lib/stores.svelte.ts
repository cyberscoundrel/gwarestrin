import { getAdapter } from "./rpc-agent-adapter.js";
import { ws } from "./ws-client.js";
import type { AgentEvent } from "./agent-types.js";
import type { AgentRuntimeSummary } from "@gwarestrin/shared";
import { SvelteMap } from "svelte/reactivity";

export interface AgentListItem {
  id: string;
  name: string;
  status: string;
  model: { provider: string; modelId: string } | null;
  mcpServers: string[];
  unread: number;
}

class Store {
  agents = $state<AgentListItem[]>([]);
  selectedId = $state<string | null>(null);
  wsStatus = $state<string>("closed");
  providers = $state<import("@gwarestrin/shared").ProviderView[]>([]);
  defaultProvider = $state<string | null>(null);
  defaultModel = $state<string | null>(null);
  private runtime = new SvelteMap<string, AgentRuntimeSummary>();
  private unreadListeners = new Set<() => void>();

  constructor() {
    ws.onStatus((s) => (this.wsStatus = s));
    ws.onMessage((msg) => {
      if (msg.kind === "agent_state") {
        this.runtime.set(msg.state.id, msg.state);
        this.syncAgentStatus(msg.state.id);
      }
      if (msg.kind === "event" && msg.event.type !== "response") {
        this.bumpUnread(msg.agentId);
        // keep the selected agent's adapter fed (adapters also self-subscribe)
        void msg;
      }
    });
  }

  get selected(): AgentListItem | null {
    return this.agents.find((a) => a.id === this.selectedId) ?? null;
  }

  runtimeFor(id: string): AgentRuntimeSummary | undefined {
    return this.runtime.get(id);
  }

  onUnread(l: () => void): () => void {
    this.unreadListeners.add(l);
    return () => this.unreadListeners.delete(l);
  }

  select(id: string | null): void {
    this.selectedId = id;
    if (id) {
      const a = this.agents.find((x) => x.id === id);
      if (a) {
        a.unread = 0;
        for (const l of this.unreadListeners) l();
      }
    }
  }

  async refreshAgents(): Promise<void> {
    const { api } = await import("./api.js");
    try {
      const agents = await api.listAgents();
      this.agents = agents.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.runtime?.status ?? a.status,
        model: a.model,
        mcpServers: a.mcpServers,
        unread: this.agents.find((x) => x.id === a.id)?.unread ?? 0,
      }));
      for (const a of agents) if (a.runtime) this.runtime.set(a.id, a.runtime);
      if (!this.selectedId && this.agents.length > 0) this.selectedId = this.agents[0]!.id;
      for (const l of this.unreadListeners) l();
    } catch {
      /* server unreachable; ws will reconnect */
    }
  }

  async refreshProviders(): Promise<void> {
    const { api } = await import("./api.js");
    try {
      const r = await api.providers();
      this.providers = r.providers;
      this.defaultProvider = r.defaultProvider;
      this.defaultModel = r.defaultModel;
    } catch {
      /* ignore */
    }
  }

  adapterEvents(agentId: string): (l: (ev: AgentEvent) => void) => () => void {
    return (l) => getAdapter(agentId).subscribe(l);
  }

  private syncAgentStatus(id: string): void {
    const a = this.agents.find((x) => x.id === id);
    const rt = this.runtime.get(id);
    if (a && rt) {
      a.status = rt.status;
      for (const l of this.unreadListeners) l();
    }
  }

  private bumpUnread(agentId: string): void {
    const a = this.agents.find((x) => x.id === agentId);
    if (a && agentId !== this.selectedId) {
      a.unread++;
      for (const l of this.unreadListeners) l();
    }
  }
}

export const store = new Store();
