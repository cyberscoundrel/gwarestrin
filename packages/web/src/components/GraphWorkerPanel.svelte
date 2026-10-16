<script lang="ts">
  import { onMount } from "svelte";
  import { Network, TriangleAlert } from "lucide";
  import { api, type GraphWorkerView, type PoolSettings, type WorkerHandler, type WorkerProposal, type WorkerQuestion, type WorkerThread } from "../lib/api.js";
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
  let handlers = $state<WorkerHandler[]>([]);
  let loadError = $state("");
  let draft = $state<PoolSettings | null>(null);
  let saving = $state(false);
  let saveMsg = $state("");
  // per question group (keyed by the question text): the answer being written
  let answers = $state<Record<string, string>>({});
  let reasons = $state<Record<string, string>>({});
  let busy = $state<string | null>(null);
  // a survey of a connection: a task thread maps it, seeds its records, relates them
  let surveyConn = $state("mssql");
  let surveyFocus = $state("");
  let surveyAudience = $state<"everyone" | "admin">("everyone");
  let surveyMsg = $state("");
  async function startSurvey(): Promise<void> {
    busy = "survey";
    surveyMsg = "";
    try {
      const r = await api.startSurvey(surveyConn.trim(), surveyFocus.trim(), surveyAudience);
      surveyMsg = `Queued "${r.task}". It runs when the pool has room (threads at once above 0).`;
      await refresh();
    } catch (e) {
      surveyMsg = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }
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
      [threads, questions, proposals, handlers] = await Promise.all([api.workerThreads(), api.workerQuestions(), api.workerProposals(), api.workerHandlers().catch(() => [])]);
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
      [threads, questions, proposals, handlers] = await Promise.all([api.workerThreads(), api.workerQuestions(), api.workerProposals(), api.workerHandlers().catch(() => [])]);
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
    closed: { label: "closed", cls: "text-faint" },
  };
  const CHANGE: Record<string, string> = { link: "Linked", upsert: "Wrote", merge: "Merged", move: "Moved", relate: "Related", followup: "Queued", unlink: "Unlinked", delete: "Deleted", fold: "Folded", unrelate: "Unrelated", update: "Corrected", rename: "Renamed" };
  const when = (at: string) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const describe = (p: WorkerProposal) => {
    try {
      const c = JSON.parse(p.change);
      if (p.kind === "merge") return `Merge "${c.drop_name}" into "${c.keep_name}" (${c.type})`;
      if (p.kind === "delete_entry") return `Delete entry ${c.rid} "${c.name}"`;
      if (p.kind === "fold") return `Fold entry ${c.drop} "${c.drop_name}" into ${c.keep} "${c.keep_name}"`;
      if (p.kind === "upsert") return `Change ${(c.entities ?? []).map((e: { name: string }) => `"${e.name}"`).join(", ")}`;
      if (p.kind === "rehome") return `Move "${c.name}"`;
    } catch {
      /* a raw command */
    }
    return p.kind === "command" ? `Run: ${p.change.slice(0, 160)}` : p.kind;
  };
</script>

