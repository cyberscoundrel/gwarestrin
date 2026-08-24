export type AgentStatus = "stopped" | "starting" | "running" | "error";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface GondolinConfig {
  image?: string;
  cpus?: number;
  memoryMB?: number;
  allowedHosts: string[];
  allowedInternalHosts?: string[];
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
  providers?: string[];
  /** optional model patterns within allowed providers */
  enabledModels?: string[];
  thinkingLevel?: ThinkingLevel;
  mcpServers: string[];
  gondolin: GondolinConfig;
  sessionFile?: string | null;
}

export interface AgentRuntimeSummary {
  id: string;
  status: AgentStatus;
  pid?: number;
  error?: string;
  vm?: "booting" | "running" | "stopped" | "error";
  restarts?: number;
}

export interface CreateAgentInput {
  name: string;
  model?: { provider: string; modelId: string } | null;
  providers?: string[];
  enabledModels?: string[];
  thinkingLevel?: ThinkingLevel;
  mcpServers?: string[];
  gondolin?: Partial<GondolinConfig>;
}

export interface PatchAgentInput extends Partial<Omit<CreateAgentInput, "name">> {
  name?: string;
}
