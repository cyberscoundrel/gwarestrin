<script lang="ts">
  import { api } from "../lib/api.js";
  import { store } from "../lib/stores.svelte.js";
  import { modelDisplayName, whereItRuns } from "../lib/format.js";

  let {
    agentId,
    ondrawer,
  }: {
    agentId: string;
    /** open the tools / briefing drawer (only offered while the agent runs) */
    ondrawer?: ((drawer: "mcp" | "context") => void) | undefined;
  } = $props();

  const record = $derived(store.agents.find((a) => a.id === agentId));
  const runtime = $derived(store.runtimeFor(agentId));
  const status = $derived(runtime?.status ?? record?.status ?? "stopped");
  const profile = $derived(store.profiles.find((p) => p.id === (record?.profileId || "default")));
  const live = $derived(status === "running" || status === "starting" || status === "streaming");

  // ---- trust strip: where the model runs, tool connections, briefing ----
  // model: the agent's declared model, else the workspace default
  const model = $derived(
    record?.model ??
      (store.defaultProvider && store.defaultModel
        ? { provider: store.defaultProvider, modelId: store.defaultModel }
        : null),
  );
  const where = $derived(model ? whereItRuns(model.provider, store.providers) : null);
  const tools = $derived(record?.mcpServers ?? []);
  const briefing = $derived.by((): { label: string; tone: string; title: string } => {
    const s = record?.contextStatus;
    const source = profile?.contextEngine?.type;
    if (s === "ok") {
      return { label: "briefing", tone: "text-fg", title: `briefing built${source ? ` by ${source}` : ""} from the knowledge graph` };
    }
    if (s === "failed") {
      return { label: "briefing failed", tone: "text-err", title: "the briefing could not be built when this agent was created" };
    }
    if (source) {
      return { label: "no briefing", tone: "text-dim", title: `the agent profile has a ${source} briefing, but none was built for this agent` };
    }
    return { label: "no briefing", tone: "text-dim", title: "this agent profile has no briefing" };
  });
  const chip = "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs";
  const canOpen = $derived(live && ondrawer !== undefined);

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
        return { label: "stopped", dot: "bg-faint" };
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

<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-edge bg-panel px-3 py-2">
  <div class="flex min-w-0 items-center gap-2">
    <span class="h-2 w-2 shrink-0 rounded-full {statusView.dot}" aria-hidden="true"></span>
    <!-- the mobile app header already shows the agent name -->
    <h2 class="m-0 truncate text-base font-semibold text-fg max-[900px]:hidden">{record?.name ?? agentId}</h2>
    <span class="truncate text-xs text-dim" title={profile?.description ?? undefined}>
      <span class="max-[900px]:hidden">·</span> agent profile <span class="text-fg">{profile?.name ?? record?.profileId ?? "Default"}</span>
    </span>
    <span class="text-xs text-dim" role="status">· {statusView.label}</span>
    {#if store.statusLineFor(agentId)}
      <span class="truncate text-xs text-dim" title={store.statusLineFor(agentId)}>· {store.statusLineFor(agentId)}</span>
    {/if}
  </div>

  <ul class="m-0 flex min-w-0 list-none flex-wrap items-center gap-1.5 p-0" aria-label="what this agent can reach">
    <li class="min-w-0">
      {#if where && model}
        <span
          class="{chip} {where.tier === 'local' ? 'border-ok/40 text-ok' : 'border-warn/40 text-warn'}"
          title="{where.tier === 'local'
            ? 'the model runs on your own infrastructure'
            : `prompts and anything the agent reads are sent to ${model.provider}`} · {modelDisplayName(model.provider, model.modelId, store.providers)}"
        >
          <span class="truncate">{where.label}</span>
        </span>
      {:else}
        <span class="{chip} border-edge2 text-dim" title="no model is set for this agent or the workspace">no model</span>
      {/if}
    </li>
    <li>
      {#if canOpen}
        <button
          class="{chip} cursor-pointer border-edge2 bg-transparent text-fg hover:border-signal"
          title={tools.length ? `switched on: ${tools.join(", ")} (open tools)` : "no tool connections switched on (open tools)"}
          onclick={() => ondrawer?.("mcp")}
        >
          {tools.length} tool connection{tools.length === 1 ? "" : "s"}
        </button>
      {:else}
        <span class="{chip} border-edge2 text-fg" title={tools.length ? `switched on: ${tools.join(", ")}` : "no tool connections switched on"}>
          {tools.length} tool connection{tools.length === 1 ? "" : "s"}
        </span>
      {/if}
    </li>
    <li>
      {#if canOpen}
        <button
          class="{chip} cursor-pointer border-edge2 bg-transparent {briefing.tone} hover:border-signal"
          title="{briefing.title} (open briefing)"
          onclick={() => ondrawer?.("context")}
        >
          {briefing.label}
        </button>
      {:else}
        <span class="{chip} border-edge2 {briefing.tone}" title={briefing.title}>{briefing.label}</span>
      {/if}
    </li>
  </ul>

  <div class="ml-auto flex items-center gap-2">
    {#if error}
      <span class="max-w-48 truncate text-xs text-err" title={error}>{error}</span>
    {/if}
    <button
      class="select-compact bg-none pr-2 disabled:opacity-50 {live ? '' : '!border-signal !text-signal'}"
      disabled={busy}
      title={live ? "stop this agent's sandbox (its files and conversations are kept)" : "start this agent's sandbox"}
      onclick={() => void toggleRunning()}
    >
      {busy ? (live ? "stopping…" : "starting…") : live ? "stop agent" : "start agent"}
    </button>
  </div>
</div>
