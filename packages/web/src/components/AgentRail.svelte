<script lang="ts">
  import { ChevronRight, Inbox, Pencil, Plus, UserPlus, X } from "lucide";
  import { store } from "../lib/stores.svelte.js";
  import { modelDisplayName } from "../lib/format.js";
  import DeleteAgentModal from "./DeleteAgentModal.svelte";
  import GraphQueuePanel from "./GraphQueuePanel.svelte";
  import Icon from "./Icon.svelte";

  let {
    oncreate,
    onnavigate,
    oneditprofile,
    inDrawer = false,
  }: {
    /** rendered in the mobile drawer (leaves room for its close button) */
    inDrawer?: boolean;
    oncreate?: () => void;
    onnavigate?: () => void;
    oneditprofile?: (id: string) => void;
  } = $props();

  let deleteTarget = $state<{ id: string; name: string } | null>(null);
  let showReview = $state(false);
  let collapsed = $state<Record<string, boolean>>({});

  function statusDot(status: string): { cls: string; label: string } {
    switch (status) {
      case "running":
        return { cls: "bg-ok", label: "running" };
      case "streaming":
        return { cls: "bg-signal animate-working", label: "working" };
      case "starting":
        return { cls: "bg-warn animate-working", label: "starting" };
      case "error":
        return { cls: "bg-err", label: "error" };
      default:
        return { cls: "bg-edge2", label: "stopped" };
    }
  }

  const groupedProfiles = $derived(
    store.profiles.length > 0
      ? store.profiles
      : [{ id: "default", name: "Default" } as import("@gwarestrin/shared").ProfileRecord],
  );

  const ghost =
    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-dim transition-colors hover:bg-hover hover:text-fg";
</script>

<nav class="flex h-full flex-col" aria-label="agents">
  <!-- wordmark -->
  <div class="flex h-12 shrink-0 items-center gap-2 px-4 {inDrawer ? 'pr-12' : ''}">
    <svg viewBox="0 0 24 24" class="h-4 w-4 text-fg" aria-hidden="true">
      <path d="M12 3v9M7 14h10M8.5 17h7M10 20h4" stroke="currentColor" stroke-width="1.75" fill="none" stroke-linecap="round" />
    </svg>
    <span class="text-sm font-semibold tracking-[0.06em] text-fg">ground chat</span>
    <span
      class="ml-auto h-1.5 w-1.5 rounded-full {store.wsStatus === 'open' ? 'bg-ok' : 'bg-err'}"
      role="img"
      aria-label={store.wsStatus === "open" ? "connected" : "disconnected"}
      title={store.wsStatus === "open" ? "Connected to the workspace server" : "Disconnected from the workspace server"}
    ></span>
  </div>

  <!-- agent profiles > agents -->
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pt-1 pb-4">
    {#each groupedProfiles as profile (profile.id)}
      {@const members = store.agentsInProfile(profile.id)}
      {@const isCollapsed = collapsed[profile.id] ?? false}
      <section class="flex flex-col gap-0.5">
        <div class="group flex items-center gap-1 pr-1">
          <button
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium text-faint transition-colors hover:text-fg"
            aria-expanded={!isCollapsed}
            title={profile.description ?? profile.name}
            onclick={() => (collapsed[profile.id] = !isCollapsed)}
          >
            <Icon icon={ChevronRight} size={12} class="transition-transform duration-150 {isCollapsed ? '' : 'rotate-90'}" />
            <span class="truncate">{profile.name}</span>
            <span class="tabular ml-auto text-2xs text-faint">{members.length}</span>
          </button>
          <button
            class="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-faint opacity-0 transition hover:bg-hover hover:text-fg
              group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
            title="Edit agent profile"
            aria-label="edit agent profile {profile.name}"
            onclick={() => oneditprofile?.(profile.id)}
          >
            <Icon icon={Pencil} size={13} />
          </button>
        </div>

        {#if !isCollapsed}
          {#if members.length === 0}
            <p class="m-0 px-2 py-1 pl-7 text-xs text-faint">No agents yet</p>
          {/if}
          <ul class="m-0 flex list-none flex-col gap-px p-0">
            {#each members as a (a.id)}
              {@const dot = statusDot(store.isWorking(a.id) && a.status === "running" ? "streaming" : a.status)}
              {@const selected = a.id === store.selectedId && !store.editingProfileId && !store.showNewChat}
              <li class="group relative">
                <button
                  class="grid w-full cursor-pointer grid-cols-[16px_1fr_auto] items-center gap-x-1.5 rounded-md py-1.5 pr-2 pl-1.5 text-left
                    transition-colors pointer-coarse:pr-9 {selected ? 'bg-selected text-fg' : 'text-fg hover:bg-hover'}"
                  aria-current={selected ? "page" : undefined}
                  onclick={() => {
                    store.select(a.id);
                    onnavigate?.();
                  }}
                >
                  <span class="mx-auto h-1.5 w-1.5 rounded-full {dot.cls}" role="img" aria-label={dot.label} title={dot.label}></span>
                  <span class="truncate text-sm">{a.name}</span>
                  {#if a.unread > 0 && a.id !== store.selectedId}
                    <span
                      class="tabular rounded-full bg-signal-soft px-1.5 text-2xs font-medium text-signal group-hover:invisible"
                      aria-label="{a.unread} unread"
                    >
                      {a.unread > 99 ? "99+" : a.unread}
                    </span>
                  {/if}
                  {#if a.model}
                    <span class="col-start-2 truncate font-mono text-2xs text-faint" title="{a.model.provider}/{a.model.modelId}">
                      {modelDisplayName(a.model.provider, a.model.modelId, store.providers)}
                    </span>
                  {/if}
                </button>
                <button
                  class="absolute top-1.5 right-1.5 grid h-6 w-6 cursor-pointer place-items-center rounded-md text-faint opacity-0 transition
                    hover:bg-err-soft hover:text-err group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                  title="Delete {a.name}"
                  aria-label="delete {a.name}"
                  onclick={(e) => {
                    e.stopPropagation();
                    deleteTarget = { id: a.id, name: a.name };
                  }}
                >
                  <Icon icon={X} size={13} />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>

  <!-- actions: one primary, two quiet -->
  <div class="flex shrink-0 flex-col gap-0.5 border-t border-edge p-2">
    <button
      class="mb-1 flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-edge2 bg-panel2 px-3 py-1.5 text-sm font-medium text-fg
        transition-colors hover:border-faint {store.showNewChat ? 'border-signal' : ''}"
      onclick={() => oncreate?.()}
    >
      <Icon icon={Plus} size={14} />
      New agent
    </button>
    <button class={ghost} onclick={() => oneditprofile?.("new")}>
      <Icon icon={UserPlus} size={14} />
      New agent profile
    </button>
    <button class={ghost} onclick={() => (showReview = true)}>
      <Icon icon={Inbox} size={14} />
      Approvals
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
