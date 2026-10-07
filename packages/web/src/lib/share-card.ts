/**
 * <gw-share-card>: a share an agent proposed, confirmed (or not) by the
 * person right in the chat. Nothing is shared until they press Share; the
 * end date can be changed first. Light DOM, so the app's styles apply. It
 * asks the server for the proposal's current state, so a reloaded chat shows
 * what happened instead of live buttons.
 */
import { LitElement, html, nothing } from "lit";

interface ProposalView {
  id: string;
  status: "pending" | "executing" | "approved" | "rejected" | "failed" | string;
  target: string;
  to: string;
  reason: string;
  expires_at: string | null;
}

const MAX_DAYS = 90;

function day(iso: string | null | undefined, offsetDays = 0): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const pretty = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "no end date";

export class GwShareCard extends LitElement {
  static override properties = {
    pendingId: { attribute: "pending-id" },
    target: {},
    to: {},
    view: { state: true },
    until: { state: true },
    busy: { state: true },
    error: { state: true },
  };

  // declared, not initialized as class fields: with ES2022 class fields an
  // initializer would shadow Lit's reactive accessors (no re-render)
  declare pendingId: string;
  declare target: string;
  declare to: string;
  declare view: ProposalView | null;
  declare until: string;
  declare busy: boolean;
  declare error: string;

  constructor() {
    super();
    this.pendingId = "";
    this.target = "";
    this.to = "";
    this.view = null;
    this.until = "";
    this.busy = false;
    this.error = "";
  }

  protected override createRenderRoot() {
    return this; // light DOM: app styles
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const r = await fetch(`/api/grants/proposals/${encodeURIComponent(this.pendingId)}`);
      const j = (await r.json()) as ProposalView & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `couldn't load the share (${r.status})`);
      this.view = j;
      this.until = day(j.expires_at, 14);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private async act(kind: "confirm" | "decline"): Promise<void> {
    if (!this.view) return;
    this.busy = true;
    this.error = "";
    try {
      const changed = kind === "confirm" && this.until && this.until !== day(this.view.expires_at, 14);
      const r = await fetch(`/api/grants/proposals/${encodeURIComponent(this.pendingId)}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // the end of the chosen day, in the person's time zone
        body: JSON.stringify(changed ? { until: new Date(`${this.until}T23:59:59`).toISOString() } : {}),
      });
      const j = (await r.json()) as ProposalView & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `${kind} failed (${r.status})`);
      this.view = j;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  override render() {
    const v = this.view;
    const what = v?.target ?? this.target;
    const who = v?.to ?? this.to;
    const head = html`<div class="text-sm text-fg">Share <span class="font-medium">${what}</span> with <span class="font-medium">${who}</span></div>`;
    if (!v) {
      return html`<div class="gw-share-card grid gap-2 rounded-lg border border-edge bg-panel p-3.5">
        ${head}
        <div class="text-xs ${this.error ? "text-err" : "text-faint"}">${this.error || "Loading…"}</div>
      </div>`;
    }
    if (v.status !== "pending") {
      const done =
        v.status === "approved"
          ? `Shared until ${pretty(v.expires_at)}. You can stop it any time in Shared access.`
          : v.status === "rejected"
            ? "Not shared."
            : v.status === "executing"
              ? "Sharing…"
              : "This share couldn't be made.";
      return html`<div class="gw-share-card grid gap-1.5 rounded-lg border border-edge bg-panel p-3.5" data-status=${v.status}>
        ${head}
        <div class="text-xs ${v.status === "approved" ? "text-dim" : "text-faint"}">${done}</div>
      </div>`;
    }
    return html`<div class="gw-share-card grid gap-2.5 rounded-lg border border-edge2 bg-panel p-3.5" data-status="pending">
      ${head}
      ${v.reason ? html`<div class="text-xs leading-relaxed text-dim">${v.reason}</div>` : nothing}
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex items-center gap-2 text-xs text-dim">
          Until
          <input
            type="date"
            class="input w-auto py-1 text-xs"
            .value=${this.until}
            min=${day(null, 1)}
            max=${day(null, MAX_DAYS)}
            ?disabled=${this.busy}
            @change=${(e: Event) => (this.until = (e.target as HTMLInputElement).value)}
          />
        </label>
        <span class="ml-auto"></span>
        <button class="btn btn-ghost btn-sm" ?disabled=${this.busy} @click=${() => void this.act("decline")}>Don't share</button>
        <button class="btn btn-primary btn-sm" ?disabled=${this.busy} @click=${() => void this.act("confirm")}>
          ${this.busy ? "Sharing…" : "Share"}
        </button>
      </div>
      ${this.error ? html`<div class="text-xs text-err" role="alert">${this.error}</div>` : nothing}
      <div class="text-2xs text-faint">Nothing is shared until you press Share.</div>
    </div>`;
  }
}

if (!customElements.get("gw-share-card")) customElements.define("gw-share-card", GwShareCard);
