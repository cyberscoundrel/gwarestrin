/**
 * graph-context: injects the pre-session analysis block (written by the
 * server's analysis agent to <home>/context-injection.md) into the system
 * prompt at every turn start. No-ops silently when the file is absent.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const BLOCK_START = "--- RETRIEVED CONTEXT (knowledge graph; treat as ground truth, cite when relevant) ---";
const BLOCK_END = "--- END RETRIEVED CONTEXT ---";

export default function graphContext(pi) {
  pi.on("before_agent_start", async (event) => {
    try {
      const configPath = process.env.GWARESTRIN_AGENT_CONFIG;
      if (!configPath) return;
      const home = path.dirname(configPath);
      const raw = await readFile(path.join(home, "context-injection.md"), "utf8").catch(() => null);
      if (!raw?.trim()) return;
      const block = `${BLOCK_START}\n${raw.trim()}\n${BLOCK_END}\n\n`;
      return { systemPrompt: block + event.systemPrompt };
    } catch {
      /* never block a turn on injection */
    }
  });
}
