<script lang="ts">
  let {
    value,
    options,
    onchange,
    compact = false,
    disabled = false,
    align = "left",
    full = false,
    label,
  }: {
    value: string;
    options: Array<{ value: string; label: string }>;
    onchange: (value: string) => void;
    compact?: boolean;
    disabled?: boolean;
    align?: "left" | "right";
    /** stretch to the parent's width (label truncates) instead of sizing to content */
    full?: boolean;
    /** accessible name when no visible label is attached */
    label?: string;
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

<div class="relative {full ? 'block w-full min-w-0' : 'inline-block max-w-full'}" bind:this={root}>
  <button
    class="{compact ? 'select-compact' : 'select'} {full ? 'w-full' : 'max-w-64'} block truncate text-left"
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={label ? `${label}: ${current?.label ?? "none"}` : undefined}
    onclick={() => (open = !open)}
  >
    {current?.label ?? "—"}
  </button>
  {#if open}
    <div
      class="absolute {align === 'right' ? 'right-0' : 'left-0'} z-30 mt-1 max-h-72 w-max min-w-full max-w-[min(32rem,calc(100vw-2rem))] overflow-y-auto
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
