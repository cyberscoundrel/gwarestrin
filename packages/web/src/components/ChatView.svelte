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
  import Icon from "./Icon.svelte";
  import { BookOpen, Check, Copy, Ellipsis, FolderOpen, Moon, Play, Shrink, SquarePen, TriangleAlert, Wrench, type IconNode } from "lucide";
  import { conversationAction } from "../lib/conversation.js";

  let { agentId, agentName }: { agentId: string; agentName: string } = $props();

  const adapter = $derived(getAdapter(agentId));
  const runtime = $derived(store.runtimeFor(agentId));

  let busy = $state(false);
  let error = $state<string | null>(null);
  let drawer = $state<"closed" | "files" | "mcp" | "context">("closed");

  // phone (<640px): the toolbar folds into one menu (P-13)
  let phoneMenu = $state(false);
  let phoneError = $state<string | null>(null);

  async function phoneAction(type: string): Promise<void> {
    phoneError = null;
    try {
      await conversationAction(agentId, type);
      phoneMenu = false;
    } catch (e) {
      phoneError = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    if (!phoneMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") phoneMenu = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

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

{#snippet drawerToggle(kind: "files" | "mcp" | "context", icon: IconNode, label: string, title: string)}
  <button
    class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors
      {drawer === kind ? 'bg-selected text-fg' : 'text-dim hover:bg-hover hover:text-fg'}"
    aria-pressed={drawer === kind}
    {title}
    onclick={() => (drawer = drawer === kind ? "closed" : kind)}
  >
    <Icon {icon} size={14} />
    {label}
  </button>
{/snippet}

<section class="flex min-h-0 flex-1 flex-col">
  <AgentHeader {agentId} ondrawer={(d) => (drawer = d)} />
  {#if runtime?.status === "running" || runtime?.status === "starting"}
    <div class="relative flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-edge bg-bg px-3 py-1">
      <!-- narrow screens: the model bar gets its own full-width row so the
           model name stays readable instead of truncating to a few letters -->
      <div class="flex min-w-0 flex-1 items-center max-[900px]:basis-full max-sm:basis-auto">
        <div class="relative min-w-0 flex-1">
          <ModelBar {agentId} />
        </div>
      </div>
      <!-- phone: one menu for panels + conversation actions -->
      <div class="relative sm:hidden">
        <button
          class="grid h-8 w-8 cursor-pointer place-items-center rounded-md transition-colors
            {phoneMenu || drawer !== 'closed' ? 'bg-selected text-fg' : 'text-dim hover:bg-hover hover:text-fg'}"
          aria-label="more"
          aria-haspopup="menu"
          aria-expanded={phoneMenu}
          onclick={() => (phoneMenu = !phoneMenu)}
        >
          <Icon icon={Ellipsis} size={16} />
        </button>
        {#if phoneMenu}
          <div class="fixed inset-0 z-29" role="presentation" onclick={() => (phoneMenu = false)}></div>
          <div class="animate-pop absolute right-0 z-30 mt-1 w-64 rounded-xl border border-edge2 bg-panel2 p-1 shadow-overlay" role="menu">
            {#each [["files", FolderOpen, "Files"], ["mcp", Wrench, "Tools"], ["context", BookOpen, "Briefing"]] as const as [kind, icon, label] (kind)}
              <button
                class="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-fg hover:bg-hover"
                role="menuitemcheckbox"
                aria-checked={drawer === kind}
                onclick={() => {
                  drawer = drawer === kind ? "closed" : kind;
                  phoneMenu = false;
                }}
              >
                <Icon {icon} size={15} class="text-faint" />
                {label}
                {#if drawer === kind}<Icon icon={Check} size={14} class="ml-auto text-signal" />{/if}
              </button>
            {/each}
            <div class="my-1 h-px bg-edge" role="separator"></div>
            <p class="eyebrow m-0 px-2.5 pt-1 pb-1">Conversation</p>
            {#each [["new_session", SquarePen, "New conversation"], ["clone", Copy, "Clone conversation"], ["compact", Shrink, "Compact conversation"]] as const as [type, icon, label] (type)}
              <button
                class="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-fg hover:bg-hover"
                role="menuitem"
                onclick={() => void phoneAction(type)}
              >
                <Icon {icon} size={15} class="text-faint" />
                {label}
              </button>
            {/each}
            {#if phoneError}<p class="m-0 px-2.5 py-1.5 text-xs text-err">{phoneError}</p>{/if}
          </div>
        {/if}
      </div>
      <div class="flex items-center gap-0.5 max-sm:hidden">
        <SessionPanel {agentId} />
        <span class="mx-1 h-4 w-px bg-edge" aria-hidden="true"></span>
        {@render drawerToggle("files", FolderOpen, "Files", "Files in this agent's sandbox")}
        {@render drawerToggle("mcp", Wrench, "Tools", "Tool connections this agent can use")}
        {@render drawerToggle("context", BookOpen, "Briefing", "The briefing this agent keeps in mind")}
      </div>
    </div>

    <div class="relative flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        <LitAgentInterface agent={adapter} />
      </div>
      {#if drawer !== "closed"}
        <!-- side drawer on wide screens; overlays the chat on narrow ones so the
             transcript is not squeezed into a sliver -->
        <div
          class="animate-drawer-right w-80 shrink-0 max-[900px]:absolute max-[900px]:inset-0 max-[900px]:z-20 max-[900px]:w-full"
        >
          {#if drawer === "files"}
            <FilesPanel {agentId} onclose={() => (drawer = "closed")} />
          {:else if drawer === "mcp"}
            <McpPanel {agentId} onclose={() => (drawer = "closed")} />
          {:else}
            <ContextPanel {agentId} onclose={() => (drawer = "closed")} />
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div class="animate-enter m-auto grid max-w-md justify-items-center gap-3 px-6 text-center">
      <span class="grid h-10 w-10 place-items-center rounded-lg border border-edge bg-panel text-faint">
        <Icon icon={runtime?.status === "error" ? TriangleAlert : Moon} size={18} />
      </span>
      <h3 class="m-0 text-base font-medium text-fg">
        {runtime?.status === "error" ? "This agent stopped with an error" : "This agent is stopped"}
      </h3>
      <p class="m-0 text-sm text-dim">
        {#if runtime?.status === "error" && runtime.error}
          <span class="font-mono text-xs break-words text-err">{runtime.error.split("\n")[0]}</span>
        {:else}
          Its files and conversations are kept. Start its sandbox to continue.
        {/if}
      </p>
      <button
        class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-signal/40 bg-signal-soft px-3 text-sm font-medium text-signal
          transition-colors hover:border-signal disabled:cursor-default disabled:opacity-60"
        disabled={busy}
        onclick={start}
      >
        <Icon icon={Play} size={14} />
        {busy ? "Starting…" : runtime?.status === "error" ? "Retry" : "Start agent"}
      </button>
      {#if error}
        <p class="m-0 text-sm text-err">{error}</p>
      {/if}
    </div>
  {/if}
</section>
