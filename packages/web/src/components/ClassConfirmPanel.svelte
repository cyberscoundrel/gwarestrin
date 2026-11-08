<script lang="ts">
  /**
   * Discovered commitment classes, for a person to confirm (the Discovery
   * stream; docs/ORGANIZATION-MODEL.md "Classes and instances"). A survey of
   * a connection drafts a class per transaction table with its stages and
   * record table and says why; nothing maps onto a class until someone here
   * confirms it. Rendered as a section of Organization settings; graph-rag
   * gates confirming and retiring to a person at the root, the same way it
   * gates the policy.
   */
  import { onMount } from "svelte";
  import { TriangleAlert } from "lucide";
  import Icon from "./Icon.svelte";
  import SkeletonRows from "./SkeletonRows.svelte";

  interface CommitmentClass {
    name: string;
    description: string | null;
    stages: string[];
    record_table: string | null;
    status: "proposed" | "confirmed" | "retired";
    proposed_by: string | null;
    confirmed_by: string | null;
    confirmed_at: string | null;
    attributes: string[];
    reasons: string[];
  }
  interface Edit {
    name: string;
    description: string;
    stages: string;
    record_table: string;
  }

  let classes = $state<CommitmentClass[]>([]);
  let canConfirm = $state(false);
  let loaded = $state(false);
  let loadError = $state("");
  let error = $state("");
  let note = $state("");
  let busy = $state("");
  let showRetired = $state(false);
  // what the person typed over a draft before confirming it, by the draft's name
  let edits = $state<Record<string, Edit>>({});

  async function json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  async function load(): Promise<void> {
    loadError = "";
    try {
      const r = await json<{ classes: CommitmentClass[]; canConfirm: boolean }>(await fetch("/api/discovery/classes"));
      classes = r.classes;
      canConfirm = r.canConfirm;
      const next: Record<string, Edit> = {};
      for (const c of r.classes) if (c.status === "proposed") next[c.name] = edits[c.name] ?? { name: c.name, description: c.description ?? "", stages: c.stages.join(", "), record_table: c.record_table ?? "" };
      edits = next;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loaded = true;
    }
  }
  onMount(() => void load());

  const drafts = $derived(classes.filter((c) => c.status === "proposed"));
  const confirmed = $derived(classes.filter((c) => c.status === "confirmed"));
  const retired = $derived(classes.filter((c) => c.status === "retired"));

  async function act(name: string, action: "confirm" | "retire", body: Record<string, unknown>, done: string): Promise<void> {
    busy = `${action}:${name}`;
    error = "";
    note = "";
    try {
      await json(await fetch(`/api/discovery/classes/${encodeURIComponent(name)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      note = done;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = "";
    }
  }
  function confirm(c: CommitmentClass): void {
    const e = edits[c.name];
    if (!e) return;
    const stages = e.stages
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!stages.length) {
      error = `"${e.name || c.name}" needs at least one stage.`;
      return;
    }
    void act(c.name, "confirm", { name: e.name.trim() || c.name, description: e.description.trim() || null, stages, record_table: e.record_table.trim() || null }, `"${e.name.trim() || c.name}" confirmed: claims and policy can use it now.`);
  }
  const retire = (c: CommitmentClass) => void act(c.name, "retire", {}, `"${c.name}" retired: nothing maps onto it from now on.`);

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
  const who = (c: CommitmentClass) => (c.proposed_by?.startsWith("survey:") ? `the survey of ${c.proposed_by.slice(7)}` : c.proposed_by?.startsWith("discovery") ? "discovery" : c.proposed_by?.startsWith("worker") ? `a worker (${c.proposed_by})` : (c.proposed_by ?? "discovery"));
</script>

{#if loadError}
  <div class="flex items-start gap-2 rounded-md border border-err/30 bg-err-soft px-3 py-2 text-xs text-err" role="alert">
    <Icon icon={TriangleAlert} size={14} class="mt-px" />
    {loadError}
  </div>
{:else if !loaded}
  <SkeletonRows rows={2} />
{:else}
  {#if drafts.length === 0}
    <p class="m-0 text-xs text-faint">
      {classes.length === 0 ? "No classes yet. A survey of a connection (Graph worker) drafts one per table that records commitments; a worker that keeps meeting a pattern no table records files one too." : "Every draft has been decided."}
    </p>
  {:else}
    <div class="grid gap-3">
      <span class="text-xs font-medium text-dim">{drafts.length} {drafts.length === 1 ? "draft" : "drafts"} to confirm</span>
      {#each drafts as c (c.name)}
        {@const e = edits[c.name] ?? { name: c.name, description: c.description ?? "", stages: c.stages.join(", "), record_table: c.record_table ?? "" }}
        <article class="grid gap-3 rounded-md border border-edge bg-panel px-3 py-3" aria-label={`draft class ${c.name}`}>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="field">
              <label class="field-label" for={`cc-name-${c.name}`}>Class</label>
              <input id={`cc-name-${c.name}`} class="input input-mono" bind:value={e.name} disabled={!canConfirm} />
            </div>
            <div class="field">
              <label class="field-label" for={`cc-table-${c.name}`}>Record table</label>
              <input id={`cc-table-${c.name}`} class="input input-mono" bind:value={e.record_table} placeholder="none: no system records it" disabled={!canConfirm} />
            </div>
          </div>
          <div class="field">
            <label class="field-label" for={`cc-desc-${c.name}`}>What one commits</label>
            <input id={`cc-desc-${c.name}`} class="input" bind:value={e.description} disabled={!canConfirm} />
          </div>
          <div class="field">
            <label class="field-label" for={`cc-stages-${c.name}`}>Stages, in order</label>
            <input id={`cc-stages-${c.name}`} class="input input-mono" bind:value={e.stages} placeholder="quoted, ordered, shipped" disabled={!canConfirm} />
            <span class="field-hint">Every instance is at one of these; a claim's stage must be one of them.</span>
          </div>
          {#if c.reasons.length}
            <ul class="m-0 grid list-disc gap-0.5 pl-4 text-xs text-faint">
              {#each c.reasons as r (r)}<li>{r}</li>{/each}
            </ul>
          {/if}
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-faint">Drafted by {who(c)}{c.attributes.length > 1 ? ` · attributes: ${c.attributes.join(", ")}` : ""}</span>
            <span class="ml-auto"></span>
            <button class="btn btn-ghost btn-sm" disabled={!canConfirm || busy !== ""} onclick={() => retire(c)}>{busy === `retire:${c.name}` ? "Retiring…" : "Not a class"}</button>
            <button class="btn btn-primary btn-sm" disabled={!canConfirm || busy !== ""} onclick={() => confirm(c)}>{busy === `confirm:${c.name}` ? "Confirming…" : "Confirm"}</button>
          </div>
        </article>
      {/each}
    </div>
  {/if}

  {#if confirmed.length}
    <div class="grid gap-1.5">
      <span class="text-xs font-medium text-dim">Confirmed</span>
      {#each confirmed as c (c.name)}
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
          <span class="font-mono text-fg">{c.name}</span>
          <span class="text-faint">{c.stages.join(" › ")}</span>
          <span class="text-faint">· {c.record_table ?? "no record table"}</span>
          <span class="text-faint">· {c.confirmed_by} {when(c.confirmed_at)}</span>
          {#if canConfirm}
            <button class="btn btn-ghost btn-sm ml-auto" disabled={busy !== ""} onclick={() => retire(c)}>{busy === `retire:${c.name}` ? "Retiring…" : "Retire"}</button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if retired.length}
    <div class="grid gap-1">
      <button class="btn btn-ghost btn-sm justify-self-start" onclick={() => (showRetired = !showRetired)}>{showRetired ? "Hide" : "Show"} {retired.length} retired</button>
      {#if showRetired}
        {#each retired as c (c.name)}
          <span class="truncate text-xs text-faint"><span class="font-mono">{c.name}</span>{c.record_table ? ` · ${c.record_table}` : ""} · {c.reasons.at(-1) ?? "retired"}</span>
        {/each}
      {/if}
    </div>
  {/if}

  {#if error}
    <span class="flex items-center gap-1.5 text-xs text-err" role="alert"><Icon icon={TriangleAlert} size={13} /> {error}</span>
  {:else if note}
    <span class="text-xs text-dim" role="status">{note}</span>
  {/if}
  {#if !canConfirm && classes.length}
    <span class="field-hint">Only a person at the organization's root confirms or retires classes.</span>
  {/if}
{/if}
