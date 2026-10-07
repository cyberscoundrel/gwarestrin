<script lang="ts">
  import { onMount } from "svelte";
  import { Building2, TriangleAlert } from "lucide";
  import { api, type WorkspaceSettings, type WorkspacesView, type WorkspaceView } from "../lib/api.js";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import PanelHeader from "./PanelHeader.svelte";
  import SkeletonRows from "./SkeletonRows.svelte";
  import Switch from "./Switch.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let view = $state<WorkspacesView | null>(null);
  let loadError = $state("");
  // per workspace: the edited copy, save state, messages
  let drafts = $state<Record<string, WorkspaceSettings>>({});
  let busy = $state<string | null>(null);
  let errors = $state<Record<string, string>>({});
  let notices = $state<Record<string, string>>({});

  async function load(): Promise<void> {
    loadError = "";
    try {
      view = await api.workspaces();
      drafts = Object.fromEntries(view.instances.map((w) => [w.name, structuredClone($state.snapshot(w.settings))]));
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }
  onMount(() => void load());

  const dirty = (w: WorkspaceView) => JSON.stringify(drafts[w.name]) !== JSON.stringify(w.settings);

  function toggle(name: string, key: "mcp" | "providers", item: string, on: boolean, all: string[]) {
    const d = drafts[name];
    if (!d) return;
    const current = d[key] === "all" ? [...all] : [...d[key]];
    d[key] = on ? [...new Set([...current, item])].sort() : current.filter((x) => x !== item);
  }

  async function save(w: WorkspaceView): Promise<void> {
    const d = drafts[w.name];
    if (!d) return;
    errors[w.name] = "";
    notices[w.name] = "";
    if (!Number.isInteger(d.maxAgents) || d.maxAgents < 1 || d.maxAgents > 32) {
      errors[w.name] = "The agent limit is a whole number from 1 to 32.";
      return;
    }
    if (Array.isArray(d.providers) && d.providers.length === 0) {
      errors[w.name] = "Allow at least one model provider.";
      return;
    }
    const changes = Object.fromEntries(
      (Object.keys(d) as Array<keyof WorkspaceSettings>)
        .filter((k) => JSON.stringify(d[k]) !== JSON.stringify(w.settings[k]))
        .map((k) => [k, d[k]]),
    ) as Partial<WorkspaceSettings>;
    busy = w.name;
    try {
      await api.saveWorkspace(w.name, changes);
      notices[w.name] = "Saved. The workspace applies it within seconds; agents using something no longer allowed are restarted without it, or stopped.";
      await load();
    } catch (e) {
      errors[w.name] = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  const label = (w: WorkspaceView) => `${w.tier === "admin" ? "Admin" : "User"} · ${w.runtime === "openshell" ? "OpenShell microVMs" : "gondolin"} · ${w.status}`;
  function describeChange(prev: WorkspaceSettings, next: WorkspaceSettings): string {
    const out: string[] = [];
    if (prev.maxAgents !== next.maxAgents) out.push(`agent limit ${prev.maxAgents} → ${next.maxAgents}`);
    const list = (v: "all" | string[]) => (v === "all" ? "all" : v.length ? v.join(", ") : "none");
    if (JSON.stringify(prev.mcp) !== JSON.stringify(next.mcp)) out.push(`tool connections: ${list(next.mcp)}`);
    if (JSON.stringify(prev.providers) !== JSON.stringify(next.providers)) out.push(`model providers: ${list(next.providers)}`);
    return out.join("; ");
  }
</script>

{#snippet allowList(w: WorkspaceView, key: "mcp" | "providers", all: string[], title: string, hint: string)}
  {@const d = drafts[w.name]}
  {#if d}
    <div class="field">
      <span class="field-label">{title}</span>
      <div class="segmented" role="group" aria-label="{title} for {w.name}">
        <button type="button" aria-pressed={d[key] === "all"} onclick={() => (d[key] = "all")}>All</button>
        <button type="button" aria-pressed={d[key] !== "all"} onclick={() => (d[key] = d[key] === "all" ? [...all] : d[key])}>Only selected</button>
      </div>
      {#if d[key] !== "all"}
        {#if all.length === 0}
          <p class="m-0 text-xs text-faint">None available.</p>
        {:else}
          <ul class="m-0 grid list-none gap-1.5 p-0 sm:grid-cols-2" aria-label="{title} for {w.name}">
            {#each all as item (item)}
              {@const on = (d[key] as string[]).includes(item)}
              <li class="flex items-center gap-2.5 rounded-md border px-3 py-2 {on ? 'border-edge2 bg-panel' : 'border-edge bg-bg'}">
                <Switch checked={on} label="allow {item} for {w.name}" onchange={(v) => toggle(w.name, key, item, v, all)} />
                <span class="truncate font-mono text-xs {on ? 'text-fg' : 'text-dim'}">{item}</span>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
      <span class="field-hint">{hint}</span>
    </div>
  {/if}
{/snippet}

<Dialog {onclose} labelledby="workspaces-title" width="52rem" dismissible={busy === null}>
  <PanelHeader
    id="workspaces-title"
    title="Workspaces"
    subtitle="Each person's workspace: how many agents it runs and what its agents may use. Applied within seconds."
    icon={Building2}
    {onclose}
  />

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if loadError}
      <div class="mx-5 mt-4 flex items-start gap-2 rounded-md border border-err/30 bg-err-soft px-3 py-2 text-xs text-err" role="alert">
        <Icon icon={TriangleAlert} size={14} class="mt-px" />
        {loadError}
      </div>
    {:else if !view}
      <SkeletonRows rows={3} />
    {:else if view.enabled === false}
      <p class="m-0 px-5 py-6 text-xs text-faint">Only the organization's admins manage workspaces.</p>
    {:else}
      <ul class="m-0 grid list-none gap-4 p-5">
        {#each view.instances as w (w.name)}
          {@const d = drafts[w.name]}
          <li class="grid gap-5 rounded-lg border border-edge bg-panel p-4">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span class="text-sm font-medium text-fg">{w.name}</span>
              <span class="text-xs text-faint">{label(w)}</span>
              <span class="ml-auto text-2xs text-faint">{w.positions.length ? w.positions.join(", ") : "no position"}</span>
            </div>
            {#if d}
              <div class="field">
                <label class="field-label" for="ws-max-{w.name}">Agents running at once</label>
                <input id="ws-max-{w.name}" type="number" min="1" max="32" class="input w-24" bind:value={d.maxAgents} />
              </div>
              {@render allowList(w, "mcp", view.choices?.mcp ?? [], "Tool connections", "What this workspace's agents may connect to, e.g. which SQL server. Each connection's own login still decides what it can read.")}
              {@render allowList(w, "providers", view.choices?.providers ?? [], "Model providers", "Where this workspace's agents may send prompts. Allowing only your own inference keeps conversations on your hardware.")}
              <div class="flex flex-wrap items-center gap-3">
                {#if errors[w.name]}
                  <span class="text-xs text-err" role="alert">{errors[w.name]}</span>
                {:else if notices[w.name]}
                  <span class="text-xs text-dim">{notices[w.name]}</span>
                {:else if dirty(w)}
                  <span class="flex items-center gap-1.5 text-xs text-dim"><span class="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true"></span> Unsaved changes</span>
                {/if}
                <span class="ml-auto"></span>
                <button class="btn btn-ghost btn-sm" disabled={busy !== null || !dirty(w)} onclick={() => (drafts[w.name] = structuredClone($state.snapshot(w.settings)))}>Undo</button>
                <button class="btn btn-primary btn-sm" disabled={busy !== null || !dirty(w)} onclick={() => void save(w)}>{busy === w.name ? "Saving…" : "Save"}</button>
              </div>
              <span class="text-2xs text-faint">
                Runtime, tier and positions are set at deploy and in authentik{w.managedBy === "docker-compose" ? "; this workspace's container is defined in docker-compose.yml" : ""}.
              </span>
            {/if}
          </li>
        {/each}
      </ul>
      {#if view.history?.length}
        <section class="grid gap-2 border-t border-edge px-5 py-5">
          <h4 class="m-0 text-xs font-medium text-dim">Recent changes</h4>
          {#each view.history as h (h.at + h.name)}
            <span class="text-xs text-faint">{h.by} · {new Date(h.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {h.name}: {describeChange(h.prev, h.next)}</span>
          {/each}
        </section>
      {/if}
    {/if}
  </div>
</Dialog>
