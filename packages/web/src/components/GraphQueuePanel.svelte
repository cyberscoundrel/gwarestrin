<script lang="ts">
  import { onMount } from "svelte";
  import { Check, CircleCheck, Inbox, TriangleAlert, X } from "lucide";
  import Dialog from "./Dialog.svelte";
  import PanelHeader from "./PanelHeader.svelte";
  import EmptyState from "./EmptyState.svelte";
  import SkeletonRows from "./SkeletonRows.svelte";
  import Icon from "./Icon.svelte";
  import { api } from "../lib/api.js";

  let { onclose }: { onclose: () => void } = $props();

  interface Pending {
    /** the queue's own id (what approve/reject take; not the record id) */
    id: string;
    kind: string;
    home?: string;
    requested_by?: string;
    created_at?: string;
    payload?: string;
    language?: string;
  }

  // position names, so proposals read in words
  let names = $state(new Map<string, string>());
  $effect(() => {
    void api
      .positions()
      .then((t) => (names = new Map((t.tree ?? t.positions).map((p) => [p.id, p.parent === null ? "the whole organization" : p.name]))))
      .catch(() => {});
  });
  const pos = (id: unknown) => (typeof id === "string" ? (names.get(id) ?? "an unknown position") : "the whole organization");

  /** what a queued write would do, in a sentence (raw payload stays one click away) */
  function describe(p: Pending): { title: string; detail?: string } | null {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(p.payload ?? "");
    } catch {
      return null;
    }
    if (p.kind === "upsert") {
      const list = (body.entities as Array<{ name?: string }> | undefined) ?? [];
      const shown = list.slice(0, 4).map((e) => e.name).join(", ");
      return { title: `Write ${list.length} ${list.length === 1 ? "entry" : "entries"} at ${pos(body.home)}`, detail: shown + (list.length > 4 ? ` and ${list.length - 4} more` : "") };
    }
    if (p.kind === "rehome") {
      const why = typeof body.reason === "string" && body.reason ? body.reason : "Changes who can see it.";
      return { title: `Move ${String(body.name)} from ${pos(body.from)} to ${pos(body.to)}`, detail: why };
    }
    if (p.kind === "grant") {
      const what = body.kind === "subtree" ? `everything under ${pos(body.target)}` : String(body.target_name);
      const until = body.expires_at ? `until ${new Date(String(body.expires_at)).toLocaleDateString()}` : "with no end date";
      return { title: `Share ${what} with ${pos(body.to_pos)} ${until}`, detail: `Why: ${String(body.reason ?? "")}` };
    }
    if (p.kind === "backfill") return { title: "Fill in missing search embeddings", detail: `Up to ${String(body.limit ?? 64)} entries.` };
    return null;
  }
  let open = $state(new Set<string>());
  const toggle = (id: string) => (open = open.has(id) ? new Set([...open].filter((x) => x !== id)) : new Set([...open, id]));

  let enabled = $state(true);
  let pending = $state<Pending[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let loaded = $state(false);

  function ago(iso: string | undefined): string {
    const t = iso ? Date.parse(iso) : NaN;
    if (Number.isNaN(t)) return iso ?? "";
    const m = Math.round((Date.now() - t) / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return new Date(t).toLocaleDateString();
  }

  async function refresh(): Promise<void> {
    error = null;
    try {
      const r = await fetch("/api/graph-queue");
      if (!r.ok) throw new Error(`couldn't load approvals (${r.status})`);
      const j = await r.json();
      enabled = j.enabled !== false;
      pending = (j.pending ?? []).map((p: Record<string, unknown>) => ({
        id: String(p.id ?? ""),
        kind: String(p.kind ?? "command"),
        ...(typeof p.home === "string" ? { home: p.home } : {}),
        requested_by: String(p.requested_by ?? "?"),
        created_at: String(p.created_at ?? ""),
        payload: String(p.payload ?? ""),
        language: String(p.language ?? "sql"),
      }));
      loaded = true;
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

  onMount(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  });
</script>

<Dialog {onclose} labelledby="graph-queue-title" width="44rem">
  <PanelHeader
    id="graph-queue-title"
    title="Approvals"
    subtitle="Changes agents want to write to the knowledge graph. Nothing is written until someone approves."
    icon={Inbox}
    {onclose}
  />

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if error}
      <div class="mx-5 mt-4 flex items-start gap-2 rounded-md border border-err/30 bg-err-soft px-3 py-2 text-xs text-err" role="alert">
        <Icon icon={TriangleAlert} size={14} class="mt-px" />
        {error}
      </div>
    {/if}
    {#if !enabled}
      <EmptyState icon={Inbox} title="Approvals aren't set up" hint="This workspace has no review step for knowledge-graph writes." />
    {:else if !loaded && !error}
      <SkeletonRows rows={3} />
    {:else if pending.length === 0 && !error}
      <EmptyState icon={CircleCheck} title="All caught up" hint="Nothing is waiting for approval. New requests appear here as agents make them." />
    {:else}
      <ul class="m-0 grid list-none gap-3 p-5">
        {#each pending as p (p.id)}
          {@const d = describe(p)}
          <li class="animate-enter grid gap-3 rounded-lg border border-edge bg-panel p-4">
            <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span class="text-sm text-fg">Requested by <span class="font-medium">{p.requested_by}</span></span>
              <span class="text-xs text-faint" title={p.created_at}>{ago(p.created_at)}</span>
              <span class="ml-auto font-mono text-2xs text-faint" title="request id">{p.id.slice(0, 8)}</span>
            </div>
            {#if d}
              <div class="grid gap-1">
                <span class="text-sm text-fg">{d.title}</span>
                {#if d.detail}<span class="text-xs text-dim">{d.detail}</span>{/if}
              </div>
              <button class="w-fit cursor-pointer text-2xs text-faint underline-offset-2 hover:text-dim hover:underline" onclick={() => toggle(p.id)}>
                {open.has(p.id) ? "Hide details" : "Show details"}
              </button>
            {/if}
            {#if !d || open.has(p.id)}
              <pre
                class="m-0 max-h-60 overflow-y-auto rounded-md border border-edge bg-inset p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-fg">{p.payload}</pre>
            {/if}
            <div class="flex justify-end gap-2">
              <button class="btn btn-danger btn-sm" disabled={busy} onclick={() => void act("reject", p.id)}>
                <Icon icon={X} size={13} />
                Reject
              </button>
              <button class="btn btn-primary btn-sm" disabled={busy} onclick={() => void act("approve", p.id)}>
                <Icon icon={Check} size={13} />
                Approve
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</Dialog>
