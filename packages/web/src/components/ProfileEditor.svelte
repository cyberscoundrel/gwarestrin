<script lang="ts">
  import { untrack } from "svelte";
  import { store } from "../lib/stores.svelte.js";
  import { api, mcpApi, type McpServerDef } from "../lib/api.js";
  import Dropdown from "./Dropdown.svelte";
  import { isFreeModelId } from "../lib/format.js";

  let {
    profileId,
    onclose,
  }: {
    profileId: string; // "new" or an existing profile id
    onclose?: () => void;
  } = $props();

  // The form is seeded once from the profile being edited; App remounts this
  // component (keyed by profile id) when a different profile is opened, so
  // reading the initial values untracked is intentional.
  const isNew = untrack(() => profileId === "new");
  const existing = untrack(() => (isNew ? undefined : store.profiles.find((p) => p.id === profileId)));

  let name = $state(isNew ? "" : (existing?.name ?? ""));
  let description = $state(isNew ? "" : (existing?.description ?? ""));
  let tier = $state<"local" | "cloud" | "">(existing?.defaults?.tier ?? "");
  let modelProvider = $state(existing?.defaults?.model?.provider ?? "");
  let modelId = $state(existing?.defaults?.model?.modelId ?? "");
  let thinkingLevel = $state(existing?.defaults?.thinkingLevel ?? "");
  let namePrefix = $state(existing?.defaults?.namePrefix ?? "");
  let mcpMode = $state<"all" | "pick">(existing?.mcpServers === "all" || !existing ? "all" : "pick");
  let pickedMcp = $state<string[]>(existing && existing.mcpServers !== "all" ? [...existing.mcpServers] : []);
  let engineEnabled = $state(existing?.contextEngine !== undefined);
  let engineType = $state<"graph-rag" | "lexical">(existing?.contextEngine?.type ?? "graph-rag");
  let enginePrompt = $state(existing?.contextEngine?.prompt ?? "");
  let engineRounds = $state(existing?.contextEngine?.maxRounds ?? 8);
  let engineTimeout = $state(existing?.contextEngine?.timeoutMs ?? 90_000);
  let sharedTools = $state(existing?.sharedTools !== false);

  let servers = $state<Record<string, McpServerDef>>({});
  let saving = $state(false);
  let error = $state("");

  $effect(() => {
    void mcpApi.list().then((s) => (servers = s));
  });

  const serverNames = $derived(Object.keys(servers));
  const modelOptions = $derived(
    tier
      ? (store.providers.find((p) => p.id === modelProvider || (modelProvider === "" && p.id === store.defaultProvider))?.models ?? [])
      : [],
  );

  function pickTier(t: "local" | "cloud") {
    tier = t;
    const prov = store.providers.find((p) => p.tier === t);
    modelProvider = prov?.id ?? store.defaultProvider ?? "";
    modelId = "";
  }

  async function save() {
    error = "";
    if (!name.trim()) {
      error = "name required";
      return;
    }
    if (mcpMode === "pick" && pickedMcp.length === 0) {
      error = "allow at least one tool connection (or allow all)";
      return;
    }
    saving = true;
    try {
      const saved = await api.saveProfile(isNew ? "new" : profileId, {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        defaults: {
          ...(tier ? { tier } : {}),
          ...(modelProvider && modelId ? { model: { provider: modelProvider, modelId } } : {}),
          ...(thinkingLevel ? { thinkingLevel: thinkingLevel as import("@gwarestrin/shared").ThinkingLevel } : {}),
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
                timeoutMs: engineTimeout,
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

  async function remove() {
    if (isNew) {
      onclose?.();
      return;
    }
    if (!confirm(`delete agent profile "${name}"? its agents keep running but fall back to the default agent profile.`)) return;
    try {
      await api.deleteProfile(profileId);
      await store.refreshProfiles();
      store.editingProfileId = null;
      onclose?.();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div class="m-auto w-full max-w-xl overflow-y-auto p-6">
  <div class="mb-4 flex items-center gap-3">
    <h2 class="m-0 tracking-wide text-fg">{isNew ? "new agent profile" : `edit agent profile — ${name || profileId}`}</h2>
    <button
      class="ml-auto cursor-pointer rounded border-none bg-transparent px-2 py-1 text-dim hover:text-fg"
      aria-label="close editor"
      onclick={() => {
        store.editingProfileId = null;
        onclose?.();
      }}
    >
      ✕
    </button>
  </div>

  <div class="grid gap-4 rounded-lg border border-edge bg-panel p-5">
    <label class="grid gap-1">
      <span class="text-xs tracking-wide text-dim uppercase">name</span>
      <input class="rounded-md border border-edge bg-inset px-3 py-2 text-fg" bind:value={name} placeholder="e.g. sql-analyst" />
    </label>

    <label class="grid gap-1">
      <span class="text-xs tracking-wide text-dim uppercase">description</span>
      <input class="rounded-md border border-edge bg-inset px-3 py-2 text-fg" bind:value={description} placeholder="what agents in this profile focus on" />
    </label>

    <div class="grid gap-2">
      <span class="text-xs tracking-wide text-dim uppercase">default model</span>
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex gap-2">
          <button
            class="cursor-pointer rounded-md border px-3 py-1.5 text-sm {tier === 'local' ? 'border-signal text-fg' : 'border-edge text-dim'}"
            onclick={() => pickTier("local")}>On-prem</button>
          <button
            class="cursor-pointer rounded-md border px-3 py-1.5 text-sm {tier === 'cloud' ? 'border-signal text-fg' : 'border-edge text-dim'}"
            onclick={() => pickTier("cloud")}>Cloud</button>
        </div>
        {#if tier}
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <div class="w-40 max-w-full">
              <Dropdown
                full
                label="default provider"
                value={modelProvider}
                options={store.providers
                  .filter((p) => p.tier === tier)
                  .map((p) => ({ value: p.id, label: p.id }))}
                onchange={(id) => {
                  modelProvider = id;
                  modelId = "";
                }}
              />
            </div>
            <div class="min-w-48 flex-1 max-sm:min-w-full">
              <Dropdown
                full
                label="default model"
                searchable
                quickFilter={modelOptions.some((m) => isFreeModelId(m.id)) ? { label: "free only", match: isFreeModelId } : undefined}
                value={modelId}
                options={modelOptions.map((m) => ({ value: m.id, label: m.id }))}
                onchange={(id) => (modelId = id)}
              />
            </div>
          </div>
        {/if}
      </div>
      {#if !tier}
        <span class="text-xs text-dim">no default model — the workspace default is used when an agent is created</span>
      {/if}
    </div>

    <label class="grid gap-1">
      <span class="text-xs tracking-wide text-dim uppercase">agent name prefix (optional)</span>
      <input class="rounded-md border border-edge bg-inset px-3 py-2 text-fg" bind:value={namePrefix} placeholder="e.g. sql-" />
    </label>

    <div class="grid gap-2">
      <span class="text-xs tracking-wide text-dim uppercase">allowed tool connections</span>
      <p class="m-0 text-xs text-dim">
        agents in this profile can only use the connections allowed here. a new agent starts with every
        allowed connection switched on; each agent can then switch them off and on again in its tools
        drawer, but never beyond this list.
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          class="cursor-pointer rounded-md border px-3 py-1.5 text-sm {mcpMode === 'all' ? 'border-signal text-fg' : 'border-edge text-dim'}"
          onclick={() => (mcpMode = "all")}>allow all workspace connections</button>
        <button
          class="cursor-pointer rounded-md border px-3 py-1.5 text-sm {mcpMode === 'pick' ? 'border-signal text-fg' : 'border-edge text-dim'}"
          onclick={() => (mcpMode = "pick")}>allow only selected…</button>
      </div>
      {#if mcpMode === "all"}
        <span class="text-xs text-dim">includes connections added to the workspace later.</span>
      {/if}
      {#if mcpMode === "pick"}
        <div class="flex flex-wrap gap-2 rounded-md border border-edge bg-inset p-3" role="group" aria-label="allowed tool connections">
          {#each serverNames as s (s)}
            <button
              class="cursor-pointer rounded-full border px-3 py-1 text-xs {pickedMcp.includes(s) ? 'border-signal bg-signal-soft text-fg' : 'border-edge text-dim'}"
              aria-pressed={pickedMcp.includes(s)}
              onclick={() => (pickedMcp = pickedMcp.includes(s) ? pickedMcp.filter((x) => x !== s) : [...pickedMcp, s])}
            >
              {s}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="grid gap-2">
      <label class="flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" class="accent-signal" bind:checked={engineEnabled} />
        <span class="tracking-wide">briefing — when an agent is created, build a briefing from the knowledge graph</span>
      </label>
      {#if engineEnabled}
        <div class="grid gap-3 rounded-md border border-edge bg-inset p-3">
          <div>
            <Dropdown
              value={engineType}
              options={[
                { value: "graph-rag", label: "graph-rag (an AI model reads the knowledge graph and writes it)" },
                { value: "lexical", label: "lexical (fixed summary of the knowledge graph, no AI)" },
              ]}
              onchange={(t) => (engineType = t as "graph-rag" | "lexical")}
            />
          </div>
          <textarea
            class="min-h-20 rounded-md border border-edge bg-inset px-3 py-2 text-fg"
            bind:value={enginePrompt}
            placeholder="what should the briefing focus on? (used even when the agent gets no first prompt)"
          ></textarea>
          <div class="flex items-center gap-3 text-xs text-dim">
            <label class="flex items-center gap-1">rounds <input type="number" min="1" max="20" class="w-16 rounded border border-edge bg-inset px-1.5 py-1 text-fg" bind:value={engineRounds} /></label>
            <label class="flex items-center gap-1">timeout ms <input type="number" min="5000" step="5000" class="w-24 rounded border border-edge bg-inset px-1.5 py-1 text-fg" bind:value={engineTimeout} /></label>
          </div>
        </div>
      {/if}
    </div>

    <label class="flex items-center gap-2 text-sm text-fg">
      <input type="checkbox" class="accent-signal" bind:checked={sharedTools} />
      <span class="tracking-wide">shared /tools directory — agents in this profile can share scripts with the rest of the workspace</span>
    </label>

    {#if error}
      <div class="rounded-md border border-err/40 bg-err-soft px-3 py-2 text-sm text-err">{error}</div>
    {/if}

    <div class="flex gap-2">
      <button
        class="cursor-pointer rounded-md bg-signal px-4 py-2 font-semibold text-on-signal hover:brightness-110 disabled:opacity-50"
        disabled={saving}
        onclick={save}
      >
        {saving ? "saving…" : isNew ? "create agent profile" : "save changes"}
      </button>
      {#if !isNew}
        <button
          class="cursor-pointer rounded-md border border-err/40 px-4 py-2 text-err hover:bg-err-soft"
          onclick={remove}
        >
          delete
        </button>
      {/if}
    </div>
  </div>
</div>
