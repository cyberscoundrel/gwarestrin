<script lang="ts">
  import type { Snippet } from "svelte";
  import type { IconNode } from "lucide";
  import Icon from "./Icon.svelte";

  // Invitation-style empty state: what this place is for and the next step.
  let {
    icon,
    title,
    hint,
    tone = "neutral",
    children,
  }: {
    icon: IconNode;
    title: string;
    hint?: string | undefined;
    tone?: "neutral" | "err";
    children?: Snippet | undefined;
  } = $props();
</script>

<div class="animate-enter grid justify-items-center gap-2 px-6 py-10 text-center">
  <span
    class="grid h-9 w-9 place-items-center rounded-lg border {tone === 'err'
      ? 'border-err/30 bg-err-soft text-err'
      : 'border-edge bg-panel2 text-faint'}"
  >
    <Icon {icon} size={16} />
  </span>
  <p class="m-0 text-sm font-medium {tone === 'err' ? 'text-err' : 'text-fg'}">{title}</p>
  {#if hint}
    <p class="m-0 max-w-64 text-xs text-faint">{hint}</p>
  {/if}
  {#if children}
    <div class="mt-1">{@render children()}</div>
  {/if}
</div>
