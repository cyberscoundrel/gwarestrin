<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../lib/stores.svelte.js";
  import { getAdapter } from "../lib/rpc-agent-adapter.js";

  let { onclose } = $props<{ onclose: () => void }>();

  let promptText = $state("");
  let name = $state("");
  let providerId = $state<string>("");
  let modelId = $state<string>("");
  let phase = $state<"input" | "analyzing">("input");
  let error = $state<string | null>(null);

  const provider = $derived(store.providers.find((p) => p.id === providerId) ?? null);
  const models = $derived(provider?.models ?? []);

  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase === "input") onclose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

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

  function deriveName(): string {
    if (name.trim()) return name.trim();
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
    if (!promptText.trim()) {
      error = "write a first prompt to start from";
      return;
    }
    phase = "analyzing";
    error = null;
    try {
      const { api } = await import("../lib/api.js");
      const res = await api.createAgent({
        name: deriveName(),
        model: providerId && modelId ? { provider: providerId, modelId } : null,
        firstPrompt: promptText.trim(),
      });
      await store.refreshAgents();
      store.select(res.agent.id);
      onclose();
      // hand the first prompt to the running agent; adapter queues until ws open
      void getAdapter(res.agent.id).prompt(promptText.trim()).catch(() => {});
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
    <textarea
      class="min-h-28 resize-y rounded-md border border-edge2 bg-bg px-3 py-2.5 text-base text-fg outline-none focus:border-accent"
      placeholder="what should this agent work on first?"
      bind:value={promptText}
      autofocus
      onkeydown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
      }}
    ></textarea>

    <div class="grid grid-cols-[1fr_auto] items-end gap-2">
      <label class="grid gap-1 text-sm text-muted">
        name <span class="text-xs">(optional)</span>
        <input
          class="rounded-md border border-edge2 bg-bg px-2.5 py-2 text-base text-fg outline-none focus:border-accent"
          bind:value={name}
          placeholder={deriveName()}
        />
      </label>
      <label class="grid gap-1 text-sm text-muted">
        provider
        <select class="select" bind:value={providerId}>
          {#each store.providers as p (p.id)}
            <option value={p.id}>{p.id}{p.degraded ? " (degraded)" : ""}</option>
          {/each}
        </select>
      </label>
    </div>

    {#if error}
      <p class="m-0 text-sm text-err">{error}</p>
    {/if}

    <div class="flex items-center justify-between gap-2">
      <span class="text-xs text-muted">⌘/ctrl+enter to start</span>
      <div class="flex gap-2">
        <button class="cursor-pointer rounded-md border border-[#333845] bg-transparent px-4 py-2 text-fg" onclick={onclose}>cancel</button>
        <button
          class="cursor-pointer rounded-md bg-accent px-4 py-2 font-semibold text-[#0b0c10] disabled:cursor-default disabled:opacity-60"
          disabled={!promptText.trim()}
          onclick={() => void submit()}
        >
          analyze &amp; start
        </button>
      </div>
    </div>
  {:else}
    <div class="grid gap-3 py-6 text-center text-muted">
      <div class="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-edge2 border-t-accent"></div>
      <p class="m-0">analyzing graph context for your prompt…</p>
      <p class="m-0 text-xs">(queries the homelab knowledge graph — can take up to a minute)</p>
    </div>
  {/if}
</div>
