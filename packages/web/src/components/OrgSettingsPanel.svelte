<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { History, ShieldCheck, TriangleAlert } from "lucide";
  import { api, type OrgPolicy, type PolicyView } from "../lib/api.js";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import PanelHeader from "./PanelHeader.svelte";
  import SkeletonRows from "./SkeletonRows.svelte";
  import Switch from "./Switch.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let view = $state<PolicyView | null>(null);
  let draft = $state<OrgPolicy | null>(null);
  let loadError = $state("");
  let error = $state("");
  let saved = $state("");
  let saving = $state(false);
  let attempted = $state(false);

  const LABELS: Record<keyof OrgPolicy, string> = {
    maxGrantDays: "Longest share",
    defaultShareDays: "Default share length",
    standingGrants: "Shares without an end date",
    peopleShareDirectly: "People share their own data",
    gradingEnabled: "Grading",
    gradingConfidence: "Grading confidence",
    derivedWindowHours: "Derived-data window",
    requestDays: "How long a request stays open",
  };

  async function load(): Promise<void> {
    loadError = "";
    try {
      view = await api.policy();
      draft = { ...view.policy };
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }
  onMount(() => void load());

  const dirty = $derived(!!view && !!draft && JSON.stringify(view.policy) !== JSON.stringify(draft));
  const isDefault = $derived(!!view && !!draft && JSON.stringify(view.defaults) === JSON.stringify(draft));

  // ---- inline validation (the server validates again) ----
  const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
  const maxError = $derived(attempted && draft && !inRange(draft.maxGrantDays, 1, 365) ? "Between 1 and 365 days." : "");
  const defError = $derived.by(() => {
    if (!attempted || !draft) return "";
    if (!inRange(draft.defaultShareDays, 1, 365)) return "Between 1 and 365 days.";
    if (draft.defaultShareDays > draft.maxGrantDays) return "Can't be longer than the longest share.";
    return "";
  });
  const requestError = $derived(attempted && draft && !inRange(draft.requestDays, 1, 90) ? "Between 1 and 90 days." : "");
  const windowError = $derived(attempted && draft && !inRange(draft.derivedWindowHours, 0, 168) ? "Between 0 and 168 hours." : "");

  async function save(): Promise<void> {
    if (!view || !draft) return;
    attempted = true;
    error = "";
    saved = "";
    if (maxError || defError || windowError || requestError) return;
    const changes = Object.fromEntries(
      (Object.keys(draft) as Array<keyof OrgPolicy>).filter((k) => draft![k] !== view!.policy[k]).map((k) => [k, draft![k]]),
    ) as Partial<OrgPolicy>;
    if (!Object.keys(changes).length) return;
    saving = true;
    try {
      await api.savePolicy(changes);
      saved = "Saved. Everyone in the organization gets the new settings within a minute.";
      attempted = false;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function resetToDefaults() {
    if (view) draft = { ...view.defaults };
  }

  /** "Longest share: 90 days → 30 days" lines for one history entry */
  function diff(prev: string, next: string): string[] {
    try {
      const a = JSON.parse(prev) as OrgPolicy;
      const b = JSON.parse(next) as OrgPolicy;
      return (Object.keys(b) as Array<keyof OrgPolicy>)
        .filter((k) => a[k] !== b[k])
        .map((k) => `${LABELS[k] ?? k}: ${fmt(k, a[k])} → ${fmt(k, b[k])}`);
    } catch {
      return [];
    }
  }
  function fmt(k: keyof OrgPolicy, v: unknown): string {
    if (typeof v === "boolean") return k === "peopleShareDirectly" ? (v ? "directly" : "through review") : v ? "on" : "off";
    if (k === "standingGrants") return v === "root" ? "root only" : "nobody";
    if (k === "maxGrantDays" || k === "defaultShareDays" || k === "requestDays") return `${v} days`;
    if (k === "derivedWindowHours") return `${v} h`;
    if (k === "gradingConfidence") return `${Math.round(Number(v) * 100)}%`;
    return String(v);
  }
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
</script>

{#snippet section(title: string, explain: string, body: Snippet)}
  <section class="grid gap-4 border-b border-edge px-5 py-6 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] sm:gap-8">
    <div class="grid content-start gap-1">
      <h3 class="m-0 text-sm font-medium text-fg">{title}</h3>
      <p class="m-0 text-xs leading-relaxed text-faint">{explain}</p>
    </div>
    <div class="grid min-w-0 content-start gap-5">{@render body()}</div>
  </section>
{/snippet}

{#snippet sharingBody()}
  {#if draft}
    <div class="grid gap-5 sm:grid-cols-2">
      <div class="field">
        <label class="field-label" for="os-max">Longest share</label>
        <div class="flex items-center gap-2">
          <input id="os-max" type="number" min="1" max="365" class="input w-24" bind:value={draft.maxGrantDays} aria-invalid={maxError ? "true" : undefined} />
          <span class="text-xs text-faint">days</span>
        </div>
        {#if maxError}<span class="field-error">{maxError}</span>{/if}
      </div>
      <div class="field">
        <label class="field-label" for="os-def">When no end date is given</label>
        <div class="flex items-center gap-2">
          <input id="os-def" type="number" min="1" max="365" class="input w-24" bind:value={draft.defaultShareDays} aria-invalid={defError ? "true" : undefined} />
          <span class="text-xs text-faint">days</span>
        </div>
        {#if defError}<span class="field-error">{defError}</span>{/if}
      </div>
    </div>
    <div class="field">
      <span class="field-label">Shares with no end date</span>
      <div class="segmented" role="group" aria-label="who may share with no end date">
        <button type="button" aria-pressed={draft.standingGrants === "root"} onclick={() => (draft!.standingGrants = "root")}>The organization's root</button>
        <button type="button" aria-pressed={draft.standingGrants === "nobody"} onclick={() => (draft!.standingGrants = "nobody")}>Nobody</button>
      </div>
      <span class="field-hint">Everyone else's shares end within the longest share. Agents never share without an end date.</span>
    </div>
    <label class="flex items-start gap-3">
      <Switch checked={draft.peopleShareDirectly} label="people share their own data directly" onchange={(v) => (draft!.peopleShareDirectly = v)} />
      <span class="grid gap-0.5">
        <span class="text-sm text-fg">People share what they own directly</span>
        <span class="text-xs text-faint">
          {draft.peopleShareDirectly
            ? "A person's share, or their yes to an agent's proposal, applies at once. Every share is recorded and ends on its date."
            : "Every share goes to Approvals and applies once an approver signs off."}
        </span>
      </span>
    </label>
    <div class="field">
      <label class="field-label" for="os-req">Requests for access stay open</label>
      <div class="flex items-center gap-2">
        <input id="os-req" type="number" min="1" max="90" class="input w-24" bind:value={draft.requestDays} aria-invalid={requestError ? "true" : undefined} />
        <span class="text-xs text-faint">days</span>
      </div>
      <span class="field-hint">When someone asks for something they can't see, the people who have it can share it with them until then.</span>
      {#if requestError}<span class="field-error">{requestError}</span>{/if}
    </div>
  {/if}
{/snippet}

{#snippet gradingBody()}
  {#if draft && view}
    <label class="flex items-start gap-3">
      <Switch checked={draft.gradingEnabled} disabled={!view.infra.graderModel} label="grade new entries" onchange={(v) => (draft!.gradingEnabled = v)} />
      <span class="grid gap-0.5">
        <span class="text-sm text-fg">Grade new entries</span>
        <span class="text-xs text-faint">
          {view.infra.graderModel
            ? "A model checks each new entry against your positions' descriptions and may file it higher. It never files anything lower on its own."
            : "No grader model is set for this deployment, so entries stay where they're written."}
        </span>
      </span>
    </label>
    <div class="field">
      <label class="field-label" for="os-conf">How sure the grader must be</label>
      <div class="flex items-center gap-3">
        <input
          id="os-conf"
          type="range"
          min="0.3"
          max="0.95"
          step="0.05"
          class="w-full max-w-64 accent-[var(--color-signal)]"
          bind:value={draft.gradingConfidence}
          disabled={!draft.gradingEnabled || !view.infra.graderModel}
        />
        <span class="w-10 text-right font-mono text-xs text-dim">{Math.round(draft.gradingConfidence * 100)}%</span>
      </div>
      <span class="field-hint">Below this, a new entry is held one level up and someone is asked to review it.</span>
    </div>
  {/if}
{/snippet}

{#snippet derivedBody()}
  {#if draft}
    <div class="field">
      <label class="field-label" for="os-win">Look back</label>
      <div class="flex items-center gap-2">
        <input id="os-win" type="number" min="0" max="168" class="input w-24" bind:value={draft.derivedWindowHours} aria-invalid={windowError ? "true" : undefined} />
        <span class="text-xs text-faint">hours</span>
      </div>
      <span class="field-hint">
        {draft.derivedWindowHours === 0
          ? "Off: what an agent read doesn't affect where its writes are filed."
          : "An agent that read more widely in this time writes where all of it is visible, so a summary can't reach people who couldn't see its sources."}
      </span>
      {#if windowError}<span class="field-error">{windowError}</span>{/if}
    </div>
  {/if}
{/snippet}

{#snippet deployBody()}
  {#if view}
    <dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
      <dt class="text-faint">Positions</dt>
      <dd class="m-0 text-dim">{view.infra.scoped ? `${view.infra.positions}, managed as groups in authentik` : "not in use"}</dd>
      <dt class="text-faint">Grader model</dt>
      <dd class="m-0 truncate font-mono text-dim">{view.infra.graderModel ?? "none"}</dd>
      <dt class="text-faint">Embedding model</dt>
      <dd class="m-0 truncate font-mono text-dim">{view.infra.embedModel}</dd>
    </dl>
    <span class="field-hint">Set when the system is deployed. For real data, both models should run on your own hardware.</span>
  {/if}
{/snippet}

{#snippet historyBody()}
  {#if view}
    {#if view.history.length === 0}
      <p class="m-0 text-xs text-faint">No changes yet: these are the deployment's defaults.</p>
    {:else}
      <ul class="m-0 grid list-none gap-3 p-0">
        {#each view.history as h (h.changed_at)}
          <li class="grid gap-0.5">
            <span class="text-xs text-dim">{h.changed_by} · {when(h.changed_at)}</span>
            {#each diff(h.prev_json, h.next_json) as line (line)}<span class="text-xs text-faint">{line}</span>{/each}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
{/snippet}

<Dialog {onclose} labelledby="org-settings-title" width="48rem" dismissible={!saving}>
  <PanelHeader
    id="org-settings-title"
    title="Organization settings"
    subtitle="How the knowledge graph decides who sees what. Applies to everyone in the organization."
    icon={ShieldCheck}
    {onclose}
  />

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if loadError}
      <div class="mx-5 mt-4 flex items-start gap-2 rounded-md border border-err/30 bg-err-soft px-3 py-2 text-xs text-err" role="alert">
        <Icon icon={TriangleAlert} size={14} class="mt-px" />
        {loadError}
      </div>
    {:else if !view || !draft}
      <SkeletonRows rows={4} />
    {:else if !view.canEdit}
      <p class="m-0 px-5 py-6 text-xs text-faint">Only the organization's root can change these settings.</p>
    {:else}
      {@render section("Sharing", "How long shares last and who makes them.", sharingBody)}
      {@render section("Grading", "Filing new entries where they belong.", gradingBody)}
      {@render section("Derived data", "Summaries and notes built from what an agent read.", derivedBody)}
      {@render section("Deployment", "For reference; changed at deploy, not here.", deployBody)}
      {@render section("Recent changes", view.updated_by ? `Last changed by ${view.updated_by}.` : "Who changed what, and when.", historyBody)}
    {/if}
  </div>

  {#if view?.canEdit && draft}
    <footer class="flex shrink-0 flex-wrap items-center gap-3 border-t border-edge px-5 py-3">
      {#if error}
        <span class="flex min-w-0 items-center gap-1.5 text-xs text-err" role="alert"><Icon icon={TriangleAlert} size={13} /> <span class="truncate">{error}</span></span>
      {:else if saved && !dirty}
        <span class="flex items-center gap-1.5 text-xs text-dim"><Icon icon={History} size={13} /> {saved}</span>
      {:else if dirty}
        <span class="flex items-center gap-1.5 text-xs text-dim"><span class="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden="true"></span> Unsaved changes</span>
      {/if}
      <span class="ml-auto"></span>
      <button class="btn btn-ghost btn-sm" disabled={saving || isDefault} onclick={resetToDefaults}>Use defaults</button>
      <button class="btn btn-ghost" disabled={saving} onclick={onclose}>Close</button>
      <button class="btn btn-primary" disabled={saving || !dirty} onclick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
    </footer>
  {/if}
</Dialog>
