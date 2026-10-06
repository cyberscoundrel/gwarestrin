<script lang="ts">
  import { filesApi, type FileEntry } from "../lib/api.js";
  import { File as FileIcon, Folder, FolderOpen, FolderPlus, Trash2, TriangleAlert, Upload } from "lucide";
  import Icon from "./Icon.svelte";
  import PanelHeader from "./PanelHeader.svelte";
  import EmptyState from "./EmptyState.svelte";
  import SkeletonRows from "./SkeletonRows.svelte";

  let { agentId, onclose }: { agentId: string; onclose?: (() => void) | undefined } = $props();

  let cwd = $state("");
  let entries = $state<FileEntry[]>([]);
  /** false while a listing is in flight (avoids an "empty" flash) */
  let loaded = $state(false);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let dragOver = $state(false);

  const breadcrumbs = $derived(cwd ? cwd.split("/").filter(Boolean) : []);

  async function refresh(): Promise<void> {
    error = null;
    try {
      entries = await filesApi.list(agentId, cwd);
      loaded = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // re-runs on mount AND when the agent tab switches (panel is reused)
  $effect(() => {
    void agentId;
    cwd = "";
    entries = [];
    loaded = false;
    void refresh();
  });

  function navigate(dir: string): void {
    cwd = dir;
    void refresh();
  }

  function openDir(name: string): void {
    navigate(cwd ? `${cwd}/${name}` : name);
  }

  function upTo(index: number): void {
    navigate(index < 0 ? "" : breadcrumbs.slice(0, index + 1).join("/"));
  }

  async function upload(files: FileList | File[] | null): Promise<void> {
    if (!files?.length) return;
    busy = true;
    error = null;
    try {
      await filesApi.upload(agentId, cwd, files);
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function remove(name: string): Promise<void> {
    const target = cwd ? `${cwd}/${name}` : name;
    if (!confirm(`delete ${target}?`)) return;
    busy = true;
    error = null;
    try {
      await filesApi.remove(agentId, target);
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function mkdirPrompt(): Promise<void> {
    const name = prompt("New folder name");
    if (!name?.trim()) return;
    error = null;
    try {
      await filesApi.mkdir(agentId, cwd ? `${cwd}/${name.trim()}` : name.trim());
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragOver = false;
    if (e.dataTransfer?.files?.length) void upload(e.dataTransfer.files);
  }
</script>

{#snippet headerActions()}
  <button
    class="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-faint transition-colors hover:bg-hover hover:text-fg"
    title="New folder"
    aria-label="new folder"
    onclick={mkdirPrompt}
  >
    <Icon icon={FolderPlus} size={15} />
  </button>
  <label
    class="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-faint transition-colors hover:bg-hover hover:text-fg"
    title="Upload files"
  >
    <Icon icon={Upload} size={15} label="upload files" />
    <input
      type="file"
      multiple
      class="sr-only"
      onchange={(e) => {
        void upload(e.currentTarget.files);
        e.currentTarget.value = "";
      }}
    />
  </label>
{/snippet}

<div
  class="relative flex h-full flex-col border-l border-edge bg-panel text-sm"
  ondragover={(e) => {
    e.preventDefault();
    dragOver = true;
  }}
  ondragleave={() => (dragOver = false)}
  ondrop={onDrop}
  role="region"
  aria-label="files"
>
  <PanelHeader title="Files" subtitle="This agent's sandbox. Drop files to upload." icon={FolderOpen} {onclose} actions={headerActions} />

  <nav class="flex min-h-9 items-center gap-1 border-b border-edge px-4 font-mono text-2xs text-faint" aria-label="path">
    <button class="cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-hover hover:text-fg" onclick={() => navigate("")}>~</button>
    {#each breadcrumbs as seg, i}
      <span aria-hidden="true">/</span>
      <button class="cursor-pointer truncate rounded px-1 py-0.5 transition-colors hover:bg-hover hover:text-fg" onclick={() => upTo(i)}>{seg}</button>
    {/each}
  </nav>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if error}
      <EmptyState icon={TriangleAlert} tone="err" title="Couldn't list files" hint={error} />
    {:else if !loaded}
      <SkeletonRows rows={5} />
    {:else if entries.length === 0}
      <EmptyState icon={FolderOpen} title="Nothing here yet" hint="Files the agent creates show up here. Drag files in to upload them." />
    {:else}
      <ul class="m-0 list-none p-1.5">
        {#each entries as e (e.name)}
          <li class="group flex h-8 items-center gap-2 rounded-md px-2.5 transition-colors hover:bg-hover">
            <Icon icon={e.type === "dir" ? Folder : FileIcon} size={14} class="text-faint" />
            {#if e.type === "dir"}
              <button class="min-w-0 flex-1 cursor-pointer truncate text-left text-fg" onclick={() => openDir(e.name)}>{e.name}</button>
            {:else}
              <a
                class="min-w-0 flex-1 truncate text-fg no-underline hover:underline"
                href={filesApi.downloadUrl(agentId, cwd ? `${cwd}/${e.name}` : e.name)}
                title="Download {e.name}">{e.name}</a
              >
            {/if}
            <span class="tabular shrink-0 font-mono text-2xs text-faint">{e.type === "file" ? fmtSize(e.size) : ""}</span>
            <button
              class="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md text-faint opacity-0 transition hover:bg-err-soft hover:text-err
                group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              title="Delete {e.name}"
              aria-label="delete {e.name}"
              onclick={() => void remove(e.name)}
            >
              <Icon icon={Trash2} size={13} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if busy}
    <div class="flex items-center gap-2 border-t border-edge px-4 py-2 text-xs text-faint" role="status">
      <span class="gw-tool-spin"></span> Working…
    </div>
  {/if}

  {#if dragOver}
    <div class="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-dashed border-signal bg-signal-soft text-sm text-signal">
      Drop to upload
    </div>
  {/if}
</div>
