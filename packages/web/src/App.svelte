<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "./lib/stores.svelte.js";
  import { ws } from "./lib/ws-client.js";
  import AgentRail from "./components/AgentRail.svelte";
  import ChatView from "./components/ChatView.svelte";
  import CreateAgentDialog from "./components/CreateAgentDialog.svelte";
  import ExtensionDialogs from "./components/ExtensionDialogs.svelte";

  let drawerOpen = $state(false);
  let showCreate = $state(false);
  let mobile = $state(false);

  $effect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const update = () => (mobile = mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  onMount(() => {
    ws.connect();
    void store.refreshAgents();
    void store.refreshProviders();
    const interval = setInterval(() => void store.refreshAgents(), 15_000);
    return () => clearInterval(interval);
  });
</script>

{#if !mobile}
  <div class="grid h-screen grid-cols-[240px_1fr] grid-rows-[minmax(0,1fr)] overflow-hidden">
    <aside class="min-h-0 overflow-y-auto border-r border-edge bg-panel">
      <AgentRail oncreate={() => (showCreate = true)} />
    </aside>
    <main class="flex min-h-0 min-w-0 flex-col overflow-hidden">
      {#if store.agents.length === 0}
        <div class="m-auto grid gap-2 text-center text-muted">
          <h2 class="m-0 tracking-widest text-fg">no agents</h2>
          <p>create an agent to get started</p>
          <button
            class="mx-auto rounded-md bg-accent px-4 py-2 font-semibold text-[#0b0c10] cursor-pointer hover:brightness-110"
            onclick={() => (showCreate = true)}
          >
            create agent
          </button>
        </div>
      {:else if store.selected}
        <ChatView agentId={store.selected.id} agentName={store.selected.name} />
      {/if}
    </main>
  </div>
{:else}
  <div class="grid h-screen grid-rows-[48px_minmax(0,1fr)] overflow-hidden">
    <header class="flex items-center gap-3 border-b border-edge bg-panel px-3">
      <button
        class="cursor-pointer border-none bg-transparent px-2 py-1 text-xl text-fg"
        aria-label="menu"
        onclick={() => (drawerOpen = true)}
      >
        ☰
      </button>
      <span class="font-semibold tracking-widest">gwarestrin</span>
      <span
        class="ml-auto h-2 w-2 rounded-full {store.wsStatus === 'open' ? 'bg-ok' : 'bg-err'}"
        title={store.wsStatus}
      ></span>
    </header>
    {#if drawerOpen}
      <div class="fixed inset-0 z-39 bg-black/50" onclick={() => (drawerOpen = false)} role="presentation"></div>
      <aside class="fixed top-0 bottom-0 left-0 z-40 w-[min(280px,80vw)] overflow-y-auto border-r border-edge bg-panel transition-transform duration-200 -translate-x-full translate-x-0">
        <AgentRail
          oncreate={() => {
            showCreate = true;
            drawerOpen = false;
          }}
          onnavigate={() => (drawerOpen = false)}
        />
      </aside>
    {/if}
    <main class="flex min-h-0 min-w-0 flex-col overflow-hidden">
      {#if store.agents.length === 0}
        <div class="m-auto grid gap-2 text-center text-muted">
          <h2 class="m-0 tracking-widest text-fg">no agents</h2>
          <button
            class="mx-auto rounded-md bg-accent px-4 py-2 font-semibold text-[#0b0c10] cursor-pointer"
            onclick={() => (showCreate = true)}
          >
            create agent
          </button>
        </div>
      {:else if store.selected}
        <ChatView agentId={store.selected.id} agentName={store.selected.name} />
      {/if}
    </main>
  </div>
{/if}

{#if showCreate}
  <CreateAgentDialog onclose={() => (showCreate = false)} />
{/if}

<ExtensionDialogs />
