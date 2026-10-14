<script lang="ts">
  import { onMount } from "svelte";
  import { Cloud, Cpu, Server, TriangleAlert } from "lucide";
  import type { ModelHosting, ModelTier } from "@gwarestrin/shared";
  import { api, type LabelInput, type ModelCatalog } from "../lib/api.js";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import PanelHeader from "./PanelHeader.svelte";
  import SkeletonRows from "./SkeletonRows.svelte";

  let { onclose }: { onclose: () => void } = $props();

  // Only labeled models run agents, in every workspace. A label says how
  // capable the model is (tier) and where its prompts go (hosting).
  const TIERS: Array<{ id: ModelTier; label: string; hint: string }> = [
    { id: "basic", label: "Basic", hint: "short, simple work: classifying, extracting" },
    { id: "standard", label: "Standard", hint: "everyday agent work with tools" },
    { id: "frontier", label: "Frontier", hint: "long, open-ended work across many tools" },
  ];
  const HOSTING: Array<{ id: ModelHosting; label: string }> = [
    { id: "on-prem", label: "On-prem" },
    { id: "private-cloud", label: "Private cloud" },
    { id: "public-api", label: "Public API" },
  ];
  const PAGE = 40;

  let catalog = $state<ModelCatalog | null>(null);
  let loadError = $state("");
  // key -> the edited label (null = no label)
  let drafts = $state<Record<string, LabelInput | null>>({});
  let query = $state("");
  let shown = $state<Record<string, number>>({});
  let busy = $state(false);
  let message = $state("");
  let error = $state("");

  const saved = (key: string): LabelInput | null => {
    for (const p of catalog?.providers ?? []) {
      const m = p.models.find((x) => x.key === key);
      if (m) return m.label ? { tier: m.label.tier, hosting: m.label.hosting, notes: m.label.notes ?? "" } : null;
    }
    const gone = catalog?.missing.find((x) => x.key === key);
    return gone ? { tier: gone.label.tier, hosting: gone.label.hosting, notes: gone.label.notes ?? "" } : null;
  };
  const same = (a: LabelInput | null, b: LabelInput | null) =>
    a === b || (!!a && !!b && a.tier === b.tier && a.hosting === b.hosting && (a.notes ?? "").trim() === (b.notes ?? "").trim());

  async function load(): Promise<void> {
    loadError = "";
    try {
      catalog = await api.modelCatalog();
      drafts = {};
      for (const p of catalog.providers) for (const m of p.models) drafts[m.key] = saved(m.key);
      for (const g of catalog.missing) drafts[g.key] = saved(g.key);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }
  onMount(() => void load());

  const changes = $derived(Object.entries(drafts).filter(([k, v]) => !same(v, saved(k))));
  const removals = $derived(changes.filter(([, v]) => v === null).length);
  const labeledCount = $derived(Object.values(drafts).filter(Boolean).length);

  function setTier(key: string, tier: ModelTier | null, providerTier: "local" | "cloud"): void {
    if (tier === null) {
      drafts[key] = null;
      return;
    }
    const cur = drafts[key];
    // a new label starts from where the provider runs; the admin can change it
    drafts[key] = cur ? { ...cur, tier } : { tier, hosting: providerTier === "local" ? "on-prem" : "public-api", notes: "" };
  }

  /** labeled first, then the rest; filtered by the search */
  function visible(p: ModelCatalog["providers"][number]) {
    const q = query.trim().toLowerCase();
    const match = (m: { id: string; name: string }) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
    const all = p.models.filter(match);
    const labeled = all.filter((m) => drafts[m.key] || saved(m.key));
    const rest = all.filter((m) => !(drafts[m.key] || saved(m.key)));
    return { labeled, rest, total: all.length };
  }

  async function save(): Promise<void> {
    busy = true;
    error = "";
    message = "";
    try {
      await api.saveModelLabels(Object.fromEntries(changes.map(([k, v]) => [k, v ? { tier: v.tier, hosting: v.hosting, notes: (v.notes ?? "").trim() } : null])));
      message = removals
        ? "Saved. Agents using a model that lost its label stop within seconds; they can be switched to a labeled model."
        : "Saved. Every workspace applies it within seconds.";
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
  const when = (at?: string) => (at ? new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
</script>

{#snippet row(key: string, id: string, name: string, providerTier: "local" | "cloud", by?: string, at?: string)}
  {@const d = drafts[key]}
  <li class="grid gap-2 rounded-md border px-3 py-2.5 {d ? 'border-edge2 bg-panel' : 'border-edge bg-bg'}">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div class="min-w-0 flex-1">
        <span class="block truncate text-sm {d ? 'text-fg' : 'text-dim'}" title={key}>{name}</span>
        {#if name !== id}<span class="block truncate font-mono text-2xs text-faint">{id}</span>{/if}
      </div>
      <div class="segmented" role="group" aria-label="tier for {key}">
        <button type="button" aria-pressed={!d} title="Not labeled: agents can't use it" onclick={() => setTier(key, null, providerTier)}>None</button>
        {#each TIERS as t (t.id)}
          <button type="button" aria-pressed={d?.tier === t.id} title={t.hint} onclick={() => setTier(key, t.id, providerTier)}>{t.label}</button>
        {/each}
      </div>
    </div>
    {#if d}
      <div class="flex flex-wrap items-center gap-2">
        <div class="segmented" role="group" aria-label="where prompts go for {key}">
          {#each HOSTING as h (h.id)}
            <button type="button" aria-pressed={d.hosting === h.id} onclick={() => (d.hosting = h.id)}>{h.label}</button>
          {/each}
        </div>
        <input class="input min-w-40 flex-1 text-xs" maxlength="500" placeholder="Notes: data terms, quirks (optional)" aria-label="notes for {key}" bind:value={d.notes} />
      </div>
      {#if by && same(d, saved(key))}
        <span class="text-2xs text-faint">Labeled by {by}{at ? ` · ${when(at)}` : ""}</span>
      {/if}
    {/if}
  </li>
{/snippet}

<Dialog {onclose} labelledby="models-title" width="52rem" dismissible={!busy}>
  <PanelHeader
    id="models-title"
    title="Models"
    subtitle="Only labeled models can run agents, in every workspace. A label says how capable a model is and where its prompts go."
    icon={Cpu}
    {onclose}
  />

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if loadError}
      <div class="mx-5 mt-4 flex items-start gap-2 rounded-md border border-err/30 bg-err-soft px-3 py-2 text-xs text-err" role="alert">
        <Icon icon={TriangleAlert} size={14} class="mt-px" />
        {loadError}
      </div>
    {:else if !catalog}
      <SkeletonRows rows={4} />
    {:else}
      <div class="grid gap-4 p-5">
        {#if !catalog.enforced}
          <p class="m-0 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
            Labels aren't enforced yet: any model can run agents. Once you save labels the first time, only labeled models can, in every workspace. Label the models people use now first, or their agents stop.
          </p>
        {:else if labeledCount === 0}
          <p class="m-0 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">No model is labeled, so no agent can start. Label at least one.</p>
        {/if}
        <div class="grid gap-1 text-xs text-faint">
          {#each TIERS as t (t.id)}<span><span class="text-dim">{t.label}</span>: {t.hint}.</span>{/each}
        </div>
        <input class="input" type="search" placeholder="Find a model" aria-label="find a model" bind:value={query} />

        {#each catalog.providers as p (p.id)}
          {@const v = visible(p)}
          {#if v.total > 0}
            <section class="grid gap-2">
              <div class="flex items-center gap-1.5">
                <Icon icon={p.tier === "local" ? Server : Cloud} size={12} class={p.tier === "local" ? "text-signal" : "text-warn"} />
                <span class="eyebrow">{p.id}</span>
                {#if p.description}<span class="truncate text-2xs text-faint">{p.description}</span>{/if}
                {#if p.degraded}<span class="text-2xs text-warn">unreachable: models may be missing</span>{/if}
                <span class="tabular ml-auto text-2xs text-faint">{v.labeled.length} labeled · {p.models.length} offered</span>
              </div>
              <ul class="m-0 grid list-none gap-1.5 p-0">
                {#each v.labeled as m (m.key)}
                  {@render row(m.key, m.id, m.name, p.tier, m.label?.by, m.label?.at)}
                {/each}
                {#each v.rest.slice(0, shown[p.id] ?? (query.trim() ? PAGE : 0)) as m (m.key)}
                  {@render row(m.key, m.id, m.name, p.tier)}
                {/each}
              </ul>
              {#if v.rest.length > (shown[p.id] ?? (query.trim() ? PAGE : 0))}
                <button class="btn btn-ghost btn-sm justify-self-start" onclick={() => (shown[p.id] = (shown[p.id] ?? (query.trim() ? PAGE : 0)) + PAGE)}>
                  Show {Math.min(PAGE, v.rest.length - (shown[p.id] ?? (query.trim() ? PAGE : 0)))} more unlabeled of {v.rest.length}
                </button>
              {/if}
            </section>
          {/if}
        {/each}

        {#if catalog.missing.length}
          <section class="grid gap-2">
            <span class="eyebrow">Labeled, but no provider offers it now</span>
            <span class="text-xs text-faint">Renamed, removed, or its provider is unreachable. The label stays until you remove it.</span>
            <ul class="m-0 grid list-none gap-1.5 p-0">
              {#each catalog.missing as g (g.key)}
                {@render row(g.key, g.key, g.key, "cloud", g.label.by, g.label.at)}
              {/each}
            </ul>
          </section>
        {/if}
      </div>
    {/if}
  </div>

  {#if catalog}
    <div class="flex shrink-0 flex-wrap items-center gap-3 border-t border-edge px-5 py-3">
      {#if error}
        <span class="text-xs text-err" role="alert">{error}</span>
      {:else if message}
        <span class="text-xs text-dim" role="status">{message}</span>
      {:else if changes.length}
        <span class="flex items-center gap-1.5 text-xs text-dim">
          <span class="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true"></span>
          {changes.length} unsaved {changes.length === 1 ? "change" : "changes"}{removals ? ` (${removals} removed: agents using ${removals === 1 ? "it" : "them"} stop)` : ""}
        </span>
      {/if}
      <span class="ml-auto"></span>
      <button class="btn btn-ghost btn-sm" disabled={busy || !changes.length} onclick={() => void load()}>Undo</button>
      <button class="btn btn-primary btn-sm" disabled={busy || !changes.length} onclick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
    </div>
  {/if}
</Dialog>
