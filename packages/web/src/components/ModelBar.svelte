<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../lib/stores.svelte.js";
  import { getAdapter } from "../lib/rpc-agent-adapter.js";
  import { ws } from "../lib/ws-client.js";
  import { modelDisplayName } from "../lib/format.js";
  import type { ModelInfo } from "../lib/agent-types.js";

  let { agentId }: { agentId: string } = $props();

  const adapter = $derived(getAdapter(agentId));
  const record = $derived(store.agents.find((a) => a.id === agentId));

  let models = $state<ModelInfo[]>([]);
  let thinkingLevels = $state<string[]>(["off"]);
  let currentModel = $state<{ provider: string; modelId: string } | null>(null);
  let currentThinking = $state<string>("off");
  let openModel = $state(false);
  let busy = $state(false);
  let stats = $state<{ context?: { tokens?: number | null; percent?: number | null } } | null>(null);

  $effect(() => {
    currentModel = record?.model ?? null;
  });

  $effect(() => {
    // sync from adapter state after bootstrap/stream
    if (adapter.state.model) {
      currentModel = { provider: adapter.state.model.provider, modelId: adapter.state.model.id };
    }
    currentThinking = adapter.state.thinkingLevel;
  });

  async function refresh(): Promise<void> {
    try {
      const res = (await ws.rpc(agentId, "get_session_stats")) as {
        data?: { contextUsage?: { tokens?: number | null; percent?: number | null } };
      };
      stats = res.data?.contextUsage ? { context: res.data.contextUsage } : null;
    } catch {
      /* agent not running */
    }
  }

  async function refreshAll(): Promise<void> {
    void refresh();
    try {
      models = await adapter.availableModels();
      thinkingLevels = await adapter.availableThinkingLevels();
    } catch {
      /* agent not running */
    }
  }

  // re-runs on mount AND when the tab switches (ChatView reuses this
  // component, so onMount alone would leave the previous agent's stats)
  $effect(() => {
    void agentId;
    stats = null;
    void refreshAll();
  });

  onMount(() => {
    // keep the context meter live: refresh after each turn + slow poll
    const off = ws.onMessage((msg) => {
      if (msg.agentId !== agentId || msg.kind !== "event") return;
      if (msg.event.type === "agent_settled" || msg.event.type === "turn_end") void refresh();
    });
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      off();
      clearInterval(timer);
    };
  });

  async function chooseModel(provider: string, modelId: string): Promise<void> {
    openModel = false;
    busy = true;
    try {
      await adapter.setModel(provider, modelId);
      const { api } = await import("../lib/api.js");
      // persist the choice on the agent record
      await api.patchAgent(agentId, { model: { provider, modelId } });
      await store.refreshAgents();
      await refresh();
    } catch {
      /* surfaced via agent error state */
    } finally {
      busy = false;
    }
  }

  async function chooseThinking(level: string): Promise<void> {
    busy = true;
    try {
      await adapter.setThinkingLevel(level);
      currentThinking = level;
    } finally {
      busy = false;
    }
  }

  const grouped = $derived.by(() => {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return [...byProvider.entries()];
  });

  const pct = $derived(stats?.context?.percent ?? null);
  const tok = $derived(stats?.context?.tokens ?? null);
</script>

<div class="flex flex-wrap items-center gap-2 py-1.5 text-sm">
  <button
    class="max-w-64 truncate rounded border border-edge2 bg-transparent px-2 py-0.5 text-fg hover:border-accent disabled:opacity-50"
    title={currentModel ? `${currentModel.provider}/${currentModel.modelId}` : undefined}
    disabled={busy}
    onclick={() => (openModel = !openModel)}
  >
    {currentModel ? modelDisplayName(currentModel.provider, currentModel.modelId, store.providers) : "no model"}
    <span class="ml-1 text-muted">▾</span>
  </button>

  {#if thinkingLevels.length > 1 || currentThinking !== "off"}
    <select
      class="rounded border border-edge2 bg-bg px-1.5 py-0.5 text-xs text-muted hover:text-fg disabled:opacity-50"
      disabled={busy}
      value={currentThinking}
      onchange={(e) => void chooseThinking(e.currentTarget.value)}
      title="thinking level"
    >
      {#each thinkingLevels as l}
        <option value={l}>{l === "off" ? "no thinking" : `think ${l}`}</option>
      {/each}
    </select>
  {/if}

  {#if pct !== null && tok !== null}
    <span class="ml-auto whitespace-nowrap text-xs {pct > 80 ? 'text-warn' : 'text-muted'}" title="context window usage">
      ctx {Math.round(pct)}% ({(tok / 1000).toFixed(1)}k)
    </span>
  {:else}
    <span class="ml-auto"></span>
  {/if}
</div>

{#if openModel}
  <div class="absolute z-30 mt-1 max-h-96 w-80 overflow-y-auto rounded-lg border border-edge2 bg-panel2 shadow-xl">
    {#if models.length === 0}
      <p class="px-3 py-2 text-sm text-muted">no models (agent not running?)</p>
    {:else}
      {#each grouped as [provider, list]}
        <div class="px-3 pt-2 text-xs font-semibold tracking-wide text-muted">{provider}</div>
        {#each list as m (m.id)}
          <button
            class="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-[#1a1d26]
              {currentModel?.provider === m.provider && currentModel?.modelId === m.id ? 'text-accent' : 'text-fg'}"
            onclick={() => void chooseModel(m.provider, m.id)}
          >
            {m.name === m.id ? m.id : m.name}
            {#if m.reasoning}<span class="ml-1 text-xs text-muted">🧠</span>{/if}
          </button>
        {/each}
      {/each}
    {/if}
  </div>
{/if}
