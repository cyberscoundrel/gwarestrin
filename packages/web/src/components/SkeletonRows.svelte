<script lang="ts">
  // loading placeholder rows for lists (shimmer is static under reduced motion)
  let { rows = 4 }: { rows?: number } = $props();
</script>

<div class="grid gap-2 px-4 py-3" aria-busy="true" aria-label="loading">
  {#each Array.from({ length: rows }) as _, i (i)}
    <div class="flex items-center gap-2.5">
      <div class="skeleton h-4 w-4"></div>
      <div class="skeleton h-3" style="width: {72 - ((i * 17) % 35)}%"></div>
    </div>
  {/each}
</div>
