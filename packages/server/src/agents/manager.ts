import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRecord, AgentRuntimeSummary, CreateAgentInput, PatchAgentInput, ProfileRecord } from "@gwarestrin/shared";
import type { ServerConfig } from "../config.js";
import type { McpRegistryStore } from "../mcp/registry-store.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { buildGeneratedProviders } from "../providers/generate.js";
import { scoped } from "../util/log.js";
import { RpcAgent } from "./rpc-agent.js";
import { PiProcess } from "./pi-process.js";
import { dirsFor, piEnvFor, scaffoldAgent, secretForEnv } from "./scaffold.js";
import { getInstanceMetadata } from "../instance/metadata.js";
import { OpenShellAgentLauncher } from "../runtime/openshell-agent.js";
import { OpenShellProviders, OpenShellRuntime, connectOpenShell } from "../runtime/openshell.js";
import { openShellIdentity } from "../runtime/openshell-identity.js";
import { AgentStore } from "./store.js";
import { DEFAULT_PROFILE_ID, ProfileStore } from "./profiles.js";

const log = scoped("manager");
const here = path.dirname(fileURLToPath(import.meta.url));

const MAX_RESTARTS = 3;

/**
 * Locate packages/pi-extensions from either layout:
 *   dev/tsx:     packages/server/src/agents -> ../../../pi-extensions
 *   built dist:  packages/server/dist       -> ../../pi-extensions
 */
function resolveExtensionsRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../../pi-extensions", "../../../pi-extensions"]) {
    const candidate = path.resolve(here, rel);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("cannot locate pi-extensions directory from " + here);
}

export interface ManagerEvents {
  agentState: [state: AgentRuntimeSummary];
  agentEvent: [data: { agentId: string; event: Record<string, unknown> & { type: string } }];
  agentUiRequest: [data: { agentId: string; request: Record<string, unknown> & { type: string } }];
}

export class AgentManager extends EventEmitter<ManagerEvents> {
  readonly store: AgentStore;
  readonly profiles: ProfileStore;
  private config: ServerConfig;
  private registry: ProviderRegistry;
  private mcpRegistry: McpRegistryStore | undefined;
  private running = new Map<string, RpcAgent>();
  private restartBudget = new Map<string, number>();
  /** pending bounded auto-restart timers, cancelled by stop()/start() */
  private restartTimers = new Map<string, NodeJS.Timeout>();
  /**
   * agent instances we asked to stop. pi handles SIGTERM itself and exits
   * normally (code set, signal null), so the exit signal alone cannot tell a
   * requested stop from a crash. Tracked per instance (not per id) so the
   * late exit of an old process during restart() is attributed correctly.
   */
  private stopRequested = new WeakSet<RpcAgent>();
  /**
   * instances whose start() hasn't succeeded yet: start() owns their status,
   * so an exit (pi dying during startup, or the kill after a failed probe)
   * must not be handled as a crash and auto-restarted
   */
  private starting = new WeakSet<RpcAgent>();
  private extensionsRoot: string;
  private launcher: Promise<OpenShellAgentLauncher> | undefined;

