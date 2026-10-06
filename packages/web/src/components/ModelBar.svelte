<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../lib/stores.svelte.js";
  import { getAdapter } from "../lib/rpc-agent-adapter.js";
  import { ws } from "../lib/ws-client.js";
  import { isFreeModelId, modelDisplayName, whereItRuns } from "../lib/format.js";
  import type { ModelInfo } from "../lib/agent-types.js";
  import Dropdown from "./Dropdown.svelte";
  import Icon from "./Icon.svelte";
  import { Cpu } from "lucide";

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
    class="modelbar-root animate-pop absolute z-30 mt-1 flex max-h-96 w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border
      border-edge2 bg-panel2 shadow-overlay"
  >
    {#if models.length > 8}
      <div class="flex items-center gap-2 border-b border-edge p-1.5">
        <input
          class="min-w-0 flex-1 rounded border border-edge2 bg-bg px-2 py-1 text-sm text-fg outline-none focus:border-signal"
          placeholder="type to filter ({models.length})"
          aria-label="filter models"
          bind:value={modelQuery}
          use:focusOnMount
          onkeydown={(e) => {
            const first = grouped[0]?.[1][0];
            if (e.key === "Enter" && first) void chooseModel(first.provider, first.id);
          }}
        />
        {#if models.some((m) => isFreeModelId(m.id))}
          <label class="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-dim">
            <input type="checkbox" bind:checked={freeOnly} />
            free only
          </label>
        {/if}
      </div>
    {/if}
    <div class="min-h-0 overflow-y-auto">
    {#if models.length === 0}
      <p class="px-3 py-2 text-sm text-dim">no models (agent not running?)</p>
    {:else if grouped.length === 0}
      <p class="px-3 py-2 text-sm text-dim">no matches</p>
    {:else}
      {#each grouped as [where, list]}
        <div class="px-3 pt-2 text-xs font-semibold tracking-wide text-dim">{where}</div>
        {#each list as m (m.id)}
          <button
            class="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-hover
              {effectiveModel?.provider === m.provider && effectiveModel?.modelId === m.id ? 'text-signal' : 'text-fg'}"
            title="{m.provider}/{m.id}"
            onclick={() => void chooseModel(m.provider, m.id)}
          >
            <!-- same label as the button and rail (no raw file paths) -->
            {m.name && m.name !== m.id ? m.name : modelDisplayName(m.provider, m.id, store.providers)}
            {#if m.reasoning}<span class="ml-1 text-xs text-dim">reasoning</span>{/if}
          </button>
        {/each}
      {/each}
    {/if}
    </div>
  </div>
{/if}
