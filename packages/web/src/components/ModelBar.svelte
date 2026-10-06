<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../lib/stores.svelte.js";
  import { getAdapter } from "../lib/rpc-agent-adapter.js";
  import { ws } from "../lib/ws-client.js";
  import { isFreeModelId, modelDisplayName, whereItRuns } from "../lib/format.js";
  import type { ModelInfo } from "../lib/agent-types.js";
  import Dropdown from "./Dropdown.svelte";
  import Icon from "./Icon.svelte";
  import { Check, Cloud, Cpu, Server } from "lucide";

  let { agentId }: { agentId: string } = $props();

  const adapter = $derived(getAdapter(agentId));
  const record = $derived(store.agents.find((a) => a.id === agentId));

  let models = $state<ModelInfo[]>([]);
  let thinkingLevels = $state<string[]>(["off"]);
  let currentModel = $state<{ provider: string; modelId: string } | null>(null);
  let currentThinking = $state<string>("off");
  let openModel = $state(false);
  // picker filter: hundreds of cloud models, paid and free mixed
  let modelQuery = $state("");
  let freeOnly = $state(false);

  function focusOnMount(el: HTMLInputElement): void {
    el.focus();
  }

  // a fresh search each time the picker opens (the free-only choice sticks)
  $effect(() => {
    if (!openModel) modelQuery = "";
  });
  let busy = $state(false);
  let error = $state<string | null>(null);
  let stats = $state<{ context?: { tokens?: number | null; percent?: number | null } } | null>(null);

  // the adapter's state is not reactive (plain class field), so we mirror the
  // bits we display into local state on adapter events
  function syncFromAdapter(): void {
    if (adapter.state.model) {
      currentModel = { provider: adapter.state.model.provider, modelId: adapter.state.model.id };
    }
    currentThinking = adapter.state.thinkingLevel;
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
    // one group per place the model runs: "On-prem" first, then
    // "Cloud: <provider>" so the vendor that sees the prompts is explicit
    const byWhere = new Map<string, { local: boolean; list: ModelInfo[] }>();
    const q = modelQuery.trim().toLowerCase();
    const shown = models.filter(
      (m) =>
        (!q || m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q)) &&
        (!freeOnly || isFreeModelId(m.id)),
    );
    for (const m of shown) {
      const where = whereItRuns(m.provider, store.providers);
      const group = byWhere.get(where.label) ?? { local: where.tier === "local", list: [] };
      group.list.push(m);
      byWhere.set(where.label, group);
    }
    return [...byWhere.entries()]
      .sort(([, a], [, b]) => Number(b.local) - Number(a.local))
      .map(([label, g]) => [label, g.list] as const);
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

<div class="modelbar-root flex min-w-0 flex-1 flex-wrap items-center gap-2 py-1 text-sm max-sm:flex-nowrap">
  <button
    class="select-compact inline-flex max-w-[min(18rem,100%)] items-center gap-1.5 font-mono text-2xs"
    title={effectiveModel ? `${effectiveModel.provider}/${effectiveModel.modelId}` : undefined}
    aria-haspopup="listbox"
    aria-expanded={openModel}
    aria-label="model: {effectiveModel ? modelDisplayName(effectiveModel.provider, effectiveModel.modelId, store.providers) : 'none'}"
    disabled={busy}
    onclick={() => (openModel = !openModel)}
  >
    <Icon icon={Cpu} size={13} class="text-faint" />
    <span class="truncate">
      {effectiveModel ? modelDisplayName(effectiveModel.provider, effectiveModel.modelId, store.providers) : "No model"}
    </span>
  </button>

  {#if thinkingLevels.length > 1 || currentThinking !== "off"}
    <Dropdown
      compact
      label="thinking"
      value={currentThinking}
      options={thinkingLevels.map((l) => ({ value: l, label: l === "off" ? "No thinking" : `Think: ${l}` }))}
      onchange={(l) => void chooseThinking(l)}
      disabled={busy}
    />
  {/if}

  {#if error}
    <span class="max-w-48 truncate text-xs text-err" title={error}>{error}</span>
  {/if}

  {#if pct !== null && tok !== null}
    <!-- context window meter: quiet until it matters -->
    <span
      class="tabular ml-auto inline-flex items-center gap-2 font-mono text-2xs whitespace-nowrap max-sm:hidden {pct > 80 ? 'text-warn' : 'text-faint'}"
      title="Context window used by this conversation"
    >
      <span class="h-1 w-12 overflow-hidden rounded-full bg-edge" aria-hidden="true">
        <span class="block h-full rounded-full {pct > 80 ? 'bg-warn' : 'bg-faint'}" style="width: {Math.min(100, Math.max(2, pct))}%"></span>
      </span>
      {Math.round(pct)}% · {(tok / 1000).toFixed(1)}k
    </span>
  {:else}
    <span class="ml-auto"></span>
  {/if}
</div>

{#if openModel}
  <div
    class="modelbar-root animate-pop absolute z-30 mt-1 flex max-h-96 w-[24rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border
      border-edge2 bg-panel2 shadow-overlay"
  >
    {#if models.length > 8}
      <div class="flex items-center gap-2 border-b border-edge p-2">
        <input
          class="input h-7"
          placeholder="Filter {models.length} models"
          aria-label="filter models"
          bind:value={modelQuery}
          use:focusOnMount
          onkeydown={(e) => {
            const first = grouped[0]?.[1][0];
            if (e.key === "Enter" && first) void chooseModel(first.provider, first.id);
          }}
        />
        {#if models.some((m) => isFreeModelId(m.id))}
          <label class="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-dim">
            <input type="checkbox" class="accent-signal" bind:checked={freeOnly} />
            Free only
          </label>
        {/if}
      </div>
    {/if}
    <div class="min-h-0 overflow-y-auto p-1" role="listbox" aria-label="models">
      {#if models.length === 0}
        <p class="m-0 px-3 py-6 text-center text-sm text-faint">No models yet. The agent may still be starting.</p>
      {:else if grouped.length === 0}
        <p class="m-0 px-3 py-6 text-center text-sm text-faint">No models match.</p>
      {:else}
        {#each grouped as [where, list]}
          <div class="flex items-center gap-1.5 px-2 pt-2.5 pb-1">
            <Icon icon={where === "On-prem" ? Server : Cloud} size={12} class={where === "On-prem" ? "text-signal" : "text-warn"} />
            <span class="eyebrow">{where}</span>
            <span class="tabular ml-auto text-2xs text-faint">{list.length}</span>
          </div>
          {#each list as m (m.provider + m.id)}
            {@const selected = effectiveModel?.provider === m.provider && effectiveModel?.modelId === m.id}
            <button
              class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
              role="option"
              aria-selected={selected}
              title="{m.provider}/{m.id}"
              onclick={() => void chooseModel(m.provider, m.id)}
            >
              <span class="w-3.5 shrink-0">{#if selected}<Icon icon={Check} size={14} class="text-signal" />{/if}</span>
              <!-- same label as the button and rail (no raw file paths) -->
              <span class="min-w-0 flex-1 truncate text-sm {selected ? 'text-fg' : 'text-dim'}">
                {m.name && m.name !== m.id ? m.name : modelDisplayName(m.provider, m.id, store.providers)}
              </span>
              {#if isFreeModelId(m.id)}<span class="shrink-0 text-2xs text-ok">free</span>{/if}
              {#if m.reasoning}<span class="shrink-0 text-2xs text-faint">reasoning</span>{/if}
            </button>
          {/each}
        {/each}
      {/if}
    </div>
  </div>
{/if}
