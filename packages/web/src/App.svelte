<script lang="ts">
  let healthy = $state<boolean | null>(null);

  $effect(() => {
    fetch("/api/health")
      .then((r) => (healthy = r.ok))
      .catch(() => (healthy = false));
  });
</script>

<main class="shell">
  <h1>gwarestrin</h1>
  <p class="muted">agent console — scaffold (M0)</p>
  {#if healthy === true}
    <p class="ok">server healthy</p>
  {:else if healthy === false}
    <p class="err">server unreachable</p>
  {:else}
    <p class="muted">checking server…</p>
  {/if}
</main>

<style>
  .shell {
    display: grid;
    place-items: center;
    min-height: 100vh;
    gap: 0.25rem;
  }
  h1 {
    margin: 0;
    letter-spacing: 0.08em;
  }
  .muted {
    color: var(--gw-muted);
  }
  .ok {
    color: #9ece6a;
  }
  .err {
    color: #f7768e;
  }
</style>
