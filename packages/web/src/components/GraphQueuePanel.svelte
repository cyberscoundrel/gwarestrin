<script lang="ts">
  import { onMount } from "svelte";

  let { onclose }: { onclose: () => void } = $props();

  interface Pending {
    "@rid": string;
    requested_by?: string;
    created_at?: string;
    payload?: string;
    language?: string;
  }

  let enabled = $state(true);
  let pending = $state<Pending[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function refresh(): Promise<void> {
    error = null;
    try {
      const r = await fetch("/api/graph-queue");
      if (!r.ok) throw new Error(`couldn't load approvals (${r.status})`);
      const j = await r.json();
      enabled = j.enabled !== false;
      pending = (j.pending ?? []).map((p: Record<string, unknown>) => ({
        "@rid": String(p["@rid"] ?? ""),
        requested_by: String(p.requested_by ?? "?"),
        created_at: String(p.created_at ?? ""),
        payload: String(p.payload ?? ""),
        language: String(p.language ?? "sql"),
      }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function act(kind: "approve" | "reject", id: string): Promise<void> {
    busy = true;
    error = null;
    try {
      const r = await fetch(`/api/graph-queue/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${kind} failed (${r.status})`);
      }
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onclose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  onMount(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  });
</script>

<div class="fixed inset-0 z-50 bg-black/55" role="presentation" onclick={onclose}></div>
<div
  class="fixed top-1/2 left-1/2 z-51 flex max-h-[80vh] w-[min(46rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col
    gap-3 overflow-hidden rounded-xl border border-edge2 bg-panel2 p-5"
  role="dialog"
  aria-modal="true"
  aria-labelledby="graph-queue-title"
>
  <div class="flex items-center justify-between">
    <h3 id="graph-queue-title" class="m-0 tracking-wide">approvals <span class="text-sm font-normal text-dim">· changes agents want to write to the knowledge graph</span></h3>
    <button class="cursor-pointer border-none bg-transparent text-dim hover:text-fg" aria-label="close" onclick={onclose}>✕</button>
  </div>

  {#if error}<p class="m-0 text-sm text-err">{error}</p>{/if}
  {#if !enabled}
    <p class="m-0 text-sm text-dim">approvals aren't set up for this workspace.</p>
  {:else if !error || pending.length > 0}
    {#if pending.length === 0}
      <p class="m-0 py-6 text-center text-sm text-dim">nothing is waiting for approval.</p>
    {:else}
      <div class="min-h-0 flex-1 overflow-y-auto">
        {#each pending as p (p["@rid"])}
          <div class="mb-2 rounded-lg border border-edge2 bg-bg p-3">
            <div class="mb-1 flex flex-wrap items-center gap-2 text-xs text-dim">
              <span class="font-mono">{p["@rid"]}</span>
              <span>· {p.requested_by}</span>
              <span>· {p.created_at}</span>
              <span class="ml-auto flex gap-1">
                <button
                  class="cursor-pointer rounded-md bg-ok px-3 py-1 text-xs font-semibold text-on-signal disabled:opacity-50"
                  disabled={busy}
                  onclick={() => void act("approve", p["@rid"])}
                >
                  approve
                </button>
                <button
                  class="cursor-pointer rounded-md bg-err px-3 py-1 text-xs font-semibold text-on-signal disabled:opacity-50"
                  disabled={busy}
                  onclick={() => void act("reject", p["@rid"])}
                >
                  reject
                </button>
              </span>
            </div>
            <pre class="m-0 max-h-60 overflow-y-auto rounded border border-edge bg-panel p-2 font-mono text-xs break-words whitespace-pre-wrap text-fg">{p.payload}</pre>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
