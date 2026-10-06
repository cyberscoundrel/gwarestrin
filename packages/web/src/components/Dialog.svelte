<script lang="ts">
  import type { Snippet } from "svelte";

  // Modal shell: scrim + centered panel, one overlay shadow, Escape closes.
  let {
    onclose,
    labelledby,
    role = "dialog",
    width = "28rem",
    dismissible = true,
    z = 50,
    children,
  }: {
    onclose: () => void;
    labelledby: string;
    role?: "dialog" | "alertdialog";
    width?: string;
    /** false while an action is in flight: Escape/scrim do nothing */
    dismissible?: boolean;
    z?: number;
    children: Snippet;
  } = $props();

  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) onclose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
</script>

<div
  class="animate-fade fixed inset-0 bg-scrim"
  style="z-index: {z}"
  role="presentation"
  onclick={() => dismissible && onclose()}
></div>
<div
  class="animate-pop fixed top-1/2 left-1/2 flex max-h-[85dvh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl
    border border-edge2 bg-panel2 shadow-overlay"
  style="z-index: {z + 1}; width: min({width}, calc(100vw - 2rem))"
  {role}
  aria-modal="true"
  aria-labelledby={labelledby}
>
  {@render children()}
</div>
