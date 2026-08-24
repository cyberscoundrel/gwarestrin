import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpRegistry, McpServerDef } from "@gwarestrin/shared";
import { validateMcpServerDef } from "@gwarestrin/shared";
import { scoped } from "../util/log.js";

const log = scoped("mcp-registry");

/**
 * Persistent MCP server registry (<stateDir>/mcp-registry.json).
 * Shape: Record<name, McpServerDef> — values are exact pi-mcp-adapter
 * mcpServers entries (+ gwarestrin `description` metadata).
 */
export class McpRegistryStore {
  private file: string;
  private servers: McpRegistry = {};
  private writeChain: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "mcp-registry.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as { servers?: McpRegistry } | McpRegistry;
      // tolerate both {servers: {...}} and bare map
      this.servers =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? ((parsed as { servers?: McpRegistry }).servers ?? (parsed as McpRegistry))
          : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.error(`failed to load ${this.file}; starting empty`, err);
      }
      this.servers = {};
    }
    log.info(`mcp registry: ${Object.keys(this.servers).length} server(s)`);
  }

  list(): McpRegistry {
    return { ...this.servers };
  }

  get(name: string): McpServerDef | undefined {
    return this.servers[name];
  }

  /** upsert; throws on invalid def */
  async put(name: string, def: McpServerDef): Promise<void> {
    const err = validateMcpServerDef(def);
    if (err) throw new Error(`invalid server "${name}": ${err}`);
    this.servers = { ...this.servers, [name]: def };
    await this.persist();
  }

  /** returns false when the name did not exist */
  async remove(name: string): Promise<boolean> {
    if (!(name in this.servers)) return false;
    const next = { ...this.servers };
    delete next[name];
    this.servers = next;
    await this.persist();
    return true;
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ servers: this.servers }, null, 2) + "\n", "utf8");
      await rename(tmp, this.file);
    }).catch((err) => log.error("persist failed", err));
    return this.writeChain;
  }
}
