/**
 * Graphite tool cards for pi's built-in shell/file tools, registered through
 * pi-web-ui's public registerToolRenderer (no fork).
 *
 * One card shape for every tool: a summary row (state glyph, tool icon, what
 * happened, the command/path in mono) and, when there is output, a native
 * <details> body - collapsible without JS and the open/closed state survives
 * Lit re-renders. Mono is used only for the command/path and the output.
 */
import { registerToolRenderer } from "@earendil-works/pi-web-ui";
import { html, svg, type TemplateResult } from "lit";
import { Cable, ChevronRight, FilePen, FileText, Pencil, SquareTerminal, type IconNode } from "lucide";
import "./share-card.js";

type State = "inprogress" | "complete" | "error";
interface ToolResultLike {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function iconTpl(node: IconNode, cls = ""): TemplateResult {
  return html`<svg
    class="gw-icon ${cls}"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${node.map(([tag, attrs]) => {
      const a = attrs as Record<string, string>;
      switch (tag) {
        case "path":
          return svg`<path d=${a.d ?? ""} />`;
        case "rect":
          return svg`<rect x=${a.x ?? 0} y=${a.y ?? 0} width=${a.width ?? 0} height=${a.height ?? 0} rx=${a.rx ?? 0} />`;
        case "circle":
          return svg`<circle cx=${a.cx ?? 0} cy=${a.cy ?? 0} r=${a.r ?? 0} />`;
        case "line":
          return svg`<line x1=${a.x1 ?? 0} y1=${a.y1 ?? 0} x2=${a.x2 ?? 0} y2=${a.y2 ?? 0} />`;
        case "polyline":
          return svg`<polyline points=${a.points ?? ""} />`;
        default:
          return svg``;
      }
    })}
  </svg>`;
}

/** tool-call arguments arrive as an object, or as a JSON string while streaming */
function args(params: unknown): Record<string, unknown> {
  if (params && typeof params === "object") return params as Record<string, unknown>;
  if (typeof params === "string") {
    try {
      const v = JSON.parse(params) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function stateOf(result: ToolResultLike | undefined, isStreaming?: boolean): State {
  if (result) return result.isError ? "error" : "complete";
  return isStreaming === false ? "complete" : "inprogress";
}

function outputText(result: ToolResultLike | undefined): string {
  return (result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

function clip(text: string, maxLines = 400): string {
  const lines = text.split("\n");
  return lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines)` : text;
}

function glyph(state: State): TemplateResult {
  if (state === "inprogress") return html`<span class="gw-tool-spin" aria-label="running"></span>`;
  return html`<span class="gw-tool-dot" data-state=${state} aria-label=${state === "error" ? "failed" : "done"}></span>`;
}

function card(opts: {
  state: State;
  icon: IconNode;
  title: string;
  detail?: string | undefined;
  body?: TemplateResult | undefined;
  open?: boolean;
}) {
  const head = html`${glyph(opts.state)}${iconTpl(opts.icon, "gw-tool-icon")}
    <span class="gw-tool-title">${opts.title}</span>
    ${opts.detail ? html`<code class="gw-tool-detail" title=${opts.detail}>${opts.detail}</code>` : ""}`;
  const content = opts.body
    ? html`<details class="gw-tool" data-state=${opts.state} ?open=${opts.open ?? false}>
        <summary class="gw-tool-head">${head}${iconTpl(ChevronRight, "gw-tool-chevron")}</summary>
        <div class="gw-tool-body">${opts.body}</div>
      </details>`
    : html`<div class="gw-tool" data-state=${opts.state}><div class="gw-tool-head">${head}</div></div>`;
  return { content, isCustom: true };
}

const consoleOut = (text: string, state: State) =>
  html`<console-block .content=${clip(text)} .variant=${state === "error" ? "error" : "default"}></console-block>`;

function label(state: State, running: string, done: string, failed: string): string {
  return state === "inprogress" ? running : state === "error" ? failed : done;
}

function pathOf(a: Record<string, unknown>): string | undefined {
  return typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : undefined;
}

export function registerGwToolRenderers(): void {
  registerToolRenderer("bash", {
    render(params: unknown, result: ToolResultLike | undefined, isStreaming?: boolean) {
      const a = args(params);
      const state = stateOf(result, isStreaming);
      const out = outputText(result);
      return card({
        state,
        icon: SquareTerminal,
        title: label(state, "Running", "Ran", "Failed"),
        detail: typeof a.command === "string" ? a.command : undefined,
        body: out ? consoleOut(out, state) : undefined,
        open: true,
      });
    },
  });

  registerToolRenderer("write", {
    render(params: unknown, result: ToolResultLike | undefined, isStreaming?: boolean) {
      const a = args(params);
      const state = stateOf(result, isStreaming);
      const content = typeof a.content === "string" ? a.content : "";
      const out = outputText(result);
      return card({
        state,
        icon: FilePen,
        title: label(state, "Writing", "Wrote", "Couldn't write"),
        detail: pathOf(a),
        body:
          content || out
            ? html`${content ? consoleOut(content, state) : ""}${out ? html`<p class="gw-tool-note">${out}</p>` : ""}`
            : undefined,
      });
    },
  });

  registerToolRenderer("read", {
    render(params: unknown, result: ToolResultLike | undefined, isStreaming?: boolean) {
      const a = args(params);
      const state = stateOf(result, isStreaming);
      const out = outputText(result);
      return card({
        state,
        icon: FileText,
        title: label(state, "Reading", "Read", "Couldn't read"),
        detail: pathOf(a),
        body: out ? consoleOut(out, state) : undefined,
      });
    },
  });

  registerToolRenderer("edit", {
    render(params: unknown, result: ToolResultLike | undefined, isStreaming?: boolean) {
      const a = args(params);
      const state = stateOf(result, isStreaming);
      const out = outputText(result);
      return card({
        state,
        icon: Pencil,
        title: label(state, "Editing", "Edited", "Couldn't edit"),
        detail: pathOf(a),
        body: out ? consoleOut(out, state) : undefined,
      });
    },
  });

  // tool connections (pi-mcp-adapter's one "mcp" tool: {tool: "<server>_<tool>", args} or
  // {server} to list a server's tools). A proposed share becomes a confirmation card.
  registerToolRenderer("mcp", {
    render(params: unknown, result: ToolResultLike | undefined, isStreaming?: boolean) {
      const a = args(params);
      const state = stateOf(result, isStreaming);
      const out = outputText(result);
      const tool = typeof a.tool === "string" ? a.tool : "";
      if (tool.endsWith("grant_access") && result && !result.isError) {
        const proposals = proposedShares(out);
        if (proposals.length) {
          return {
            content: html`<div class="grid gap-2">
              ${proposals.map(
                (p) => html`<gw-share-card pending-id=${p.pendingId} .target=${p.target} .to=${p.to}></gw-share-card>`,
              )}
            </div>`,
            isCustom: true,
          };
        }
      }
      const server = typeof a.server === "string" ? a.server : tool.split("_")[0] ?? "";
      const name = tool ? tool.slice(server.length + 1) || tool : "";
      return card({
        state,
        icon: Cable,
        title: name
          ? label(state, `Using ${name.replace(/_/g, " ")}`, `Used ${name.replace(/_/g, " ")}`, `Couldn't use ${name.replace(/_/g, " ")}`)
          : label(state, `Opening ${server}`, `Opened ${server}`, `Couldn't open ${server}`),
        detail: server || undefined,
        body: out ? consoleOut(out, state) : undefined,
      });
    },
  });
}

/** shares an agent proposed, from a grant_access result (the JSON may be wrapped in text) */
function proposedShares(text: string): Array<{ pendingId: string; target: string; to: string }> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as { results?: Array<Record<string, unknown>> };
    return (j.results ?? [])
      .filter((r) => r.proposed === true && typeof r.pendingId === "string")
      .map((r) => ({ pendingId: String(r.pendingId), target: String(r.target ?? ""), to: String(r.to ?? "") }));
  } catch {
    return [];
  }
}
