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
    searchable = false,
    quickFilter,
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
    /** show a type-to-filter box when the list is long */
    searchable?: boolean;
    /** optional one-click filter shown next to the search box, e.g. "free only" */
    quickFilter?: { label: string; match: (value: string) => boolean } | undefined;
  } = $props();

  let open = $state(false);
  let query = $state("");
  let quickOn = $state(false);
  let root: HTMLElement;

  const current = $derived(options.find((o) => o.value === value));
  const showSearch = $derived(searchable && options.length > 8);
  const visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return options.filter(
      (o) =>
        (!q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) &&
        (!quickOn || !quickFilter || quickFilter.match(o.value)),
    );
  });

  function choose(v: string): void {
    open = false;
    query = "";
    onchange(v);
  }

  function focusOnMount(el: HTMLInputElement): void {
    el.focus();
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
      class="absolute {align === 'right' ? 'right-0' : 'left-0'} z-30 mt-1 flex max-h-80 w-max min-w-full max-w-[min(32rem,calc(100vw-2rem))]
        flex-col overflow-hidden rounded-lg border border-edge2 bg-panel2 shadow-xl"
    >
      {#if showSearch}
        <div class="flex items-center gap-2 border-b border-edge p-1.5">
          <input
            class="min-w-0 flex-1 rounded border border-edge2 bg-bg px-2 py-1 text-sm text-fg outline-none focus:border-signal"
            placeholder="type to filter ({options.length})"
            aria-label="filter {label ?? 'options'}"
            bind:value={query}
            use:focusOnMount
            onkeydown={(e) => {
              if (e.key === "Enter" && visible[0]) choose(visible[0].value);
            }}
          />
          {#if quickFilter}
            <label class="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-dim">
              <input type="checkbox" bind:checked={quickOn} />
              {quickFilter.label}
            </label>
          {/if}
        </div>
      {/if}
      <div class="min-h-0 overflow-y-auto" role="listbox">
        {#each visible as o (o.value)}
          <button
            class="block w-full whitespace-nowrap truncate px-3 py-1.5 text-left text-sm
              {o.value === value ? 'text-signal' : 'text-fg'} hover:bg-hover"
            role="option"
            aria-selected={o.value === value}
            title={o.label !== o.value ? o.value : undefined}
            onclick={() => choose(o.value)}
          >
            {o.label}
          </button>
        {:else}
          <p class="m-0 px-3 py-2 text-sm text-dim">no matches</p>
        {/each}
      </div>
    </div>
  {/if}
</div>
