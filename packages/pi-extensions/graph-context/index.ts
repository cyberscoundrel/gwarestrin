/**
 * graph-context: injects, at every turn start, the pre-session analysis block
 * (written by the server's analysis agent to <home>/context-injection.md) and
 * the workspace's standing instructions (<home>/standing-instructions.md, e.g.
 * how to share knowledge-graph entries). No-ops silently when absent.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const BLOCK_START = "--- RETRIEVED CONTEXT (knowledge graph; treat as ground truth, cite when relevant) ---";
const BLOCK_END = "--- END RETRIEVED CONTEXT ---";
const RULES_START = "--- WORKSPACE INSTRUCTIONS ---";
const RULES_END = "--- END WORKSPACE INSTRUCTIONS ---";

export default function graphContext(pi) {
  pi.on("before_agent_start", async (event) => {
    try {
      const configPath = process.env.GWARESTRIN_AGENT_CONFIG;
      if (!configPath) return;
      const home = path.dirname(configPath);
      const raw = await readFile(path.join(home, "context-injection.md"), "utf8").catch(() => null);
      const rules = await readFile(path.join(home, "standing-instructions.md"), "utf8").catch(() => null);
      let prefix = "";
      if (raw?.trim()) prefix += `${BLOCK_START}\n${raw.trim()}\n${BLOCK_END}\n\n`;
      if (rules?.trim()) prefix += `${RULES_START}\n${rules.trim()}\n${RULES_END}\n\n`;
      if (!prefix) return;
      return { systemPrompt: prefix + event.systemPrompt };
    } catch {
      /* never block a turn on injection */
    }
  });
}
