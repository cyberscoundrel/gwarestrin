import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRecord, AgentRuntimeSummary, PatchAgentInput } from "@gwarestrin/shared";
import type { ServerConfig } from "../config.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { scoped } from "../util/log.js";
import { RpcAgent } from "./rpc-agent.js";
import { PiProcess } from "./pi-process.js";
import { dirsFor, piEnvFor, scaffoldAgent } from "./scaffold.js";
import { AgentStore } from "./store.js";

const log = scoped("manager");
const here = path.dirname(fileURLToPath(import.meta.url));

const MAX_RESTARTS = 3;

export interface ManagerEvents {
  agentState: [state: AgentRuntimeSummary];
  agentEvent: [data: { agentId: string; event: Record<string, unknown> & { type: string } }];
  agentUiRequest: [data: { agentId: string; request: Record<string, unknown> & { type: string } }];
}

export class AgentManager extends EventEmitter<ManagerEvents> {
  readonly store: AgentStore;
  private config: ServerConfig;
  private registry: ProviderRegistry;
  private running = new Map<string, RpcAgent>();
  private restartBudget = new Map<string, number>();
  private extensionsRoot: string;

  constructor(config: ServerConfig, registry: ProviderRegistry, store: AgentStore) {
    super();
    this.config = config;
    this.registry = registry;
    this.store = store;
    this.extensionsRoot = path.resolve(here, "../../../pi-extensions");
  }

  cliPath(): string {
    // dedicated RPC entrypoint (adds --mode rpc itself; extra argv passes
    // through). The export map is import-condition-only, so locate it by
    // walking up from this module to node_modules.
    const rel = path.join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "rpc-entry.js");
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, rel);
      if (existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
    throw new Error("cannot locate pi-coding-agent rpc-entry (looked for " + rel + " upward)");
  }

  listSummaries(): AgentRuntimeSummary[] {
    return this.store.list().map((r) => this.running.get(r.id)?.summary() ?? { id: r.id, status: r.status });
  }

  getRunning(agentId: string): RpcAgent | undefined {
    return this.running.get(agentId);
  }

  runningCount(): number {
    return this.running.size;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  async createAgent(input: Parameters<AgentStore["create"]>[0]): Promise<AgentRecord> {
    const record = this.store.create(input);
    await scaffoldAgent(this.config.stateDir, record, this.registry, this.extensionsRoot);
    return record;
  }

  async patchAgent(id: string, patch: PatchAgentInput): Promise<AgentRecord> {
    const record = this.store.patch(id, patch);
    await scaffoldAgent(this.config.stateDir, record, this.registry, this.extensionsRoot);
    // config-affecting patches require a restart of a running agent
    if (this.running.has(id)) {
      log.info(`agent ${id} running during patch; scheduling restart`);
      await this.restart(id);
    }
    return record;
  }

  async deleteAgent(id: string, purge: boolean): Promise<void> {
    await this.stop(id);
    const record = this.store.delete(id);
    if (!record) throw new Error(`no such agent: ${id}`);
    if (purge) {
      const { rm } = await import("node:fs/promises");
      await rm(dirsFor(this.config.stateDir, record).root, { recursive: true, force: true });
    }
  }

  async start(id: string): Promise<AgentRuntimeSummary> {
    const record = this.store.get(id);
    if (!record) throw new Error(`no such agent: ${id}`);
    if (this.running.has(id)) return this.running.get(id)!.summary();

    const runningCount = this.running.size;
    if (runningCount >= this.config.maxAgents) {
      throw new Error(`concurrency cap reached (${this.config.maxAgents}); stop an agent first`);
    }

    this.store.setStatus(id, "starting");
    const dirs = await scaffoldAgent(this.config.stateDir, record, this.registry, this.extensionsRoot);

    const args: string[] = [
      // rpc-entry implies --mode rpc
      "--no-extensions",
      "--no-context-files",
      "--session-dir", dirs.sessions,
      "-e", path.join(this.extensionsRoot, "provider-bridge", "index.js"),
    ];
    if (record.sessionFile) {
      args.push("--session", record.sessionFile);
    }
    if (record.enabledModels?.length) {
      args.push("--models", record.enabledModels.join(","));
    }

    const proc = new PiProcess({
      cliPath: this.cliPath(),
      args,
      cwd: dirs.workspace,
      env: piEnvFor(dirs, this.registry),
    });
    const agent = new RpcAgent(id, proc);
    this.running.set(id, agent);

    agent.on("event", (event) => this.emit("agentEvent", { agentId: id, event }));
    agent.on("uiRequest", (request) => this.emit("agentUiRequest", { agentId: id, request }));
    agent.on("state", (state) => this.emit("agentState", state));

    proc.on("exit", (info) => this.onExit(id, info));

    try {
      // readiness probe: first successful response means RPC is up and
      // extensions (incl. provider-bridge) finished loading
      const state = await proc.send("get_state", {}, 30_000);
      if (!state.success) throw new Error(`rpc not ready: ${state.error ?? "get_state failed"}`);
      const data = state.data as { sessionFile?: string } | undefined;
      if (data?.sessionFile) this.store.setSessionFile(id, data.sessionFile);
      this.store.setStatus(id, "running");
      log.info(`agent ${record.name} (${id}) running pid=${proc.pid}`);
      return agent.summary();
    } catch (err) {
      this.running.delete(id);
      this.store.setStatus(id, "error");
      agent.noteError(err instanceof Error ? err.message : String(err));
      proc.kill("SIGKILL");
      throw err;
    }
  }

  async stop(id: string): Promise<void> {
    const agent = this.running.get(id);
    if (!agent) {
      this.store.setStatus(id, "stopped");
      return;
    }
    try {
      await agent.waitIdle().catch(() => {});
    } finally {
      this.running.delete(id);
      agent.kill("SIGTERM");
      this.store.setStatus(id, "stopped");
      log.info(`agent ${id} stopped`);
    }
  }

  async restart(id: string): Promise<AgentRuntimeSummary> {
    await this.stop(id);
    return this.start(id);
  }

  private onExit(id: string, info: { code: number | null; signal: NodeJS.Signals | null; crashed: boolean }): void {
    const agent = this.running.get(id);
    this.running.delete(id);
    if (info.signal === "SIGTERM" || info.signal === "SIGKILL") {
      // deliberate stop
      this.store.setStatus(id, "stopped");
      return;
    }
    log.warn(`agent ${id} crashed (code=${info.code} signal=${info.signal})`);
    this.store.setStatus(id, "error");
    if (agent) {
      agent.noteError(`exit code=${info.code} signal=${info.signal}\n${agent.lastStderr()}`.trim());
    }
    // bounded auto-restart (budget tracked per agent id in the manager)
    const attempt = (this.restartBudget.get(id) ?? 0) + 1;
    this.restartBudget.set(id, attempt);
    if (attempt <= MAX_RESTARTS) {
      const delay = 2_000 * 2 ** (attempt - 1);
      log.info(`restarting agent ${id} in ${delay}ms (attempt ${attempt}/${MAX_RESTARTS})`);
      setTimeout(() => {
        this.start(id)
          .then(() => this.restartBudget.set(id, 0))
          .catch((err) => log.error(`restart failed for ${id}`, err));
      }, delay);
    } else {
      log.error(`agent ${id} exceeded restart budget; leaving stopped`);
    }
  }
}
