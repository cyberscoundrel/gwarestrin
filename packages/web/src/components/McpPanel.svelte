<script lang="ts">
  import { onMount } from "svelte";
  import { api, mcpApi, type McpServerDef } from "../lib/api.js";
  import { store } from "../lib/stores.svelte.js";
  import { Lock, Pencil, Plus, Trash2, TriangleAlert, Wrench } from "lucide";
  import Icon from "./Icon.svelte";
  import PanelHeader from "./PanelHeader.svelte";
  import EmptyState from "./EmptyState.svelte";
  import SkeletonRows from "./SkeletonRows.svelte";
  import Switch from "./Switch.svelte";

  let { agentId, onclose }: { agentId: string; onclose?: (() => void) | undefined } = $props();

  let showCatalogue = $state(false);

  const record = $derived(store.agents.find((a) => a.id === agentId));

  let registry = $state<Record<string, McpServerDef>>({});
  /** false until the first registry load settles (avoids an "empty" flash) */
  let loaded = $state(false);
  let error = $state<string | null>(null);
  let busy = $state(false);

  // liveness per registry server, probed server-side (the browser cannot
  // reach container-network urls); refreshed while the panel is open
  let probes = $state<Record<string, { reachable: boolean | null; httpStatus?: number; ms?: number }>>({});

  // add/edit form state
  let editing = $state<string | null>(null); // name being edited, "" = new
  let formName = $state("");
  let formTransport = $state<"stdio" | "http">("stdio");
  let formCommand = $state("");
  let formArgs = $state("");
  let formUrl = $state("");
  let formBearerEnv = $state("");
  let formDescription = $state("");

  async function refresh(): Promise<void> {
    error = null;
    try {
      registry = await mcpApi.list();
      loaded = true;
      probes = await mcpApi.status();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => {
    void refresh();
    void store.refreshProfiles();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  });

  function isEnabled(name: string): boolean {
    return record?.mcpServers.includes(name) ?? false;
  }

  /** the agent's profile allowlist — null means unrestricted ("all") */
  const allowedSet = $derived.by(() => {
    const profile = store.profiles.find((p) => p.id === (record?.profileId || "default"));
    if (!profile || profile.mcpServers === "all") return null;
    return new Set(profile.mcpServers);
  });

  /** allowed connections first, so the agent's usable set reads top-down */
  const sortedEntries = $derived(
    Object.entries(registry).sort(([a], [b]) => Number(isGranted(b)) - Number(isGranted(a))),
  );

  const profileName = $derived(
    store.profiles.find((p) => p.id === (record?.profileId || "default"))?.name ?? "its agent profile",
  );

  /** false = the profile does not grant this server; the toggle is locked */
  function isGranted(name: string): boolean {
    return allowedSet === null || allowedSet.has(name);
  }

  async function toggle(name: string): Promise<void> {
    if (!record) return;
    const next = isEnabled(name)
      ? record.mcpServers.filter((n) => n !== name)
      : [...record.mcpServers, name];
    busy = true;
    error = null;
    try {
      await api.patchAgent(agentId, { mcpServers: next });
      await store.refreshAgents();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function startEdit(name: string | null): void {
    editing = name ?? "";
    const def = name ? registry[name] : undefined;
    formName = name ?? "";
    formTransport = def?.url ? "http" : "stdio";
    formCommand = def?.command ?? "";
    formArgs = (def?.args ?? []).join(" ");
    formUrl = def?.url ?? "";
    formBearerEnv = def?.bearerTokenEnv ?? "";
    formDescription = def?.description ?? "";
  }

  async function save(): Promise<void> {
    const name = formName.trim();
    if (!name) {
      error = "Give the connection a name.";
      return;
    }
    const def: McpServerDef = {};
    if (formTransport === "stdio") {
      def.command = formCommand.trim();
      const args = formArgs.trim().split(/\s+/).filter(Boolean);
      if (args.length) def.args = args;
    } else {
      def.url = formUrl.trim();
      def.auth = "bearer";
      if (formBearerEnv.trim()) def.bearerTokenEnv = formBearerEnv.trim();
    }
    if (formDescription.trim()) def.description = formDescription.trim();
    busy = true;
    error = null;
    try {
      registry = await mcpApi.put(name, def);
      editing = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function remove(name: string): Promise<void> {
    if (!confirm(`Remove tool connection "${name}" from the workspace? Every agent loses access to it.`)) return;
    busy = true;
    error = null;
    try {
      registry = await mcpApi.remove(name);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function summarize(def: McpServerDef): string {
    return def.url ? def.url : `${def.command} ${(def.args ?? []).join(" ")}`.trim();
  }

  function statusDot(name: string): { cls: string; title: string } {
    if (!isEnabled(name)) return { cls: "bg-edge2", title: "Off for this agent" };
    const p = probes[name];
    if (!p || p.reachable === null) return { cls: "bg-faint", title: "Local command connection (no reachability check)" };
    if (p.reachable) return { cls: "bg-ok", title: `Reachable${p.ms != null ? ` · ${p.ms} ms` : ""}` };
    return { cls: "bg-err", title: "Unreachable" };
  }

  const allowedEntries = $derived(sortedEntries.filter(([n]) => isGranted(n)));
  const blockedEntries = $derived(sortedEntries.filter(([n]) => !isGranted(n)));
  const onCount = $derived(allowedEntries.filter(([n]) => isEnabled(n)).length);
</script>

{#snippet row(name: string, def: McpServerDef, allowed: boolean)}
  {@const dot = statusDot(name)}
  <li class="flex items-center gap-3 rounded-md px-2.5 py-2 transition-colors hover:bg-hover">
    <span class="h-1.5 w-1.5 shrink-0 rounded-full {dot.cls}" role="img" aria-label={dot.title} title={dot.title}></span>
    <div class="grid min-w-0 flex-1">
      <span class="flex items-center gap-1.5 truncate text-sm {allowed ? 'text-fg' : 'text-dim'}">
        {name}
        {#if !allowed}<Icon icon={Lock} size={12} class="text-faint" label="not allowed" />{/if}
      </span>
      <span class="truncate font-mono text-2xs text-faint" title={summarize(def)}>
        {def.description ?? summarize(def)}
      </span>
    </div>
    <Switch
      checked={isEnabled(name)}
      disabled={busy || !record || (!allowed && !isEnabled(name))}
      label="{isEnabled(name) ? 'switch off' : 'switch on'} {name} for this agent"
      onchange={() => void toggle(name)}
    />
  </li>
{/snippet}

<div class="flex h-full flex-col border-l border-edge bg-panel text-sm">
  <PanelHeader
    title="Tools"
    subtitle="Tool connections this agent may use. {profileName} sets the limit."
    icon={Wrench}
    {onclose}
  />

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if error}
      <div class="mx-4 mt-3 flex items-start gap-2 rounded-md border border-err/30 bg-err-soft px-3 py-2 text-xs text-err" role="alert">
        <Icon icon={TriangleAlert} size={14} class="mt-px" />
        {error}
      </div>
    {/if}

    {#if !loaded && !error}
      <SkeletonRows rows={3} />
    {:else if Object.keys(registry).length === 0}
      <EmptyState
        icon={Wrench}
        title="No tool connections yet"
        hint="Add one to the workspace, then allow it in an agent profile."
      />
    {:else}
      <section class="px-1.5 pt-3 pb-2">
        <div class="flex items-center justify-between px-2.5 pb-1.5">
          <span class="eyebrow">Allowed</span>
          <span class="tabular text-2xs text-faint">{onCount} of {allowedEntries.length} on</span>
        </div>
        {#if allowedEntries.length === 0}
          <p class="m-0 px-2.5 py-2 text-xs text-faint">{profileName} allows no tool connections.</p>
        {:else}
          <ul class="m-0 grid list-none gap-px p-0">
            {#each allowedEntries as [name, def] (name)}
              {@render row(name, def, true)}
            {/each}
          </ul>
        {/if}
      </section>

      {#if blockedEntries.length > 0}
        <section class="border-t border-edge px-1.5 pt-3 pb-2">
          <div class="px-2.5 pb-1.5">
            <span class="eyebrow">Not allowed by {profileName}</span>
          </div>
          <ul class="m-0 grid list-none gap-px p-0">
            {#each blockedEntries as [name, def] (name)}
              {@render row(name, def, false)}
            {/each}
          </ul>
          <p class="m-0 px-2.5 pt-1 text-xs text-faint">Edit the agent profile to allow more.</p>
        </section>
      {/if}
    {/if}

    <!-- workspace-wide administration, deliberately separate from the
         per-agent switches above: changes here affect every agent -->
    <section class="mx-3 mt-3 mb-4 rounded-lg border border-edge bg-bg">
      <button
        class="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-hover"
        aria-expanded={showCatalogue}
        onclick={() => (showCatalogue = !showCatalogue)}
      >
        <span class="grid">
          <span class="text-xs font-medium text-fg">Workspace connections</span>
          <span class="text-2xs text-faint">Add, edit or remove for every agent</span>
        </span>
        <span class="text-2xs text-faint">{showCatalogue ? "Hide" : "Manage"}</span>
      </button>

      {#if showCatalogue}
        <div class="animate-enter border-t border-edge p-1.5">
          <ul class="m-0 grid list-none gap-px p-0">
            {#each Object.entries(registry) as [name, def] (name)}
              <li class="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-hover">
                <span class="min-w-0 flex-1 truncate text-xs text-fg" title={summarize(def)}>{name}</span>
                <button
                  class="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-faint transition-colors hover:bg-selected hover:text-fg"
                  title="Edit {name} (workspace-wide)"
                  aria-label="edit tool connection {name} for the whole workspace"
                  onclick={() => startEdit(name)}><Icon icon={Pencil} size={13} /></button
                >
                <button
                  class="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-faint transition-colors hover:bg-err-soft hover:text-err"
                  title="Remove {name} from the workspace (all agents)"
                  aria-label="remove tool connection {name} from the workspace"
                  onclick={() => void remove(name)}><Icon icon={Trash2} size={13} /></button
                >
              </li>
            {/each}
          </ul>

          {#if editing !== null}
            <form
              class="animate-enter mt-1.5 grid gap-3 rounded-md border border-edge bg-panel p-3"
              onsubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <div class="field">
                <label class="field-label" for="mcp-name">Name</label>
                <input id="mcp-name" class="input" placeholder="e.g. crm" bind:value={formName} disabled={editing !== ""} />
              </div>
              <div class="field">
                <span class="field-label">Connects via</span>
                <div class="segmented" role="group" aria-label="transport">
                  <button type="button" aria-pressed={formTransport === "stdio"} onclick={() => (formTransport = "stdio")}>Command</button>
                  <button type="button" aria-pressed={formTransport === "http"} onclick={() => (formTransport = "http")}>HTTP URL</button>
                </div>
              </div>
              {#if formTransport === "stdio"}
                <div class="field">
                  <label class="field-label" for="mcp-cmd">Command</label>
                  <input id="mcp-cmd" class="input input-mono" placeholder="npx" bind:value={formCommand} />
                </div>
                <div class="field">
                  <label class="field-label" for="mcp-args">Arguments</label>
                  <input id="mcp-args" class="input input-mono" placeholder="-y @modelcontextprotocol/server-filesystem /workspace" bind:value={formArgs} />
                  <span class="field-hint">Separated by spaces.</span>
                </div>
              {:else}
                <div class="field">
                  <label class="field-label" for="mcp-url">URL</label>
                  <input id="mcp-url" class="input input-mono" placeholder="https://…/mcp" bind:value={formUrl} />
                </div>
                <div class="field">
                  <label class="field-label" for="mcp-env">Bearer token variable</label>
                  <input id="mcp-env" class="input input-mono" placeholder="CRM_TOKEN (optional)" bind:value={formBearerEnv} />
                  <span class="field-hint">Name of a server-side environment variable, never the token itself.</span>
                </div>
              {/if}
              <div class="field">
                <label class="field-label" for="mcp-desc">Description</label>
                <input id="mcp-desc" class="input" placeholder="What it gives agents access to" bind:value={formDescription} />
              </div>
              <div class="flex justify-end gap-2">
                <button type="button" class="btn btn-ghost btn-sm" onclick={() => (editing = null)}>Cancel</button>
                <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>{editing === "" ? "Add connection" : "Save"}</button>
              </div>
            </form>
          {:else}
            <button class="btn btn-ghost btn-sm mt-1 w-full justify-start" onclick={() => startEdit(null)}>
              <Icon icon={Plus} size={13} />
              Add tool connection
            </button>
          {/if}
        </div>
      {/if}
    </section>
  </div>

  <div class="border-t border-edge px-4 py-2 text-2xs text-faint">Switching a connection restarts the agent.</div>
</div>
