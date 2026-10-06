<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";

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

<div class="flex h-full flex-col border-l border-edge bg-panel text-sm">
  <div class="flex items-center gap-2 border-b border-edge px-3 py-2">
    <span class="font-semibold tracking-wide">briefing</span>
    <button
      class="ml-auto rounded border border-edge2 bg-transparent px-2 py-0.5 text-xs text-dim hover:text-fg"
      aria-label="close briefing"
      onclick={() => onclose?.()}
    >
      ✕
    </button>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto p-3">
    {#if error}
      <p class="text-err">{error}</p>
    {:else if !info}
      <p class="text-dim">loading…</p>
    {:else}
      <div class="mb-3 grid gap-1 text-xs text-dim">
        <span>agent profile: <span class="text-fg">{info.profileName}</span></span>
        <span>
          built by:
          {#if info.engine}
            <span class="text-fg">{info.engine.type}</span>
            {#if info.engine.prompt}
              — <span class="italic">“{info.engine.prompt}”</span>
            {/if}
          {:else}
            nothing — this agent profile has no briefing
          {/if}
        </span>
        <span>
          status:
          <span class={info.status === "ok" ? "text-ok" : info.status === "failed" ? "text-err" : "text-dim"}>
            {info.status === "ok" ? "ready" : info.status === "failed" ? "failed to build" : "not built"}
          </span>
        </span>
      </div>
      {#if info.block}
        <pre class="m-0 overflow-x-auto whitespace-pre-wrap rounded-md border border-edge bg-inset p-3 text-xs text-fg">{info.block}</pre>
      {:else}
        <p class="text-dim italic">no briefing was generated for this agent</p>
      {/if}
    {/if}
  </div>

  <div class="border-t border-edge px-3 py-1.5 text-xs text-dim">
    the agent keeps this briefing in mind on every turn
  </div>
</div>
