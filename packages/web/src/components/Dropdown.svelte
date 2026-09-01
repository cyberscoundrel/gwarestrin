<script lang="ts">
  let {
    value,
    options,
    onchange,
    compact = false,
    disabled = false,
    align = "left",
  }: {
    value: string;
    options: Array<{ value: string; label: string }>;
    onchange: (value: string) => void;
    compact?: boolean;
    disabled?: boolean;
    align?: "left" | "right";
  } = $props();

  let open = $state(false);
  let root: HTMLElement;

  const current = $derived(options.find((o) => o.value === value));

  function choose(v: string): void {
    open = false;
    onchange(v);
  }

  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open = false;
    };
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !root.contains(e.target)) open = false;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  });
</script>

<div class="relative inline-block" bind:this={root}>
  <button class="{compact ? 'select-compact' : 'select'} max-w-64 truncate text-left" {disabled} onclick={() => (open = !open)}>
    {current?.label ?? "—"}
  </button>
  {#if open}
    <div
      class="absolute {align === 'right' ? 'right-0' : 'left-0'} z-30 mt-1 max-h-72 min-w-full w-max overflow-y-auto
        rounded-lg border border-edge2 bg-panel2 shadow-xl"
    >
      {#each options as o (o.value)}
        <button
          class="block w-full whitespace-nowrap truncate px-3 py-1.5 text-left text-sm
            {o.value === value ? 'text-accent' : 'text-fg'} hover:bg-[#1a1d26]"
          onclick={() => choose(o.value)}
        >
          {o.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
