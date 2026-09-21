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
      enabled = false;
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function act(kind: "approve" | "reject", id: string): Promise<void> {
    busy = true;
    error = null;
    try {
      await fetch(`/api/graph-queue/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

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
>
  <div class="flex items-center justify-between">
    <h3 class="m-0 tracking-wide">graph write approvals</h3>
    <button class="cursor-pointer border-none bg-transparent text-muted hover:text-fg" onclick={onclose}>✕</button>
  </div>

  {#if !enabled}
    <p class="m-0 text-sm text-muted">no review surface configured for this instance.</p>
  {:else}
    {#if error}<p class="m-0 text-sm text-err">{error}</p>{/if}
    {#if pending.length === 0}
      <p class="m-0 py-6 text-center text-sm text-muted">no pending writes.</p>
    {:else}
      <div class="min-h-0 flex-1 overflow-y-auto">
        {#each pending as p (p["@rid"])}
          <div class="mb-2 rounded-lg border border-edge2 bg-bg p-3">
            <div class="mb-1 flex items-center gap-2 text-xs text-muted">
              <span class="font-mono">{p["@rid"]}</span>
              <span>· {p.requested_by}</span>
              <span>· {p.created_at}</span>
              <span class="ml-auto flex gap-1">
                <button
                  class="cursor-pointer rounded-md bg-ok px-3 py-1 text-xs font-semibold text-[#0b0c10] disabled:opacity-50"
                  disabled={busy}
                  onclick={() => void act("approve", p["@rid"])}
                >
                  approve
                </button>
                <button
                  class="cursor-pointer rounded-md bg-err px-3 py-1 text-xs font-semibold text-[#0b0c10] disabled:opacity-50"
                  disabled={busy}
                  onclick={() => void act("reject", p["@rid"])}
                >
                  reject
                </button>
              </span>
            </div>
            <pre class="m-0 overflow-x-auto rounded border border-edge bg-panel p-2 font-mono text-xs text-fg">{p.payload}</pre>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
