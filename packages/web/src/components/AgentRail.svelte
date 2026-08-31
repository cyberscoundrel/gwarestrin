<script lang="ts">
  import { store } from "../lib/stores.svelte.js";
  import { modelDisplayName } from "../lib/format.js";
  import DeleteAgentModal from "./DeleteAgentModal.svelte";

  let { oncreate, onnavigate } = $props<{ oncreate?: () => void; onnavigate?: () => void }>();

  let deleteTarget = $state<{ id: string; name: string } | null>(null);

  function statusColor(status: string): string {
    switch (status) {
      case "running":
        return "bg-ok";
      case "streaming":
      case "starting":
        return "bg-warn animate-pulse";
      case "error":
        return "bg-err";
      default:
        return "bg-[#565f89]";
    }
  }
</script>

<nav class="flex h-full flex-col gap-3 px-2 py-3">
  <div class="flex items-center gap-2 px-2">
    <span class="font-bold tracking-[0.12em]">gwarestrin</span>
    <span
      class="h-[7px] w-[7px] rounded-full {store.wsStatus === 'open' ? 'bg-ok' : 'bg-err'}"
      title="ws: {store.wsStatus}"
    ></span>
  </div>

  <ul class="m-0 flex list-none flex-col flex-1 gap-0.5 overflow-y-auto p-0">
    {#each store.agents as a (a.id)}
      <li class="group relative">
        <button
          class="grid w-full grid-cols-[10px_1fr_auto] items-center gap-2 rounded-md px-2.5 py-2 text-left
            text-[0.92rem] text-fg cursor-pointer border-none bg-transparent hover:bg-[#1a1d26]
            {a.id === store.selectedId ? 'bg-[#20242f]' : ''}"
          onclick={() => {
            store.select(a.id);
            onnavigate?.();
          }}
        >
          <span class="h-2 w-2 rounded-full {statusColor(a.status)}"></span>
          <span class="truncate pr-4">{a.name}</span>
          {#if a.unread > 0 && a.id !== store.selectedId}
            <span class="rounded-full bg-accent px-1.5 text-[0.7rem] font-bold text-[#0b0c10]">
              {a.unread > 99 ? "99+" : a.unread}
            </span>
          {/if}
          {#if a.model}
            <span class="col-start-2 truncate text-[0.7rem] text-muted" title={a.model.modelId}>
              {modelDisplayName(a.model.provider, a.model.modelId, store.providers)}
            </span>
          {/if}
        </button>
        <button
          class="absolute top-1.5 right-1.5 hidden rounded px-1 text-xs text-muted hover:bg-[#2a1218] hover:text-err
            group-hover:block"
          title="delete {a.name}"
          aria-label="delete {a.name}"
          onclick={(e) => {
            e.stopPropagation();
            deleteTarget = { id: a.id, name: a.name };
          }}
        >
          ✕
        </button>
      </li>
    {/each}
  </ul>

  <button
    class="cursor-pointer rounded-md border border-dashed border-[#333845] bg-transparent px-4 py-2 text-muted
      hover:border-accent hover:text-fg"
    onclick={() => oncreate?.()}
  >
    + new agent
  </button>
</nav>

{#if deleteTarget}
  <DeleteAgentModal
    agentId={deleteTarget.id}
    agentName={deleteTarget.name}
    onclose={() => (deleteTarget = null)}
  />
{/if}
