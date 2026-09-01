<script lang="ts">
  import { api } from "../lib/api.js";
  import { store } from "../lib/stores.svelte.js";

  let { agentId, agentName, onclose }: { agentId: string; agentName: string; onclose: () => void } = $props();

  let busy = $state(false);
  let exported = $state(false);
  let error = $state<string | null>(null);

  function exportTrace(): void {
    // plain navigation download; browser handles it as an attachment
    window.open(api.exportUrl(agentId), "_blank");
    exported = true;
  }

  async function confirmDelete(): Promise<void> {
    busy = true;
    error = null;
    try {
      await api.deleteAgent(agentId, true);
      const wasSelected = store.selectedId === agentId;
      await store.refreshAgents();
      if (wasSelected) store.select(store.agents[0]?.id ?? null);
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      busy = false;
    }
  }
</script>

<div class="fixed inset-0 z-50 bg-black/55" role="presentation" onclick={onclose}></div>
<div
  class="fixed top-1/2 left-1/2 z-51 grid w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-xl
    border border-edge2 bg-panel2 p-5"
  role="alertdialog"
  aria-modal="true"
>
  <h3 class="m-0 tracking-wide">delete {agentName}?</h3>
  <p class="m-0 text-sm text-muted">
    this erases <span class="text-warn font-medium">all data</span> for this agent — workspace files, session
    history, and configuration. this cannot be undone.
  </p>
  {#if error}
    <p class="m-0 text-sm text-err">{error}</p>
  {/if}
  <div class="flex flex-wrap items-center justify-end gap-2">
    <button
      class="cursor-pointer rounded-md border border-edge2 bg-transparent px-3 py-2 text-sm text-muted hover:text-fg"
      onclick={exportTrace}
      disabled={busy}
      title="download the conversation trace (session jsonl)"
    >
      {exported ? "trace downloaded ✓" : "export trace"}
    </button>
    <button class="cursor-pointer rounded-md border border-[#333845] bg-transparent px-4 py-2 text-fg" onclick={onclose} disabled={busy}>
      cancel
    </button>
    <button
      class="cursor-pointer rounded-md bg-err px-4 py-2 font-semibold text-[#0b0c10] disabled:cursor-default disabled:opacity-60"
      onclick={() => void confirmDelete()}
      disabled={busy}
    >
      {busy ? "deleting…" : "delete"}
    </button>
  </div>
</div>
