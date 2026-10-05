/**
 * Builders for the OpenShell objects an agent sandbox needs:
 *  - provider profiles + instances that hold real credentials (model API keys,
 *    MCP bearer tokens) and bind each to the endpoint it belongs to; the
 *    sandbox only ever sees placeholder env values
 *  - the sandbox policy: filesystem baseline plus network rules for the
 *    agent's plain (non-credentialed) destinations
 *
 * Pure functions; applying them to a gateway lives in openshell.ts.
 */
import { isIP } from "node:net";
import {
  NetworkAccessPreset,
  NetworkEnforcementMode,
  ProviderProfileCategory,
  type ProviderProfileSchema,
  type SandboxPolicySchema,
} from "@nvidia/openshell-sdk/raw";
import type { MessageInitShape } from "@bufbuild/protobuf";

export type ProfileInit = MessageInitShape<typeof ProviderProfileSchema>;
export type PolicyInit = MessageInitShape<typeof SandboxPolicySchema>;
type EndpointInit = NonNullable<ProfileInit["endpoints"]>[number];

/** The node interpreter in the agent image: pi, its extensions and MCP adapter. */
export const AGENT_NODE = "/usr/local/bin/node";
/** Binaries an agent's own tool use may run (bash tool: curl, git, python...). */
export const AGENT_TOOL_BINARIES = ["/usr/bin/*", "/usr/local/bin/*", "/bin/*"];

/** Mirrors OpenShell's restrictive default, plus /usr/local for the image's node. */
const FILESYSTEM_BASELINE = {
  includeWorkdir: true,
  readOnly: ["/bin", "/usr", "/lib", "/proc", "/dev/urandom", "/etc", "/var/log"],
  readWrite: ["/tmp", "/dev/null"],
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function profileIdFor(kind: "llm" | "mcp", name: string): string {
  return `gw-${kind}-${slug(name)}`;
}

/** Provider instance name; scoped per gwarestrin instance so tenants never share one. */
export function providerNameFor(instance: string, kind: "llm" | "mcp", name: string): string {
  return `gw-${slug(instance)}-${kind}-${slug(name)}`;
}

function isPrivateIp(host: string): boolean {
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return v === 6 && /^(fc|fd|fe80|::1)/i.test(host);
}

/**
 * Endpoint for a base URL. Path is scoped to the URL's path prefix; private
 * IP literals get an exact allowed_ips entry (OpenShell denies private
 * destinations by default).
 */
export function endpointFromUrl(rawUrl: string, access: NetworkAccessPreset = NetworkAccessPreset.READ_WRITE): EndpointInit {
  const u = new URL(rawUrl);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const prefix = u.pathname.replace(/\/+$/, "");
  return {
    host,
    port,
    protocol: "rest",
    access,
    enforcement: NetworkEnforcementMode.ENFORCE,
    path: prefix ? `${prefix}/**` : "/**",
    ...(isPrivateIp(host) ? { allowedIps: [isIP(host) === 6 ? `${host}/128` : `${host}/32`] } : {}),
  };
}

/** How each pi provider API type authenticates. */
function credentialStyle(type: string): { authStyle: string; headerName: string } {
  switch (type) {
    case "anthropic-messages":
      return { authStyle: "header", headerName: "x-api-key" };
    case "google-generative-ai":
      return { authStyle: "header", headerName: "x-goog-api-key" };
    default:
      return { authStyle: "bearer", headerName: "authorization" };
  }
}

/** Profile binding one model provider's key (env `keyEnv`) to its base URL, for node only. */
export function inferenceProfile(provider: { id: string; type: string; baseUrl: string }, keyEnv: string): ProfileInit {
  return {
    id: profileIdFor("llm", provider.id),
    displayName: `gwarestrin LLM ${provider.id}`,
    description: `Model provider ${provider.id} (${provider.type})`,
    category: ProviderProfileCategory.INFERENCE,
    inferenceCapable: true,
    credentials: [{ name: "api_key", envVars: [keyEnv], required: true, ...credentialStyle(provider.type) }],
    endpoints: [endpointFromUrl(provider.baseUrl)],
    binaries: [{ path: AGENT_NODE }],
  };
}

/** Profile binding an MCP server's bearer token (env `tokenEnv`) to its URL, for node only. */
export function mcpProfile(server: { name: string; url: string }, tokenEnv: string): ProfileInit {
  return {
    id: profileIdFor("mcp", server.name),
    displayName: `gwarestrin MCP ${server.name}`,
    description: `MCP server ${server.name}`,
    category: ProviderProfileCategory.KNOWLEDGE,
    credentials: [{ name: "token", envVars: [tokenEnv], required: true, authStyle: "bearer", headerName: "authorization" }],
    endpoints: [endpointFromUrl(server.url)],
    binaries: [{ path: AGENT_NODE }],
  };
}

export interface PolicyInput {
  /** credential-free destinations pi itself calls (MCP servers, keyless model APIs); node only */
  openUrls?: string[];
  /** agent allowedHosts: hostnames reachable by the agent's tools over https */
  allowedHosts?: string[];
}

/**
 * Sandbox policy: filesystem baseline + rules for destinations that carry no
 * provider credential. Credentialed destinations come from attached provider
 * profiles, which OpenShell merges into the effective policy itself.
 */
export function sandboxPolicy(input: PolicyInput): PolicyInit {
  const networkPolicies: NonNullable<PolicyInit["networkPolicies"]> = {};
  [...new Set(input.openUrls ?? [])].forEach((url, i) => {
    networkPolicies[`gw_open_${i}`] = { name: `gw_open_${i}`, endpoints: [endpointFromUrl(url)], binaries: [{ path: AGENT_NODE }] };
  });
  const hosts = [...new Set(input.allowedHosts ?? [])].filter((h) => /^[a-z0-9.*-]+$/i.test(h));
  if (hosts.length) {
    networkPolicies.gw_allowed_hosts = {
      name: "gw_allowed_hosts",
      endpoints: hosts.map((host) => ({
        host,
        port: 443,
        protocol: "rest",
        access: NetworkAccessPreset.FULL,
        enforcement: NetworkEnforcementMode.ENFORCE,
      })),
      binaries: [AGENT_NODE, ...AGENT_TOOL_BINARIES].map((path) => ({ path })),
    };
  }
  return { version: 1, filesystem: FILESYSTEM_BASELINE, networkPolicies };
}
