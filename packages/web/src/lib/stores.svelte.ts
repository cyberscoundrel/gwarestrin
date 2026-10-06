import { getAdapter } from "./rpc-agent-adapter.js";
import { ws } from "./ws-client.js";
import type { AgentEvent } from "./agent-types.js";
import type { AgentRuntimeSummary, ProfileRecord } from "@gwarestrin/shared";
import { SvelteMap, SvelteSet } from "svelte/reactivity";

export interface AgentListItem {
  id: string;
  name: string;
  status: string;
  model: { provider: string; modelId: string } | null;
  mcpServers: string[];
  profileId: string;
  /** whether a briefing was built at create time (absent on older records) */
  contextStatus?: "skipped" | "ok" | "failed" | undefined;
  /** sandbox network allow-list from the agent record (egress fact for the trust strip) */
  allowedHosts?: string[] | undefined;
  unread: number;
}

// last agent this browser opened (per-browser convenience; storage may be
// unavailable in private windows, so every access is guarded)
const SELECTED_AGENT_KEY = "gwarestrin.selectedAgentId";

function readRememberedAgent(): string | null {
  try {
    return localStorage.getItem(SELECTED_AGENT_KEY);
  } catch {
    return null;
  }
}

export function rememberAgent(id: string | null): void {
  try {
    if (id) localStorage.setItem(SELECTED_AGENT_KEY, id);
    else localStorage.removeItem(SELECTED_AGENT_KEY);
  } catch {
    /* storage unavailable: selection just isn't remembered */
  }
}

class Store {
  agents = $state<AgentListItem[]>([]);
  profiles = $state<ProfileRecord[]>([]);
  selectedId = $state<string | null>(null);
  /** profile being edited in the main area (null = chat view) */
  editingProfileId = $state<string | null>(null);
  /** centered create view (greeting + composer) */
  showNewChat = $state(false);
  wsStatus = $state<string>("closed");
  providers = $state<import("@gwarestrin/shared").ProviderView[]>([]);
  mcpServers = $state<Record<string, unknown>>({});
  defaultProvider = $state<string | null>(null);
  defaultModel = $state<string | null>(null);
  private runtime = new SvelteMap<string, AgentRuntimeSummary>();
  /** the remembered agent is restored once, on the first agent list load */
  private initialSelectionDone = false;
  private working = new SvelteSet<string>();

  /** an agent turn is currently in flight */
  isWorking(id: string): boolean {
    return this.working.has(id);
  }

  /** extension status text per agent (e.g. "sandbox: running"), shown in its header */
  private statusLines = new SvelteMap<string, string>();

  statusLineFor(id: string): string {
    return this.statusLines.get(id) ?? "";
  }

  setStatusLine(id: string, text: string): void {
    if (text) this.statusLines.set(id, text);
    else this.statusLines.delete(id);
  }
  private unreadListeners = new Set<() => void>();

  constructor() {
    ws.onStatus((s) => (this.wsStatus = s));
    ws.onMessage((msg) => {
      if (msg.kind === "agent_state") {
        this.runtime.set(msg.state.id, msg.state);
        this.syncAgentStatus(msg.state.id);
      }
      // "working" = an agent turn is in flight (drives the only looping
      // animation in the UI, so it must clear as soon as the turn settles)
      if (msg.kind === "event") {
        const t = msg.event.type;
        if (t === "agent_start") this.working.add(msg.agentId);
        else if (t === "agent_settled" || t === "agent_end") this.working.delete(msg.agentId);
      }
      if (msg.kind === "agent_state" && msg.state.status !== "running") this.working.delete(msg.state.id);
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
      this.editingProfileId = null;
      this.showNewChat = false;
      rememberAgent(id);
    }
    if (id) {
      const a = this.agents.find((x) => x.id === id);
      if (a) {
        a.unread = 0;
        for (const l of this.unreadListeners) l();
      }
    }
  }

  editProfile(id: string | null): void {
    this.editingProfileId = id;
    if (id) {
      this.selectedId = null;
      this.showNewChat = false;
    }
  }

  /** agents grouped under a profile id */
  agentsInProfile(profileId: string): AgentListItem[] {
    return this.agents.filter((a) => (a.profileId || "default") === profileId);
  }

  async refreshProfiles(): Promise<void> {
    const { api } = await import("./api.js");
    try {
      this.profiles = await api.listProfiles();
    } catch {
      /* ignore */
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
        profileId: a.profileId ?? "default",
        contextStatus: a.contextStatus,
        allowedHosts: a.gondolin?.allowedHosts,
        unread: this.agents.find((x) => x.id === a.id)?.unread ?? 0,
      }));
      for (const a of agents) if (a.runtime) this.runtime.set(a.id, a.runtime);
      // first load only: reopen the agent this browser last picked, if it
      // still exists. Otherwise stay on the composer - never auto-select
      // some other agent (often someone else's, stopped, with a big "start").
      const remembered = readRememberedAgent();
      if (remembered && !this.agents.some((a) => a.id === remembered)) rememberAgent(null);
      if (!this.initialSelectionDone) {
        this.initialSelectionDone = true;
        if (!this.selectedId && !this.showNewChat && !this.editingProfileId && remembered) {
          if (this.agents.some((a) => a.id === remembered)) this.select(remembered);
        }
      }
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
