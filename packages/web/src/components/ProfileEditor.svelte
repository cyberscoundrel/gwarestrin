<script lang="ts">
  import { store } from "../lib/stores.svelte.js";
  import { api, mcpApi, type McpServerDef } from "../lib/api.js";
  import Dropdown from "./Dropdown.svelte";

  let {
    profileId,
    onclose,
  }: {
    profileId: string; // "new" or an existing profile id
    onclose?: () => void;
  } = $props();

  const isNew = profileId === "new";
  const existing = $derived(store.profiles.find((p) => p.id === profileId));

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
    const prov = store.providers.find((p) => (t === "local" ? p.id.includes("local") : !p.id.includes("local")));
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
      error = "pick at least one MCP server (or switch to all)";
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
    if (!confirm(`delete profile "${name}"? agents keep running but fall back to the default profile.`)) return;
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
    <h2 class="m-0 tracking-wide text-fg">{isNew ? "new profile" : `edit profile — ${name || profileId}`}</h2>
    <button
      class="ml-auto cursor-pointer rounded border-none bg-transparent px-2 py-1 text-muted hover:text-fg"
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
      <span class="text-xs tracking-wide text-muted uppercase">name</span>
      <input class="rounded-md border border-edge bg-[#12141b] px-3 py-2 text-fg" bind:value={name} placeholder="e.g. sql-analyst" />
    </label>

    <label class="grid gap-1">
      <span class="text-xs tracking-wide text-muted uppercase">description</span>
      <input class="rounded-md border border-edge bg-[#12141b] px-3 py-2 text-fg" bind:value={description} placeholder="what agents under this profile do" />
    </label>

    <div class="grid gap-2">
      <span class="text-xs tracking-wide text-muted uppercase">default model</span>
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex gap-2">
          <button
            class="cursor-pointer rounded-md border px-3 py-1.5 text-sm {tier === 'local' ? 'border-accent text-fg' : 'border-edge text-muted'}"
            onclick={() => pickTier("local")}>local</button>
          <button
            class="cursor-pointer rounded-md border px-3 py-1.5 text-sm {tier === 'cloud' ? 'border-accent text-fg' : 'border-edge text-muted'}"
            onclick={() => pickTier("cloud")}>cloud</button>
        </div>
        {#if tier}
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <div class="w-40 [&_button]:w-full [&_button]:max-w-40">
              <Dropdown
                value={modelProvider}
                options={store.providers
                  .filter((p) => (tier === "local") === p.id.includes("local"))
                  .map((p) => ({ value: p.id, label: p.id }))}
                onchange={(id) => {
                  modelProvider = id;
                  modelId = "";
                }}
              />
            </div>
            <div class="min-w-0 flex-1 [&_button]:w-full">
              <Dropdown
                value={modelId}
                options={modelOptions.map((m) => ({ value: m.id, label: m.id }))}
                onchange={(id) => (modelId = id)}
              />
            </div>
          </div>
        {/if}
      </div>
      {#if !tier}
        <span class="text-xs text-muted">no model default — server default is used at create time</span>
      {/if}
    </div>

    <label class="grid gap-1">
      <span class="text-xs tracking-wide text-muted uppercase">agent name prefix (optional)</span>
      <input class="rounded-md border border-edge bg-[#12141b] px-3 py-2 text-fg" bind:value={namePrefix} placeholder="e.g. sql-" />
    </label>

    <div class="grid gap-2">
      <span class="text-xs tracking-wide text-muted uppercase">MCP servers (fixed at agent creation)</span>
      <div class="flex gap-2">
        <button
          class="cursor-pointer rounded-md border px-3 py-1.5 text-sm {mcpMode === 'all' ? 'border-accent text-fg' : 'border-edge text-muted'}"
          onclick={() => (mcpMode = "all")}>all instance servers</button>
        <button
          class="cursor-pointer rounded-md border px-3 py-1.5 text-sm {mcpMode === 'pick' ? 'border-accent text-fg' : 'border-edge text-muted'}"
          onclick={() => (mcpMode = "pick")}>pick…</button>
      </div>
      {#if mcpMode === "pick"}
        <div class="flex flex-wrap gap-2 rounded-md border border-edge bg-[#12141b] p-3">
          {#each serverNames as s (s)}
            <button
              class="cursor-pointer rounded-full border px-3 py-1 text-xs {pickedMcp.includes(s) ? 'border-accent bg-accent/10 text-fg' : 'border-edge text-muted'}"
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
        <input type="checkbox" class="accent-[var(--accent)]" bind:checked={engineEnabled} />
        <span class="tracking-wide">context engine — generate standing context at agent creation</span>
      </label>
      {#if engineEnabled}
        <div class="grid gap-3 rounded-md border border-edge bg-[#12141b] p-3">
          <div>
            <Dropdown
              value={engineType}
              options={[
                { value: "graph-rag", label: "graph-rag (LLM tool-loop over the knowledge graph)" },
                { value: "lexical", label: "lexical (deterministic graph summary)" },
              ]}
              onchange={(t) => (engineType = t as "graph-rag" | "lexical")}
            />
          </div>
          <textarea
            class="min-h-20 rounded-md border border-edge bg-[#1a1d26] px-3 py-2 text-fg"
            bind:value={enginePrompt}
            placeholder="analysis prompt — what should the engine focus on? (runs even without a user first prompt)"
          ></textarea>
          <div class="flex items-center gap-3 text-xs text-muted">
            <label class="flex items-center gap-1">rounds <input type="number" min="1" max="20" class="w-16 rounded border border-edge bg-[#1a1d26] px-1.5 py-1 text-fg" bind:value={engineRounds} /></label>
            <label class="flex items-center gap-1">timeout ms <input type="number" min="5000" step="5000" class="w-24 rounded border border-edge bg-[#1a1d26] px-1.5 py-1 text-fg" bind:value={engineTimeout} /></label>
          </div>
        </div>
      {/if}
    </div>

    <label class="flex items-center gap-2 text-sm text-fg">
      <input type="checkbox" class="accent-[var(--accent)]" bind:checked={sharedTools} />
      <span class="tracking-wide">shared /tools directory — agents under this profile can share scripts with the instance</span>
    </label>

    {#if error}
      <div class="rounded-md border border-err/40 bg-[#2a1218] px-3 py-2 text-sm text-err">{error}</div>
    {/if}

    <div class="flex gap-2">
      <button
        class="cursor-pointer rounded-md bg-accent px-4 py-2 font-semibold text-[#0b0c10] hover:brightness-110 disabled:opacity-50"
        disabled={saving}
        onclick={save}
      >
        {saving ? "saving…" : isNew ? "create profile" : "save changes"}
      </button>
      {#if !isNew}
        <button
          class="cursor-pointer rounded-md border border-err/40 px-4 py-2 text-err hover:bg-[#2a1218]"
          onclick={remove}
        >
          delete
        </button>
      {/if}
    </div>
  </div>
</div>
