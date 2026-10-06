<script lang="ts">
  import type { IconNode } from "lucide";

  // One icon primitive for the whole app: lucide nodes, 1.5 stroke, currentColor.
  let {
    icon,
    size = 16,
    stroke = 1.5,
    class: klass = "",
    label,
  }: {
    icon: IconNode;
    size?: number;
    stroke?: number;
    class?: string;
    /** accessible name; omit for decorative icons next to a visible label */
    label?: string | undefined;
  } = $props();

  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  // lucide's IconNode is trusted static data: [tag, attrs][]
  const body = $derived(
    icon
      .map(([tag, attrs]) => {
        const a = Object.entries(attrs as Record<string, string | number>)
          .map(([k, v]) => `${k}="${esc(String(v))}"`)
          .join(" ");
        return `<${tag} ${a}/>`;
      })
      .join(""),
  );
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  class="shrink-0 {klass}"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
>
  {@html body}
</svg>
