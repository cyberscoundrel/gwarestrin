<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "./lib/stores.svelte.js";
  import { ws } from "./lib/ws-client.js";
  import AgentRail from "./components/AgentRail.svelte";
  import ChatView from "./components/ChatView.svelte";
  import NewChat from "./components/NewChat.svelte";
  import ExtensionDialogs from "./components/ExtensionDialogs.svelte";
  import ProfileEditor from "./components/ProfileEditor.svelte";
  import Icon from "./components/Icon.svelte";
  import { Menu, X } from "lucide";

  let drawerOpen = $state(false);
  let createProfileId = $state<string | null>(null);
  let mobile = $state(false);

  // mobile has no rail on screen, so the header names the current view
  const mobileTitle = $derived(
    store.editingProfileId
      ? store.editingProfileId === "new"
        ? "new agent profile"
        : "edit agent profile"
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

  // the only other offline signal is a tiny red dot; show a banner once the
  // socket has been down for a moment (skips the initial connect / blips)
  let offline = $state(false);
  let offlineTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    if (store.wsStatus === "open") {
      if (offlineTimer) clearTimeout(offlineTimer);
      offlineTimer = null;
      offline = false;
    } else if (!offlineTimer) {
      // not restarted by connecting/closed flips during reconnect backoff
      offlineTimer = setTimeout(() => (offline = true), 2000);
    }
  });

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


{#snippet offlineBanner()}
  {#if offline}
    <div role="status" class="flex items-center justify-center gap-2 border-b border-edge bg-err-soft px-3 py-1.5 text-xs text-err">
      <span class="h-1.5 w-1.5 rounded-full bg-err" aria-hidden="true"></span>
      Can't reach the workspace server. Retrying; what you see may be out of date.
    </div>
  {/if}
{/snippet}

{#snippet mainView()}
  {@render offlineBanner()}
  {#if store.editingProfileId}
    <!-- remount per profile: the editor seeds its form once -->
    {#key store.editingProfileId}
      <ProfileEditor profileId={store.editingProfileId} onclose={() => (store.editingProfileId = null)} />
    {/key}
  {:else if store.showNewChat || !store.selected}
    <NewChat preselectProfileId={createProfileId} />
  {:else if store.selected}
    <ChatView agentId={store.selected.id} agentName={store.selected.name} />
  {/if}
{/snippet}

{#if !mobile}
  <div class="grid h-screen grid-cols-[248px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-bg">
    <aside class="min-h-0 border-r border-edge bg-panel">
      <AgentRail oncreate={() => openCreate()} oneditprofile={(id) => openProfileEditor(id)} />
    </aside>
    <main class="flex min-h-0 min-w-0 flex-col overflow-hidden">
      {@render mainView()}
    </main>
  </div>
{:else}
  <div class="grid h-dvh grid-rows-[48px_minmax(0,1fr)] overflow-hidden bg-bg">
    <header class="flex items-center gap-2 border-b border-edge bg-panel px-2">
      <button
        class="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-fg"
        aria-label="menu"
        aria-expanded={drawerOpen}
        onclick={() => (drawerOpen = true)}
      >
        <Icon icon={Menu} size={18} />
      </button>
      <span class="min-w-0 truncate text-sm font-medium text-fg {mobileTitle ? '' : 'font-semibold tracking-[0.06em]'}">
        {mobileTitle ?? "ground chat"}
      </span>
      <span
        class="mr-2 ml-auto h-1.5 w-1.5 rounded-full {store.wsStatus === 'open' ? 'bg-ok' : 'bg-err'}"
        role="img"
        aria-label={store.wsStatus === "open" ? "connected" : "disconnected"}
        title={store.wsStatus === "open" ? "Connected" : "Disconnected"}
      ></span>
    </header>
    {#if drawerOpen}
      <div class="animate-fade fixed inset-0 z-39 bg-scrim" onclick={() => (drawerOpen = false)} role="presentation"></div>
      <aside
        class="animate-drawer fixed top-0 bottom-0 left-0 z-40 w-[min(288px,84vw)] border-r border-edge bg-panel shadow-overlay"
        aria-label="navigation"
      >
        <button
          class="absolute top-2 right-2 z-10 grid h-8 w-8 cursor-pointer place-items-center rounded-md text-dim transition-colors hover:bg-hover hover:text-fg"
          aria-label="close menu"
          onclick={() => (drawerOpen = false)}
        >
          <Icon icon={X} size={16} />
        </button>
        <AgentRail
          inDrawer
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
      </aside>
    {/if}
    <main class="flex min-h-0 min-w-0 flex-col overflow-hidden">
      {@render mainView()}
    </main>
  </div>
{/if}

<ExtensionDialogs />
