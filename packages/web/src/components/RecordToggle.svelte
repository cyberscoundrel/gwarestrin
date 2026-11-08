<script lang="ts">
  // On or off record: the person's switch for the current conversation
  // (docs/ORGANIZATION-MODEL.md, "On record is a deliberate act"). Off is the
  // default and nothing said reaches the knowledge graph; on, the agent
  // condenses sections into documents with claims. Switching off again stops
  // recording and unrecords nothing.
  import type { ThreadRecordState } from "@gwarestrin/shared";
  import { Circle, CircleDot } from "lucide";
  import { api } from "../lib/api.js";
  import { store } from "../lib/stores.svelte.js";
  import Icon from "./Icon.svelte";

  let { agentId }: { agentId: string } = $props();

  const record = $derived<ThreadRecordState | undefined>(store.recordFor(agentId));
  const on = $derived(record?.on ?? false);
  let open = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let reason = $state("");

  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // the state the server has (the socket sends every change; this covers a reconnect)
  $effect(() => {
    if (!open) return;
    void api
      .threadRecord(agentId)
      .then((r) => store.setRecord(agentId, r))
      .catch(() => {});
  });

  const when = (iso: string | null | undefined): string => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  };

  async function set(next: boolean): Promise<void> {
    busy = true;
    error = null;
    try {
      const r = await api.setThreadRecord(agentId, { on: next, ...(next && reason.trim() ? { reason: reason.trim() } : {}) });
      store.setRecord(agentId, r);
      reason = "";
      open = false;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="relative">
  <button
    class="relative z-30 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs transition-colors disabled:opacity-50
      {on ? 'border-signal/40 bg-signal-soft text-signal' : open ? 'border-edge2 bg-selected text-fg' : 'border-edge2 text-dim hover:bg-hover hover:text-fg'}"
    disabled={busy}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-pressed={on}
    title={on
      ? `On record since ${when(record?.since)}: what is said here is condensed into the knowledge graph`
      : record?.ever
        ? `Off record since ${when(record?.until)}. What was recorded stays.`
        : "Off record: nothing said here reaches the knowledge graph"}
    onclick={() => (open = !open)}
  >
    <Icon icon={on ? CircleDot : Circle} size={13} class={on ? "animate-working" : "text-faint"} />
    {on ? "On record" : "Off record"}
    {#if on && record?.documents}
      <span class="rounded bg-signal/15 px-1 font-mono text-2xs" title="documents condensed from this conversation">{record.documents}</span>
    {/if}
  </button>

  {#if open}
    <div class="fixed inset-0 z-29" role="presentation" onclick={() => (open = false)}></div>
    <div class="animate-pop absolute left-0 z-30 mt-1 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-edge2 bg-panel2 p-3 shadow-overlay" role="dialog" aria-label="On or off record">
      {#if on}
        <p class="m-0 text-sm text-fg">This conversation is on record.</p>
        <dl class="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-dim">
          <dt class="text-faint">Since</dt>
          <dd class="m-0">{when(record?.since)}</dd>
          {#if record?.by}
            <dt class="text-faint">By</dt>
            <dd class="m-0">{record.by}{record.position ? ` (${record.position})` : ""}</dd>
          {/if}
          {#if record?.reason}
            <dt class="text-faint">Reason</dt>
            <dd class="m-0">{record.reason}</dd>
          {/if}
          <dt class="text-faint">Recorded</dt>
          <dd class="m-0">
            {record?.documents ?? 0} document{record?.documents === 1 ? "" : "s"}{record?.condensed_at ? `, last ${when(record.condensed_at)}` : ""}
          </dd>
        </dl>
        <p class="m-0 mt-2 text-xs text-faint">
          The agent condenses what is said into documents with claims, at the end of a matter or when you ask it to. Switching off stops further recording; what was recorded stays.
        </p>
        <button
          class="mt-3 inline-flex h-7 w-full cursor-pointer items-center justify-center rounded-md border border-edge2 px-2.5 text-xs font-medium text-dim transition-colors hover:border-faint hover:text-fg disabled:opacity-50"
          disabled={busy}
          onclick={() => void set(false)}
        >
          {busy ? "Switching…" : "Switch off record"}
        </button>
      {:else}
        <p class="m-0 text-sm text-fg">This conversation is off record.</p>
        <p class="m-0 mt-1 text-xs text-faint">
          Nothing said here reaches the knowledge graph. On record, what you say from then on is condensed by your agent into documents with claims, under your position and name.
          {#if record?.ever}
            It was on record from {when(record.since)} to {when(record.until)}; {record.documents} document{record.documents === 1 ? " was" : "s were"} recorded and stay.
          {/if}
        </p>
        <label class="mt-2 block text-xs text-dim">
          Why it goes on record
          <input
            class="mt-1 h-7 w-full rounded-md border border-edge2 bg-inset px-2 text-xs text-fg placeholder:text-faint"
            placeholder="e.g. shift handover, the Toro reorder"
            bind:value={reason}
            maxlength="300"
            onkeydown={(e) => {
              if (e.key === "Enter") void set(true);
            }}
          />
        </label>
        <button
          class="mt-3 inline-flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-signal/40 bg-signal-soft px-2.5 text-xs font-medium text-signal transition-colors hover:border-signal disabled:opacity-50"
          disabled={busy}
          onclick={() => void set(true)}
        >
          <Icon icon={CircleDot} size={13} />
          {busy ? "Switching…" : "Put on record from now"}
        </button>
      {/if}
      {#if error}
        <p class="m-0 mt-2 text-xs text-err">{error}</p>
      {/if}
    </div>
  {/if}
</div>
