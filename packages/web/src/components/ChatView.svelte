<script lang="ts">
  import { getAdapter } from "../lib/rpc-agent-adapter.js";
  import { store } from "../lib/stores.svelte.js";
  import LitAgentInterface from "./LitAgentInterface.svelte";
  import ModelBar from "./ModelBar.svelte";
  import SessionPanel from "./SessionPanel.svelte";
  import FilesPanel from "./FilesPanel.svelte";
  import McpPanel from "./McpPanel.svelte";
  import ContextPanel from "./ContextPanel.svelte";
  import AgentHeader from "./AgentHeader.svelte";

  let { agentId, agentName }: { agentId: string; agentName: string } = $props();

  const adapter = $derived(getAdapter(agentId));
  const runtime = $derived(store.runtimeFor(agentId));

  let busy = $state(false);
  let error = $state<string | null>(null);
  let drawer = $state<"closed" | "files" | "mcp" | "context">("closed");

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
  <AgentHeader {agentId} />
  {#if runtime?.status === "running" || runtime?.status === "starting"}
    <div class="relative flex flex-wrap items-center gap-2 border-b border-edge bg-panel px-2">
      <div class="flex min-w-0 flex-1 items-center">
        <div class="relative min-w-0 flex-1">
          <ModelBar {agentId} />
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <SessionPanel {agentId} />
        <button
          class="select-compact bg-none pr-2 {drawer === 'files' ? '!border-accent !text-accent' : ''}"
          aria-pressed={drawer === "files"}
          title="files in this agent's sandbox"
          onclick={() => (drawer = drawer === "files" ? "closed" : "files")}
        >
          files
        </button>
        <button
          class="select-compact bg-none pr-2 {drawer === 'mcp' ? '!border-accent !text-accent' : ''}"
          aria-pressed={drawer === "mcp"}
          title="tool connections this agent can use"
          onclick={() => (drawer = drawer === "mcp" ? "closed" : "mcp")}
        >
          tools
        </button>
        <button
          class="select-compact bg-none pr-2 {drawer === 'context' ? '!border-accent !text-accent' : ''}"
          aria-pressed={drawer === "context"}
          title="the briefing this agent keeps in mind"
          onclick={() => (drawer = drawer === "context" ? "closed" : "context")}
        >
          briefing
        </button>
      </div>
    </div>

    <div class="relative flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        <LitAgentInterface agent={adapter} />
      </div>
      {#if drawer !== "closed"}
        <!-- side drawer on wide screens; overlays the chat on narrow ones so the
             transcript is not squeezed into a sliver -->
        <div class="w-80 shrink-0 max-[900px]:absolute max-[900px]:inset-0 max-[900px]:z-20 max-[900px]:w-full">
          {#if drawer === "files"}
            <FilesPanel {agentId} />
          {:else if drawer === "mcp"}
            <McpPanel {agentId} />
          {:else}
            <ContextPanel {agentId} onclose={() => (drawer = "closed")} />
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div class="m-auto grid gap-3 text-center text-muted">
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
