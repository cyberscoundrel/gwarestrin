/**
 * Readable cards for pi's built-in file/shell tools, registered through
 * pi-web-ui's public renderer registry (no fork). Without these, `write`,
 * `read` and `edit` fall back to a raw "Tool Call" JSON card, and pi-web-ui's
 * bash card keeps saying "Running command..." after the command finished.
 */
import { registerToolRenderer, renderHeader } from "@earendil-works/pi-web-ui";
import { html } from "lit";

type State = "inprogress" | "complete" | "error";
interface ToolResultLike {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

// simple line icons (lucide-style IconNode: [tag, attrs][])
const TerminalIcon = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
  ["path", { d: "M7 9l3 3-3 3" }],
  ["path", { d: "M12 15h5" }],
];
const FileIcon = [
  ["path", { d: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" }],
  ["path", { d: "M14 3v6h6" }],
];
const PenIcon = [
  ["path", { d: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" }],
  ["path", { d: "M18.5 2.5a2.1 2.1 0 0 1 3 3L13 14l-4 1 1-4z" }],
];

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

function clip(text: string, maxLines = 40): string {
  const lines = text.split("\n");
  return lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines)` : text;
}

const card = (header: unknown, body?: unknown) => ({
  content: html`<div class="space-y-3">${header}${body ?? ""}</div>`,
  isCustom: false,
});

function label(state: State, running: string, done: string, failed: string): string {
  return state === "inprogress" ? running : state === "error" ? failed : done;
}

export function registerGwToolRenderers(): void {
  registerToolRenderer("bash", {
    render(params: unknown, result: ToolResultLike | undefined, isStreaming?: boolean) {
      const a = args(params);
      const state = stateOf(result, isStreaming);
      const command = typeof a.command === "string" ? a.command : "";
      const out = outputText(result);
      const text = command ? (out ? `> ${command}\n\n${out}` : `> ${command}`) : out;
      return card(
        renderHeader(state, TerminalIcon, label(state, "Running command…", "Ran command", "Command failed")),
        text ? html`<console-block .content=${text} .variant=${state === "error" ? "error" : "default"}></console-block>` : "",
      );
    },
  });

  registerToolRenderer("write", {
    render(params: unknown, result: ToolResultLike | undefined, isStreaming?: boolean) {
      const a = args(params);
      const state = stateOf(result, isStreaming);
      const path = typeof a.path === "string" ? a.path : "file";
      const content = typeof a.content === "string" ? a.content : "";
      const out = outputText(result);
      return card(
        renderHeader(state, PenIcon, label(state, `Writing ${path}…`, `Wrote ${path}`, `Couldn't write ${path}`)),
        html`${content ? html`<console-block .content=${clip(content)}></console-block>` : ""}
          ${out ? html`<div class="text-xs ${state === "error" ? "text-destructive" : "text-muted-foreground"}">${out}</div>` : ""}`,
      );
    },
  });

  registerToolRenderer("read", {
    render(params: unknown, result: ToolResultLike | undefined, isStreaming?: boolean) {
      const a = args(params);
      const state = stateOf(result, isStreaming);
      const path = typeof a.path === "string" ? a.path : "file";
      const out = outputText(result);
      return card(
        renderHeader(state, FileIcon, label(state, `Reading ${path}…`, `Read ${path}`, `Couldn't read ${path}`)),
        out ? html`<console-block .content=${clip(out)} .variant=${state === "error" ? "error" : "default"}></console-block>` : "",
      );
    },
  });

  registerToolRenderer("edit", {
    render(params: unknown, result: ToolResultLike | undefined, isStreaming?: boolean) {
      const a = args(params);
      const state = stateOf(result, isStreaming);
      const path = typeof a.path === "string" ? a.path : "file";
      const out = outputText(result);
      return card(
        renderHeader(state, PenIcon, label(state, `Editing ${path}…`, `Edited ${path}`, `Couldn't edit ${path}`)),
        out ? html`<console-block .content=${clip(out)} .variant=${state === "error" ? "error" : "default"}></console-block>` : "",
      );
    },
  });
}
