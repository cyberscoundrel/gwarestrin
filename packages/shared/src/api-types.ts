export type AgentStatus = "stopped" | "starting" | "running" | "error";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface GondolinConfig {
  /** false = dev mode: tools run on the host, no sandbox (default true) */
  enabled?: boolean | undefined;
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
  /** profile this agent was created under (resolution fallback: "default") */
  profileId?: string | undefined;
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
  /** outcome of the profile context engine at creation time */
  contextStatus?: "skipped" | "ok" | "failed" | undefined;
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
  /** profile to create under (default: "default"); profile fills unset fields */
  profileId?: string | undefined;
  model?: { provider: string; modelId: string } | null;
  providers?: string[] | undefined;
  enabledModels?: string[] | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  mcpServers?: string[];
  gondolin?: Partial<GondolinConfig>;
  /**
   * chat-first creation: run pre-session graph analysis on this prompt,
   * inject the result as standing context, start the agent, and let the UI
   * send it as the agent's first message
   */
  firstPrompt?: string | undefined;
}

export interface PatchAgentInput extends Partial<Omit<CreateAgentInput, "name">> {
  name?: string;
}

// ---------- agent profiles ----------

export type ProfileTier = "local" | "cloud";

export interface ProfileDefaults {
  /** model tier preference (used by the UI to preselect provider/model) */
  tier?: ProfileTier | undefined;
  /** concrete model; null means "server default at create time" */
  model?: { provider: string; modelId: string } | null | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
  /** prefix for agent names created under this profile (user still completes) */
  namePrefix?: string | undefined;
}

export interface ProfileContextEngine {
  /** "graph-rag": LLM tool-loop over the knowledge-graph MCP; "lexical": deterministic graph summary */
  type: "graph-rag" | "lexical";
  /** profile-authored analysis prompt; runs even without a user firstPrompt */
  prompt?: string | undefined;
  /** fold the user's firstPrompt into the analysis input (default: true when present) */
  includeFirstPrompt?: boolean | undefined;
  maxRounds?: number | undefined;
  timeoutMs?: number | undefined;
  /** context block character budget written to context-injection.md */
  maxChars?: number | undefined;
}

export interface ProfileRecord {
  id: string;
  name: string;
  description?: string | undefined;
  defaults: ProfileDefaults;
  /** per-agent MCP allowlist for agents created under this profile */
  mcpServers: string[] | "all";
  /** omitted = no context generation step at agent creation */
  contextEngine?: ProfileContextEngine | undefined;
  /** mount the instance-shared /tools directory into agent VMs (default true) */
  sharedTools?: boolean | undefined;
  /**
   * knowledge-graph positions agents under this profile work at (position
   * ids). Empty/omitted = where the instance's user stands. Positions outside
   * the user's reach are ignored by the graph (see docs/DATA-SCOPING.md).
   */
  positions?: string[] | undefined;
}

export interface UpsertProfileInput {
  name: string;
  description?: string | undefined;
  defaults?: ProfileDefaults | undefined;
  mcpServers: string[] | "all";
  contextEngine?: ProfileContextEngine | undefined;
  sharedTools?: boolean | undefined;
  positions?: string[] | undefined;
}
