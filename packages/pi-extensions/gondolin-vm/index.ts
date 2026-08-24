/**
 * gondolin-vm: routes pi's read/write/edit/bash tools (and user `!` bash)
 * into this agent's gondolin microvm. The VM mounts the agent workspace
 * read-write at /workspace; host-side HTTP policy (allowlist + secret
 * injection) mediates all guest egress.
 *
 * Config arrives via GWARESTRIN_AGENT_CONFIG (JSON file written by the
 * gwarestrin server). Secret VALUES are never in that file — the extension
 * resolves them from env vars at boot (server injects them at spawn).
 *
 * Fails closed: if the VM cannot boot, extension load throws (pi exits) —
 * tools never silently fall back to host execution.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { createHttpHooks, RealFSProvider, VM } from "@earendil-works/gondolin";

const GUEST_WORKSPACE = "/workspace";

interface GondolinAgentConfig {
  workspaceDir: string;
  gondolin: {
    enabled?: boolean;
    image?: string;
    cpus?: number;
    memoryMB?: number;
    allowedHosts: string[];
    allowedInternalHosts?: string[];
    secrets?: Record<string, { hosts: string[]; valueEnv: string }>;
  };
}

function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function toGuestPath(localCwd: string, localPath: string): string {
  const rel = path.relative(localCwd, localPath);
  if (rel === "") return GUEST_WORKSPACE;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(GUEST_WORKSPACE, posixRel);
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
  return {
    readFile: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      const r = await vm.exec(["/bin/cat", guestPath]);
      if (!r.ok) throw new Error(`cat failed (${r.exitCode}): ${r.stderr}`);
      return r.stdoutBuffer;
    },
    access: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      const r = await vm.exec(["/bin/sh", "-lc", `test -r ${shQuote(guestPath)}`]);
      if (!r.ok) throw new Error(`not readable: ${p}`);
    },
    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      try {
        const r = await vm.exec(["/bin/sh", "-lc", `file --mime-type -b ${shQuote(guestPath)}`]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
  return {
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(localCwd, p);
      const dir = path.posix.dirname(guestPath);
      // chunked base64 to stay under MAX_ARG_STRLEN (gondolin #130)
      const b64 = Buffer.from(content, "utf8").toString("base64");
      const CHUNK = 65536;
      const script = [`set -eu`, `mkdir -p ${shQuote(dir)}`, `: > ${shQuote(guestPath)}`];
      for (let i = 0; i < b64.length; i += CHUNK) {
        script.push(`printf %s ${shQuote(b64.slice(i, i + CHUNK))} >> ${shQuote(guestPath)}`);
      }
      const r = await vm.exec(["/bin/sh", "-lc", script.join("\n")]);
      if (!r.ok) throw new Error(`write failed (${r.exitCode}): ${r.stderr}`);
    },
    mkdir: async (dir) => {
      const guestDir = toGuestPath(localCwd, dir);
      const r = await vm.exec(["/bin/mkdir", "-p", guestDir]);
      if (!r.ok) throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
    },
  };
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
  const r = createGondolinReadOps(vm, localCwd);
  const w = createGondolinWriteOps(vm, localCwd);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function sanitizeEnv(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function createGondolinBashOps(vm: VM, localCwd: string): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const guestCwd = toGuestPath(localCwd, cwd);

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, timeout * 1000)
          : undefined;

      const sanitized = sanitizeEnv(env);
      try {
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd: guestCwd,
          signal: ac.signal,
          ...(sanitized !== undefined ? { env: sanitized } : {}),
          stdout: "pipe",
          stderr: "pipe",
        });

        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }

        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export default async function gondolinVm(pi: ExtensionAPI) {
  const configPath = process.env.GWARESTRIN_AGENT_CONFIG;
  if (!configPath) {
    throw new Error("gondolin-vm: GWARESTRIN_AGENT_CONFIG env not set");
  }

  let config: GondolinAgentConfig;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    throw new Error(`gondolin-vm: cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (config.gondolin?.enabled === false) {
    return; // server disabled sandboxing for this agent (dev mode)
  }

  const localCwd = config.workspaceDir;

  // resolve secret values from env (server-injected); placeholder-only in guest
  const secrets: Record<string, { hosts: string[]; value: string }> = {};
  for (const [name, def] of Object.entries(config.gondolin.secrets ?? {})) {
    const value = process.env[def.valueEnv];
    if (value) secrets[name] = { hosts: def.hosts, value };
  }

  const { httpHooks, env: guestEnv } = createHttpHooks({
    allowedHosts: config.gondolin.allowedHosts,
    ...(config.gondolin.allowedInternalHosts !== undefined ? { allowedInternalHosts: config.gondolin.allowedInternalHosts } : {}),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  });

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;

  async function ensureVm(ctx?: { ui: { setStatus: (key: string, text?: string) => void; notify: (message: string, type?: "error" | "info" | "warning") => void } }) {
    if (vm) return vm;
    if (vmStarting) return vmStarting;

    vmStarting = (async () => {
      ctx?.ui.setStatus("gondolin", "booting");
      const created = await VM.create({
        httpHooks,
        env: guestEnv,
        ...(config.gondolin.cpus !== undefined ? { cpus: config.gondolin.cpus } : {}),
        ...(config.gondolin.memoryMB !== undefined ? { memory: `${config.gondolin.memoryMB}M` } : {}),
        ...(config.gondolin.image !== undefined ? { imagePath: config.gondolin.image } : {}),
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
          },
        },
      });
      vm = created;
      ctx?.ui.setStatus("gondolin", "running");
      ctx?.ui.notify(`Gondolin VM ready. ${localCwd} mounted at ${GUEST_WORKSPACE}`, "info");
      return created;
    })();

    try {
      return await vmStarting;
    } catch (err) {
      // fail closed: never fall back to host tools
      vmStarting = null;
      ctx?.ui.setStatus("gondolin", "error");
      throw new Error(`gondolin VM boot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async () => {
    const closing = vm;
    vm = null;
    vmStarting = null;
    if (closing) await closing.close().catch(() => {});
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createReadTool(localCwd, { operations: createGondolinReadOps(activeVm, localCwd) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(localCwd, { operations: createGondolinWriteOps(activeVm, localCwd) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(localCwd, { operations: createGondolinEditOps(activeVm, localCwd) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(localCwd, { operations: createGondolinBashOps(activeVm, localCwd) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // user `!` commands also run inside the VM
  pi.on("user_bash", (_event, _ctx) => {
    const activeVm = vm;
    if (!activeVm) return;
    return { operations: createGondolinBashOps(activeVm, localCwd) };
  });

  // present /workspace as cwd to the model
  pi.on("before_agent_start", async (event) => {
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM, mounted from host: ${localCwd}). All file and bash tools execute inside this sandboxed Linux VM.`,
    );
    return { systemPrompt: modified };
  });
}
