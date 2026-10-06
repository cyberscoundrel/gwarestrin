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
  /** where agents run: host child process (default when unset) or OpenShell sandboxes */
  runtime?: "local" | "openshell" | undefined;
  openshell?: OpenShellRuntimeConfig | undefined;
}

export interface OpenShellRuntimeConfig {
  gateway: string;
  /** dir with ca.crt, client/tls.crt, client/tls.key (gateway mTLS bundle) */
  pkiDir: string;
  workspace: string;
  image: string;
  /**
   * How sandboxes reach compose services. "ips": the server rewrites service
   * names to the IPs it resolves (gateway outside compose, e.g. the Docker
   * driver's host-network supervisor). "names": keep names; the gateway runs
   * on the compose network and resolves them itself (VM driver in compose).
   */
  resolve: "ips" | "names";
  /**
   * OIDC client-credentials identity at the gateway (multi-tenant gateways).
   * The secret and the workspace come from instance metadata, see
   * runtime/openshell-identity.ts. Unset: mTLS-only (single-user gateway).
   */
  oidc?: { issuer: string; clientId: string } | undefined;
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
    ...runtimeConfig(),
  };
}

function runtimeConfig(): Pick<ServerConfig, "runtime" | "openshell"> {
  const runtime = process.env.GWARESTRIN_RUNTIME ?? "local";
  if (runtime === "local") return { runtime };
  if (runtime !== "openshell") throw new Error(`GWARESTRIN_RUNTIME must be local or openshell (got ${runtime})`);
  const image = process.env.GWARESTRIN_OPENSHELL_IMAGE;
  if (!image) throw new Error("GWARESTRIN_OPENSHELL_IMAGE is required when GWARESTRIN_RUNTIME=openshell");
  return {
    runtime,
    openshell: {
      gateway: process.env.GWARESTRIN_OPENSHELL_GATEWAY ?? "https://127.0.0.1:17670",
      pkiDir: process.env.GWARESTRIN_OPENSHELL_PKI ?? "/etc/gwarestrin/openshell-pki",
      workspace: process.env.GWARESTRIN_OPENSHELL_WORKSPACE ?? "default",
      image,
      resolve: resolveMode(process.env.GWARESTRIN_OPENSHELL_RESOLVE),
      ...(process.env.GWARESTRIN_OPENSHELL_OIDC_ISSUER
        ? {
            oidc: {
              issuer: process.env.GWARESTRIN_OPENSHELL_OIDC_ISSUER,
              clientId: process.env.GWARESTRIN_OPENSHELL_OIDC_CLIENT_ID ?? "openshell-gateway",
            },
          }
        : {}),
    },
  };
}

function resolveMode(raw: string | undefined): "ips" | "names" {
  if (raw === undefined || raw === "ips") return "ips";
  if (raw === "names") return "names";
  throw new Error(`GWARESTRIN_OPENSHELL_RESOLVE must be ips or names (got ${raw})`);
}
