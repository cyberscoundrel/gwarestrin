<script lang="ts">
  import { Download, Trash2 } from "lucide";
  import { api } from "../lib/api.js";
  import { store } from "../lib/stores.svelte.js";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";

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
      // back to the composer rather than jumping into some other agent
      if (wasSelected) store.select(null);
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      busy = false;
    }
  }
</script>

<Dialog {onclose} labelledby="delete-agent-title" role="alertdialog" dismissible={!busy}>
  <div class="grid gap-3 p-5">
    <div class="flex items-start gap-3">
      <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-err/30 bg-err-soft text-err">
        <Icon icon={Trash2} size={15} />
      </span>
      <div class="grid min-w-0 gap-1">
        <h3 id="delete-agent-title" class="m-0 text-base font-medium break-words text-fg">Delete {agentName}?</h3>
        <p class="m-0 text-sm text-dim">
          This permanently erases the agent's files, conversation history and configuration. It can't be undone.
        </p>
      </div>
    </div>
    {#if error}
      <p class="m-0 text-sm text-err" role="alert">{error}</p>
    {/if}
  </div>
  <div class="flex flex-wrap items-center gap-2 border-t border-edge bg-panel px-5 py-3">
    <button
      class="btn btn-ghost btn-sm"
      onclick={exportTrace}
      disabled={busy}
      title="Download the conversation history (jsonl) first"
    >
      <Icon icon={Download} size={13} />
      {exported ? "History downloaded" : "Export conversation"}
    </button>
    <span class="ml-auto"></span>
    <button class="btn btn-secondary btn-sm" onclick={onclose} disabled={busy}>Cancel</button>
    <button class="btn btn-danger-solid btn-sm" onclick={() => void confirmDelete()} disabled={busy}>
      {busy ? "Deleting…" : "Delete agent"}
    </button>
  </div>
</Dialog>
