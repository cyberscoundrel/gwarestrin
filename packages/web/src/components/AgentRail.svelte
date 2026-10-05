<script lang="ts">
  import { store } from "../lib/stores.svelte.js";
  import { modelDisplayName } from "../lib/format.js";
  import DeleteAgentModal from "./DeleteAgentModal.svelte";
  import GraphQueuePanel from "./GraphQueuePanel.svelte";

  let {
    oncreate,
    onnavigate,
    oneditprofile,
  }: {
    oncreate?: () => void;
    onnavigate?: () => void;
    oneditprofile?: (id: string) => void;
  } = $props();

  let deleteTarget = $state<{ id: string; name: string } | null>(null);
  let showReview = $state(false);
  let collapsed = $state<Record<string, boolean>>({});

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

  const groupedProfiles = $derived(
    store.profiles.length > 0
      ? store.profiles
      : [{ id: "default", name: "Default" } as import("@gwarestrin/shared").ProfileRecord],
  );
</script>

<nav class="flex h-full flex-col gap-3 px-2 py-3">
  <div class="flex items-center gap-2 px-2">
    <svg viewBox="0 0 24 24" class="h-4 w-4 text-fg" aria-hidden="true">
      <path d="M12 3v9M7 14h10M8.5 17h7M10 20h4" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" />
    </svg>
    <span class="font-bold tracking-[0.12em]">ground chat</span>
    <span
      class="h-[7px] w-[7px] rounded-full {store.wsStatus === 'open' ? 'bg-ok' : 'bg-err'}"
      role="img"
      aria-label={store.wsStatus === "open" ? "connected" : "disconnected"}
      title={store.wsStatus === "open" ? "connected to server" : "disconnected from server"}
    ></span>
  </div>

  <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
    {#each groupedProfiles as profile (profile.id)}
      {@const members = store.agentsInProfile(profile.id)}
      {@const isCollapsed = collapsed[profile.id] ?? false}
      <div class="rounded-md">
        <div class="group grid grid-cols-[14px_1fr_auto] items-center gap-1 rounded-md px-2 py-1.5 hover:bg-[#1a1d26]">
          <button
            class="cursor-pointer border-none bg-transparent p-0 text-[0.7rem] text-muted transition-transform {isCollapsed ? '' : 'rotate-90'}"
            aria-label="toggle {profile.name}"
            onclick={() => (collapsed[profile.id] = !isCollapsed)}
          >
            ▶
          </button>
          <button
            class="cursor-pointer overflow-hidden truncate border-none bg-transparent p-0 text-left text-[0.85rem] font-semibold tracking-wide text-fg"
            title={profile.description ?? profile.name}
            onclick={() => oneditprofile?.(profile.id)}
          >
            {profile.name}
          </button>
          <button
            class="cursor-pointer rounded border-none bg-transparent px-1 text-[0.7rem] text-muted hover:text-fg"
            title="edit profile"
            aria-label="edit profile {profile.name}"
            onclick={() => oneditprofile?.(profile.id)}
          >
            ✎
          </button>
        </div>
        {#if !isCollapsed}
          {#if members.length === 0}
            <div class="px-6 py-1 text-[0.78rem] text-muted italic">no agents</div>
          {/if}
          <ul class="m-0 list-none border-l border-edge/60 p-0 ml-4">
            {#each members as a (a.id)}
              <li class="group relative">
                <button
                  class="grid w-full grid-cols-[10px_1fr_auto] items-center gap-2 rounded-md px-2.5 py-2 text-left pointer-coarse:pr-8
                    text-[0.9rem] text-fg cursor-pointer border-none bg-transparent hover:bg-[#1a1d26]
                    {a.id === store.selectedId && !store.editingProfileId ? 'bg-[#20242f]' : ''}"
                  onclick={() => {
                    store.select(a.id);
                    onnavigate?.();
                  }}
                >
                  <span class="h-2 w-2 rounded-full {statusColor(a.status)}"></span>
                  <span class="truncate pr-4">{a.name}</span>
                  {#if a.unread > 0 && a.id !== store.selectedId}
                    <span class="rounded-full bg-accent px-1.5 text-[0.7rem] font-bold text-[#0b0c10] group-hover:hidden">
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
                    group-hover:block group-focus-within:block pointer-coarse:block pointer-coarse:px-2 pointer-coarse:py-1"
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
        {/if}
      </div>
    {/each}
  </div>

  <div class="flex flex-col gap-1">
    <button
      class="cursor-pointer rounded-md border border-dashed border-[#333845] bg-transparent px-4 py-2 text-muted
        hover:border-accent hover:text-fg"
      onclick={() => oncreate?.()}
    >
      + new agent
    </button>
    <button
      class="cursor-pointer rounded-md border border-dashed border-[#333845] bg-transparent px-4 py-1 text-xs text-muted
        hover:border-accent hover:text-fg"
      onclick={() => oneditprofile?.("new")}
    >
      + new profile
    </button>
    <button
      class="cursor-pointer rounded-md border-none bg-transparent px-4 py-1 text-xs text-muted hover:text-fg"
      onclick={() => (showReview = true)}
    >
      graph review
    </button>
  </div>
</nav>

{#if showReview}
  <GraphQueuePanel onclose={() => (showReview = false)} />
{/if}

{#if deleteTarget}
  <DeleteAgentModal
    agentId={deleteTarget.id}
    agentName={deleteTarget.name}
    onclose={() => (deleteTarget = null)}
  />
{/if}
