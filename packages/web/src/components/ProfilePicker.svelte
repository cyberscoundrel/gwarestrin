<script lang="ts">
  import { BookOpen, Check, ChevronDown, Users } from "lucide";
  import type { ProfileRecord } from "@gwarestrin/shared";
  import { store } from "../lib/stores.svelte.js";
  import Icon from "./Icon.svelte";

  // Rich select for agent profiles: name, one-line focus, allowed tool
  // connections as chips, briefing yes/no.
  let { value, onchange }: { value: string; onchange: (id: string) => void } = $props();

  let open = $state(false);
  let root: HTMLElement;

  const current = $derived(store.profiles.find((p) => p.id === value));

  function toolsOf(p: ProfileRecord | undefined): string[] {
    if (!p) return [];
    return p.mcpServers === "all" ? Object.keys(store.mcpServers ?? {}) : p.mcpServers;
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

<div class="relative inline-block max-w-full" bind:this={root}>
  <button
    type="button"
    class="inline-flex h-8 max-w-full cursor-pointer items-center gap-2 rounded-md border border-edge2 bg-panel px-2.5 text-sm text-fg transition-colors
      hover:border-faint {open ? 'border-faint' : ''}"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label="agent profile: {current?.name ?? value}"
    onclick={() => (open = !open)}
  >
    <Icon icon={Users} size={14} class="text-faint" />
    <span class="truncate">{current?.name ?? "Default"}</span>
    {#if current?.contextEngine}
      <Icon icon={BookOpen} size={13} class="shrink-0 text-faint" label="has a briefing" />
    {/if}
    <Icon icon={ChevronDown} size={13} class="shrink-0 text-faint" />
  </button>

  {#if open}
    <div
      class="animate-pop absolute left-0 z-40 mt-1 max-h-96 w-[24rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-edge2 bg-panel2 p-1
        shadow-overlay"
      role="listbox"
      aria-label="agent profiles"
    >
      {#each store.profiles as p (p.id)}
        {@const tools = toolsOf(p)}
        {@const selected = p.id === value}
        <button
          type="button"
          class="grid w-full cursor-pointer grid-cols-[14px_1fr] gap-x-2 gap-y-1 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover"
          role="option"
          aria-selected={selected}
          onclick={() => {
            open = false;
            onchange(p.id);
          }}
        >
          <span class="pt-0.5">{#if selected}<Icon icon={Check} size={14} class="text-signal" />{/if}</span>
          <span class="flex min-w-0 items-center gap-2">
            <span class="truncate text-sm font-medium text-fg">{p.name}</span>
            <span class="ml-auto shrink-0 text-2xs {p.contextEngine ? 'text-dim' : 'text-faint'}">
              {p.contextEngine ? `Briefing: ${p.contextEngine.type}` : "No briefing"}
            </span>
          </span>
          {#if p.description}
            <span class="col-start-2 line-clamp-1 text-xs text-faint">{p.description}</span>
          {/if}
          <span class="col-start-2 flex flex-wrap gap-1">
            {#each tools.slice(0, 4) as t (t)}
              <span class="rounded border border-edge px-1.5 py-px font-mono text-2xs text-dim">{t}</span>
            {/each}
            {#if tools.length > 4}<span class="text-2xs text-faint">+{tools.length - 4}</span>{/if}
            {#if tools.length === 0}<span class="text-2xs text-faint">No tool connections</span>{/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>
