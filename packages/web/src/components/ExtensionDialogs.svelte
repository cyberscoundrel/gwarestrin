<script lang="ts">
  import { onMount } from "svelte";
  import { ws } from "../lib/ws-client.js";
  import { store } from "../lib/stores.svelte.js";
  import type { WsUiRequest } from "@gwarestrin/shared";
  import { Bot, Info, TriangleAlert } from "lucide";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";

  // focus the first field when a dialog opens (instead of the autofocus attr)
  function focusOnMount(el: HTMLElement): void {
    el.focus();
  }

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
            store.setStatusLine(msg.agentId, text ? `sandbox: ${text}` : "");
          }
          break;
        }
        case "setWidget": {
          if (Array.isArray(r.widgetLines)) {
            store.setStatusLine(msg.agentId, (r.widgetLines as string[]).join(" · "));
          }
          break;
        }
        case "setTitle":
          document.title = String(r.title ?? "ground chat");
          break;
        case "set_editor_text":
          // handled by MessageEditor in future; ignore for now
          break;
      }
    });
  });
</script>

{#each dialogs as d (d!.id)}
  {@const agentName = store.agents.find((a) => a.id === d!.agentId)?.name ?? d!.agentId}
  <Dialog onclose={() => answer(d, { cancelled: true })} labelledby="ext-dialog-{d!.id}" width="34rem" z={60}>
    <div class="grid gap-3 p-5">
      <div class="flex items-start gap-3">
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-edge bg-panel text-faint">
          <Icon icon={Bot} size={15} />
        </span>
        <div class="grid min-w-0 gap-1">
          <span class="truncate text-xs text-faint">Request from <span class="text-dim">{agentName}</span></span>
          <h3 id="ext-dialog-{d!.id}" class="m-0 text-base font-medium break-words text-fg">{d!.title ?? "The agent needs your input"}</h3>
          {#if d!.message}
            <p class="m-0 text-sm break-words text-dim">{d!.message}</p>
          {/if}
        </div>
      </div>

      {#if d!.method === "select"}
        <div class="grid gap-1" role="listbox" aria-label="options">
          {#each d!.options ?? [] as opt, i}
            <button
              class="flex w-full cursor-pointer items-center rounded-md border border-edge2 bg-panel px-3 py-2 text-left text-sm text-fg transition-colors hover:border-faint"
              role="option"
              aria-selected="false"
              onclick={() => answer(d, { value: opt })}>{opt}</button
            >
          {/each}
        </div>
      {:else if d!.method === "input"}
        <input
          class="input"
          placeholder={d!.placeholder ?? ""}
          aria-label={d!.title ?? "answer"}
          bind:value={inputValue}
          use:focusOnMount
          onkeydown={(e) => e.key === "Enter" && answer(d, { value: inputValue })}
        />
      {:else if d!.method === "editor"}
        <textarea class="input input-mono min-h-40" aria-label={d!.title ?? "text"} bind:value={editorValue} use:focusOnMount></textarea>
      {/if}
    </div>

    {#if d!.method !== "select"}
      <div class="flex justify-end gap-2 border-t border-edge bg-panel px-5 py-3">
        {#if d!.method === "confirm"}
          <button class="btn btn-secondary btn-sm" onclick={() => answer(d, { confirmed: false })}>No</button>
          <button class="btn btn-primary btn-sm" use:focusOnMount onclick={() => answer(d, { confirmed: true })}>Yes</button>
        {:else if d!.method === "input"}
          <button class="btn btn-ghost btn-sm" onclick={() => answer(d, { cancelled: true })}>Cancel</button>
          <button class="btn btn-primary btn-sm" onclick={() => answer(d, { value: inputValue })}>OK</button>
        {:else}
          <button class="btn btn-ghost btn-sm" onclick={() => answer(d, { cancelled: true })}>Cancel</button>
          <button class="btn btn-primary btn-sm" onclick={() => answer(d, { value: editorValue })}>Done</button>
        {/if}
      </div>
    {:else}
      <div class="flex justify-end border-t border-edge bg-panel px-5 py-3">
        <button class="btn btn-ghost btn-sm" onclick={() => answer(d, { cancelled: true })}>Dismiss</button>
      </div>
    {/if}
  </Dialog>
{/each}

<div class="pointer-events-none fixed right-4 bottom-4 z-70 grid w-[min(22rem,calc(100vw-2rem))] gap-2" aria-live="polite">
  {#each toasts as t (t.id)}
    <div
      class="animate-enter pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-panel2 px-3 py-2.5 text-sm shadow-overlay
        {t.kind === 'error' ? 'border-err/40 text-fg' : t.kind === 'warning' ? 'border-warn/40 text-fg' : 'border-edge2 text-fg'}"
      role={t.kind === "error" ? "alert" : "status"}
    >
      <Icon
        icon={t.kind === "error" || t.kind === "warning" ? TriangleAlert : Info}
        size={15}
        class="mt-0.5 {t.kind === 'error' ? 'text-err' : t.kind === 'warning' ? 'text-warn' : 'text-faint'}"
      />
      <span class="min-w-0 break-words">{t.message}</span>
    </div>
  {/each}
</div>
