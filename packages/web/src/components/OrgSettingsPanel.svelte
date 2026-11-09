<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { History, ShieldCheck, TriangleAlert } from "lucide";
  import { api, type AuthorityMap, type OrgPolicy, type PolicyView, type PositionsView, type PrunedEntry } from "../lib/api.js";
  import ClassConfirmPanel from "./ClassConfirmPanel.svelte";
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
  // pruning: what was removed, and pruning what's due now
  let pruned = $state<PrunedEntry[]>([]);
  let pruneBusy = $state(false);
  let pruneNote = $state("");
  let topicsText = $state("");
  // the authority map as rows a person edits: a class, an attribute (either may be blank), the position
  type Rule = { cls: string; attribute: string; position: string };
  let rules = $state<Rule[]>([]);
  let tree = $state<PositionsView | null>(null);

  const LABELS: Record<keyof OrgPolicy, string> = {
    maxGrantDays: "Longest share",
    defaultShareDays: "Default share length",
    standingGrants: "Shares without an end date",
    peopleShareDirectly: "People share their own data",
    gradingEnabled: "Grading",
    gradingConfidence: "Grading confidence",
    restrictedTopics: "Restricted topics",
    authorityMap: "Authority",
    derivedWindowHours: "Derived-data window",
    requestDays: "How long a request stays open",
    pruneAfterDays: "Removing expired entries",
  };

  async function load(): Promise<void> {
    loadError = "";
    try {
      view = await api.policy();
      draft = { ...view.policy };
      topicsText = draft.restrictedTopics.join("\n");
      rules = rulesOf(draft.authorityMap);
      if (view.canEdit) {
        tree = await api.positions().catch(() => null);
        pruned = (await api.pruned().catch(() => ({ pruned: [] }))).pruned;
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }
  onMount(() => void load());

  async function pruneNow(): Promise<void> {
    pruneBusy = true;
    pruneNote = "";
    try {
      const r = await api.pruneNow();
      if (view) view.pruning = r.preview;
      pruneNote = r.pruned ? `Removed ${r.pruned} expired ${r.pruned === 1 ? "entry" : "entries"}.` : "Nothing was due.";
      pruned = (await api.pruned().catch(() => ({ pruned }))).pruned;
    } catch (e) {
      pruneNote = e instanceof Error ? e.message : String(e);
    } finally {
      pruneBusy = false;
    }
  }

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
  const pruneError = $derived(attempted && draft && !inRange(draft.pruneAfterDays, 0, 365) ? "Between 0 and 365 days." : "");
  const requestError = $derived(attempted && draft && !inRange(draft.requestDays, 1, 90) ? "Between 1 and 90 days." : "");
  const windowError = $derived(attempted && draft && !inRange(draft.derivedWindowHours, 0, 168) ? "Between 0 and 168 hours." : "");

  async function save(): Promise<void> {
    if (!view || !draft) return;
    attempted = true;
    error = "";
    saved = "";
    if (maxError || defError || windowError || requestError || pruneError) return;
    const changes = Object.fromEntries(
      (Object.keys(draft) as Array<keyof OrgPolicy>).filter((k) => !same(draft![k], view!.policy[k])).map((k) => [k, draft![k]]),
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

  // a topic list compares by its contents
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  // one topic per line, kept as typed; blank lines dropped from the list
  function setTopics(text: string) {
    topicsText = text;
    if (draft) draft.restrictedTopics = text.split("\n").map((t) => t.trim()).filter(Boolean);
  }

  function resetToDefaults() {
    if (view) {
      draft = { ...view.defaults };
      topicsText = draft.restrictedTopics.join("\n");
      rules = rulesOf(draft.authorityMap);
    }
  }

  // ---- the authority map: who may commit the organization to what ----
  /** the map as rows: attribute rules, then each class's own rule and its attribute rules */
  function rulesOf(m: AuthorityMap | undefined): Rule[] {
    const out: Rule[] = [];
    for (const [a, p] of Object.entries(m?.attributes ?? {})) out.push({ cls: "", attribute: a, position: p });
    for (const [c, r] of Object.entries(m?.classes ?? {})) {
      if (r.authority) out.push({ cls: c, attribute: "", position: r.authority });
      for (const [a, p] of Object.entries(r.attributes ?? {})) out.push({ cls: c, attribute: a, position: p });
    }
    return out;
  }
  /** the rows as the map the server stores (sorted the way it sorts, so unchanged rows read as unchanged) */
  function mapOf(list: Rule[]): AuthorityMap {
    const sorted = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    const classes: Record<string, { authority?: string; attributes?: Record<string, string> }> = {};
    const attributes: Record<string, string> = {};
    for (const r of list) {
      const c = r.cls.trim();
      const a = r.attribute.trim();
      if (!r.position || (!c && !a)) continue;
      if (!c) attributes[a] = r.position;
      else if (!a) classes[c] = { authority: r.position, ...classes[c] };
      else classes[c] = { ...classes[c], attributes: { ...classes[c]?.attributes, [a]: r.position } };
    }
    for (const [c, r] of Object.entries(classes)) classes[c] = { ...(r.authority ? { authority: r.authority } : {}), ...(r.attributes ? { attributes: sorted(r.attributes) } : {}) };
    return { classes: sorted(classes), attributes: sorted(attributes) };
  }
  function setRule(i: number, patch: Partial<Rule>) {
    rules[i] = { ...rules[i], ...patch } as Rule;
    if (draft) draft.authorityMap = mapOf(rules);
  }
  function addRule() {
    rules.push({ cls: "", attribute: "", position: tree?.root ?? "" });
    if (draft) draft.authorityMap = mapOf(rules);
  }
  function removeRule(i: number) {
    rules.splice(i, 1);
    if (draft) draft.authorityMap = mapOf(rules);
  }
  const ruleCount = (m: AuthorityMap | undefined) => rulesOf(m).length;
  // position names as paths ("Operations › Production floor"), as the sharing panel shows them
  const byId = $derived(new Map((tree?.tree ?? []).map((p) => [p.id, p])));
  function path(id: string): string {
    const parts: string[] = [];
    for (let cur = byId.get(id); cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
      if (cur.parent === null) break;
      parts.unshift(cur.name);
    }
    return parts.length ? parts.join(" › ") : "Top of the organization";
  }
  const positionOptions = $derived([...(tree?.tree ?? [])].map((p) => ({ value: p.id, label: path(p.id) })).sort((a, b) => (a.value === tree?.root ? -1 : b.value === tree?.root ? 1 : a.label.localeCompare(b.label))));

  /** "Longest share: 90 days → 30 days" lines for one history entry */
  function diff(prev: string, next: string): string[] {
    try {
      const a = JSON.parse(prev) as OrgPolicy;
      const b = JSON.parse(next) as OrgPolicy;
      return (Object.keys(b) as Array<keyof OrgPolicy>)
        .filter((k) => !same(a[k], b[k]))
        .map((k) => `${LABELS[k] ?? k}: ${fmt(k, a[k])} → ${fmt(k, b[k])}`);
    } catch {
      return [];
    }
  }
  function fmt(k: keyof OrgPolicy, v: unknown): string {
    if (typeof v === "boolean") return k === "peopleShareDirectly" ? (v ? "directly" : "through review") : v ? "on" : "off";
    if (k === "standingGrants") return v === "root" ? "root only" : "nobody";
    if (k === "pruneAfterDays") return Number(v) === 0 ? "never" : `${v} days after they end`;
    if (k === "maxGrantDays" || k === "defaultShareDays" || k === "requestDays") return `${v} days`;
    if (k === "derivedWindowHours") return `${v} h`;
    if (k === "gradingConfidence") return `${Math.round(Number(v) * 100)}%`;
    if (k === "authorityMap") {
      const n = ruleCount(v as AuthorityMap);
      return n ? `${n} rule${n === 1 ? "" : "s"}` : "no rules";
    }
    if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
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
    <div class="field">
      <label class="field-label" for="os-topics">Restricted topics</label>
      <textarea
        id="os-topics"
        class="input min-h-32"
        value={topicsText}
        oninput={(e) => setTopics(e.currentTarget.value)}
        disabled={!draft.gradingEnabled || !view.infra.graderModel}
      ></textarea>
      <span class="field-hint">One per line. The grader files an entry higher only when it's about one of these; everything else stays with the writer's team.</span>
    </div>
  {/if}
{/snippet}

{#snippet authorityBody()}
  {#if draft && view}
    <div class="grid gap-2">
      {#if rules.length}
        <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-2 text-xs font-medium text-dim" aria-hidden="true">
          <span>Class</span><span>Attribute</span><span>Authority</span><span></span>
        </div>
      {/if}
      {#each rules as r, i (i)}
        <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-2">
          <input class="input" placeholder="any class" aria-label="class" value={r.cls} oninput={(e) => setRule(i, { cls: e.currentTarget.value })} />
          <input class="input" placeholder="whole class" aria-label="attribute" value={r.attribute} oninput={(e) => setRule(i, { attribute: e.currentTarget.value })} />
          <select class="input" aria-label="position holding authority" value={r.position} onchange={(e) => setRule(i, { position: e.currentTarget.value })}>
            {#each positionOptions as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
            {#if r.position && !positionOptions.some((o) => o.value === r.position)}<option value={r.position}>{r.position} (no longer a position)</option>{/if}
          </select>
          <button type="button" class="btn btn-ghost btn-sm" aria-label="remove this rule" onclick={() => removeRule(i)}>Remove</button>
        </div>
      {/each}
      <div>
        <button type="button" class="btn btn-ghost btn-sm" disabled={!tree?.scoped} onclick={addRule}>Add rule</button>
      </div>
      <span class="field-hint">
        A rule names the position that may commit the organization to a class of commitment (orders, hires, maintenance), or to one attribute of it (price, pay, dismissal); an attribute rule with no class applies to that attribute in every class.
        The position named and those above it see such claims and enter them directly; people below it propose, and what they write of it is filed where the authority sees it. Anything with no rule stays with whoever wrote it.
        Only sections no claim was extracted from go to the grader, with the restricted topics above.
      </span>
    </div>
  {/if}
{/snippet}

{#snippet classesBody()}
  <ClassConfirmPanel />
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

{#snippet pruningBody()}
  {#if draft && view}
    {@const p = view.pruning}
    {@const upcoming = p?.days.find((d) => d.day > new Date().toISOString().slice(0, 10))}
    <div class="field">
      <label class="field-label" for="os-prune">Remove expired entries</label>
      <div class="flex items-center gap-2">
        <input id="os-prune" type="number" min="0" max="365" class="input w-24" bind:value={draft.pruneAfterDays} aria-invalid={pruneError ? "true" : undefined} />
        <span class="text-xs text-faint">days after they end</span>
      </div>
      <span class="field-hint">
        {draft.pruneAfterDays === 0
          ? "Never: expired entries stay in the graph, out of searches."
          : p?.sink.keeps
            ? `Then they move to ${p.sink.name}. Entries that last are never removed.`
            : "Then they're deleted permanently: no cold storage is set up. Entries that last are never removed."}
      </span>
      {#if pruneError}<span class="field-error">{pruneError}</span>{/if}
    </div>
    {#if p}
      <div class="grid gap-2 rounded-md border border-edge bg-panel px-3 py-2.5 text-xs">
        {#if p.sink.unknown}
          <span class="text-warn">Pruning is off: this deployment names a storage ({p.sink.name}) that isn't available, so nothing is removed.</span>
        {:else if !p.enabled}
          <span class="text-dim">{p.waiting} expired {p.waiting === 1 ? "entry is" : "entries are"} kept out of searches.</span>
        {:else if p.waiting === 0}
          <span class="text-dim">No expired entries are waiting.</span>
        {:else}
          <span class="text-dim">
            {p.waiting} expired {p.waiting === 1 ? "entry" : "entries"} waiting.
            {#if upcoming}Next removal: {upcoming.count} on {new Date(`${upcoming.day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.{/if}
          </span>
          {#if p.due}
            <div class="flex items-center gap-2">
              <span class="text-faint">{p.due} {p.due === 1 ? "is" : "are"} due now.</span>
              <button class="btn btn-ghost btn-sm" disabled={pruneBusy} onclick={() => void pruneNow()}>{pruneBusy ? "Removing…" : "Remove now"}</button>
            </div>
          {/if}
        {/if}
        {#if pruneNote}<span class="text-dim" role="status">{pruneNote}</span>{/if}
      </div>
    {/if}
    {#if pruned.length}
      <div class="grid gap-1">
        <span class="text-xs font-medium text-dim">Removed</span>
        {#each pruned.slice(0, 8) as e (e.pruned_at + e.name)}
          <span class="truncate text-xs text-faint">{e.name}{e.home ? ` · ${e.home}` : ""} · ended {e.valid_until ? new Date(e.valid_until).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "?"} · removed {new Date(e.pruned_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{e.kept ? "" : " for good"}</span>
        {/each}
      </div>
    {/if}
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
      {@render section("Commitment classes", "What the organization commits to (orders, jobs, hires), discovered from the connected systems. Nothing maps onto a class until you confirm it; a wrong name here misleads every later mapping.", classesBody)}
      {@render section("Authority", "Who may commit the organization to what: the hierarchy read the other way.", authorityBody)}
      {@render section("Expired entries", "Entries that end (a visit, this week's schedule) leave searches on their date, and the graph later.", pruningBody)}
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
