<script lang="ts">
  import { getAdapter } from "../lib/rpc-agent-adapter.js";
  import { store } from "../lib/stores.svelte.js";
  import LitAgentInterface from "./LitAgentInterface.svelte";
  import ModelBar from "./ModelBar.svelte";
  import SessionPanel from "./SessionPanel.svelte";
  import FilesPanel from "./FilesPanel.svelte";
  import McpPanel from "./McpPanel.svelte";

  let { agentId, agentName }: { agentId: string; agentName: string } = $props();

  const adapter = $derived(getAdapter(agentId));
  const runtime = $derived(store.runtimeFor(agentId));

  let busy = $state(false);
  let error = $state<string | null>(null);
  let drawer = $state<"closed" | "files" | "mcp">("closed");

  async function start(): Promise<void> {
    busy = true;
    error = null;
    try {
      const { api } = await import("../lib/api.js");
      await api.startAgent(agentId);
      await store.refreshAgents();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section class="flex min-h-0 flex-1 flex-col">
  {#if runtime?.status === "running" || runtime?.status === "starting"}
    <div class="relative flex items-center gap-2 border-b border-edge bg-panel px-2">
      <div class="relative">
        <ModelBar {agentId} />
      </div>
      <SessionPanel {agentId} />
      <button
        class="ml-auto rounded border bg-transparent px-2 py-0.5 text-xs hover:text-fg
          {drawer === 'files' ? 'border-accent text-accent' : 'border-edge2 text-muted'}"
        onclick={() => (drawer = drawer === "files" ? "closed" : "files")}
      >
        files
      </button>
      <button
        class="rounded border bg-transparent px-2 py-0.5 text-xs hover:text-fg
          {drawer === 'mcp' ? 'border-accent text-accent' : 'border-edge2 text-muted'}"
        onclick={() => (drawer = drawer === "mcp" ? "closed" : "mcp")}
      >
        mcp
      </button>
    </div>

    <div class="flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        <LitAgentInterface agent={adapter} />
      </div>
      {#if drawer !== "closed"}
        <div class="w-80 shrink-0 border-l border-edge">
          {#if drawer === "files"}
            <FilesPanel {agentId} />
          {:else}
            <McpPanel {agentId} />
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div class="m-auto grid gap-3 text-center text-muted">
      <h3 class="m-0 text-fg">{agentName}</h3>
      <p class="m-0 max-w-2xl">
        {runtime?.status === "error"
          ? `errored${runtime.error ? `: ${runtime.error.split("\n")[0]}` : ""}`
          : "agent is not running"}
      </p>
      <div class="flex justify-center gap-2">
        <button
          class="cursor-pointer rounded-md bg-accent px-4 py-2 font-semibold text-[#0b0c10] disabled:cursor-default disabled:opacity-60"
          disabled={busy}
          onclick={start}
        >
          {busy ? "starting…" : "start agent"}
        </button>
        {#if runtime?.status === "error"}
          <button
            class="cursor-pointer rounded-md border border-[#333845] bg-transparent px-4 py-2 text-fg"
            disabled={busy}
            onclick={start}
          >
            retry
          </button>
        {/if}
      </div>
      {#if error}
        <p class="m-0 max-w-2xl text-err">{error}</p>
      {/if}
    </div>
  {/if}
</section>
