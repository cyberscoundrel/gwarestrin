<script lang="ts">
  import { api } from "../lib/api.js";
  import { store } from "../lib/stores.svelte.js";

  let { agentId }: { agentId: string } = $props();

  const record = $derived(store.agents.find((a) => a.id === agentId));
  const runtime = $derived(store.runtimeFor(agentId));
  const status = $derived(runtime?.status ?? record?.status ?? "stopped");
  const profile = $derived(store.profiles.find((p) => p.id === (record?.profileId || "default")));
  const live = $derived(status === "running" || status === "starting" || status === "streaming");

  let busy = $state(false);
  let error = $state<string | null>(null);

  const statusView = $derived.by((): { label: string; dot: string } => {
    switch (status) {
      case "running":
        return { label: "running", dot: "bg-ok" };
      case "streaming":
        return { label: "working", dot: "bg-warn animate-pulse" };
      case "starting":
        return { label: "starting…", dot: "bg-warn animate-pulse" };
      case "error":
        return { label: "error", dot: "bg-err" };
      default:
        return { label: "stopped", dot: "bg-[#565f89]" };
    }
  });

  async function toggleRunning(): Promise<void> {
    busy = true;
    error = null;
    try {
      if (live) await api.stopAgent(agentId);
      else await api.startAgent(agentId);
      await store.refreshAgents();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge bg-panel px-3 py-2">
  <div class="flex min-w-0 items-center gap-2">
    <span class="h-2 w-2 shrink-0 rounded-full {statusView.dot}" aria-hidden="true"></span>
    <!-- the mobile app header already shows the agent name -->
    <h2 class="m-0 truncate text-base font-semibold text-fg max-[900px]:hidden">{record?.name ?? agentId}</h2>
    <span class="truncate text-xs text-muted" title={profile?.description ?? undefined}>
      <span class="max-[900px]:hidden">·</span> agent profile <span class="text-fg">{profile?.name ?? record?.profileId ?? "Default"}</span>
    </span>
    <span class="text-xs text-muted" role="status">· {statusView.label}</span>
  </div>

  <div class="ml-auto flex items-center gap-2">
    {#if error}
      <span class="max-w-48 truncate text-xs text-err" title={error}>{error}</span>
    {/if}
    <button
      class="select-compact bg-none pr-2 disabled:opacity-50 {live ? '' : '!border-accent !text-accent'}"
      disabled={busy}
      title={live ? "stop this agent's sandbox (its files and conversations are kept)" : "start this agent's sandbox"}
      onclick={() => void toggleRunning()}
    >
      {busy ? (live ? "stopping…" : "starting…") : live ? "stop agent" : "start agent"}
    </button>
  </div>
</div>