{#snippet num(label: string, key: "poolSize" | "dailyThreads" | "threadMinutes" | "keepDays" | "batchSize" | "batchMinutes" | "maxHandlers", min: number, max: number, hint: string)}
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
    subtitle="Agent threads keep the graph linked and current, one entry each. They read everything, make small changes themselves, and stop to ask you about large ones."
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

        {#if status.master?.on}
          <section class="grid gap-2">
            {#if status.master.halted}
              <p class="m-0 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn" role="status">
                Halted: {status.master.handlers} stopped workers wait on you (at most {status.master.maxHandlers}). No new batch starts until some are settled.
              </p>
            {/if}
            {#if status.triage?.on}
              <span class="text-xs text-faint">
                Triage ({status.triage.model}) today: {status.triage.today} entries · {status.triage.byLevel["0"] ?? 0} needed nothing{status.triage.sampled ? ` (${status.triage.sampled} sampled anyway)` : ""} · {status.triage.byLevel["1"] ?? 0} quick checks · {status.triage.byLevel["2"] ?? 0} investigations · {status.triage.byLevel["3"] ?? 0} broad · {status.triage.settledNames} names settled without a worker{status.triage.outcomes.needed + status.triage.outcomes.nothing_done ? ` · workers found something to do for ${status.triage.outcomes.needed} of ${status.triage.outcomes.needed + status.triage.outcomes.nothing_done}` : ""}
              </span>
            {/if}
            <span class="text-xs text-faint">
              Master on · {status.master.intake} entries waiting for the next batch · {status.master.signals} signals for the master · {status.master.handlers} handlers waiting on you
            </span>
            {#each handlers.filter((h) => h.status !== "done") as h (h.id)}
              <div class="flex flex-wrap items-center gap-2 rounded-lg border border-edge2 bg-panel p-3">
                <span class="min-w-0 flex-1 text-sm text-fg">{h.title}<span class="block text-xs text-faint">{h.description.slice(0, 220)}</span></span>
                {#if h.agent_id}<button class="btn btn-primary btn-sm" onclick={() => open(h.agent_id)}>Open</button>{:else}<span class="text-2xs text-faint">starting…</span>{/if}
              </div>
            {/each}
          </section>
        {/if}

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
            <label class="flex items-start gap-3">
              <Switch checked={draft.master} label="run a master" onchange={(v) => draft && (draft.master = v)} />
              <span class="grid gap-0.5">
                <span class="text-sm text-fg">Run a master</span>
                <span class="text-xs text-faint">Saved entries batch up for one long-running master thread, which groups them, starts workers, settles what it can of their stops and hands the rest to handlers that ask you. Off: each entry is sorted and threaded on its own.</span>
              </span>
            </label>
            {#if draft.master}
              <div class="grid gap-4 sm:grid-cols-3">
                {@render num("Batch size", "batchSize", 1, 200, "A batch goes to the master at this many entries…")}
                {@render num("Batch minutes", "batchMinutes", 1, 1440, "…or when its oldest entry has waited this long.")}
                {@render num("Handlers waiting, at most", "maxHandlers", 1, 50, "Past this, no new batch starts until you've answered some.")}
              </div>
            {/if}
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
          <h4 class="m-0 text-xs font-medium text-dim">Survey a connection</h4>
          <span class="text-xs text-faint">A thread maps what the connection holds, seeds its main records (customers, vendors, people, work centers) as things with their keys, records how they relate, and queues follow-ups by topic. Rows stay in the source.</span>
          <div class="flex flex-wrap items-center gap-2">
            <input class="input w-36 font-mono text-xs" aria-label="connection" bind:value={surveyConn} />
            <input class="input min-w-48 flex-1 text-xs" maxlength="1000" placeholder="Focus (optional): e.g. production scheduling and suppliers" aria-label="focus" bind:value={surveyFocus} />
            <button class="btn btn-primary btn-sm" disabled={busy !== null || !surveyConn.trim()} onclick={() => void startSurvey()}>{busy === "survey" ? "Queuing…" : "Survey"}</button>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-dim">What it builds is seen by</span>
            <div class="segmented" role="group" aria-label="who sees the survey's results">
              <button type="button" aria-pressed={surveyAudience === "everyone"} onclick={() => (surveyAudience = "everyone")}>Everyone</button>
              <button type="button" aria-pressed={surveyAudience === "admin"} onclick={() => (surveyAudience = "admin")}>Only you</button>
            </div>
            <span class="text-xs text-faint">{surveyAudience === "everyone" ? "The map and the records it seeds are for the whole organization (never personal details)." : "You decide later what to share."}</span>
          </div>
          {#if surveyMsg}<span class="text-xs text-dim" role="status">{surveyMsg}</span>{/if}
        </section>

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
                  {#if t.changes?.length}
                    <details class="text-xs text-faint">
                      <summary class="cursor-pointer">{t.changes.length} {t.changes.length === 1 ? "change" : "changes"} made without asking</summary>
                      <ul class="m-0 mt-1 grid list-none gap-0.5 p-0">
                        {#each t.changes as c, i (i)}
                          <li>{CHANGE[c.kind] ?? c.kind}: {c.detail ?? (c.entries ?? []).join(", ")}{c.reason ? ` (${c.reason})` : ""}</li>
                        {/each}
                      </ul>
                    </details>
                  {/if}
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
