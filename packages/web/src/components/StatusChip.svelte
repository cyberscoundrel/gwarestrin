<script lang="ts">
  import type { IconNode } from "lucide";
  import Icon from "./Icon.svelte";

  // Compact ops-style status chip: icon + short fact, tooltip with the detail.
  // tone: signal (trusted/local), warn (data leaves the workspace), err, neutral
  let {
    icon,
    label,
    title,
    tone = "neutral",
    onclick,
  }: {
    icon: IconNode;
    label: string;
    title: string;
    tone?: "signal" | "warn" | "err" | "neutral" | "quiet";
    onclick?: (() => void) | undefined;
  } = $props();

  const toneCls = $derived(
    {
      signal: "border-signal/30 bg-signal-soft text-signal",
      warn: "border-warn/30 bg-warn-soft text-warn",
      err: "border-err/30 bg-err-soft text-err",
      neutral: "border-edge2 text-dim",
      quiet: "border-edge text-faint",
    }[tone],
  );
  const base = "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs whitespace-nowrap";
</script>

{#if onclick}
  <button class="{base} {toneCls} cursor-pointer transition-colors hover:border-faint" {title} aria-label="{label}: {title}" {onclick}>
    <Icon {icon} size={13} />
    <span class="truncate">{label}</span>
  </button>
{:else}
  <span class="{base} {toneCls}" {title} role="note" aria-label="{label}: {title}">
    <Icon {icon} size={13} />
    <span class="truncate">{label}</span>
  </span>
{/if}
