import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProfileRecord, UpsertProfileInput } from "@gwarestrin/shared";
import { scoped } from "../util/log.js";

const log = scoped("profiles");

export const DEFAULT_PROFILE_ID = "default";

function defaultProfile(): ProfileRecord {
  return {
    id: DEFAULT_PROFILE_ID,
    name: "Default",
    description: "Bare agents: every instance MCP server, no context generation step.",
    defaults: {},
    mcpServers: "all",
    sharedTools: true,
  };
}

/**
 * Instance-level agent profiles, persisted to <stateDir>/profiles.json.
 * Host/JSON-authored (seeded with the default profile on first boot) and
 * editable through the profiles REST surface; the file is the source of
 * truth, so hand edits are picked up on reload.
 */
export class ProfileStore {
  private file: string;
  private profiles = new Map<string, ProfileRecord>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "profiles.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as { profiles?: ProfileRecord[] };
      for (const p of parsed.profiles ?? []) this.profiles.set(p.id, p);
      log.info(`loaded ${this.profiles.size} profile(s)`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      log.info("no profiles.json yet; seeding default profile");
    }
    if (!this.profiles.has(DEFAULT_PROFILE_ID)) {
      const def = defaultProfile();
      this.profiles.set(def.id, def);
      await this.persist();
    }
  }

  list(): ProfileRecord[] {
    return [...this.profiles.values()];
  }

  get(id: string | undefined | null): ProfileRecord | undefined {
    return this.profiles.get(id ?? DEFAULT_PROFILE_ID);
  }

  /** profile for an agent create request, guaranteed to resolve — even
   * before load() (an unloaded store behaves as if only the default
   * profile exists, so the manager stays functional in tests/boot) */
  resolve(id: string | undefined | null): ProfileRecord {
    return this.get(id) ?? this.profiles.get(DEFAULT_PROFILE_ID) ?? defaultProfile();
  }

  /** await pending persistence (tests) */
  flush(): Promise<void> {
    return this.writeChain;
  }

  upsert(id: string | undefined, input: UpsertProfileInput): ProfileRecord {
    const recordId = id ?? randomUUID();
    const existing = this.profiles.get(recordId);
    const record: ProfileRecord = {
      id: recordId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : existing?.description ? { description: existing.description } : {}),
      defaults: input.defaults ?? existing?.defaults ?? {},
      mcpServers: input.mcpServers,
      ...(input.contextEngine !== undefined ? { contextEngine: input.contextEngine } : existing?.contextEngine ? { contextEngine: existing.contextEngine } : {}),
      ...(input.sharedTools !== undefined ? { sharedTools: input.sharedTools } : existing?.sharedTools !== undefined ? { sharedTools: existing.sharedTools } : {}),
      ...(input.positions !== undefined
        ? input.positions.length > 0
          ? { positions: [...new Set(input.positions)] }
          : {}
        : existing?.positions
          ? { positions: existing.positions }
          : {}),
    };
    this.profiles.set(recordId, record);
    void this.persist();
    return record;
  }

  remove(id: string): ProfileRecord | undefined {
    if (id === DEFAULT_PROFILE_ID) throw new Error("the default profile cannot be deleted");
    const record = this.profiles.get(id);
    if (!record) return undefined;
    this.profiles.delete(id);
    void this.persist();
    return record;
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const dir = path.dirname(this.file);
      await mkdir(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      const payload = JSON.stringify({ profiles: this.list() }, null, 2) + "\n";
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, this.file);
    }).catch((err) => log.error("persist failed", err));
    return this.writeChain;
  }
}
