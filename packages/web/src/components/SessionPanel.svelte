<script lang="ts">
  import { store } from "../lib/stores.svelte.js";
  import { ws } from "../lib/ws-client.js";
  import { getAdapter } from "../lib/rpc-agent-adapter.js";
  import { ChevronDown, Copy, GitBranch, MessagesSquare, Shrink, SquarePen, type IconNode } from "lucide";
  import Icon from "./Icon.svelte";

  let { agentId }: { agentId: string } = $props();

  const adapter = $derived(getAdapter(agentId));
  let open = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  interface ForkMessage {
    entryId: string;
    text: string;
  }
  let forkMessages = $state<ForkMessage[]>([]);

  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  async function loadForkable(): Promise<void> {
    try {
      const res = (await ws.rpc(agentId, "get_fork_messages")) as {
        data?: { messages?: ForkMessage[] };
      };
      forkMessages = res.data?.messages ?? [];
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function run(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    busy = true;
    error = null;
    try {
      const res = (await ws.rpc(agentId, type, payload)) as { success?: boolean; error?: string };
      if (res.success === false) throw new Error(res.error ?? `${type} failed`);
      open = false;
      // session-replacing commands: re-pull state so the cleared transcript shows
      if (type === "new_session" || type === "fork" || type === "clone") {
        await getAdapter(agentId).refreshSession();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function fork(entryId: string): Promise<void> {
    await run("fork", { entryId });
    await store.refreshAgents();
  }
</script>

{#snippet item(icon: IconNode, label: string, hint: string, action: () => void)}
  <button
    class="flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
    role="menuitem"
    onclick={action}
  >
    <Icon {icon} size={14} class="mt-0.5 text-faint" />
    <span class="grid">
      <span class="text-sm text-fg">{label}</span>
      <span class="text-xs text-faint">{hint}</span>
    </span>
  </button>
{/snippet}

<div class="relative">
  <button
    class="relative z-30 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors disabled:opacity-50
      {open ? 'bg-selected text-fg' : 'text-dim hover:bg-hover hover:text-fg'}"
    disabled={busy}
    aria-haspopup="menu"
    title="Conversation actions"
    aria-expanded={open}
    onclick={() => {
      open = !open;
      if (open) void loadForkable();
    }}
  >
    <Icon icon={MessagesSquare} size={14} />
    Conversation
    <Icon icon={ChevronDown} size={12} class="text-faint" />
  </button>

  {#if open}
    <div class="fixed inset-0 z-29" role="presentation" onclick={() => (open = false)}></div>
    <div class="animate-pop absolute right-0 z-30 mt-1 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-edge2 bg-panel2 shadow-overlay" role="menu">
      <div class="flex flex-col p-1">
        {@render item(SquarePen, "New conversation", "Start fresh. Files in the sandbox stay.", () => void run("new_session"))}
        {@render item(Copy, "Clone conversation", "Continue a copy of this thread.", () => void run("clone"))}
        {@render item(Shrink, "Compact conversation", "Summarise older messages to free up context.", () => void run("compact"))}
      </div>
      <div class="border-t border-edge px-3 pt-2 pb-1 text-2xs font-medium tracking-wide text-faint uppercase">Fork from a message</div>
      <div class="max-h-48 overflow-y-auto p-1">
        {#if forkMessages.length === 0}
          <p class="m-0 px-2 py-1.5 text-xs text-faint">No messages to fork from yet.</p>
        {:else}
          {#each forkMessages as fm (fm.entryId)}
            <button
              class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-dim transition-colors hover:bg-hover hover:text-fg"
              role="menuitem"
              title={fm.text}
              onclick={() => void fork(fm.entryId)}
            >
              <Icon icon={GitBranch} size={13} class="text-faint" />
              <span class="truncate">{fm.text}</span>
            </button>
          {/each}
        {/if}
      </div>
      {#if error}
        <p class="m-0 border-t border-edge px-3 py-2 text-xs text-err">{error}</p>
      {/if}
    </div>
  {/if}
</div>
