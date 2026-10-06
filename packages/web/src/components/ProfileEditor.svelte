<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { ArrowLeft, Copy, Ellipsis, Lock, Trash2, TriangleAlert, Users } from "lucide";
  import type { ThinkingLevel } from "@gwarestrin/shared";
  import { store } from "../lib/stores.svelte.js";
  import { api, mcpApi, type McpServerDef } from "../lib/api.js";
  import Dropdown from "./Dropdown.svelte";
  import Icon from "./Icon.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import Switch from "./Switch.svelte";
  import SkeletonRows from "./SkeletonRows.svelte";

  let {
    profileId,
    onclose,
  }: {
    profileId: string; // "new" or an existing profile id
    onclose?: () => void;
  } = $props();

  // The form is seeded once from the profile being edited (or, for "new",
  // from a Duplicate seed); App remounts this component (keyed by profile
  // id) when a different profile is opened, so the untracked read is
  // intentional.
  const isNew = untrack(() => profileId === "new");
  const existing = untrack(() => {
    if (!isNew) return store.profiles.find((p) => p.id === profileId);
    const seed = store.profileSeed;
    store.profileSeed = null;
    return seed ?? undefined;
  });
  const duplicating = isNew && existing !== undefined;

  let name = $state(duplicating ? `${existing?.name ?? ""} copy` : (existing?.name ?? ""));
  let description = $state(existing?.description ?? "");
  let tier = $state<"local" | "cloud" | "">(existing?.defaults?.tier ?? "");
  let model = $state<{ provider: string; modelId: string } | null>(existing?.defaults?.model ?? null);
  let thinkingLevel = $state<string>(existing?.defaults?.thinkingLevel ?? "");
  let namePrefix = $state(existing?.defaults?.namePrefix ?? "");
  let mcpMode = $state<"all" | "pick">(existing?.mcpServers === "all" || !existing ? "all" : "pick");
  let pickedMcp = $state<string[]>(existing && existing.mcpServers !== "all" ? [...existing.mcpServers] : []);
  let engineEnabled = $state(existing?.contextEngine !== undefined);
  let engineType = $state<"graph-rag" | "lexical">(existing?.contextEngine?.type ?? "graph-rag");
  let enginePrompt = $state(existing?.contextEngine?.prompt ?? "");
  let engineRounds = $state(existing?.contextEngine?.maxRounds ?? 8);
  let engineTimeoutS = $state(Math.round((existing?.contextEngine?.timeoutMs ?? 90_000) / 1000));
  let sharedTools = $state(existing?.sharedTools !== false);

  let servers = $state<Record<string, McpServerDef>>({});
  let serversLoaded = $state(false);
  let saving = $state(false);
  let error = $state("");
  let attempted = $state(false);
  let menuOpen = $state(false);

  $effect(() => {
    void mcpApi
      .list()
      .then((s) => (servers = s))
      .catch(() => {})
      .finally(() => (serversLoaded = true));
  });

  const serverNames = $derived(Object.keys(servers));

  // ---- dirty state: compare against the seeded snapshot ----
  const snapshot = () =>
    JSON.stringify([name, description, tier, model, thinkingLevel, namePrefix, mcpMode, [...pickedMcp].sort(), engineEnabled, engineType, enginePrompt, engineRounds, engineTimeoutS, sharedTools]);
  const initial = untrack(snapshot);
  const dirty = $derived(snapshot() !== initial || duplicating);

  // ---- inline validation ----
  const nameError = $derived(attempted && !name.trim() ? "Give the agent profile a name." : "");
  const toolsError = $derived(attempted && mcpMode === "pick" && pickedMcp.length === 0 ? "Allow at least one connection, or allow all." : "");

  const thinkingOptions = [
    { value: "", label: "Workspace default" },
    { value: "off", label: "Off" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ];

  function isAllowed(s: string): boolean {
    return mcpMode === "all" || pickedMcp.includes(s);
  }

  function setAllowed(s: string, on: boolean): void {
    if (mcpMode === "all") return;
    pickedMcp = on ? [...new Set([...pickedMcp, s])] : pickedMcp.filter((x) => x !== s);
  }

  async function save() {
    attempted = true;
    error = "";
    if (nameError || toolsError) return;
    saving = true;
    try {
      const saved = await api.saveProfile(isNew ? "new" : profileId, {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        defaults: {
          ...(tier ? { tier } : {}),
          ...(model ? { model } : {}),
          ...(thinkingLevel ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}),
          ...(namePrefix.trim() ? { namePrefix: namePrefix.trim() } : {}),
        },
        mcpServers: mcpMode === "all" ? "all" : [...pickedMcp],
        ...(engineEnabled
          ? {
              contextEngine: {
                type: engineType,
                ...(enginePrompt.trim() ? { prompt: enginePrompt.trim() } : {}),
                includeFirstPrompt: true,
                maxRounds: engineRounds,
                timeoutMs: Math.max(5, engineTimeoutS) * 1000,
              },
            }
          : {}),
        sharedTools,
      });
      await store.refreshProfiles();
      store.editingProfileId = saved.id;
      onclose?.();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  function duplicate() {
    menuOpen = false;
    if (!existing) return;
    store.profileSeed = $state.snapshot(existing);
    store.editingProfileId = "new";
  }

  async function remove() {
    menuOpen = false;
    if (!confirm(`Delete agent profile "${name}"? Its agents keep running but fall back to the Default agent profile.`)) return;
    try {
      await api.deleteProfile(profileId);
      await store.refreshProfiles();
      store.editingProfileId = null;
      onclose?.();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function close() {
    if (dirty && !confirm("Discard unsaved changes to this agent profile?")) return;
    store.editingProfileId = null;
    onclose?.();
  }

  $effect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(".profile-menu")) menuOpen = false;
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  });
</script>

{#snippet section(title: string, explain: string, body: Snippet)}
  <section class="grid gap-4 border-b border-edge py-7 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-10">
    <div class="grid content-start gap-1">
      <h3 class="m-0 text-sm font-medium text-fg">{title}</h3>
      <p class="m-0 text-xs leading-relaxed text-faint">{explain}</p>
    </div>
    <div class="grid min-w-0 content-start gap-5">{@render body()}</div>
  </section>
{/snippet}

{#snippet focusBody()}
  <div class="field">
    <label class="field-label" for="pf-name">Name</label>
    <input
      id="pf-name"
      class="input"
      bind:value={name}
      placeholder="e.g. Sales analyst"
      aria-invalid={nameError ? "true" : undefined}
      aria-describedby={nameError ? "pf-name-err" : undefined}
    />
    {#if nameError}<span id="pf-name-err" class="field-error">{nameError}</span>{/if}
  </div>
  <div class="field">
    <label class="field-label" for="pf-desc">Focus</label>
    <textarea
      id="pf-desc"
      class="input min-h-20 resize-y"
      bind:value={description}
      placeholder="What agents in this profile work on, e.g. answers questions about orders and customers"
    ></textarea>
    <span class="field-hint">Shown when picking a profile for a new agent.</span>
  </div>
{/snippet}

{#snippet defaultsBody()}
  <div class="field">
    <span class="field-label" id="pf-model-label">Model</span>
    <div>
      <ModelPicker
        value={model}
        noneLabel="Workspace default"
        label="default model"
        onchange={(v) => {
          model = v;
          tier = v ? (store.providers.find((p) => p.id === v.provider)?.tier ?? "cloud") : "";
        }}
      />
    </div>
    <span class="field-hint">New agents start on this model. People can still change it per agent.</span>
  </div>
  <div class="grid gap-5 sm:grid-cols-2">
    <div class="field">
      <span class="field-label">Thinking</span>
      <Dropdown full label="thinking level" value={thinkingLevel} options={thinkingOptions} onchange={(v) => (thinkingLevel = v)} />
    </div>
    <div class="field">
      <label class="field-label" for="pf-prefix">Name prefix</label>
      <input id="pf-prefix" class="input input-mono" bind:value={namePrefix} placeholder="e.g. sales-" />
    </div>
  </div>
{/snippet}

{#snippet toolsBody()}
  <div class="flex flex-wrap items-center gap-3">
    <div class="segmented" role="group" aria-label="which tool connections are allowed">
      <button type="button" aria-pressed={mcpMode === "all"} onclick={() => (mcpMode = "all")}>All workspace connections</button>
      <button
        type="button"
        aria-pressed={mcpMode === "pick"}
        onclick={() => {
          if (mcpMode === "all" && pickedMcp.length === 0) pickedMcp = [...serverNames];
          mcpMode = "pick";
        }}>Only selected</button
      >
    </div>
    {#if mcpMode === "all"}<span class="text-xs text-faint">Includes connections added later.</span>{/if}
  </div>

  {#if !serversLoaded}
    <SkeletonRows rows={2} />
  {:else if serverNames.length === 0}
    <p class="m-0 rounded-lg border border-dashed border-edge2 px-4 py-6 text-center text-xs text-faint">
      This workspace has no tool connections yet. Add them from an agent's Tools drawer.
    </p>
  {:else}
    <ul class="m-0 grid list-none gap-2 p-0" aria-label="tool connections">
      {#each serverNames as s (s)}
        {@const allowed = isAllowed(s)}
        <li class="flex items-center gap-3 rounded-lg border px-3.5 py-3 transition-colors {allowed ? 'border-edge2 bg-panel' : 'border-edge bg-bg'}">
          <Switch
            checked={allowed}
            disabled={mcpMode === "all"}
            label="allow {s}"
            onchange={(on) => setAllowed(s, on)}
          />
          <div class="grid min-w-0 flex-1">
            <span class="flex items-center gap-1.5 text-sm {allowed ? 'text-fg' : 'text-dim'}">
              {s}
              {#if !allowed}
                <span class="inline-flex items-center gap-1 text-2xs text-faint"><Icon icon={Lock} size={11} /> Not allowed</span>
              {/if}
            </span>
            <span class="truncate text-xs text-faint" title={servers[s]?.url ?? servers[s]?.command}>
              {servers[s]?.description ?? servers[s]?.url ?? servers[s]?.command ?? ""}
            </span>
          </div>
          <!-- per-connection default: the API has no field for it yet (P-11);
               today every allowed connection starts switched on -->
          <span
            class="flex shrink-0 items-center gap-2 text-2xs {allowed ? 'text-dim' : 'text-faint'}"
            title="New agents currently start with every allowed connection on. A per-connection default needs a backend change (UX-AUDIT P-11)."
          >
            <span class="max-sm:hidden">On by default</span>
            <Switch checked={allowed} disabled label="{s} on by default for new agents (not configurable yet)" onchange={() => {}} />
          </span>
        </li>
      {/each}
    </ul>
  {/if}
  {#if toolsError}<span class="field-error">{toolsError}</span>{/if}
{/snippet}

{#snippet briefingBody()}
  <label class="flex items-start gap-3">
    <Switch checked={engineEnabled} label="build a briefing for new agents" onchange={(v) => (engineEnabled = v)} />
    <span class="grid gap-0.5">
      <span class="text-sm text-fg">Build a briefing for new agents</span>
      <span class="text-xs text-faint">Adds a short wait when an agent is created.</span>
    </span>
  </label>
  {#if engineEnabled}
    <div class="animate-enter grid gap-5 rounded-lg border border-edge bg-panel p-4">
      <div class="field">
        <span class="field-label">How it's built</span>
        <div class="segmented w-fit" role="group" aria-label="briefing engine">
          <button type="button" aria-pressed={engineType === "graph-rag"} onclick={() => (engineType = "graph-rag")}>Graph-RAG</button>
          <button type="button" aria-pressed={engineType === "lexical"} onclick={() => (engineType = "lexical")}>Lexical</button>
        </div>
        <span class="field-hint">
          {engineType === "graph-rag"
            ? "An AI model explores the knowledge graph and writes the briefing."
            : "A fixed, deterministic summary of the knowledge graph. No AI model involved."}
        </span>
      </div>
      <div class="field">
        <label class="field-label" for="pf-focus">What to focus on</label>
        <textarea
          id="pf-focus"
          class="input min-h-20 resize-y"
          bind:value={enginePrompt}
          placeholder="e.g. The sales domain: customers, orders, products and how they relate"
        ></textarea>
        <span class="field-hint">Used even when the new agent gets no first task.</span>
      </div>
      <details class="group">
        <summary class="cursor-pointer list-none text-xs text-dim transition-colors hover:text-fg">
          <span class="group-open:hidden">Show advanced limits</span><span class="hidden group-open:inline">Hide advanced limits</span>
        </summary>
        <div class="mt-3 grid gap-5 sm:grid-cols-2">
          <div class="field">
            <label class="field-label" for="pf-rounds">Max rounds</label>
            <input id="pf-rounds" type="number" min="1" max="20" class="input tabular" bind:value={engineRounds} />
          </div>
          <div class="field">
            <label class="field-label" for="pf-timeout">Time limit (seconds)</label>
            <input id="pf-timeout" type="number" min="5" step="5" class="input tabular" bind:value={engineTimeoutS} />
          </div>
        </div>
      </details>
    </div>
  {/if}
{/snippet}

{#snippet sharedBody()}
  <label class="flex items-start gap-3">
    <Switch checked={sharedTools} label="shared scripts" onchange={(v) => (sharedTools = v)} />
    <span class="grid gap-0.5">
      <span class="text-sm text-fg">Share a <code class="font-mono text-xs">/tools</code> folder with the workspace</span>
      <span class="text-xs text-faint">Agents in this profile can save scripts there and reuse ones other agents made.</span>
    </span>
  </label>
{/snippet}

<div class="flex h-full min-h-0 flex-col">
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto w-full max-w-4xl px-6 max-sm:px-4">
      <!-- header -->
      <header class="flex items-start gap-3 border-b border-edge pt-6 pb-5">
        <button
          class="mt-0.5 grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-md text-faint transition-colors hover:bg-hover hover:text-fg"
          aria-label="close editor"
          title="Back"
          onclick={close}
        >
          <Icon icon={ArrowLeft} size={16} />
        </button>
        <span class="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-edge bg-panel text-faint">
          <Icon icon={Users} size={15} />
        </span>
        <div class="grid min-w-0 flex-1 gap-0.5">
          <span class="text-xs text-faint">{isNew ? "New agent profile" : "Agent profile"}</span>
          <h2 class="m-0 truncate text-lg font-medium text-fg">{name.trim() || (isNew ? "Untitled agent profile" : profileId)}</h2>
          {#if isNew}
            <p class="m-0 mt-1 text-sm text-dim">
              {duplicating
                ? "A copy of an existing profile. Change what you need and save."
                : "A group of agents that share a focus, a default model, the tool connections they may use and an optional briefing."}
            </p>
          {/if}
        </div>
        {#if !isNew}
          <div class="profile-menu relative">
            <button
              class="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-faint transition-colors hover:bg-hover hover:text-fg"
              aria-label="more actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onclick={() => (menuOpen = !menuOpen)}
            >
              <Icon icon={Ellipsis} size={16} />
            </button>
            {#if menuOpen}
              <div class="animate-pop absolute right-0 z-30 mt-1 w-48 rounded-xl border border-edge2 bg-panel2 p-1 shadow-overlay" role="menu">
                <button class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-hover" role="menuitem" onclick={duplicate}>
                  <Icon icon={Copy} size={14} class="text-faint" /> Duplicate
                </button>
                {#if profileId !== "default"}
                  <button class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-err hover:bg-err-soft" role="menuitem" onclick={() => void remove()}>
                    <Icon icon={Trash2} size={14} /> Delete
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </header>

      {@render section("Focus", "What agents in this profile are for. This is what people see when they pick a profile.", focusBody)}
      {@render section("Defaults", "Where new agents start. Each agent can still change its model later.", defaultsBody)}
      {@render section(
        "Tool connections",
        "The connections agents in this profile may use at all. Agents can switch allowed ones off and on, never beyond this list.",
        toolsBody,
      )}
      {@render section("Briefing", "Standing knowledge from the graph that a new agent keeps in mind on every turn.", briefingBody)}
      {@render section("Shared scripts", "Reuse across agents.", sharedBody)}
    </div>
  </div>

  <!-- sticky footer -->
  <footer class="shrink-0 border-t border-edge bg-bg/95 backdrop-blur-sm">
    <div class="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-3 px-6 py-3 max-sm:px-4">
      {#if error}
        <span class="flex min-w-0 items-center gap-1.5 text-xs text-err" role="alert">
          <Icon icon={TriangleAlert} size={13} /> <span class="truncate">{error}</span>
        </span>
      {:else if dirty}
        <span class="flex items-center gap-1.5 text-xs text-dim">
          <span class="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true"></span> Unsaved changes
        </span>
      {:else}
        <span class="text-xs text-faint">No changes</span>
      {/if}
      <span class="ml-auto"></span>
      <button class="btn btn-ghost" onclick={close}>Cancel</button>
      <button class="btn btn-primary" disabled={saving} onclick={() => void save()}>
        {saving ? "Saving…" : isNew ? "Create agent profile" : "Save changes"}
      </button>
    </div>
  </footer>
</div>
