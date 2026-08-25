<script lang="ts">
  import type { Agent } from "../lib/agent-types.js";
  import "@earendil-works/pi-web-ui";

  let { agent, onApiKeyRequired }: { agent: Agent; onApiKeyRequired?: (provider: string) => Promise<boolean> } = $props();

  let host: HTMLElement;

  // pi-web-ui elements render into light DOM (createRenderRoot -> this);
  // complex props must be assigned imperatively. Re-runs when `agent` changes.
  $effect(() => {
    const el = host?.querySelector("agent-interface") as unknown as Record<string, unknown> | null;
    if (!el) return;
    el.session = agent;
    el.enableAttachments = true;
    el.enableModelSelector = false;
    el.enableThinkingSelector = false;
    // keys live server-side; never prompt from the browser
    el.onApiKeyRequired = async (provider: string) => onApiKeyRequired?.(provider) ?? true;
  });
</script>

<div bind:this={host} class="flex min-h-0 flex-1 flex-col overflow-hidden [&_agent-interface]:flex [&_agent-interface]:min-h-0 [&_agent-interface]:flex-1 [&_agent-interface]:flex-col">
  <agent-interface></agent-interface>
</div>
