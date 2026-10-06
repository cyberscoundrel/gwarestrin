<script lang="ts">
  // On/off switch (role=switch). Accent fill only for the "on" state.
  let {
    checked,
    onchange,
    disabled = false,
    label,
  }: {
    checked: boolean;
    onchange: (next: boolean) => void;
    disabled?: boolean;
    label: string;
  } = $props();
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  class="relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border transition-colors
    disabled:cursor-not-allowed disabled:opacity-40 {checked ? 'border-signal bg-signal' : 'border-edge2 bg-inset'}"
  onclick={() => onchange(!checked)}
>
  <span
    class="absolute h-3 w-3 rounded-full shadow-sm transition-transform duration-150
      {checked ? 'translate-x-[15px] bg-on-signal' : 'translate-x-[2px] bg-faint'}"
  ></span>
</button>
