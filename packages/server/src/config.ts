import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerConfig {
  port: number;
  host: string;
  /** persistent state root (agents.json, per-agent dirs) */
  stateDir: string;
  /** multi-provider config file (providers.json); optional */
  providersFile: string | undefined;
  maxAgents: number;
  /** directory containing built web bundle, if present */
  webDistDir: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): ServerConfig {
  return {
    port: intEnv("PORT", 3000),
    host: process.env.GWARESTRIN_HOST ?? "0.0.0.0",
    // always absolute: paths are handed to child processes whose cwd is the
    // agent workspace, not the server cwd
    stateDir: path.resolve(process.env.GWARESTRIN_STATE ?? path.join(here, "../../../state")),
    providersFile: process.env.GWARESTRIN_PROVIDERS_FILE ?? undefined,
    maxAgents: intEnv("GWARESTRIN_MAX_AGENTS", 4),
    webDistDir: process.env.GWARESTRIN_WEB_DIST ?? path.resolve(here, "../../web/dist"),
  };
}
