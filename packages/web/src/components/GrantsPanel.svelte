<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowRight, CalendarClock, CircleCheck, Plus, Search, Share2, TriangleAlert, X } from "lucide";
  import { api, type GrantView, type PositionsView } from "../lib/api.js";
  import Dialog from "./Dialog.svelte";
  import Dropdown from "./Dropdown.svelte";
  import EmptyState from "./EmptyState.svelte";
  import Icon from "./Icon.svelte";
  import PanelHeader from "./PanelHeader.svelte";
  import SkeletonRows from "./SkeletonRows.svelte";
  import Switch from "./Switch.svelte";

  let { onclose }: { onclose: () => void } = $props();

  // the organization's limits (Organization settings); defaults until loaded
  let maxDays = $state(90);
  let defaultDays = $state(14);

  let tree = $state<PositionsView | null>(null);
  let grants = $state<GrantView[]>([]);
  let loaded = $state(false);
  let error = $state("");
  let notice = $state("");
  let busyId = $state<string | null>(null);
  let view = $state<"list" | "new">("list");

  // ---- new grant form ----
  let what = $state<"entries" | "branch">("entries");
  let query = $state("");
  let found = $state<Array<{ name: string; home?: { id: string; name: string } }>>([]);
  let searching = $state(false);
  let picked = $state<Array<{ name: string; home?: { id: string; name: string } }>>([]);
  let branch = $state("");
  let to = $state("");
  let reason = $state("");
  let until = $state(dateIn(14));
  let standing = $state(false);
  let attempted = $state(false);
  let saving = $state(false);

  function dateIn(days: number): string {
    const d = new Date(Date.now() + days * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  async function refresh(): Promise<void> {
    error = "";
    try {
      tree = await api.positions();
      if (tree.scoped) grants = (await api.grants()).grants;
      const p = await api.policy().catch(() => null);
      if (p) {
        const fresh = maxDays === 90 && defaultDays === 14 && until === dateIn(14);
        maxDays = p.policy.maxGrantDays;
        defaultDays = p.policy.defaultShareDays;
        if (fresh) until = dateIn(defaultDays);
      }
      loaded = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  onMount(() => void refresh());

  // ---- position names as paths ("Operations › Production floor") ----
  const byId = $derived(new Map((tree?.tree ?? []).map((p) => [p.id, p])));
  function path(id: string): string {
    const parts: string[] = [];
    for (let cur = byId.get(id); cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
      if (cur.parent === null) break; // the root reads as "Whole organization"
      parts.unshift(cur.name);
    }
    return parts.length ? parts.join(" › ") : "Whole organization";
  }
  const sortedTree = $derived([...(tree?.tree ?? [])].sort((a, b) => path(a.id).localeCompare(path(b.id))));
  /** branches you can share: the positions you reach */
  const branchOptions = $derived(
    [...(tree?.positions ?? [])].map((p) => ({ value: p.id, label: path(p.id) })).sort((a, b) => a.label.localeCompare(b.label)),
  );
  /** anyone but the root (it already sees everything) */
  const toOptions = $derived(sortedTree.filter((p) => p.parent !== null).map((p) => ({ value: p.id, label: path(p.id) })));

  const outgoing = $derived(grants.filter((g) => g.direction === "outgoing"));
  const incoming = $derived(grants.filter((g) => g.direction === "incoming"));

  // ---- owned-entity search (debounced) ----
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const q = query;
    if (view !== "new" || what !== "entries") return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searching = true;
      void api
        .ownedEntities(q)
        .then((r) => (found = r))
        .catch(() => (found = []))
        .finally(() => (searching = false));
    }, 250);
    return () => clearTimeout(searchTimer);
  });
  const isPicked = (e: { name: string; home?: { id: string } }) => picked.some((p) => p.name === e.name && p.home?.id === e.home?.id);
  function togglePick(e: { name: string; home?: { id: string; name: string } }) {
    picked = isPicked(e) ? picked.filter((p) => !(p.name === e.name && p.home?.id === e.home?.id)) : [...picked, e];
  }

  // ---- validation ----
  const whatError = $derived(
    attempted && (what === "entries" ? picked.length === 0 : !branch) ? (what === "entries" ? "Pick at least one entry." : "Pick a branch to share.") : "",
  );
  const toError = $derived(attempted && !to ? "Pick who to share with." : "");
  const reasonError = $derived(attempted && reason.trim().length < 3 ? "Say why, so the share can be reviewed later." : "");
  const untilError = $derived.by(() => {
    if (!attempted || standing) return "";
    if (!until) return "Pick an end date.";
    if (until <= dateIn(0)) return "Pick a date after today.";
    if (!tree?.canGrantStanding && until > dateIn(maxDays)) return `Shares end within ${maxDays} days.`;
    return "";
  });

  function openForm() {
    view = "new";
    notice = "";
    attempted = false;
  }
  function resetForm() {
    picked = [];
    branch = "";
    to = "";
    reason = "";
    until = dateIn(defaultDays);
    standing = false;
    query = "";
    attempted = false;
  }

  async function share(): Promise<void> {
    attempted = true;
    error = "";
    if (whatError || toError || reasonError || untilError) return;
    saving = true;
    try {
      // the end of the chosen day, in the user's time zone
      const end = standing ? undefined : new Date(`${until}T23:59:59`).toISOString();
      const r = await api.createGrant({
        ...(what === "entries" ? { entities: picked.map((e) => ({ name: e.name, ...(e.home ? { home: e.home.id } : {}) })) } : { subtree: branch }),
        to,
        reason: reason.trim(),
        ...(end ? { until: end } : {}),
      });
      const proposed = r.results.filter((x) => x.proposed).length;
      const granted = r.results.length - proposed;
      notice = proposed
        ? `Sent for approval: ${proposed === 1 ? "this share takes effect" : `${proposed} shares take effect`} once someone approves.`
        : `Shared with ${path(to)}${granted > 1 ? ` (${granted} entries)` : ""}.`;
      resetForm();
      view = "list";
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function revoke(g: GrantView): Promise<void> {
    busyId = g.id;
    error = "";
    try {
      await api.revokeGrant(g.id);
      notice = `Stopped sharing ${g.kind === "subtree" ? `everything under ${g.target}` : g.target} with ${g.to}.`;
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busyId = null;
    }
  }

  function when(iso: string | null): string {
    if (!iso) return "No end date";
    const d = new Date(iso);
    return `Until ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" })}`;
  }
</script>

{#snippet grantRow(g: GrantView, canRevoke: boolean)}
  <li class="animate-enter grid gap-2 rounded-lg border border-edge bg-panel p-4">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg">
      <span class="min-w-0 truncate">{g.kind === "subtree" ? `Everything under ${g.target}` : g.target}</span>
      <Icon icon={ArrowRight} size={13} class="shrink-0 text-faint" />
      <span class="min-w-0 truncate">{g.to}</span>
      {#if canRevoke}
        <button class="btn btn-danger btn-sm ml-auto" disabled={busyId === g.id} onclick={() => void revoke(g)}>
          {busyId === g.id ? "Revoking…" : "Revoke"}
        </button>
      {/if}
    </div>
    <p class="m-0 text-xs leading-relaxed text-dim">{g.reason}</p>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-faint">
      <span class="inline-flex items-center gap-1"><Icon icon={CalendarClock} size={11} /> {when(g.expires_at)}</span>
      <span>Shared by {g.granted_by}</span>
      {#if g.kind === "entity"}<span>Home: {g.target_home}</span>{/if}
    </div>
  </li>
{/snippet}

{#snippet listView()}
  {#if !tree?.scoped}
    <EmptyState icon={Share2} title="Nothing to share yet" hint="This workspace's knowledge graph isn't divided into positions, so everyone already sees all of it." />
  {:else}
    <section class="grid gap-3 px-5 pt-5">
      <h4 class="m-0 text-xs font-medium text-dim">Shared by you</h4>
      {#if outgoing.length === 0}
        <p class="m-0 text-xs text-faint">You aren't sharing anything outside its usual reach.</p>
      {:else}
        <ul class="m-0 grid list-none gap-3 p-0">
          {#each outgoing as g (g.id)}{@render grantRow(g, true)}{/each}
        </ul>
      {/if}
    </section>
    <section class="grid gap-3 px-5 py-5">
      <h4 class="m-0 text-xs font-medium text-dim">Shared with you</h4>
      {#if incoming.length === 0}
        <p class="m-0 text-xs text-faint">Nobody has shared anything with your positions.</p>
      {:else}
        <ul class="m-0 grid list-none gap-3 p-0">
          {#each incoming as g (g.id)}{@render grantRow(g, false)}{/each}
        </ul>
      {/if}
    </section>
  {/if}
{/snippet}

{#snippet formView()}
  <div class="grid gap-5 p-5">
    <div class="field">
      <span class="field-label">What to share</span>
      <div class="segmented" role="group" aria-label="what to share">
        <button type="button" aria-pressed={what === "entries"} onclick={() => (what = "entries")}>Specific entries</button>
        <button type="button" aria-pressed={what === "branch"} onclick={() => (what = "branch")}>Everything under a position</button>
      </div>
      {#if what === "entries"}
        <div class="relative">
          <span class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"><Icon icon={Search} size={13} /></span>
          <input class="input pl-8" bind:value={query} placeholder="Search entries you own" aria-label="search entries you own" />
        </div>
        {#if picked.length}
          <div class="flex flex-wrap gap-1.5" aria-label="picked entries">
            {#each picked as e (e.name + (e.home?.id ?? ""))}
              <span class="inline-flex items-center gap-1 rounded-md border border-edge2 bg-panel2 py-0.5 pr-1 pl-2 text-xs text-fg">
                {e.name}{#if e.home}<span class="text-faint">· {e.home.name}</span>{/if}
                <button class="cursor-pointer rounded p-0.5 text-faint hover:text-fg" aria-label="remove {e.name}" onclick={() => togglePick(e)}>
                  <Icon icon={X} size={11} />
                </button>
              </span>
            {/each}
          </div>
        {/if}
        {#if searching && found.length === 0}
          <SkeletonRows rows={2} />
        {:else if found.length === 0}
          <p class="m-0 rounded-lg border border-dashed border-edge2 px-4 py-4 text-center text-xs text-faint">
            {query ? "No entries you own match." : "You don't own any entries yet."}
          </p>
        {:else}
          <ul class="m-0 grid max-h-56 list-none gap-1 overflow-y-auto p-0" aria-label="entries you own">
            {#each found as e (e.name + (e.home?.id ?? ""))}
              {@const on = isPicked(e)}
              <li>
                <label class="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 {on ? 'border-edge2 bg-panel' : 'border-edge bg-bg'}">
                  <Switch checked={on} label="share {e.name}" onchange={() => togglePick(e)} />
                  <span class="min-w-0 flex-1 truncate text-sm {on ? 'text-fg' : 'text-dim'}">{e.name}</span>
                  {#if e.home}<span class="shrink-0 text-2xs text-faint">{e.home.name}</span>{/if}
                </label>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <Dropdown full label="branch to share" value={branch} options={[{ value: "", label: "Pick a position" }, ...branchOptions]} onchange={(v) => (branch = v)} searchable />
        <span class="field-hint">Shares everything homed at that position and below it, including entries added later.</span>
      {/if}
      {#if whatError}<span class="field-error">{whatError}</span>{/if}
    </div>

    <div class="field">
      <span class="field-label">Share with</span>
      <Dropdown full label="position to share with" value={to} options={[{ value: "", label: "Pick a position" }, ...toOptions]} onchange={(v) => (to = v)} searchable />
      <span class="field-hint">People at that position, and those above it, will see what you share.</span>
      {#if toError}<span class="field-error">{toError}</span>{/if}
    </div>

    <div class="field">
      <label class="field-label" for="gr-reason">Why</label>
      <textarea id="gr-reason" class="input min-h-16 resize-y" bind:value={reason} placeholder="e.g. Sales needs the capacity plan for the Acme quote"></textarea>
      {#if reasonError}<span class="field-error">{reasonError}</span>{/if}
    </div>

    <div class="field">
      <label class="field-label" for="gr-until">Until</label>
      <input
        id="gr-until"
        type="date"
        class="input w-auto"
        bind:value={until}
        min={dateIn(1)}
        max={tree?.canGrantStanding ? undefined : dateIn(maxDays)}
        disabled={standing}
      />
      {#if tree?.canGrantStanding}
        <label class="mt-1 flex items-center gap-2 text-xs text-dim">
          <Switch checked={standing} label="share with no end date" onchange={(v) => (standing = v)} />
          No end date (only the organization's root can do this)
        </label>
      {:else}
        <span class="field-hint">Shares end within {maxDays} days. You can stop one sooner at any time.</span>
      {/if}
      {#if untilError}<span class="field-error">{untilError}</span>{/if}
    </div>
  </div>
{/snippet}

<Dialog {onclose} labelledby="grants-title" width="44rem" dismissible={!saving}>
  <PanelHeader
    id="grants-title"
    title={view === "new" ? "Share access" : "Shared access"}
    subtitle={view === "new"
      ? "Show part of the knowledge graph to a position that normally can't see it."
      : "Exceptions to who sees what in the knowledge graph. Every share is recorded and ends on its date unless revoked sooner."}
    icon={Share2}
    {onclose}
  >
    {#snippet actions()}
      {#if view === "list" && tree?.scoped}
        <button class="btn btn-primary btn-sm" onclick={openForm}><Icon icon={Plus} size={13} /> Share</button>
      {/if}
    {/snippet}
  </PanelHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if error}
      <div class="mx-5 mt-4 flex items-start gap-2 rounded-md border border-err/30 bg-err-soft px-3 py-2 text-xs text-err" role="alert">
        <Icon icon={TriangleAlert} size={14} class="mt-px" />
        {error}
      </div>
    {/if}
    {#if notice && view === "list"}
      <div class="mx-5 mt-4 flex items-start gap-2 rounded-md border border-edge2 bg-panel2 px-3 py-2 text-xs text-fg" role="status">
        <Icon icon={CircleCheck} size={14} class="mt-px text-ok" />
        {notice}
      </div>
    {/if}
    {#if !loaded && !error}
      <SkeletonRows rows={3} />
    {:else if view === "list"}
      {@render listView()}
    {:else}
      {@render formView()}
    {/if}
  </div>

  {#if view === "new"}
    <footer class="flex shrink-0 justify-end gap-2 border-t border-edge px-5 py-3">
      <button class="btn btn-ghost" disabled={saving} onclick={() => ((view = "list"), resetForm())}>Cancel</button>
      <button class="btn btn-primary" disabled={saving} onclick={() => void share()}>{saving ? "Sharing…" : "Share"}</button>
    </footer>
  {/if}
</Dialog>
