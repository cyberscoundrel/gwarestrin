<script lang="ts">
  import type { Snippet } from "svelte";
  import { X, type IconNode } from "lucide";
  import Icon from "./Icon.svelte";

  // Shared header for drawers and dialogs: icon, title, optional one-line
  // explanation, trailing actions, close.
  let {
    title,
    subtitle,
    icon,
    onclose,
    actions,
    id,
  }: {
    title: string;
    subtitle?: string | undefined;
    icon?: IconNode | undefined;
    onclose?: (() => void) | undefined;
    actions?: Snippet | undefined;
    id?: string | undefined;
  } = $props();
</script>

<div class="flex items-start gap-2.5 border-b border-edge px-4 py-3">
  {#if icon}
    <Icon {icon} size={16} class="mt-0.5 text-faint" />
  {/if}
  <div class="grid min-w-0 flex-1 gap-0.5">
    <h3 {id} class="m-0 truncate text-sm font-medium text-fg">{title}</h3>
    {#if subtitle}
      <p class="m-0 text-xs text-faint">{subtitle}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex shrink-0 items-center gap-1">{@render actions()}</div>
  {/if}
  {#if onclose}
    <button
      class="-mr-1 grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-faint transition-colors hover:bg-hover hover:text-fg"
      aria-label="close"
      onclick={onclose}
    >
      <Icon icon={X} size={15} />
    </button>
  {/if}
</div>
