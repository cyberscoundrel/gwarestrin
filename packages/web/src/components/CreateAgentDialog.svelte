<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../lib/stores.svelte.js";
  import { getAdapter } from "../lib/rpc-agent-adapter.js";
  import { modelDisplayName } from "../lib/format.js";
  import Dropdown from "./Dropdown.svelte";

  let { onclose, preselectProfileId }: { onclose: () => void; preselectProfileId?: string | null } = $props();

  let promptText = $state("");
  let name = $state("");
  let profileId = $state("default");
  let tier = $state<"local" | "cloud">("local");
  let providerId = $state<string>("");
  let modelId = $state<string>("");
  let phase = $state<"input" | "analyzing">("input");
  let error = $state<string | null>(null);

  const profile = $derived(store.profiles.find((p) => p.id === profileId) ?? store.profiles.find((p) => p.id === "default"));
  const hasEngine = $derived(profile?.contextEngine !== undefined);
  const mcpChips = $derived(profile?.mcpServers === "all" ? Object.keys(store.mcpServers ?? {}) : (profile?.mcpServers ?? []));
  const provider = $derived(store.providers.find((p) => p.id === providerId) ?? null);
  const models = $derived(provider?.models ?? []);
  const tiers = $derived(
    [...new Set(store.providers.map((p) => p.tier))].sort((a, b) => (a === "local" ? -1 : b === "local" ? 1 : 0)),
  );

  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase === "input") onclose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // apply profile defaults when the selection changes
  $effect(() => {
    const p = profile;
    if (!p) return;
    const dTier = p.defaults?.tier;
    if (dTier === "local" || dTier === "cloud") tier = dTier;
    if (p.defaults?.model) {
      providerId = p.defaults.model.provider;
      modelId = p.defaults.model.modelId;
    }
  });

  $effect(() => {
    if (!providerId && store.providers.length > 0) {
      // prefer the default provider within the selected tier
      const inTier = store.providers.filter((p) => p.tier === tier);
      const def = inTier.find((p) => p.id === store.defaultProvider) ?? inTier[0] ?? store.providers[0]!;
      providerId = def.id;
      tier = def.tier;
    }
  });
  $effect(() => {
    if (provider && models.length > 0 && !models.some((m) => m.id === modelId)) {
      const def = models.find((m) => m.id === store.defaultModel) ?? models[0]!;
      modelId = def.id;
    }
  });

  onMount(async () => {
    await store.refreshProfiles();
    if (preselectProfileId && store.profiles.some((p) => p.id === preselectProfileId)) {
      profileId = preselectProfileId;
    }
    const { mcpApi } = await import("../lib/api.js");
    store.mcpServers = await mcpApi.list();
  });

  function deriveName(): string {
    if (name.trim()) return name.trim();
    const prefix = profile?.defaults?.namePrefix;
    if (prefix?.trim()) {
      const rest = promptText.trim().split(/\s+/).filter(Boolean).slice(0, 3).join("-");
      return `${prefix.trim()}${rest}`.slice(0, 64);
    }
    // first few words, cut at a word boundary rather than mid-word
    const parts = promptText.trim().split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let len = 0;
    for (const w of parts) {
      const add = w.length + (out.length ? 1 : 0);
      if (len + add > 32) break;
      out.push(w);
      len += add;
    }
    return out.join(" ") || "agent";
  }

  async function submit(): Promise<void> {
    error = null;
    // engine-less profiles can start without a prompt
    if (!promptText.trim() && !hasEngine) {
      error = "write a first prompt to start from";
      return;
    }
    phase = "analyzing";
    try {
      const { api } = await import("../lib/api.js");
      const res = await api.createAgent({
        name: deriveName(),
        ...(profileId ? { profileId } : {}),
        model: providerId && modelId ? { provider: providerId, modelId } : null,
        ...(promptText.trim() ? { firstPrompt: promptText.trim() } : {}),
      });
      await store.refreshAgents();
      store.select(res.agent.id);
      onclose();
      if (promptText.trim()) {
        // hand the first prompt to the running agent; adapter queues until ws open
        void getAdapter(res.agent.id).prompt(promptText.trim()).catch(() => {});
      }
    } catch (e) {
      error =
        e instanceof TypeError && /fetch/i.test(e.message)
          ? "couldn't reach the server — check the connection and try again"
          : e instanceof Error
            ? e.message
            : String(e);
      phase = "input";
    }
  }
