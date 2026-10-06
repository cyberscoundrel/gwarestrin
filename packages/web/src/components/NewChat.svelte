<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowUp, BookOpen, Check, Pencil, TriangleAlert } from "lucide";
  import type { ProfileRecord } from "@gwarestrin/shared";
  import { store } from "../lib/stores.svelte.js";
  import { getAdapter } from "../lib/rpc-agent-adapter.js";
  import { isFreeModelId } from "../lib/format.js";
  import Icon from "./Icon.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import ProfilePicker from "./ProfilePicker.svelte";

  let { preselectProfileId }: { preselectProfileId?: string | null } = $props();

  type ModelRef = { provider: string; modelId: string };

  let promptText = $state("");
  let name = $state("");
  let naming = $state(false);
  let profileId = $state("default");
  let model = $state<ModelRef | null>(null);
  /** the user picked a model by hand; profile defaults stop overriding it */
  let modelTouched = $state(false);
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let username = $state("");
  let promptEl: HTMLTextAreaElement | undefined = $state();

  const profile = $derived(store.profiles.find((p) => p.id === profileId) ?? store.profiles.find((p) => p.id === "default"));
  const hasEngine = $derived(profile?.contextEngine !== undefined);
  const tools = $derived(profile?.mcpServers === "all" ? Object.keys(store.mcpServers ?? {}) : (profile?.mcpServers ?? []));
  const canStart = $derived(!submitting && (promptText.trim().length > 0 || hasEngine));

  const greeting = $derived.by(() => {
    const h = new Date().getHours();
    const part = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    return username ? `${part}, ${username}` : part;
  });

  /** the profile's default model, else the workspace default, else a free model */
  function defaultModelFor(p: ProfileRecord | undefined): ModelRef | null {
    if (p?.defaults?.model) return p.defaults.model;
    const tier = p?.defaults?.tier;
    const inTier = tier ? store.providers.filter((x) => x.tier === tier) : store.providers;
    const prov = inTier.find((x) => x.id === store.defaultProvider) ?? inTier[0];
    if (!prov) return null;
    const m =
      prov.models.find((x) => x.id === store.defaultModel) ?? prov.models.find((x) => isFreeModelId(x.id)) ?? prov.models[0];
    return m ? { provider: prov.id, modelId: m.id } : null;
  }

  $effect(() => {
    void store.providers.length;
    const p = profile;
    if (!modelTouched) model = defaultModelFor(p);
  });

  onMount(async () => {
    const { api, mcpApi } = await import("../lib/api.js");
    try {
      const me = await api.me();
      username = me.username;
    } catch {
      /* greeting falls back to unnamed */
    }
    await store.refreshProfiles();
    if (preselectProfileId && store.profiles.some((p) => p.id === preselectProfileId)) {
      profileId = preselectProfileId;
    }
    try {
      store.mcpServers = await mcpApi.list();
    } catch {
      /* tool chips just stay empty; the offline banner explains why */
    }
    promptEl?.focus();
  });

  function derivedName(): string {
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
    return out.join(" ") || "New agent";
  }

  const finalName = $derived(name.trim() || derivedName());

  async function submit(): Promise<void> {
    error = null;
    if (!promptText.trim() && !hasEngine) {
      error = "Describe the first task so the agent knows where to start.";
      promptEl?.focus();
      return;
    }
    submitting = true;
    try {
      const { api } = await import("../lib/api.js");
      const res = await api.createAgent({
        name: finalName,
        ...(profileId ? { profileId } : {}),
        model,
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
          ? "Couldn't reach the server. Check the connection and try again."
          : e instanceof Error
            ? e.message
            : String(e);
      submitting = false;
      // the server may have created the record before failing to start it
      // (e.g. the concurrency cap); show it in the rail instead of hiding it
      void store.refreshAgents();
    }
  }

  // creation runs as one request; the steps show the expected order, with
  // the first unfinished one active (the API reports no finer progress)
  const steps = $derived([
    { label: "Preparing sandbox", hint: "Booting an isolated machine for this agent" },
    ...(hasEngine ? [{ label: "Building briefing", hint: "Reading the knowledge graph" }] : []),
    { label: "Sending first task", hint: "" },
  ]);
</script>

<div class="grid h-full grid-cols-[minmax(0,1fr)] overflow-y-auto">
  <div class="mx-auto flex w-full max-w-[640px] flex-col justify-center gap-6 px-6 py-10 max-sm:px-4">
    <div class="grid gap-1">
      <p class="m-0 text-sm text-faint">{greeting}</p>
      <h1 class="m-0 text-xl font-medium text-fg">What should a new agent work on?</h1>
    </div>

    <form
      class="rounded-xl border border-edge2 bg-panel transition-colors focus-within:border-faint"
      onsubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {#if submitting}
        <!-- inline progress, in place of the form -->
        <div class="grid gap-4 p-5" role="status" aria-live="polite">
          <div class="grid gap-0.5">
            <span class="text-sm font-medium text-fg">Starting {finalName}</span>
            <span class="text-xs text-faint">This can take a minute while the sandbox boots.</span>
          </div>
          <ol class="m-0 grid list-none gap-2.5 p-0">
            {#each steps as s, i (s.label)}
              <li class="flex items-center gap-3 text-sm {i === 0 ? 'text-fg' : 'text-faint'}">
                {#if i === 0}
                  <span class="gw-tool-spin"></span>
                {:else}
                  <span class="h-3 w-3 rounded-full border border-edge2"></span>
                {/if}
                <span>{s.label}</span>
                {#if s.hint && i === 0}<span class="text-xs text-faint">{s.hint}</span>{/if}
              </li>
            {/each}
          </ol>
        </div>
      {:else}
        <label class="sr-only" for="first-task">First task</label>
        <textarea
          id="first-task"
          bind:this={promptEl}
          class="block min-h-36 w-full resize-none rounded-t-xl border-none bg-transparent px-5 pt-4 pb-2 text-base leading-relaxed text-fg outline-none
            placeholder:text-faint focus-visible:outline-none"
          placeholder={hasEngine
            ? "Optional: a first task. The briefing is built either way."
            : "e.g. Review last week's failed orders in the sales database and summarise the three most common causes"}
          bind:value={promptText}
          aria-invalid={error ? "true" : undefined}
          onkeydown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
        ></textarea>

        <!-- secondary controls: profile + model in one compact row -->
        <div class="flex flex-wrap items-center gap-2 px-4 pb-3">
          <ProfilePicker
            value={profileId}
            onchange={(id) => {
              profileId = id;
              modelTouched = false;
            }}
          />
          <ModelPicker
            value={model}
            onchange={(v) => {
              model = v;
              modelTouched = true;
            }}
          />
        </div>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-edge px-4 py-2.5">
          <!-- what the agent will get from its profile -->
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" aria-label="from the agent profile">
            {#each tools.slice(0, 5) as t (t)}
              <span class="rounded border border-edge px-1.5 py-px font-mono text-2xs text-dim" title="Tool connection allowed by {profile?.name}">{t}</span>
            {/each}
            {#if tools.length > 5}<span class="text-2xs text-faint">+{tools.length - 5}</span>{/if}
            {#if hasEngine}
              <span class="inline-flex items-center gap-1 text-2xs text-dim"><Icon icon={BookOpen} size={12} /> Briefing</span>
            {/if}
          </div>
          <span class="text-2xs text-faint pointer-coarse:hidden">⌘/Ctrl + Enter</span>
          <button type="submit" class="btn btn-primary" disabled={!canStart}>
            {hasEngine ? "Build briefing & start" : "Start agent"}
            <Icon icon={ArrowUp} size={14} />
          </button>
        </div>
      {/if}
    </form>

    {#if !submitting}
      <!-- name: a preview by default, editable behind "Rename" (P-5) -->
      <div class="flex min-h-8 flex-wrap items-center gap-2 px-1 text-xs text-faint">
        {#if naming}
          <label class="sr-only" for="agent-name">Agent name</label>
          <input
            id="agent-name"
            class="input h-7 max-w-72 text-xs"
            placeholder={derivedName()}
            bind:value={name}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                naming = false;
              }
            }}
          />
          <button class="btn btn-ghost btn-sm" onclick={() => (naming = false)}>
            <Icon icon={Check} size={13} />
            Done
          </button>
        {:else}
          <span>Will be called <span class="text-dim">{finalName}</span></span>
          <button class="btn btn-ghost btn-sm -my-1" onclick={() => (naming = true)}>
            <Icon icon={Pencil} size={12} />
            Rename
          </button>
        {/if}
      </div>
    {/if}

    {#if error}
      <p class="m-0 flex items-start gap-2 px-1 text-sm text-err" role="alert">
        <Icon icon={TriangleAlert} size={14} class="mt-0.5" />
        {error}
      </p>
    {/if}
  </div>
</div>
