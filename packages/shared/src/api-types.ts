export type AgentStatus = "stopped" | "starting" | "running" | "error";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface GondolinConfig {
  image?: string | undefined;
  cpus?: number | undefined;
  memoryMB?: number | undefined;
  allowedHosts: string[];
  allowedInternalHosts?: string[] | undefined;
  secrets: Record<string, { hosts: string[]; valueEnv: string }>;
}

export interface AgentRecord {
  id: string;
  name: string;
  createdAt: string;
  /** runtime status, recomputed on boot (not persisted as source of truth) */
  status: AgentStatus;
  /** selected model; provider is a registry id (e.g. "zai-glm", "openai") */
  model: { provider: string; modelId: string } | null;
  /** optional allowlist of registry provider ids visible to this agent */
  providers?: string[] | undefined;
  /** optional model patterns within allowed providers */
  enabledModels?: string[] | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  mcpServers: string[];
  gondolin: GondolinConfig;
  sessionFile?: string | null | undefined;
}

export interface AgentRuntimeSummary {
  id: string;
  status: AgentStatus;
  pid?: number | undefined;
  error?: string | undefined;
  vm?: "booting" | "running" | "stopped" | "error" | undefined;
  restarts?: number | undefined;
}

export interface CreateAgentInput {
  name: string;
  model?: { provider: string; modelId: string } | null;
  providers?: string[] | undefined;
  enabledModels?: string[] | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  mcpServers?: string[];
  gondolin?: Partial<GondolinConfig>;
}

export interface PatchAgentInput extends Partial<Omit<CreateAgentInput, "name">> {
  name?: string;
}
