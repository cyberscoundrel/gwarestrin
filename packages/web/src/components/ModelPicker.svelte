<script lang="ts">
  import { Check, ChevronDown, Cloud, Cpu, Server } from "lucide";
  import { store } from "../lib/stores.svelte.js";
  import { isFreeModelId, modelDisplayName, whereItRuns } from "../lib/format.js";
  import Icon from "./Icon.svelte";

  type ModelRef = { provider: string; modelId: string };

  // One control for tier + provider + model: a grouped list ("On-prem",
  // "Cloud: <provider>") with type-to-filter and a free-only toggle.
  let {
    value,
    onchange,
    noneLabel,
    label = "model",
    align = "left",
  }: {
    value: ModelRef | null;
    onchange: (v: ModelRef | null) => void;
    /** offer an explicit "no choice" row, e.g. "Workspace default" */
    noneLabel?: string | undefined;
    label?: string;
    align?: "left" | "right";
  } = $props();

  let open = $state(false);
  let query = $state("");
  let freeOnly = $state(false);
  let root: HTMLElement;

  const where = $derived(value ? whereItRuns(value.provider, store.providers) : null);
  const anyFree = $derived(store.providers.some((p) => p.models.some((m) => isFreeModelId(m.id))));

  const groups = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return [...store.providers]
      .sort((a, b) => Number(b.tier === "local") - Number(a.tier === "local"))
      .map((p) => ({
        provider: p,
        label: whereItRuns(p.id, store.providers).label,
        local: p.tier === "local",
        models: p.models.filter(
          (m) =>
            (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) && (!freeOnly || isFreeModelId(m.id)),
        ),
      }))
      .filter((g) => g.models.length > 0);
  });
  const total = $derived(store.providers.reduce((n, p) => n + p.models.length, 0));

  function choose(v: ModelRef | null): void {
    open = false;
    query = "";
    onchange(v);
  }

  function focusOnMount(el: HTMLInputElement): void {
    el.focus();
  }

  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open = false;
    };
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !root.contains(e.target)) open = false;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  });
</script>

<div class="relative inline-block max-w-full" bind:this={root}>
  <button
    type="button"
    class="inline-flex h-8 max-w-full cursor-pointer items-center gap-2 rounded-md border border-edge2 bg-panel px-2.5 text-sm text-fg transition-colors
      hover:border-faint {open ? 'border-faint' : ''}"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label="{label}: {value ? modelDisplayName(value.provider, value.modelId, store.providers) : (noneLabel ?? 'none')}"
    onclick={() => (open = !open)}
  >
    <Icon icon={Cpu} size={14} class="text-faint" />
    <span class="truncate">{value ? modelDisplayName(value.provider, value.modelId, store.providers) : (noneLabel ?? "Choose a model")}</span>
    {#if where}
      <span
        class="shrink-0 rounded px-1.5 py-px text-2xs {where.tier === 'local' ? 'bg-signal-soft text-signal' : 'bg-warn-soft text-warn'}"
      >
        {where.label}
      </span>
    {/if}
    <Icon icon={ChevronDown} size={13} class="shrink-0 text-faint" />
  </button>

  {#if open}
    <div
      class="animate-pop absolute {align === 'right' ? 'right-0' : 'left-0'} z-40 mt-1 flex max-h-96 w-[24rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden
        rounded-xl border border-edge2 bg-panel2 shadow-overlay"
    >
      <div class="flex items-center gap-2 border-b border-edge p-2">
        <input
          class="input h-7"
          placeholder="Filter {total} models"
          aria-label="filter models"
          bind:value={query}
          use:focusOnMount
          onkeydown={(e) => {
            const first = groups[0]?.models[0];
            if (e.key === "Enter" && first && groups[0]) {
              e.preventDefault();
              choose({ provider: groups[0].provider.id, modelId: first.id });
            }
          }}
        />
        {#if anyFree}
          <label class="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-dim">
            <input type="checkbox" class="accent-signal" bind:checked={freeOnly} />
            Free only
          </label>
        {/if}
      </div>
      <div class="min-h-0 overflow-y-auto p-1" role="listbox" aria-label="models">
        {#if noneLabel}
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-dim transition-colors hover:bg-hover"
            role="option"
            aria-selected={value === null}
            onclick={() => choose(null)}
          >
            <span class="w-3.5">{#if value === null}<Icon icon={Check} size={14} class="text-signal" />{/if}</span>
            {noneLabel}
          </button>
        {/if}
        {#each groups as g (g.provider.id)}
          <div class="flex items-center gap-1.5 px-2 pt-2.5 pb-1">
            <Icon icon={g.local ? Server : Cloud} size={12} class={g.local ? "text-signal" : "text-warn"} />
            <span class="eyebrow">{g.label}</span>
            <span class="tabular ml-auto text-2xs text-faint">{g.models.length}</span>
          </div>
          {#each g.models as m (m.id)}
            {@const selected = value?.provider === g.provider.id && value?.modelId === m.id}
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
              role="option"
              aria-selected={selected}
              title="{g.provider.id}/{m.id}"
              onclick={() => choose({ provider: g.provider.id, modelId: m.id })}
            >
              <span class="w-3.5 shrink-0">{#if selected}<Icon icon={Check} size={14} class="text-signal" />{/if}</span>
              <span class="min-w-0 flex-1 truncate text-sm {selected ? 'text-fg' : 'text-dim'}">
                {modelDisplayName(g.provider.id, m.id, store.providers)}
              </span>
              {#if isFreeModelId(m.id)}<span class="shrink-0 text-2xs text-ok">free</span>{/if}
              {#if m.reasoning}<span class="shrink-0 text-2xs text-faint">reasoning</span>{/if}
            </button>
          {/each}
        {:else}
          <p class="m-0 px-3 py-6 text-center text-sm text-faint">No models match.</p>
        {/each}
      </div>
    </div>
  {/if}
</div>
