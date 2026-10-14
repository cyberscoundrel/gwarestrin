<script lang="ts">
  import { onMount } from "svelte";
  import { Network, TriangleAlert } from "lucide";
  import { api, type GraphWorkerView, type PoolSettings, type WorkerProposal, type WorkerQuestion, type WorkerThread } from "../lib/api.js";
  import { store } from "../lib/stores.svelte.js";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import PanelHeader from "./PanelHeader.svelte";
  import SkeletonRows from "./SkeletonRows.svelte";
  import Switch from "./Switch.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let status = $state<GraphWorkerView | null>(null);
  let threads = $state<WorkerThread[]>([]);
  let questions = $state<WorkerQuestion[]>([]);
  let proposals = $state<WorkerProposal[]>([]);
  let loadError = $state("");
  let draft = $state<PoolSettings | null>(null);
  let saving = $state(false);
  let saveMsg = $state("");
  // per question group (keyed by the question text): the answer being written
  let answers = $state<Record<string, string>>({});
  let reasons = $state<Record<string, string>>({});
  let busy = $state<string | null>(null);
  let actionError = $state("");

  async function load(): Promise<void> {
    loadError = "";
    try {
      const w = await api.graphWorker();
      if (!w) {
        loadError = "Only the organization's admin runs the graph worker.";
        return;
      }
      status = w;
      draft = w.pool ? { ...w.pool } : null;
      [threads, questions, proposals] = await Promise.all([api.workerThreads(), api.workerQuestions(), api.workerProposals()]);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }
  onMount(() => {
    void load();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  });
  /** the lists, without touching the settings being edited */
  async function refresh(): Promise<void> {
    try {
      const w = await api.graphWorker();
      // the saved settings stay what the form compares against until the admin saves
      if (w) status = { ...w, ...(status?.pool ? { pool: status.pool } : {}) };
      [threads, questions, proposals] = await Promise.all([api.workerThreads(), api.workerQuestions(), api.workerProposals()]);
    } catch {
      /* the next refresh tries again */
    }
  }

  const dirty = $derived(!!draft && !!status?.pool && JSON.stringify(draft) !== JSON.stringify(status.pool));
  async function savePool(): Promise<void> {
    if (!draft) return;
    saving = true;
    saveMsg = "";
    try {
      status = await api.savePool(draft);
      draft = status.pool ? { ...status.pool } : draft;
      saveMsg = draft.poolSize ? "Saved. Threads start within seconds when entries are waiting." : "Saved. No threads run: entries only get the one-call linking.";
    } catch (e) {
      saveMsg = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  // several threads asking the same thing are answered once
  const groups = $derived.by(() => {
    const m = new Map<string, WorkerQuestion[]>();
    for (const q of questions) {
      const key = q.question.trim().toLowerCase();
      m.set(key, [...(m.get(key) ?? []), q]);
    }
    return [...m.entries()].map(([key, qs]) => ({ key, qs }));
  });

  async function answer(key: string, qs: WorkerQuestion[], text: string, dismiss = false): Promise<void> {
    busy = key;
    actionError = "";
    try {
      await api.answerWorkerQuestions(
        qs.map((q) => q.id),
        text,
        dismiss,
      );
      delete answers[key];
      await refresh();
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }
  async function decide(p: WorkerProposal, approve: boolean): Promise<void> {
    busy = p.id;
    actionError = "";
    try {
      await api.decideWorkerProposal(p.id, approve, reasons[p.id] ?? "");
      delete reasons[p.id];
      await refresh();
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  function open(agentId: string | null): void {
    if (!agentId) return;
    store.select(agentId);
    onclose();
  }
  const STATUS: Record<WorkerThread["status"], { label: string; cls: string }> = {
    pending: { label: "queued", cls: "text-faint" },
    running: { label: "working", cls: "text-signal" },
    waiting: { label: "waiting on you", cls: "text-warn" },
    done: { label: "done", cls: "text-ok" },
    failed: { label: "failed", cls: "text-err" },
  };
  const when = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const describe = (p: WorkerProposal) => {
    try {
      const c = JSON.parse(p.change);
      if (p.kind === "merge") return `Merge "${c.drop_name}" into "${c.keep_name}" (${c.type})`;
      if (p.kind === "upsert") return `Change ${(c.entities ?? []).map((e: { name: string }) => `"${e.name}"`).join(", ")}`;
      if (p.kind === "rehome") return `Move "${c.name}"`;
    } catch {
      /* a raw command */
    }
    return p.kind === "command" ? `Run: ${p.change.slice(0, 160)}` : p.kind;
  };
</script>

{#snippet num(label: string, key: "poolSize" | "dailyThreads" | "threadMinutes" | "keepDays", min: number, max: number, hint: string)}
  {#if draft}
    <div class="field">
      <label class="field-label" for="gw-{key}">{label}</label>
      <input id="gw-{key}" type="number" {min} {max} class="input w-24" bind:value={draft[key]} />
      <span class="field-hint">{hint}</span>
    </div>
  {/if}
{/snippet}

<Dialog {onclose} labelledby="gw-title" width="52rem" dismissible={!saving && busy === null}>
  <PanelHeader
    id="gw-title"
    title="Graph worker"
    subtitle="Agent threads keep the graph linked and current, one entry each. They read everything, change only their own entry, and bring everything else to you."
    icon={Network}
    {onclose}
  />

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if loadError}
      <div class="mx-5 mt-4 flex items-start gap-2 rounded-md border border-err/30 bg-err-soft px-3 py-2 text-xs text-err" role="alert">
        <Icon icon={TriangleAlert} size={14} class="mt-px" />
        {loadError}
      </div>
    {:else if !status}
      <SkeletonRows rows={4} />
    {:else}
      <div class="grid gap-6 p-5">
        <p class="m-0 text-xs text-faint">
          {status.profile ? `From the ${status.profile} profile` : "No profile runs the graph worker: mark one in its profile's Graph worker section"} ·
          {status.threads?.running ?? 0} working · {status.threads?.waiting ?? 0} waiting on you · {status.threads?.pending ?? 0} queued ·
          {status.threads?.today ?? 0}{status.pool ? ` of ${status.pool.dailyThreads}` : ""} started today · {status.things} things known
        </p>

        {#if groups.length || proposals.length}
          <section class="grid gap-3">
            <h4 class="m-0 text-xs font-medium text-dim">Waiting on you</h4>
            {#if actionError}<span class="text-xs text-err" role="alert">{actionError}</span>{/if}
            {#each groups as g (g.key)}
              {@const q = g.qs[0]!}
              <div class="grid gap-2 rounded-lg border border-edge2 bg-panel p-3">
                <span class="text-sm text-fg">{q.question}</span>
                <span class="text-xs text-faint">
                  {g.qs.length === 1 ? `About "${q.entry_name ?? "an entry"}"` : `${g.qs.length} threads ask this: ${g.qs.map((x) => `"${x.entry_name ?? "an entry"}"`).join(", ")}`}{q.why ? ` · ${q.why}` : ""}
                </span>
                {#if q.options.length}
                  <div class="flex flex-wrap gap-1.5">
                    {#each q.options as o (o)}
                      <button class="btn btn-ghost btn-sm" disabled={busy !== null} onclick={() => void answer(g.key, g.qs, o)}>{o}</button>
                    {/each}
                  </div>
                {/if}
                <div class="flex flex-wrap items-center gap-2">
                  <input class="input min-w-48 flex-1 text-xs" maxlength="2000" placeholder="Your answer" aria-label="answer" bind:value={answers[g.key]} />
                  <button class="btn btn-primary btn-sm" disabled={busy !== null || !(answers[g.key] ?? "").trim()} onclick={() => void answer(g.key, g.qs, answers[g.key] ?? "")}>Answer</button>
                  <button class="btn btn-ghost btn-sm" disabled={busy !== null} onclick={() => void answer(g.key, g.qs, "", true)}>Dismiss</button>
                  {#if g.qs.length === 1 && q.agent_id}<button class="btn btn-ghost btn-sm" onclick={() => open(q.agent_id)}>Open thread</button>{/if}
                </div>
              </div>
            {/each}
            {#each proposals as p (p.id)}
              <div class="grid gap-2 rounded-lg border border-edge2 bg-panel p-3">
                <span class="text-sm text-fg">{describe(p)}</span>
                <span class="text-xs text-faint">Proposed while working on "{p.entry ?? "an entry"}" · {when(p.created_at)}</span>
                <span class="text-xs text-dim">Why: {p.reason}</span>
                <div class="flex flex-wrap items-center gap-2">
                  <input class="input min-w-48 flex-1 text-xs" maxlength="1000" placeholder="Reason (optional; the thread gets it)" aria-label="reason" bind:value={reasons[p.id]} />
                  <button class="btn btn-primary btn-sm" disabled={busy !== null} onclick={() => void decide(p, true)}>Apply</button>
                  <button class="btn btn-ghost btn-sm" disabled={busy !== null} onclick={() => void decide(p, false)}>Reject</button>
                  {#if p.agent_id}<button class="btn btn-ghost btn-sm" onclick={() => open(p.agent_id)}>Open thread</button>{/if}
                </div>
              </div>
            {/each}
          </section>
        {/if}

        {#if draft}
          <section class="grid gap-4">
            <h4 class="m-0 text-xs font-medium text-dim">Threads</h4>
            <div class="grid gap-4 sm:grid-cols-2">
              {@render num("Threads at once", "poolSize", 0, 64, "0 = no threads: entries only get the one-call linking. Each thread counts toward the workspace's agent limit.")}
              {@render num("Threads per day", "dailyThreads", 1, 5000, "Started or resumed. When it's used up, entries wait for tomorrow.")}
              {@render num("Minutes per thread", "threadMinutes", 5, 120, "A thread still working after this is stopped and retried.")}
              {@render num("Keep finished threads (days)", "keepDays", 1, 90, "Then the conversation is deleted. What it changed stays.")}
            </div>
            <label class="flex items-start gap-3">
              <Switch checked={draft.sortFirst} label="sort entries first" onchange={(v) => draft && (draft.sortFirst = v)} />
              <span class="grid gap-0.5">
                <span class="text-sm text-fg">Sort entries first</span>
                <span class="text-xs text-faint">One model call per entry links the plain ones and sends only the ones that need judgement to a thread. Off: every entry gets a thread (more thorough, many more model calls).</span>
              </span>
            </label>
            <span class="text-xs text-faint">Threads use the Graph worker profile's model, which must be a labeled model. They can't run commands or reach the internet, and other connections are read-only for them.</span>
            <div class="flex items-center gap-3">
              {#if saveMsg}<span class="text-xs text-dim" role="status">{saveMsg}</span>{/if}
              <span class="ml-auto"></span>
              <button class="btn btn-ghost btn-sm" disabled={saving || !dirty} onclick={() => status?.pool && (draft = { ...status.pool })}>Undo</button>
              <button class="btn btn-primary btn-sm" disabled={saving || !dirty} onclick={() => void savePool()}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </section>
        {/if}

        <section class="grid gap-2">
          <h4 class="m-0 text-xs font-medium text-dim">Recent threads</h4>
          {#if threads.length === 0}
            <p class="m-0 text-xs text-faint">None yet.</p>
          {:else}
            <ul class="m-0 grid list-none gap-1.5 p-0">
              {#each threads as t (t.id)}
                <li class="grid gap-1 rounded-md border border-edge bg-bg px-3 py-2">
                  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span class="min-w-0 flex-1 truncate text-sm text-fg">{t.entry ?? "(entry gone)"}</span>
                    <span class="text-2xs {STATUS[t.status]?.cls ?? 'text-faint'}">{STATUS[t.status]?.label ?? t.status}</span>
                    <span class="text-2xs text-faint">{when(t.updated_at)}</span>
                    {#if t.agent_id}<button class="btn btn-ghost btn-sm" onclick={() => open(t.agent_id)}>Open</button>{/if}
                  </div>
                  {#if t.why}<span class="text-xs text-faint">Why: {t.why}</span>{/if}
                  {#if t.summary}<span class="line-clamp-3 text-xs text-dim">{t.summary}</span>{/if}
                  {#if t.status === "failed" && t.error}<span class="text-xs text-err">{t.error}</span>{/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>
    {/if}
  </div>
</Dialog>