</script>

<div class="fixed inset-0 z-50 bg-black/55" role="presentation" onclick={() => phase === "input" && onclose()}></div>
<div
  class="fixed top-1/2 left-1/2 z-51 grid w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-xl
    border border-edge2 bg-panel2 p-5"
  role="dialog"
  aria-modal="true"
>
  <h3 class="m-0 tracking-wide">new agent</h3>

  {#if phase === "input"}
    <label class="grid gap-1 text-sm text-muted">
      profile
      <select
        class="rounded-md border border-edge2 bg-bg px-2.5 py-2 text-base text-fg outline-none focus:border-accent"
        bind:value={profileId}
      >
        {#each store.profiles as p (p.id)}
          <option value={p.id}>{p.name}{p.contextEngine ? " ⚙" : ""}</option>
        {/each}
      </select>
    </label>

    <textarea
      class="min-h-28 w-full resize-y rounded-md border border-edge2 bg-bg px-3 py-2.5 text-base text-fg outline-none focus:border-accent"
      placeholder={hasEngine ? "first prompt (optional — the profile's context engine runs either way)" : "what should this agent work on first?"}
      bind:value={promptText}
      autofocus
      onkeydown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
      }}
    ></textarea>

    <label class="grid gap-1 text-sm text-muted">
      name <span class="text-xs">(optional)</span>
      <input
        class="w-full rounded-md border border-edge2 bg-bg px-2.5 py-2 text-base text-fg outline-none focus:border-accent"
        bind:value={name}
        placeholder={deriveName()}
      />
    </label>

    <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <div class="grid gap-1 text-sm text-muted">
        models
        <Dropdown
          value={tier}
          options={tiers.map((t) => ({ value: t, label: t }))}
          onchange={(t) => {
            tier = t as "local" | "cloud";
            const first = store.providers.find((p) => p.tier === tier);
            if (first) providerId = first.id;
          }}
        />
      </div>
      <div class="grid gap-1 text-sm text-muted">
        provider
        <Dropdown
          value={providerId}
          options={store.providers
            .filter((p) => p.tier === tier)
            .map((p) => ({ value: p.id, label: p.degraded ? `${p.id} (degraded)` : p.id }))}
          onchange={(id) => (providerId = id)}
        />
      </div>
      <div class="grid gap-1 text-sm text-muted">
        model
        <div class="[&_button]:w-full">
          <Dropdown
            value={modelId}
            options={models.map((m) => ({ value: m.id, label: modelDisplayName(providerId, m.id, store.providers) }))}
            onchange={(id) => (modelId = id)}
          />
        </div>
      </div>
    </div>

    {#if mcpChips.length > 0}
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-muted">mcp:</span>
        {#each mcpChips as s (s)}
          <span class="rounded-full border border-edge2 px-2 py-0.5 text-xs text-muted">{s}</span>
        {/each}
        <span class="text-xs text-muted italic">(from profile)</span>
      </div>
    {/if}

    {#if error}
      <p class="m-0 text-sm text-err">{error}</p>
    {/if}

    <div class="flex items-center justify-between gap-2">
      <span class="text-xs text-muted">⌘/ctrl+enter to start</span>
      <div class="flex gap-2">
        <button class="cursor-pointer rounded-md border border-[#333845] bg-transparent px-4 py-2 text-fg" onclick={onclose}>cancel</button>
        <button
          class="cursor-pointer rounded-md bg-accent px-4 py-2 font-semibold text-[#0b0c10] disabled:cursor-default disabled:opacity-60"
          disabled={!promptText.trim() && !hasEngine}
          onclick={() => void submit()}
        >
          {hasEngine ? "analyze & start" : "start"}
        </button>
      </div>
    </div>
  {:else}
    <div class="grid gap-3 py-6 text-center text-muted">
      <div class="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-edge2 border-t-accent"></div>
      <p class="m-0">generating context from the profile's engine…</p>
      <p class="m-0 text-xs">(queries the homelab knowledge graph — can take up to a minute)</p>
    </div>
  {/if}
</div>
