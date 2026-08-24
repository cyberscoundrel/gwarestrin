<script lang="ts">
  import { onMount } from "svelte";
  import { filesApi, type FileEntry } from "../lib/api.js";

  let { agentId }: { agentId: string } = $props();

  let cwd = $state("");
  let entries = $state<FileEntry[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let dragOver = $state(false);

  const breadcrumbs = $derived(cwd ? cwd.split("/").filter(Boolean) : []);

  async function refresh(): Promise<void> {
    error = null;
    try {
      entries = await filesApi.list(agentId, cwd);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => void refresh());

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
    const name = prompt("new directory name");
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

<div
  class="flex h-full flex-col border-l border-edge bg-panel text-sm"
  class:outline-2={dragOver}
  class:outline-dashed={dragOver}
  class:outline-accent={dragOver}
  ondragover={(e) => {
    e.preventDefault();
    dragOver = true;
  }}
  ondragleave={() => (dragOver = false)}
  ondrop={onDrop}
  role="region"
  aria-label="files"
>
  <div class="flex items-center gap-2 border-b border-edge px-3 py-2">
    <span class="font-semibold tracking-wide">workspace</span>
    <button class="ml-auto rounded border border-edge2 bg-transparent px-2 py-0.5 text-xs text-muted hover:text-fg" onclick={mkdirPrompt}>+ dir</button>
    <label class="rounded border border-edge2 bg-transparent px-2 py-0.5 text-xs text-muted hover:text-fg cursor-pointer">
      upload
      <input
        type="file"
        multiple
        class="hidden"
        onchange={(e) => {
          void upload(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
    </label>
  </div>

  <div class="flex items-center gap-1 border-b border-edge px-3 py-1.5 text-xs text-muted">
    <button class="hover:text-fg" onclick={() => navigate("")}>root</button>
    {#each breadcrumbs as seg, i}
      <span>/</span>
      <button class="hover:text-fg" onclick={() => upTo(i)}>{seg}</button>
    {/each}
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if error}
      <p class="px-3 py-2 text-err">{error}</p>
    {:else if entries.length === 0}
      <p class="px-3 py-2 text-muted">empty — drag files here to upload</p>
    {:else}
      <ul class="m-0 list-none p-0">
        {#each entries as e (e.name)}
          <li class="group flex items-center gap-2 px-3 py-1 hover:bg-[#1a1d26]">
            <span class="w-4 text-muted">{e.type === "dir" ? "📁" : "📄"}</span>
            {#if e.type === "dir"}
              <button class="flex-1 truncate text-left hover:text-accent" onclick={() => openDir(e.name)}>{e.name}</button>
            {:else}
              <a class="flex-1 truncate hover:text-accent" href={filesApi.downloadUrl(agentId, cwd ? `${cwd}/${e.name}` : e.name)}>{e.name}</a>
            {/if}
            <span class="text-xs text-muted">{e.type === "file" ? fmtSize(e.size) : ""}</span>
            <button
              class="invisible rounded px-1 text-xs text-err hover:bg-[#2a1218] group-hover:visible"
              title="delete"
              onclick={() => void remove(e.name)}
            >
              ✕
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if busy}
    <div class="border-t border-edge px-3 py-1.5 text-xs text-muted">working…</div>
  {/if}
</div>
