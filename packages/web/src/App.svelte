<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "./lib/stores.svelte.js";
  import { ws } from "./lib/ws-client.js";
  import AgentRail from "./components/AgentRail.svelte";
  import ChatView from "./components/ChatView.svelte";
  import NewChat from "./components/NewChat.svelte";
  import ExtensionDialogs from "./components/ExtensionDialogs.svelte";
  import ProfileEditor from "./components/ProfileEditor.svelte";

  let drawerOpen = $state(false);
  let createProfileId = $state<string | null>(null);
  let mobile = $state(false);

  // mobile has no rail on screen, so the header names the current view
  const mobileTitle = $derived(
    store.editingProfileId
      ? store.editingProfileId === "new"
        ? "new profile"
        : "edit profile"
      : store.showNewChat || store.agents.length === 0
        ? null
        : (store.selected?.name ?? null),
  );

  function openCreate(profileId?: string) {
    createProfileId = profileId ?? null;
    store.selectedId = null;
    store.editingProfileId = null;
    store.showNewChat = true;
  }

  function openProfileEditor(id: string) {
    store.editingProfileId = id;
    store.selectedId = null;
    store.showNewChat = false;
  }

  $effect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const update = () => (mobile = mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  $effect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") drawerOpen = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  onMount(() => {
    ws.connect();
    void store.refreshAgents();
    void store.refreshProviders();
    void store.refreshProfiles();
    const interval = setInterval(() => void store.refreshAgents(), 15_000);
    return () => clearInterval(interval);
  });
</script>

{#if !mobile}
  <div class="grid h-screen grid-cols-[240px_1fr] grid-rows-[minmax(0,1fr)] overflow-hidden">
    <aside class="min-h-0 overflow-y-auto border-r border-edge bg-panel">
      <AgentRail oncreate={() => openCreate()} oneditprofile={(id) => openProfileEditor(id)} />
    </aside>
    <main class="flex min-h-0 min-w-0 flex-col overflow-hidden">
      {#if store.editingProfileId}
        <ProfileEditor
          profileId={store.editingProfileId}
          onclose={() => (store.editingProfileId = null)}
        />
      {:else if store.showNewChat || store.agents.length === 0}
        <NewChat preselectProfileId={createProfileId} />
      {:else if store.selected}
        <ChatView agentId={store.selected.id} agentName={store.selected.name} />
      {/if}
    </main>
  </div>
{:else}
  <div class="grid h-dvh grid-rows-[48px_minmax(0,1fr)] overflow-hidden">
    <header class="flex items-center gap-3 border-b border-edge bg-panel px-3">
      <button
        class="cursor-pointer border-none bg-transparent px-2 py-1 text-xl text-fg"
        aria-label="menu"
        onclick={() => (drawerOpen = true)}
      >
        ☰
      </button>
      <span class="min-w-0 truncate font-semibold {mobileTitle ? '' : 'tracking-widest'}">{mobileTitle ?? "ground chat"}</span>
      <span
        class="ml-auto h-2 w-2 rounded-full {store.wsStatus === 'open' ? 'bg-ok' : 'bg-err'}"
        title={store.wsStatus}
      ></span>
    </header>
    {#if drawerOpen}
      <div class="fixed inset-0 z-39 bg-black/50" onclick={() => (drawerOpen = false)} role="presentation"></div>
      <aside class="fixed top-0 bottom-0 left-0 z-40 flex w-[min(280px,80vw)] flex-col border-r border-edge bg-panel">
        <div class="flex justify-end px-3 pt-2">
          <button
            class="cursor-pointer rounded border-none bg-transparent px-1.5 text-muted hover:text-fg"
            aria-label="close menu"
            onclick={() => (drawerOpen = false)}
          >
            ✕
          </button>
        </div>
        <div class="min-h-0 flex-1">
          <AgentRail
            oncreate={() => {
              openCreate();
              drawerOpen = false;
            }}
            oneditprofile={(id) => {
              openProfileEditor(id);
              drawerOpen = false;
            }}
            onnavigate={() => (drawerOpen = false)}
          />
        </div>
      </aside>
    {/if}
    <main class="flex min-h-0 min-w-0 flex-col overflow-hidden">
      {#if store.editingProfileId}
        <ProfileEditor
          profileId={store.editingProfileId}
          onclose={() => (store.editingProfileId = null)}
        />
      {:else if store.showNewChat || store.agents.length === 0}
        <NewChat preselectProfileId={createProfileId} />
      {:else if store.selected}
        <ChatView agentId={store.selected.id} agentName={store.selected.name} />
      {/if}
    </main>
  </div>
{/if}


<ExtensionDialogs />
