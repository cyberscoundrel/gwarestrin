<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../lib/stores.svelte.js";
  import { getAdapter } from "../lib/rpc-agent-adapter.js";
  import { ws } from "../lib/ws-client.js";
  import { modelDisplayName } from "../lib/format.js";
  import type { ModelInfo } from "../lib/agent-types.js";
  import Dropdown from "./Dropdown.svelte";

  let { agentId }: { agentId: string } = $props();

  const adapter = $derived(getAdapter(agentId));
  const record = $derived(store.agents.find((a) => a.id === agentId));

  let models = $state<ModelInfo[]>([]);
  let thinkingLevels = $state<string[]>(["off"]);
  let currentModel = $state<{ provider: string; modelId: string } | null>(null);
  let currentThinking = $state<string>("off");
  let openModel = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let streaming = $state(false);
  let stats = $state<{ context?: { tokens?: number | null; percent?: number | null } } | null>(null);

  // the adapter's state is not reactive (plain class field), so we mirror the
  // bits we display into local state on adapter events
  function syncFromAdapter(): void {
    if (adapter.state.model) {
      currentModel = { provider: adapter.state.model.provider, modelId: adapter.state.model.id };
    }
    currentThinking = adapter.state.thinkingLevel;
    streaming = Boolean(adapter.state.isStreaming);
  }

  function stopAgent(): void {
    streaming = false;
    adapter.abort();
  }

  $effect(() => {
    // record is the declared model; don't clobber a live adapter-provided one
    if (!adapter.state.model) currentModel = record?.model ?? null;
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
    currentModel = record?.model ?? null;
    currentThinking = "off";
    void refreshAll();
    const off = adapter.subscribe(() => syncFromAdapter());
    syncFromAdapter();
    return off;
  });

  // close the model dropdown on outside click / escape
  $effect(() => {
    if (!openModel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") openModel = false;
    };
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("main .modelbar-root")) openModel = false;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
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
    error = null;
    try {
      await adapter.setModel(provider, modelId);
      const { api } = await import("../lib/api.js");
      // persist the choice on the agent record
      await api.patchAgent(agentId, { model: { provider, modelId } });
      await store.refreshAgents();
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
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
    // tier grouping (local first) — cloud providers collapse into one group
    const tierOf = (providerId: string): "local" | "cloud" =>
      store.providers.find((p) => p.id === providerId)?.tier ?? "cloud";
    const byTier = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const tier = tierOf(m.provider);
      const list = byTier.get(tier) ?? [];
      list.push(m);
      byTier.set(tier, list);
    }
    return [...byTier.entries()].sort(([a], [b]) => (a === "local" ? -1 : b === "local" ? 1 : 0));
  });

  const pct = $derived(stats?.context?.percent ?? null);
  const tok = $derived(stats?.context?.tokens ?? null);
  // display chain: live adapter model → declared record model → server default
  const effectiveModel = $derived(
    currentModel ??
      (store.defaultProvider && store.defaultModel
        ? { provider: store.defaultProvider, modelId: store.defaultModel }
        : null),
  );
</script>

<div class="modelbar-root flex flex-1 flex-wrap items-center gap-2 py-1.5 text-sm">
  <button
    class="select-compact max-w-64 truncate"
    title={effectiveModel ? `${effectiveModel.provider}/${effectiveModel.modelId}` : undefined}
    disabled={busy}
    onclick={() => (openModel = !openModel)}
  >
    {effectiveModel ? modelDisplayName(effectiveModel.provider, effectiveModel.modelId, store.providers) : "no model"}
  </button>

  {#if thinkingLevels.length > 1 || currentThinking !== "off"}
    <Dropdown
      compact
      value={currentThinking}
      options={thinkingLevels.map((l) => ({ value: l, label: l === "off" ? "no thinking" : `think ${l}` }))}
      onchange={(l) => void chooseThinking(l)}
      disabled={busy}
    />
  {/if}

  {#if error}
    <span class="max-w-48 truncate text-xs text-err" title={error}>{error}</span>
  {/if}

  {#if pct !== null && tok !== null}
    <span class="ml-auto whitespace-nowrap text-xs {pct > 80 ? 'text-warn' : 'text-muted'}" title="context window usage">
      ctx {Math.round(pct)}% ({(tok / 1000).toFixed(1)}k)
    </span>
  {:else}
    <span class="ml-auto"></span>
  {/if}

  {#if streaming}
    <button
      class="select-compact bg-none pr-2 !border-err !text-err animate-pulse"
      title="interrupt the agent"
      onclick={stopAgent}
    >
      stop
    </button>
  {/if}
</div>

{#if openModel}
  <div class="modelbar-root absolute z-30 mt-1 max-h-96 w-80 overflow-y-auto rounded-lg border border-edge2 bg-panel2 shadow-xl">
    {#if models.length === 0}
      <p class="px-3 py-2 text-sm text-muted">no models (agent not running?)</p>
    {:else}
      {#each grouped as [tier, list]}
        <div class="px-3 pt-2 text-xs font-semibold tracking-wide text-muted">{tier === "local" ? "local" : "cloud"}</div>
        {#each list as m (m.id)}
          <button
            class="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-[#1a1d26]
              {effectiveModel?.provider === m.provider && effectiveModel?.modelId === m.id ? 'text-accent' : 'text-fg'}"
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
