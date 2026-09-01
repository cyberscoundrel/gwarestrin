<script lang="ts">
  import { store } from "../lib/stores.svelte.js";
  import { ws } from "../lib/ws-client.js";
  import { getAdapter } from "../lib/rpc-agent-adapter.js";

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

<div class="relative">
  <button
    class="select-compact relative z-30"
    disabled={busy}
    onclick={() => {
      open = !open;
      if (open) void loadForkable();
    }}
  >
    session
  </button>

  {#if open}
    <div class="fixed inset-0 z-29" role="presentation" onclick={() => (open = false)}></div>
    <div class="absolute right-0 z-30 mt-1 w-72 rounded-lg border border-edge2 bg-panel2 shadow-xl">
      <div class="flex flex-col gap-0.5 p-1.5">
        <button class="rounded px-2 py-1.5 text-left text-sm hover:bg-[#1a1d26]" onclick={() => void run("new_session")}>new session</button>
        <button class="rounded px-2 py-1.5 text-left text-sm hover:bg-[#1a1d26]" onclick={() => void run("clone")}>clone branch</button>
        <button class="rounded px-2 py-1.5 text-left text-sm hover:bg-[#1a1d26]" onclick={() => void run("compact")}>compact context</button>
      </div>
      <div class="border-t border-edge px-3 py-1.5 text-xs font-semibold text-muted">fork from message</div>
      <div class="max-h-48 overflow-y-auto p-1.5">
        {#if forkMessages.length === 0}
          <p class="px-2 py-1 text-xs text-muted">no fork points</p>
        {:else}
          {#each forkMessages as fm (fm.entryId)}
            <button
              class="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-[#1a1d26]"
              title={fm.text}
              onclick={() => void fork(fm.entryId)}
            >
              {fm.text.slice(0, 60)}{fm.text.length > 60 ? "…" : ""}
            </button>
          {/each}
        {/if}
      </div>
      {#if error}
        <p class="border-t border-edge px-3 py-1.5 text-xs text-err">{error}</p>
      {/if}
    </div>
  {/if}
</div>
