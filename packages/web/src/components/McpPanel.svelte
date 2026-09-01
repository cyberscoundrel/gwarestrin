<script lang="ts">
  import { onMount } from "svelte";
  import { api, mcpApi, type McpServerDef } from "../lib/api.js";
  import { store } from "../lib/stores.svelte.js";

  let { agentId }: { agentId: string } = $props();

  const record = $derived(store.agents.find((a) => a.id === agentId));

  let registry = $state<Record<string, McpServerDef>>({});
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
      probes = await mcpApi.status();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  });

  function isEnabled(name: string): boolean {
    return record?.mcpServers.includes(name) ?? false;
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
      error = "server name required";
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
    if (!confirm(`remove MCP server "${name}" from the registry?`)) return;
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

  function statusDot(name: string): { color: string; title: string } {
    if (!isEnabled(name)) return { color: "text-muted", title: "not enabled for this agent" };
    const p = probes[name];
    if (!p || p.reachable === null) return { color: "text-muted", title: "no http probe (stdio server)" };
    if (p.reachable) return { color: "text-ok", title: `reachable${p.ms != null ? ` · ${p.ms}ms` : ""}` };
    return { color: "text-err", title: "unreachable" };
  }
</script>

<div class="flex h-full flex-col border-l border-edge bg-panel text-sm">
  <div class="flex items-center gap-2 border-b border-edge px-3 py-2">
    <span class="font-semibold tracking-wide">mcp servers</span>
    <button
      class="ml-auto rounded border border-edge2 bg-transparent px-2 py-0.5 text-xs text-muted hover:text-fg"
      onclick={() => startEdit(null)}
    >
      + add
    </button>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if error}
      <p class="px-3 py-2 text-err">{error}</p>
    {/if}

    {#if editing !== null}
      <div class="grid gap-2 border-b border-edge px-3 py-2">
        <input class="rounded border border-edge2 bg-bg px-2 py-1 text-fg outline-none focus:border-accent" placeholder="name" bind:value={formName} disabled={editing !== ""} />
        <select class="rounded border border-edge2 bg-bg px-2 py-1 text-fg" bind:value={formTransport}>
          <option value="stdio">stdio (command)</option>
          <option value="http">http (url)</option>
        </select>
        {#if formTransport === "stdio"}
          <input class="rounded border border-edge2 bg-bg px-2 py-1 text-fg outline-none focus:border-accent" placeholder="command (e.g. npx)" bind:value={formCommand} />
          <input class="rounded border border-edge2 bg-bg px-2 py-1 text-fg outline-none focus:border-accent" placeholder="args (space separated)" bind:value={formArgs} />
        {:else}
          <input class="rounded border border-edge2 bg-bg px-2 py-1 text-fg outline-none focus:border-accent" placeholder="url (https://…/mcp)" bind:value={formUrl} />
          <input class="rounded border border-edge2 bg-bg px-2 py-1 text-fg outline-none focus:border-accent" placeholder="bearer token env var (optional)" bind:value={formBearerEnv} />
        {/if}
        <input class="rounded border border-edge2 bg-bg px-2 py-1 text-fg outline-none focus:border-accent" placeholder="description (optional)" bind:value={formDescription} />
        <div class="flex justify-end gap-2">
          <button class="rounded border border-edge2 bg-transparent px-2 py-1 text-xs text-muted hover:text-fg" onclick={() => (editing = null)}>cancel</button>
          <button class="rounded bg-accent px-3 py-1 text-xs font-semibold text-[#0b0c10] disabled:opacity-50" disabled={busy} onclick={() => void save()}>save</button>
        </div>
      </div>
    {/if}

    {#if Object.keys(registry).length === 0}
      <p class="px-3 py-2 text-muted">registry is empty — add a server to make it available to agents</p>
    {:else}
      <ul class="m-0 list-none p-0">
        {#each Object.entries(registry) as [name, def] (name)}
          {@const dot = statusDot(name)}
          <li class="border-b border-edge/50 px-3 py-2">
            <div class="flex items-center gap-2">
              <span class="{dot.color}" title={dot.title}>●</span>
              <label class="flex flex-1 items-center gap-2 truncate" title={summarize(def)}>
                <input
                  type="checkbox"
                  checked={isEnabled(name)}
                  disabled={busy || !record}
                  onchange={() => void toggle(name)}
                />
                <span class="truncate font-medium">{name}</span>
              </label>
              <button class="rounded px-1 text-xs text-muted hover:text-fg" title="edit" onclick={() => startEdit(name)}>✎</button>
              <button class="rounded px-1 text-xs text-err hover:bg-[#2a1218]" title="delete" onclick={() => void remove(name)}>✕</button>
            </div>
            <div class="mt-0.5 truncate pl-6 text-xs text-muted" title={summarize(def)}>
              {summarize(def)}{def.description ? ` — ${def.description}` : ""}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="border-t border-edge px-3 py-1.5 text-xs text-muted">
    checked = enabled for this agent (restarts it)
  </div>
</div>