  constructor(config: ServerConfig, registry: ProviderRegistry, store: AgentStore, mcpRegistry?: McpRegistryStore, profiles?: ProfileStore) {
    super();
    this.config = config;
    this.registry = registry;
    this.store = store;
    this.mcpRegistry = mcpRegistry;
    this.profiles = profiles ?? new ProfileStore(config.stateDir);
    this.extensionsRoot = resolveExtensionsRoot();
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

  /** absolute path to the installed pi-mcp-adapter package dir (pi manifest) */
  mcpAdapterPath(): string {
    if (process.env.GWARESTRIN_MCP_ADAPTER_PATH) return process.env.GWARESTRIN_MCP_ADAPTER_PATH;
    const rel = path.join("node_modules", "pi-mcp-adapter");
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, rel);
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
      dir = path.dirname(dir);
    }
    throw new Error("cannot locate pi-mcp-adapter package (looked for " + rel + " upward)");
  }

  /** Lazily connected OpenShell launcher (runtime=openshell only); retried after a failed connect. */
  private openShellLauncher(): Promise<OpenShellAgentLauncher> {
    const cfg = this.config.openshell;
    if (!cfg) throw new Error("openshell runtime selected but not configured");
    this.launcher ??= (async () => {
      const identity = openShellIdentity(cfg);
      const client = await connectOpenShell({
        gateway: cfg.gateway,
        caCertPath: path.join(cfg.pkiDir, "ca.crt"),
        clientCertPath: path.join(cfg.pkiDir, "client", "tls.crt"),
        clientKeyPath: path.join(cfg.pkiDir, "client", "tls.key"),
        image: cfg.image,
        ...(identity.tokenProvider ? { tokenProvider: identity.tokenProvider } : {}),
      });
      const { workspace } = identity;
      log.info(
        `openshell runtime: gateway ${cfg.gateway}, workspace ${workspace}, image ${cfg.image}, resolve ${cfg.resolve}, auth ${cfg.oidc ? "oidc" : "mtls"}`,
      );
      return new OpenShellAgentLauncher({
        runtime: new OpenShellRuntime(client, { workspace, image: cfg.image }),
        providers: new OpenShellProviders(client.raw, workspace),
        sandbox: client,
        instance: getInstanceMetadata()?.instance.name ?? process.env.GWARESTRIN_INSTANCE ?? "default",
        workspace,
        rewriteHosts: cfg.resolve !== "names",
      });
    })().catch((err) => {
      this.launcher = undefined;
      throw err;
    });
    return this.launcher;
  }

  get onOpenShell(): boolean {
    return this.config.runtime === "openshell";
  }

  /** the agent's workspace inside its OpenShell sandbox (runtime=openshell only) */
  async workspaceFs(id: string): Promise<import("../runtime/openshell-fs.js").SandboxFs> {
    return (await this.openShellLauncher()).workspaceFs(id);
  }

  /** default provider endpoint for server-side LLM calls (analysis agent) */
  defaultLlmEndpoint(): { url: string; key: string; model: string } | null {
    const gen = buildGeneratedProviders(this.registry);
    const id = gen.defaultProvider;
    const modelId = gen.defaultModel;
    if (!id || !modelId) return null;
    const def = gen.providers[id];
    if (!def) return null;
    return { url: `${def.baseUrl}/chat/completions`, key: this.registry.resolveKey(id) ?? "", model: modelId };
  }

  /** streamable-HTTP url of a registered MCP server (e.g. "neo4j") */
  mcpServerUrl(name: string): string | undefined {
    return this.mcpRegistry?.get(name)?.url;
  }

  /** default model for new agents (server default provider/model) */
  defaultModel(): { provider: string; modelId: string } | null {
    const gen = buildGeneratedProviders(this.registry);
    if (!gen.defaultProvider || !gen.defaultModel) return null;
    return { provider: gen.defaultProvider, modelId: gen.defaultModel };
  }

  /** registry server names — default MCP enablement for new agents */
  defaultMcpServers(): string[] {
    return this.mcpRegistry ? Object.keys(this.mcpRegistry.list()) : [];
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

  async createAgent(input: CreateAgentInput & { profileId?: string | undefined }): Promise<AgentRecord> {
    // resolution order: explicit create input > selected profile > default
    // profile > server defaults. The profile also fixes the MCP allowlist
    // unless the request overrides it explicitly.
    const profile = this.profiles.resolve(input.profileId);
    const defaults: CreateAgentInput = { ...input, profileId: profile.id };

    const profileModel = profile.defaults.model ?? undefined;
    if (!defaults.model && profileModel) defaults.model = profileModel;
    if (!defaults.model) {
      const m = this.defaultModel();
      if (m) defaults.model = m;
    }
    if (defaults.thinkingLevel === undefined && profile.defaults.thinkingLevel !== undefined) {
      defaults.thinkingLevel = profile.defaults.thinkingLevel;
    }
    if (defaults.providers === undefined && profile.defaults.tier) {
      // tier is a UI preselection hint; server-side it constrains nothing
    }
    if (!defaults.mcpServers?.length) {
      defaults.mcpServers = profile.mcpServers === "all" ? this.defaultMcpServers() : profile.mcpServers;
    }
    if (!defaults.mcpServers?.length) defaults.mcpServers = this.defaultMcpServers();

    const record = this.store.create(defaults);
    await scaffoldAgent(this.config.stateDir, record, this.registry, this.extensionsRoot, this.mcpRegistry, {
      sharedTools: profile.sharedTools === false ? { enabled: false, hostDir: "" } : { enabled: true, hostDir: this.sharedToolsDir() },
    });
    return record;
  }

  /** instance-wide directory shared by every agent VM at /tools */
  sharedToolsDir(): string {
    return path.join(this.config.stateDir, "shared-tools");
  }

  /** the profile an agent was created under (fallback: default) */
  profileFor(record: { profileId?: string | undefined }): ProfileRecord {
    return this.profiles.resolve(record.profileId);
  }

  async patchAgent(id: string, patch: PatchAgentInput): Promise<AgentRecord> {
    const record = this.store.patch(id, patch);
    await scaffoldAgent(this.config.stateDir, record, this.registry, this.extensionsRoot, this.mcpRegistry);
    // restart only when spawn-affecting config changes; model/thinkingLevel are
    // applied live via RPC and picked up from settings on the next start
    const needsRestart =
      patch.mcpServers !== undefined ||
      patch.gondolin !== undefined ||
      patch.providers !== undefined ||
      patch.enabledModels !== undefined;
    if (needsRestart && this.running.has(id)) {
      log.info(`agent ${id} running during config patch; scheduling restart`);
      await this.restart(id);
    }
    return record;
  }

  async deleteAgent(id: string, purge: boolean): Promise<void> {
    await this.stop(id);
    const record = this.store.delete(id);
    if (!record) throw new Error(`no such agent: ${id}`);
    if (purge) {
      if (this.onOpenShell) {
        // the sandbox holds the agent's workspace and sessions on this runtime
        await (await this.openShellLauncher()).deleteSandbox(id).catch((err) => log.error(`sandbox delete for ${id} failed`, err));
      }
      const { rm } = await import("node:fs/promises");
      await rm(dirsFor(this.config.stateDir, record).root, { recursive: true, force: true });
    }
  }

  async start(id: string): Promise<AgentRuntimeSummary> {
    const record = this.store.get(id);
    if (!record) throw new Error(`no such agent: ${id}`);
    if (this.running.has(id)) return this.running.get(id)!.summary();
    this.cancelPendingRestart(id);

    const runningCount = this.running.size;
    if (runningCount >= this.config.maxAgents) {
      throw new Error(`concurrency cap reached (${this.config.maxAgents}); stop an agent first`);
    }

    this.store.setStatus(id, "starting");
    const profile = this.profiles.resolve(record.profileId);
    const dirs = await scaffoldAgent(this.config.stateDir, record, this.registry, this.extensionsRoot, this.mcpRegistry, {
      sharedTools: profile.sharedTools === false ? { enabled: false, hostDir: "" } : { enabled: true, hostDir: this.sharedToolsDir() },
    });

    let proc: PiProcess;
    if (this.onOpenShell) {
      try {
        const launch = await (await this.openShellLauncher()).prepare({
          record,
          dirs,
          resolveKey: (providerId) => this.registry.resolveKey(providerId),
          resolveSecret: secretForEnv,
        });
        proc = new PiProcess({ transport: launch.transport });
      } catch (err) {
        this.store.setStatus(id, "error");
        throw err;
      }
    } else {
      proc = this.localProcess(record, dirs);
    }
    const agent = new RpcAgent(id, proc);
    this.running.set(id, agent);

    if (this.onOpenShell) agent.noteVm("running");
    agent.on("event", (event) => this.emit("agentEvent", { agentId: id, event }));
    agent.on("sessionFile", (file) => {
      this.store.setSessionFile(id, file);
      log.info(`agent ${record.name} session file -> ${path.basename(file)}`);
    });
    agent.on("uiRequest", (request) => {
      // gondolin-vm reports lifecycle via setStatus("gondolin", ...)
      if (request.method === "setStatus" && request.statusKey === "gondolin") {
        const text = String(request.statusText ?? "");
        const vmState = text === "running" ? "running" : text === "booting" ? "booting" : text === "error" ? "error" : "stopped";
        agent.noteVm(vmState);
      }
      this.emit("agentUiRequest", { agentId: id, request });
    });
    agent.on("state", (state) => this.emit("agentState", state));

    this.starting.add(agent);
    proc.on("exit", (info) => this.onExit(id, agent, info));

    try {
      // readiness probe: first successful response means RPC is up and
      // extensions (incl. provider-bridge) finished loading
      const state = await proc.send("get_state", {}, 30_000);
      if (!state.success) throw new Error(`rpc not ready: ${state.error ?? "get_state failed"}`);
      const data = state.data as { sessionFile?: string } | undefined;
      if (data?.sessionFile) this.store.setSessionFile(id, data.sessionFile);
      this.starting.delete(agent);
      this.store.setStatus(id, "running");
      log.info(`agent ${record.name} (${id}) running pid=${proc.pid}`);
      return agent.summary();
    } catch (err) {
      if (this.running.get(id) === agent) this.running.delete(id);
      this.store.setStatus(id, "error");
      const message = err instanceof Error ? err.message : String(err);
      const stderr = agent.lastStderr().trim();
      agent.noteError(`${message}\n${stderr}`.trim());
      proc.kill("SIGKILL");
      log.warn(`agent ${record.name} (${id}) failed to start: ${message}${stderr ? `\n${stderr}` : ""}`);
      // the last stderr line is usually the reason (e.g. an extension that failed to load)
      const reason = stderr.split("\n").filter(Boolean).pop();
      throw reason ? new Error(`${message}: ${reason.slice(0, 300)}`) : err;
    }
  }


  /** pi as a host child process (local runtime; tools optionally in gondolin) */
  private localProcess(record: AgentRecord, dirs: ReturnType<typeof dirsFor>): PiProcess {
    const args: string[] = [
      // rpc-entry implies --mode rpc
      "--no-extensions",
      "--no-context-files",
      "--session-dir", dirs.sessions,
      "-e", path.join(this.extensionsRoot, "provider-bridge", "index.js"),
      // injects <home>/context-injection.md when present (no-op otherwise)
      "-e", path.join(this.extensionsRoot, "graph-context", "index.ts"),
    ];
    if (record.gondolin.enabled !== false) {
      args.push("-e", path.join(this.extensionsRoot, "gondolin-vm", "index.ts"));
    }
    if (record.mcpServers.length > 0) {
      args.push("-e", this.mcpAdapterPath());
    }
    if (record.sessionFile) {
      args.push("--session", record.sessionFile);
    }
    if (record.enabledModels?.length) {
      args.push("--models", record.enabledModels.join(","));
    }

    return new PiProcess({
      cliPath: this.cliPath(),
      args,
      cwd: dirs.workspace,
      env: piEnvFor(dirs, this.registry, record),
    });
  }

  async stop(id: string): Promise<void> {
    // a requested stop also cancels a pending crash auto-restart
    this.cancelPendingRestart(id);
    this.restartBudget.delete(id);
    const agent = this.running.get(id);
    if (!agent) {
      this.store.setStatus(id, "stopped");
      return;
    }
    // mark before anything can make the process exit
    this.stopRequested.add(agent);
    try {
      await agent.waitIdle().catch(() => {});
    } finally {
      if (this.running.get(id) === agent) this.running.delete(id);
      agent.kill("SIGTERM");
      this.store.setStatus(id, "stopped");
      log.info(`agent ${id} stopped`);
    }
  }

  async restart(id: string): Promise<AgentRuntimeSummary> {
    await this.stop(id);
    return this.start(id);
  }

  private cancelPendingRestart(id: string): void {
    const timer = this.restartTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(id);
    }
  }

  private onExit(
    id: string,
    agent: RpcAgent,
    info: { code: number | null; signal: NodeJS.Signals | null; crashed: boolean },
  ): void {
    const current = this.running.get(id);
    if (current === agent) this.running.delete(id);

    if (this.starting.has(agent)) {
      // start() records status "error" and the reason; keep it
      this.starting.delete(agent);
      return;
    }
    if (current && current !== agent) {
      // stale exit of a replaced instance (e.g. old process exiting after
      // restart() already spawned a new one): don't touch the new one's state
      this.stopRequested.delete(agent);
      log.info(`agent ${id}: previous process exited (code=${info.code} signal=${info.signal})`);
      return;
    }
    if (this.stopRequested.has(agent) || info.signal === "SIGTERM" || info.signal === "SIGKILL") {
      // deliberate stop (signal check is a fallback for kills from outside stop())
      this.stopRequested.delete(agent);
      this.restartBudget.delete(id);
      this.store.setStatus(id, "stopped");
      return;
    }
    log.warn(`agent ${id} crashed (code=${info.code} signal=${info.signal})`);
    this.store.setStatus(id, "error");
    agent.noteError(`exit code=${info.code} signal=${info.signal}\n${agent.lastStderr()}`.trim());
    // bounded auto-restart (budget tracked per agent id in the manager)
    const attempt = (this.restartBudget.get(id) ?? 0) + 1;
    this.restartBudget.set(id, attempt);
    if (attempt <= MAX_RESTARTS) {
      const delay = 2_000 * 2 ** (attempt - 1);
      log.info(`restarting agent ${id} in ${delay}ms (attempt ${attempt}/${MAX_RESTARTS})`);
      this.cancelPendingRestart(id);
      const timer = setTimeout(() => {
        this.restartTimers.delete(id);
        this.start(id)
          .then(() => this.restartBudget.set(id, 0))
          .catch((err) => log.error(`restart failed for ${id}`, err));
      }, delay);
      this.restartTimers.set(id, timer);
    } else {
      log.error(`agent ${id} exceeded restart budget; leaving stopped`);
    }
  }
}
