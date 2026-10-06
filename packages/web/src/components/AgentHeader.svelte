<script lang="ts">
  import { BookOpen, Cloud, Globe, Server, Square, Wrench } from "lucide";
  import { api } from "../lib/api.js";
  import { store } from "../lib/stores.svelte.js";
  import { modelDisplayName, whereItRuns } from "../lib/format.js";
  import Icon from "./Icon.svelte";
  import StatusChip from "./StatusChip.svelte";

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
  const live = $derived(status === "running" || status === "starting");
  const working = $derived(status === "running" && store.isWorking(agentId));

  // ---- trust strip: where the model runs, tools, briefing, egress ----
  // model: the agent's declared model, else the workspace default
  const model = $derived(
    record?.model ??
      (store.defaultProvider && store.defaultModel
        ? { provider: store.defaultProvider, modelId: store.defaultModel }
        : null),
  );
  const where = $derived(model ? whereItRuns(model.provider, store.providers) : null);
  const tools = $derived(record?.mcpServers ?? []);
  const hosts = $derived(record?.allowedHosts);
  const briefing = $derived.by((): { label: string; tone: "neutral" | "err" | "quiet"; title: string } => {
    const s = record?.contextStatus;
    const source = profile?.contextEngine?.type;
    if (s === "ok") {
      return { label: "Briefing", tone: "neutral", title: `Briefing built${source ? ` by ${source}` : ""} from the knowledge graph` };
    }
    if (s === "failed") {
      return { label: "Briefing failed", tone: "err", title: "The briefing could not be built when this agent was created" };
    }
    if (source) {
      return { label: "No briefing", tone: "quiet", title: `The agent profile has a ${source} briefing, but none was built for this agent` };
    }
    return { label: "No briefing", tone: "quiet", title: "This agent profile has no briefing" };
  });
  const canOpen = $derived(live && ondrawer !== undefined);

  let busy = $state(false);
  let error = $state<string | null>(null);

  const statusView = $derived.by((): { label: string; dot: string; text: string } => {
    if (working) return { label: "Working", dot: "bg-signal animate-working", text: "text-signal" };
    switch (status) {
      case "running":
        return { label: "Running", dot: "bg-ok", text: "text-dim" };
      case "starting":
        return { label: "Starting", dot: "bg-warn animate-working", text: "text-warn" };
      case "error":
        return { label: "Error", dot: "bg-err", text: "text-err" };
      default:
        return { label: "Stopped", dot: "bg-edge2", text: "text-faint" };
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

<header class="flex flex-col gap-2 border-b border-edge bg-bg px-4 pt-2.5 pb-2">
  <!-- row 1: identity + the one start/stop control -->
  <div class="flex min-h-7 items-center gap-2.5">
    <!-- the mobile app header already shows the agent name -->
    <h2 class="m-0 truncate text-base font-medium text-fg max-[900px]:hidden">{record?.name ?? agentId}</h2>
    <span class="flex shrink-0 items-center gap-1.5 text-xs {statusView.text}" role="status">
      <span class="h-1.5 w-1.5 rounded-full {statusView.dot}" aria-hidden="true"></span>
      {statusView.label}
    </span>
    <span class="truncate text-xs text-faint" title={profile?.description ?? undefined}>
      <span class="sr-only">agent profile </span>{profile?.name ?? record?.profileId ?? "Default"}
    </span>
    {#if store.statusLineFor(agentId)}
      <span class="hidden truncate font-mono text-2xs text-faint lg:inline" title={store.statusLineFor(agentId)}>
        {store.statusLineFor(agentId)}
      </span>
    {/if}
    <div class="ml-auto flex shrink-0 items-center gap-2">
      {#if error}
        <span class="max-w-48 truncate text-xs text-err" title={error}>{error}</span>
      {/if}
      {#if live || busy}
        <!-- stopped agents get their start action in the empty state below -->
        <button
          class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-edge2 px-2.5 text-xs font-medium text-dim transition-colors
            hover:border-err/50 hover:text-err disabled:cursor-default disabled:opacity-50"
          disabled={busy}
          title="Stop this agent's sandbox. Its files and conversations are kept."
          onclick={() => void toggleRunning()}
        >
          <Icon icon={Square} size={12} />
          {busy ? "Stopping…" : "Stop agent"}
        </button>
      {/if}
    </div>
  </div>

  <!-- row 2: trust strip (ops-style facts) -->
  <div class="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="what this agent can reach">
    {#if where && model}
      <StatusChip
        icon={where.tier === "local" ? Server : Cloud}
        label={where.label}
        tone={where.tier === "local" ? "signal" : "warn"}
        title="{where.tier === 'local'
          ? 'The model runs on your own infrastructure'
          : `Prompts and anything the agent reads are sent to ${model.provider}`}. Model: {modelDisplayName(model.provider, model.modelId, store.providers)}"
      />
    {:else}
      <StatusChip icon={Cloud} label="No model" tone="quiet" title="No model is set for this agent or the workspace" />
    {/if}
    <StatusChip
      icon={Wrench}
      label="{tools.length} tool{tools.length === 1 ? '' : 's'}"
      title={tools.length ? `Tool connections switched on: ${tools.join(", ")}` : "No tool connections switched on"}
      onclick={canOpen ? () => ondrawer?.("mcp") : undefined}
    />
    <StatusChip
      icon={BookOpen}
      label={briefing.label}
      tone={briefing.tone}
      title={briefing.title}
      onclick={canOpen ? () => ondrawer?.("context") : undefined}
    />
    {#if hosts}
      <!-- egress: only the agent record's allow-list is exposed; the full
           sandbox policy is not in the API yet (see UX-AUDIT P-12) -->
      <StatusChip
        icon={Globe}
        label={hosts.length ? `${hosts.length} host${hosts.length === 1 ? "" : "s"}` : "No extra hosts"}
        tone="quiet"
        title={hosts.length
          ? `Sandbox network allow-list: ${hosts.join(", ")}`
          : "The sandbox's network allow-list adds no hosts. The full egress policy isn't exposed by the API yet."}
      />
    {/if}
  </div>
</header>
