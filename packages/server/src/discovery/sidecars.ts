import { scoped } from "../util/log.js";
import type { McpRegistryStore } from "../mcp/registry-store.js";

const log = scoped("discovery");

const MCP_ENABLE_LABEL = "gwarestrin.mcp.enable";
const NET_LABEL = "gwarestrin.net";
const POLL_MS = 30_000;

interface ContainerSummary {
  Id?: string;
  Names?: string[];
  Labels?: Record<string, string>;
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

/**
 * Labeled sidecar auto-discovery.
 *
 * Any compose service labeled `gwarestrin.mcp.enable=true` is registered in
 * the MCP registry automatically (registry key = `gwarestrin.mcp.name` label
 * or the container name; url/port/path/auth via labels). `gwarestrin.net=true`
 * marks non-MCP sidecars for documentation. Entries whose container
 * disappears are kept (they degrade naturally via status probes); entries
 * whose url does not point at the container name are never touched.
 */
export function startSidecarDiscovery(proxyUrl: string | undefined, registry: McpRegistryStore): void {
  if (!proxyUrl) {
    log.info("DOCKER_PROXY_URL not set; sidecar discovery disabled");
    return;
  }
  const poll = async () => {
    try {
      const res = await fetch(`${proxyUrl.replace(/\/+$/, "")}/containers/json?all=1`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as ContainerSummary[];
      await syncSidecars(list, registry);
    } catch (err) {
      log.warn(`discovery poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  void poll();
  const t = setInterval(() => void poll(), POLL_MS);
  t.unref?.();
}

export async function syncSidecars(containers: ContainerSummary[], registry: McpRegistryStore): Promise<void> {
  for (const c of containers) {
    const labels = c.Labels ?? {};
    const mcp = labels[MCP_ENABLE_LABEL] === "true";
    const net = labels[NET_LABEL] === "true";
    if (!mcp && !net) continue;

    // compose containers: prefer the service label over the runtime name
    // (which carries project prefixes and scale suffixes)
    const rawName = (c.Names?.[0] ?? "").replace(/^\//, "");
    const name = labels["com.docker.compose.service"] ?? rawName.replace(/-\d+$/, "");
    if (!name) continue;
    const ip = Object.values(c.NetworkSettings?.Networks ?? {})
      .map((n) => n.IPAddress)
      .find(Boolean);
    log.debug(`sidecar ${name} (${mcp ? "mcp" : "net"}) at ${ip ?? "?"}`);

    if (!mcp) continue;
    const def = sidecarDefFromLabels(name, labels);
    if (!def) continue;

    // adopt a hand-registered entry that already points at this service
    let key = def.key;
    const adopted = Object.entries(registry.list()).find(([, d]) => d.url?.includes(`//${name}:`));
    if (adopted) key = adopted[0];
    // never clobber an entry under the target key that resolves elsewhere
    const existing = registry.get(key);
    if (existing && !existing.url?.includes(`//${name}:`)) {
      log.debug(`skipping ${key}: entry resolves elsewhere (${existing.url})`);
      continue;
    }
    await registry.put(key, def);
    log.info(`registered ${key} -> ${def.url} (managed)`);
  }
}

/** build an MCP registry def from container labels; null when misconfigured */
export function sidecarDefFromLabels(
  containerName: string,
  labels: Record<string, string>,
): { key: string; url: string; description?: string; auth?: "bearer"; bearerTokenEnv?: string } | null {
  const port = labels["gwarestrin.mcp.port"] ?? "8000";
  const path = labels["gwarestrin.mcp.path"] ?? "/mcp";
  const key = labels["gwarestrin.mcp.name"] ?? containerName;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key)) return null;
  const def: { key: string; url: string; description?: string; auth?: "bearer"; bearerTokenEnv?: string } = {
    key,
    url: `http://${containerName}:${port}${path.startsWith("/") ? path : "/" + path}`,
    description: `${labels["gwarestrin.mcp.description"] ?? "auto-discovered sidecar"} (managed)`,
  };
  if (labels["gwarestrin.mcp.auth"] === "bearer") {
    const envName = labels["gwarestrin.mcp.bearer-env"];
    if (!envName) return null;
    def.auth = "bearer";
    def.bearerTokenEnv = envName;
  }
  return def;
}
