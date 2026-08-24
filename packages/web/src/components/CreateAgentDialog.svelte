<script lang="ts">
  import { store } from "../lib/stores.js";

  let { onclose } = $props<{ onclose: () => void }>();

  let name = $state("");
  let providerId = $state<string>("");
  let modelId = $state<string>("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  const provider = $derived(store.providers.find((p) => p.id === providerId) ?? null);
  const models = $derived(provider?.models ?? []);

  $effect(() => {
    if (!providerId && store.providers.length > 0) {
      const def = store.providers.find((p) => p.id === store.defaultProvider) ?? store.providers[0]!;
      providerId = def.id;
    }
  });

  $effect(() => {
    if (provider && models.length > 0 && !models.some((m) => m.id === modelId)) {
      const def = models.find((m) => m.id === store.defaultModel) ?? models[0]!;
      modelId = def.id;
    }
  });

  async function create(): Promise<void> {
    if (!name.trim()) {
      error = "name required";
      return;
    }
    busy = true;
    error = null;
    try {
      const { api } = await import("../lib/api.js");
      const agent = await api.createAgent({
        name: name.trim(),
        model: providerId && modelId ? { provider: providerId, modelId } : null,
      });
      await store.refreshAgents();
      store.select(agent.id);
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="fixed inset-0 z-50 bg-black/55" role="presentation" onclick={onclose}></div>
<div
  class="fixed top-1/2 left-1/2 z-51 grid min-w-88 -translate-x-1/2 -translate-y-1/2 gap-3 rounded-xl
    border border-edge2 bg-panel2 p-5 pb-4"
  role="dialog"
  aria-modal="true"
>
  <h3 class="m-0 tracking-wide">new agent</h3>

  <label class="grid gap-1 text-sm text-muted">
    name
    <input
      class="rounded-md border border-edge2 bg-bg px-2.5 py-2 text-base text-fg outline-none focus:border-accent"
      bind:value={name}
      placeholder="e.g. researcher"
      autofocus
    />
  </label>

  <label class="grid gap-1 text-sm text-muted">
    provider
    <select
      class="rounded-md border border-edge2 bg-bg px-2.5 py-2 text-fg"
      bind:value={providerId}
    >
      {#each store.providers as p (p.id)}
        <option value={p.id}>
          {p.id}{p.degraded ? " (degraded)" : ""}{p.firstParty ? " ★" : ""}
        </option>
      {/each}
    </select>
  </label>

  <label class="grid gap-1 text-sm text-muted">
    model
    <select
      class="rounded-md border border-edge2 bg-bg px-2.5 py-2 text-fg disabled:opacity-60"
      bind:value={modelId}
      disabled={!provider || models.length === 0}
    >
      {#each models as m (m.id)}
        <option value={m.id}>{m.name === m.id ? m.id : `${m.name} (${m.id})`}</option>
      {/each}
    </select>
  </label>

  {#if provider && provider.models.length === 0}
    <p class="m-0 text-sm text-muted">no models configured for this provider</p>
  {/if}
  {#if error}
    <p class="m-0 text-sm text-err">{error}</p>
  {/if}

  <div class="flex justify-end gap-2">
    <button
      class="cursor-pointer rounded-md border border-[#333845] bg-transparent px-4 py-2 text-fg"
      onclick={onclose}
    >
      cancel
    </button>
    <button
      class="cursor-pointer rounded-md bg-accent px-4 py-2 font-semibold text-[#0b0c10] disabled:cursor-default disabled:opacity-60"
      disabled={busy}
      onclick={create}
    >
      {busy ? "creating…" : "create"}
    </button>
  </div>
</div>
