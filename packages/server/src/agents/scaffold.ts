import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRecord } from "@gwarestrin/shared";
import { mcpSubset } from "@gwarestrin/shared";
import type { McpRegistryStore } from "../mcp/registry-store.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { buildGeneratedProviders, generatedProvidersPath, writeGeneratedProviders } from "../providers/generate.js";
import { scoped } from "../util/log.js";
import { agentDir } from "./store.js";

const log = scoped("scaffold");

export interface AgentDirs {
  root: string;
  workspace: string;
  home: string;
  sessions: string;
}

export function dirsFor(stateDir: string, agent: AgentRecord): AgentDirs {
  const root = agentDir(stateDir, agent.id);
  return {
    root,
    workspace: path.join(root, "workspace"),
    home: path.join(root, "home"),
    sessions: path.join(root, "sessions"),
  };
}

/**
 * Create/refresh the per-agent on-disk layout:
 *   workspace/          <- pi cwd + VM /workspace mount + .mcp.json (M5)
 *   home/               <- $PI_CODING_AGENT_DIR (settings.json, providers.gen.json)
 *   sessions/           <- pi --session-dir
 */
export async function scaffoldAgent(
  stateDir: string,
  agent: AgentRecord,
  registry: ProviderRegistry,
  extensionsRoot: string,
  mcpRegistry?: McpRegistryStore,
): Promise<AgentDirs> {
  const dirs = dirsFor(stateDir, agent);
  await Promise.all([
    mkdir(dirs.workspace, { recursive: true }),
    mkdir(dirs.home, { recursive: true }),
    mkdir(dirs.sessions, { recursive: true }),
  ]);

  // pi settings: no ambient discovery; defaults from agent record
  const settings: Record<string, unknown> = {
    defaultProjectTrust: "never",
    quietStartup: true,
    enableInstallTelemetry: false,
  };
  if (agent.model) {
    settings.defaultProvider = agent.model.provider;
    settings.defaultModel = agent.model.modelId;
  } else {
    const gen = buildGeneratedProviders(registry, agent.providers);
    if (gen.defaultProvider) settings.defaultProvider = gen.defaultProvider;
    if (gen.defaultModel) settings.defaultModel = gen.defaultModel;
  }
  if (agent.enabledModels?.length) settings.enabledModels = agent.enabledModels;
  await writeFile(path.join(dirs.home, "settings.json"), JSON.stringify(settings, null, 2) + "\n", "utf8");

  // keyless provider catalogue for provider-bridge
  const gen = buildGeneratedProviders(registry, agent.providers);
  await writeGeneratedProviders(generatedProvidersPath(dirs.home), gen);

  // gondolin-vm extension config (no secret values — env-resolved)
  const agentConfig = {
    workspaceDir: dirs.workspace,
    gondolin: {
      ...(agent.gondolin.enabled !== undefined ? { enabled: agent.gondolin.enabled } : {}),
      ...(agent.gondolin.image !== undefined ? { image: agent.gondolin.image } : {}),
      ...(agent.gondolin.cpus !== undefined ? { cpus: agent.gondolin.cpus } : {}),
      ...(agent.gondolin.memoryMB !== undefined ? { memoryMB: agent.gondolin.memoryMB } : {}),
      allowedHosts: agent.gondolin.allowedHosts,
      ...(agent.gondolin.allowedInternalHosts !== undefined ? { allowedInternalHosts: agent.gondolin.allowedInternalHosts } : {}),
      secrets: agent.gondolin.secrets,
    },
  };
  await writeFile(agentConfigPath(dirs.home), JSON.stringify(agentConfig, null, 2) + "\n", "utf8");

  // MCP subset for pi-mcp-adapter (reads .mcp.json from cwd = workspace).
  // hostConfigDiscovery defaults to "off" in the adapter — no ambient config.
  if (mcpRegistry) {
    const subset = mcpSubset(mcpRegistry.list(), agent.mcpServers);
    await writeFile(
      path.join(dirs.workspace, ".mcp.json"),
      JSON.stringify({ mcpServers: subset }, null, 2) + "\n",
      "utf8",
    );
  }

  // extensions dir marker (loaded explicitly via -e by the manager)
  const extMarker = path.join(extensionsRoot, "README");
  await mkdir(path.dirname(extMarker), { recursive: true }).catch(() => {});

  return dirs;
}

export function agentConfigPath(agentHomeDir: string): string {
  return path.join(agentHomeDir, "agent-config.json");
}

/** Build the env for the pi child process. Secrets only via env vars. */
export function piEnvFor(
  dirs: AgentDirs,
  registry: ProviderRegistry,
  agent: AgentRecord,
): Record<string, string> {
  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: dirs.home,
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    GWARESTRIN_PROVIDERS_GEN: generatedProvidersPath(dirs.home),
    GWARESTRIN_AGENT_CONFIG: agentConfigPath(dirs.home),
  };
  const gen = buildGeneratedProviders(registry);
  for (const id of Object.keys(gen.providers)) {
    const key = registry.resolveKey(id);
    if (key) env[`GWARESTRIN_KEY_${id.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`] = key;
  }
  // gondolin secret values: extension resolves valueEnv from here
  for (const [name, def] of Object.entries(agent.gondolin.secrets)) {
    const value = process.env[def.valueEnv];
    if (value) env[def.valueEnv] = value;
    else log.warn(`secret ${name}: env ${def.valueEnv} not set; placeholder will fail at egress`);
  }
  return env;
}
