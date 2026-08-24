import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRecord, CreateAgentInput, PatchAgentInput } from "@gwarestrin/shared";
import { scoped } from "../util/log.js";

const log = scoped("store");

export function agentDir(stateDir: string, id: string): string {
  return path.join(stateDir, "agents", id);
}

export class AgentStore {
  private file: string;
  private agents = new Map<string, AgentRecord>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "agents.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as { agents?: AgentRecord[] };
      for (const a of parsed.agents ?? []) {
        // persisted runtime status is never trusted; recompute via manager
        this.agents.set(a.id, { ...a, status: "stopped" });
      }
      log.info(`loaded ${this.agents.size} agent records`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      log.info("no agents.json yet; starting empty");
    }
  }

  list(): AgentRecord[] {
    return [...this.agents.values()];
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  getByName(name: string): AgentRecord | undefined {
    return this.list().find((a) => a.name === name);
  }

  create(input: CreateAgentInput): AgentRecord {
    const name = input.name?.trim();
    if (!name) throw new Error("name required");
    if (this.getByName(name)) throw new Error(`agent name already in use: ${name}`);
    const record: AgentRecord = {
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      status: "stopped",
      model: input.model ?? null,
      providers: input.providers,
      enabledModels: input.enabledModels,
      thinkingLevel: input.thinkingLevel,
      mcpServers: input.mcpServers ?? [],
      gondolin: {
        allowedHosts: input.gondolin?.allowedHosts ?? [],
        ...(input.gondolin?.allowedInternalHosts !== undefined ? { allowedInternalHosts: input.gondolin.allowedInternalHosts } : {}),
        secrets: input.gondolin?.secrets ?? {},
        ...(input.gondolin?.image !== undefined ? { image: input.gondolin.image } : {}),
        ...(input.gondolin?.cpus !== undefined ? { cpus: input.gondolin.cpus } : {}),
        ...(input.gondolin?.memoryMB !== undefined ? { memoryMB: input.gondolin.memoryMB } : {}),
      },
    };
    this.agents.set(record.id, record);
    void this.persist();
    return record;
  }

  patch(id: string, patch: PatchAgentInput): AgentRecord {
    const record = this.agents.get(id);
    if (!record) throw new Error(`no such agent: ${id}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("name cannot be empty");
      const clash = this.getByName(name);
      if (clash && clash.id !== id) throw new Error(`agent name already in use: ${name}`);
      record.name = name;
    }
    if (patch.model !== undefined) record.model = patch.model;
    if (patch.providers !== undefined) record.providers = patch.providers;
    if (patch.enabledModels !== undefined) record.enabledModels = patch.enabledModels;
    if (patch.thinkingLevel !== undefined) record.thinkingLevel = patch.thinkingLevel;
    if (patch.mcpServers !== undefined) record.mcpServers = patch.mcpServers;
    if (patch.gondolin !== undefined) {
      const g = patch.gondolin;
      record.gondolin = {
        ...record.gondolin,
        ...g,
        secrets: g.secrets ?? record.gondolin.secrets,
        allowedHosts: g.allowedHosts ?? record.gondolin.allowedHosts,
      };
    }
    void this.persist();
    return record;
  }

  setStatus(id: string, status: AgentRecord["status"]): void {
    const record = this.agents.get(id);
    if (!record) return;
    record.status = status;
  }

  setSessionFile(id: string, sessionFile: string | null): void {
    const record = this.agents.get(id);
    if (!record) return;
    record.sessionFile = sessionFile;
    void this.persist();
  }

  delete(id: string): AgentRecord | undefined {
    const record = this.agents.get(id);
    if (!record) return undefined;
    this.agents.delete(id);
    void this.persist();
    return record;
  }

  /** serialized atomic write (tmp + rename), chains to preserve order */
  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const dir = path.dirname(this.file);
      await mkdir(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      const payload = JSON.stringify({ agents: this.list() }, null, 2) + "\n";
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, this.file);
    }).catch((err) => log.error("persist failed", err));
    return this.writeChain;
  }
}
