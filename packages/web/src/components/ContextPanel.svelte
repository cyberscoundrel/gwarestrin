<script lang="ts">
  import { onMount } from "svelte";
  import { BookOpen, TriangleAlert } from "lucide";
  import PanelHeader from "./PanelHeader.svelte";
  import EmptyState from "./EmptyState.svelte";
  import SkeletonRows from "./SkeletonRows.svelte";

  let { agentId, onclose }: { agentId: string; onclose?: () => void } = $props();

  interface ContextInfo {
    profileName: string;
    engine: { type: string; prompt?: string } | null;
    status: "skipped" | "ok" | "failed";
    block: string | null;
  }

  let info = $state<ContextInfo | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const r = await fetch(`/api/agents/${agentId}/context`);
      if (!r.ok) throw new Error(`${r.status}`);
      info = (await r.json()) as ContextInfo;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });
</script>

{#snippet fact(label: string, value: string, tone: string = "text-fg", mono: boolean = false)}
  <div class="flex items-baseline justify-between gap-3 py-1.5">
    <dt class="text-xs text-faint">{label}</dt>
    <dd class="m-0 truncate text-right text-xs {tone} {mono ? 'font-mono' : ''}">{value}</dd>
  </div>
{/snippet}

<div class="flex h-full flex-col border-l border-edge bg-panel text-sm">
  <PanelHeader title="Briefing" subtitle="What this agent keeps in mind on every turn." icon={BookOpen} {onclose} />

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if error}
      <EmptyState icon={TriangleAlert} tone="err" title="Couldn't load the briefing" hint={error} />
    {:else if !info}
      <SkeletonRows rows={3} />
    {:else}
      <dl class="m-0 divide-y divide-edge border-b border-edge px-4 py-1">
        {@render fact("Agent profile", info.profileName)}
        {@render fact("Built by", info.engine ? info.engine.type : "Nothing", info.engine ? "text-fg" : "text-faint", Boolean(info.engine))}
        {@render fact(
          "Status",
          info.status === "ok" ? "Ready" : info.status === "failed" ? "Failed to build" : "Not built",
          info.status === "ok" ? "text-ok" : info.status === "failed" ? "text-err" : "text-faint",
        )}
      </dl>
      {#if info.engine?.prompt}
        <div class="border-b border-edge px-4 py-3">
          <p class="eyebrow m-0 mb-1">Focus</p>
          <p class="m-0 text-xs text-dim">{info.engine.prompt}</p>
        </div>
      {/if}
      {#if info.block}
        <div class="p-4">
          <pre class="m-0 max-h-none overflow-x-auto rounded-lg border border-edge bg-inset p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">{info.block}</pre>
        </div>
      {:else}
        <EmptyState
          icon={BookOpen}
          title="No briefing for this agent"
          hint={info.engine
            ? "The agent profile has a briefing, but none was built when this agent was created."
            : "Turn on a briefing in the agent profile to give new agents standing knowledge from the graph."}
        />
      {/if}
    {/if}
  </div>
</div>
