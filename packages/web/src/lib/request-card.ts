/**
 * <gw-request-card>: a request for information the person can't see, drafted
 * by their agent. The person confirms it here (it carries their question and
 * name to others), then the card shows what, if anything, has been shared
 * with them. It never says whether anything matched or who was asked: that
 * would tell the person what exists outside their view. Light DOM, so the
 * app's styles apply.
 */
import { LitElement, html, nothing } from "lit";

interface RequestView {
  id: string;
  question: string;
  status: "proposed" | "asked" | "shared" | "withdrawn" | "expired" | "joined" | string;
  still_open: boolean;
  /** entries shared with the person so far */
  shared: string[];
  expires_at: string | null;
  joined_into?: string;
}

const pretty = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");

export class GwRequestCard extends LitElement {
  static override properties = {
    requestId: { attribute: "request-id" },
    question: {},
    view: { state: true },
    busy: { state: true },
    error: { state: true },
  };

  // declared, not initialized as class fields (see share-card.ts)
  declare requestId: string;
  declare question: string;
  declare view: RequestView | null;
  declare busy: boolean;
  declare error: string;

  constructor() {
    super();
    this.requestId = "";
    this.question = "";
    this.view = null;
    this.busy = false;
    this.error = "";
  }

  protected override createRenderRoot() {
    return this;
  }

  private poll: ReturnType<typeof setInterval> | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    // an open request changes when an owner shares
    this.poll = setInterval(() => {
      if (this.view?.still_open) void this.load();
    }, 15_000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearInterval(this.poll);
  }

  private async load(): Promise<void> {
    try {
      const r = await fetch(`/api/requests/${encodeURIComponent(this.requestId)}`);
      const j = (await r.json()) as RequestView & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `couldn't load the request (${r.status})`);
      this.view = j;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private async act(kind: "confirm" | "withdraw"): Promise<void> {
    this.busy = true;
    this.error = "";
    try {
      const r = await fetch(`/api/requests/${encodeURIComponent(this.requestId)}/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = (await r.json()) as RequestView & { error?: string };
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
    const q = v?.question ?? this.question;
    const head = html`<div class="text-sm text-fg">Ask people who might know</div>
      <div class="border-l-2 border-edge2 pl-2.5 text-xs leading-relaxed text-dim">${q}</div>`;
    const errorLine = this.error ? html`<div class="text-xs text-err" role="alert">${this.error}</div>` : nothing;
    if (!v) {
      return html`<div class="gw-request-card grid gap-2 rounded-lg border border-edge bg-panel p-3.5">
        ${head}
        <div class="text-xs ${this.error ? "text-err" : "text-faint"}">${this.error || "Loading…"}</div>
      </div>`;
    }
    if (v.status === "proposed") {
      return html`<div class="gw-request-card grid gap-2.5 rounded-lg border border-edge2 bg-panel p-3.5" data-status="proposed">
        ${head}
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-2xs text-faint">Your question and your name go to whoever may have the answer. They decide whether to share it.</span>
          <span class="ml-auto"></span>
          <button class="btn btn-ghost btn-sm" ?disabled=${this.busy} @click=${() => void this.act("withdraw")}>Don't ask</button>
          <button class="btn btn-primary btn-sm" ?disabled=${this.busy} @click=${() => void this.act("confirm")}>${this.busy ? "Asking…" : "Ask"}</button>
        </div>
        ${errorLine}
      </div>`;
    }
    const shared = v.shared.length
      ? html`<div class="text-xs text-dim">Shared with you: <span class="text-fg">${v.shared.join(", ")}</span>. Ask your agent again to use it.</div>`
      : nothing;
    const line =
      v.status === "withdrawn"
        ? "Not asked."
        : v.status === "expired"
          ? v.shared.length ? "" : "This request has ended; nobody shared anything."
          : v.still_open
            ? v.shared.length
              ? `More may be shared with you${v.expires_at ? ` until ${pretty(v.expires_at)}` : ""}.`
              : `Asked. If someone has this, they can share it with you${v.expires_at ? ` until ${pretty(v.expires_at)}` : ""}.`
            : "";
    return html`<div class="gw-request-card grid gap-2 rounded-lg border border-edge bg-panel p-3.5" data-status=${v.status}>
      ${head} ${shared} ${line ? html`<div class="text-xs text-faint">${line}</div>` : nothing}
      ${v.still_open
        ? html`<div class="flex"><span class="ml-auto"></span><button class="btn btn-ghost btn-sm" ?disabled=${this.busy} @click=${() => void this.act("withdraw")}>Withdraw</button></div>`
        : nothing}
      ${errorLine}
    </div>`;
  }
}

if (!customElements.get("gw-request-card")) customElements.define("gw-request-card", GwRequestCard);
