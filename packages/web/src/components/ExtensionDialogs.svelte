<script lang="ts">
  import { onMount } from "svelte";
  import { ws } from "../lib/ws-client.js";
  import type { WsUiRequest } from "@gwarestrin/shared";

  type DialogState = {
    agentId: string;
    id: string;
    method: "select" | "confirm" | "input" | "editor";
    title?: string | undefined;
    message?: string | undefined;
    options?: string[] | undefined;
    placeholder?: string | undefined;
    prefill?: string | undefined;
  } | null;

  let dialogs = $state<DialogState[]>([]);
  let toasts = $state<Array<{ id: string; agentId: string; message: string; kind: string }>>([]);
  let statusLine = $state<string>("");
  let inputValue = $state("");
  let editorValue = $state("");

  function answer(d: DialogState, response: Record<string, unknown>): void {
    ws.send({
      v: 1,
      agentId: d!.agentId,
      kind: "ui_response",
      response: { type: "extension_ui_response", id: d!.id, ...response },
    });
    dialogs = dialogs.filter((x) => x !== d);
    inputValue = "";
    editorValue = "";
  }

  function toast(message: string, kind: string, agentId: string): void {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    toasts = [...toasts, { id, agentId, message, kind }];
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, 5000);
  }

  onMount(() => {
    return ws.onMessage((msg) => {
      if (msg.kind !== "ui_request") return;
      const r = msg.request as WsUiRequest["request"] & { timeout?: number };
      switch (r.method) {
        case "select":
        case "confirm":
        case "input":
        case "editor": {
          const d: DialogState = {
            agentId: msg.agentId,
            id: r.id,
            method: r.method,
            title: typeof r.title === "string" ? r.title : undefined,
            message: typeof r.message === "string" ? r.message : undefined,
            options: Array.isArray(r.options) ? (r.options as string[]) : undefined,
            placeholder: typeof r.placeholder === "string" ? r.placeholder : undefined,
            prefill: typeof r.prefill === "string" ? r.prefill : undefined,
          };
          if (d && d.method === "editor") editorValue = d.prefill ?? "";
          dialogs = [...dialogs, d];
          break;
        }
        case "notify":
          toast(String(r.message ?? ""), String(r.notifyType ?? "info"), msg.agentId);
          break;
        case "setStatus": {
          const text = r.statusText ? String(r.statusText) : "";
          if (String(r.statusKey) === "gondolin") {
            statusLine = text ? `vm: ${text}` : "";
          }
          break;
        }
        case "setWidget": {
          if (Array.isArray(r.widgetLines)) {
            statusLine = (r.widgetLines as string[]).join(" · ");
          }
          break;
        }
        case "setTitle":
          document.title = String(r.title ?? "gwarestrin");
          break;
        case "set_editor_text":
          // handled by MessageEditor in future; ignore for now
          break;
      }
    });
  });
</script>

{#each dialogs as d (d!.id)}
  <div class="fixed inset-0 z-60 bg-black/55" role="presentation"></div>
  <div class="fixed top-1/2 left-1/2 z-61 grid min-w-88 max-w-2xl -translate-x-1/2 -translate-y-1/2 gap-3 rounded-xl border border-edge2 bg-panel2 p-5" role="dialog" aria-modal="true">
    <h3 class="m-0">{d!.title ?? d!.method}</h3>
    {#if d!.message}
      <p class="m-0 text-sm text-muted">{d!.message}</p>
    {/if}

    {#if d!.method === "select"}
      <div class="flex flex-wrap gap-2">
        {#each d!.options ?? [] as opt}
          <button class="rounded-md bg-accent px-3 py-1.5 font-medium text-[#0b0c10]" onclick={() => answer(d, { value: opt })}>{opt}</button>
        {/each}
      </div>
    {:else if d!.method === "confirm"}
      <div class="flex justify-end gap-2">
        <button class="rounded-md border border-[#333845] bg-transparent px-4 py-1.5 text-fg" onclick={() => answer(d, { confirmed: false })}>no</button>
        <button class="rounded-md bg-accent px-4 py-1.5 font-semibold text-[#0b0c10]" onclick={() => answer(d, { confirmed: true })}>yes</button>
      </div>
    {:else if d!.method === "input"}
      <input
        class="rounded-md border border-edge2 bg-bg px-2.5 py-2 text-fg outline-none focus:border-accent"
        placeholder={d!.placeholder ?? ""}
        bind:value={inputValue}
        autofocus
        onkeydown={(e) => e.key === "Enter" && answer(d, { value: inputValue })}
      />
      <div class="flex justify-end gap-2">
        <button class="rounded-md bg-accent px-4 py-1.5 font-semibold text-[#0b0c10]" onclick={() => answer(d, { value: inputValue })}>ok</button>
      </div>
    {:else if d!.method === "editor"}
      <textarea
        class="min-h-40 rounded-md border border-edge2 bg-bg px-2.5 py-2 font-mono text-sm text-fg outline-none focus:border-accent"
        bind:value={editorValue}
        autofocus
      ></textarea>
      <div class="flex justify-end gap-2">
        <button class="rounded-md bg-accent px-4 py-1.5 font-semibold text-[#0b0c10]" onclick={() => answer(d, { value: editorValue })}>done</button>
      </div>
    {/if}

    <button
      class="absolute top-3 right-3 rounded px-1.5 text-muted hover:text-fg"
      aria-label="dismiss"
      onclick={() => answer(d, { cancelled: true })}
    >
      ✕
    </button>
  </div>
{/each}

<div class="pointer-events-none fixed right-3 bottom-3 z-70 grid gap-2">
  {#each toasts as t (t.id)}
    <div class="rounded-lg border px-3 py-2 text-sm shadow-lg
      {t.kind === 'error' ? 'border-err bg-[#2a1218] text-err' : t.kind === 'warning' ? 'border-warn bg-[#26200f] text-warn' : 'border-edge bg-panel2 text-fg'}">
      {t.message}
    </div>
  {/each}
</div>

{#if statusLine}
  <div class="fixed bottom-1 left-2 z-70 rounded bg-panel2/90 px-2 py-0.5 text-xs text-muted">
    {statusLine}
  </div>
{/if}
