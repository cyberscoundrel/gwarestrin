<script lang="ts">
import { onMount } from "svelte";
import { store } from "../lib/stores.svelte.js";
import { getAdapter } from "../lib/rpc-agent-adapter.js";
import { modelDisplayName } from "../lib/format.js";
import Dropdown from "./Dropdown.svelte";

  let { preselectProfileId }: { preselectProfileId?: string | null } = $props();

  let promptText = $state("");
  let name = $state("");
  let profileId = $state("default");
  let tier = $state<"local" | "cloud">("local");
  let providerId = $state<string>("");
  let modelId = $state<string>("");
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let username = $state("");

  const profile = $derived(store.profiles.find((p) => p.id === profileId) ?? store.profiles.find((p) => p.id === "default"));
  const hasEngine = $derived(profile?.contextEngine !== undefined);
  const mcpChips = $derived(profile?.mcpServers === "all" ? Object.keys(store.mcpServers ?? {}) : (profile?.mcpServers ?? []));
  const provider = $derived(store.providers.find((p) => p.id === providerId) ?? null);
  const models = $derived(provider?.models ?? []);
  const tiers = $derived(
    [...new Set(store.providers.map((p) => p.tier))].sort((a, b) => (a === "local" ? -1 : b === "local" ? 1 : 0)),
  );

  function greeting(): string {
    const h = new Date().getHours();
    const phrase = h < 5 ? "late night session" : h < 12 ? "morning session" : h < 17 ? "afternoon session" : "evening session";
    return username ? `${phrase}, ${username}?` : `${phrase}?`;
  }

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
    const { api, mcpApi } = await import("../lib/api.js");
    try {
      const me = await api.me();
      username = me.username;
    } catch { /* greeting falls back to unnamed */ }
    await store.refreshProfiles();
    if (preselectProfileId && store.profiles.some((p) => p.id === preselectProfileId)) {
      profileId = preselectProfileId;
    }
    store.mcpServers = await mcpApi.list();
  });

  function deriveName(): string {
    if (name.trim()) return name.trim();
    const prefix = profile?.defaults?.namePrefix;
    if (prefix?.trim()) {
      const rest = promptText.trim().split(/\s+/).filter(Boolean).slice(0, 3).join("-");
      return `${prefix.trim()}${rest}`.slice(0, 64);
    }
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
    if (!promptText.trim() && !hasEngine) {
      error = "write a first prompt to start from";
      return;
    }
    submitting = true;
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
      if (promptText.trim()) {
        void getAdapter(res.agent.id).prompt(promptText.trim()).catch(() => {});
      }
    } catch (e) {
      error =
        e instanceof TypeError && /fetch/i.test(e.message)
          ? "couldn't reach the server — check the connection and try again"
          : e instanceof Error
            ? e.message
            : String(e);
      submitting = false;
    }
  }
</script>

<div class="grid h-full grid-cols-[minmax(0,1fr)] place-items-center overflow-y-auto p-6 max-sm:p-4">
  <div class="grid w-full max-w-2xl justify-items-center gap-6">
    <div class="grid justify-items-center gap-2 text-center">
      <svg viewBox="0 0 24 24" class="h-10 w-10 text-muted" aria-hidden="true">
        <path
          d="M12 3v9M7 14h10M8.5 17h7M10 20h4"
          stroke="currentColor"
          stroke-width="1.7"
          fill="none"
          stroke-linecap="round"
        />
      </svg>
      <h1 class="m-0 text-2xl tracking-wide text-fg">{greeting()}</h1>
      <p class="m-0 text-sm text-muted">start an agent — pick a profile, drop your first prompt</p>
    </div>

    <div class="grid w-full gap-4 rounded-xl border border-edge bg-panel p-5 max-sm:p-4">
      <div class="grid gap-2">
        <span class="text-xs tracking-wide text-muted uppercase">profile</span>
        <div class="flex flex-wrap items-center gap-2">
          <div class="max-w-full">
            <Dropdown
              label="profile"
              value={profileId}
              options={store.profiles.map((p) => ({ value: p.id, label: p.name + (p.contextEngine ? " ⚙" : "") }))}
              onchange={(id) => (profileId = id)}
            />
          </div>
          {#if mcpChips.length > 0}
            <div class="flex flex-wrap items-center gap-1.5">
              {#each mcpChips as s (s)}
                <span class="rounded-full border border-edge2 px-2 py-0.5 text-xs text-muted">{s}</span>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <div class="grid gap-2">
        <span class="text-xs tracking-wide text-muted uppercase">model</span>
        <div class="flex flex-wrap items-center gap-2">
          <div class="w-28">
            <Dropdown
              full
              label="model tier"
              value={tier}
              options={tiers.map((t) => ({ value: t, label: t }))}
              onchange={(t) => {
                tier = t as "local" | "cloud";
                const first = store.providers.find((p) => p.tier === tier);
                if (first) providerId = first.id;
              }}
            />
          </div>
          <div class="w-44 max-w-full">
            <Dropdown
              full
              label="provider"
              value={providerId}
              options={store.providers
                .filter((p) => p.tier === tier)
                .map((p) => ({ value: p.id, label: p.degraded ? `${p.id} (degraded)` : p.id }))}
              onchange={(id) => (providerId = id)}
            />
          </div>
          <div class="min-w-48 flex-1 max-sm:min-w-full">
            <Dropdown
              full
              label="model"
              value={modelId}
              options={models.map((m) => ({ value: m.id, label: modelDisplayName(providerId, m.id, store.providers) }))}
              onchange={(id) => (modelId = id)}
            />
          </div>
        </div>
      </div>

      <textarea
        class="min-h-24 w-full resize-y rounded-lg border border-edge2 bg-bg px-4 py-3 text-base text-fg outline-none focus:border-accent"
        placeholder={hasEngine ? "first prompt (optional — the profile's engine runs either way)" : "what should this agent work on first?"}
        bind:value={promptText}
        onkeydown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
      ></textarea>

      {#if error}
        <p class="m-0 text-sm text-err">{error}</p>
      {/if}

      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-muted">⌘/ctrl+enter to start</span>
        <button
          class="cursor-pointer rounded-md bg-accent px-5 py-2 font-semibold text-[#0b0c10] disabled:cursor-default disabled:opacity-60"
          disabled={submitting || (!promptText.trim() && !hasEngine)}
          onclick={() => void submit()}
        >
          {#if submitting}
            {hasEngine ? "generating context…" : "starting…"}
          {:else}
            {hasEngine ? "analyze & start" : "start"}
          {/if}
        </button>
      </div>
    </div>
  </div>
</div>
