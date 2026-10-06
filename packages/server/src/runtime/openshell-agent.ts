/**
 * Prepares one agent start on the OpenShell runtime: pi runs inside the
 * agent's sandbox and its RPC stdio is relayed over an exec stream.
 *
 * The host-side scaffold still produces the per-agent files (settings,
 * providers.gen.json, .mcp.json, context injection); the launcher rewrites
 * them for the sandbox's network view, pushes them in, and turns every
 * credential into an OpenShell provider so the sandbox holds placeholders only.
 */
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import type { AgentRecord } from "@gwarestrin/shared";
import type { SandboxClient } from "@nvidia/openshell-sdk";
import type { PiTransportFactory } from "../agents/pi-transport.js";
import type { AgentDirs } from "../agents/scaffold.js";
import type { GeneratedProvidersFile } from "../providers/generate.js";
import { scoped } from "../util/log.js";
import { errorCode } from "@nvidia/openshell-sdk";
import { HttpPathError } from "../util/paths.js";
import { SandboxFs } from "./openshell-fs.js";
import { inferenceProfile, mcpProfile, providerNameFor, sandboxPolicy } from "./openshell-policy.js";
import { type OpenShellProviders, type OpenShellRuntime, sandboxNameFor } from "./openshell.js";

const log = scoped("openshell-agent");

/** Where pi and the gwarestrin extensions live inside the agent image. */
export interface GuestLayout {
  piCli: string;
  extensionsDir: string;
  mcpAdapterDir: string;
}

export const DEFAULT_GUEST_LAYOUT: GuestLayout = {
  piCli: "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js",
  extensionsDir: "/usr/local/lib/gwarestrin/pi-extensions",
  mcpAdapterDir: "/usr/local/lib/node_modules/pi-mcp-adapter",
};

export interface LaunchInputs {
  record: AgentRecord;
  /** host-side scaffold output for this agent */
  dirs: AgentDirs;
  /** real key for a model provider id (never written into the sandbox) */
  resolveKey: (providerId: string) => string | undefined;
  /** real value behind an MCP bearerTokenEnv name */
  resolveSecret: (envName: string) => string | undefined;
}

export interface Launch {
  sandbox: string;
  created: boolean;
  transport: PiTransportFactory;
  /** sandbox-side session dir; pi reports session files under it */
  sessionsDir: string;
}

export interface LauncherDeps {
  runtime: Pick<OpenShellRuntime, "ensureSandbox" | "transport" | "deleteSandbox">;
  providers: Pick<OpenShellProviders, "ensureProfile" | "ensureProvider">;
  sandbox: Pick<SandboxClient, "exec" | "execStream" | "setPolicy" | "attachProvider">;
  /** gwarestrin instance (tenant) name; scopes provider instances */
  instance: string;
  workspace?: string;
  guest?: GuestLayout;
  /** hostname -> IP as the server sees it; injectable for tests */
  resolveHost?: (host: string) => Promise<string | null>;
  /** false when the gateway resolves compose names itself (VM driver in compose) */
  rewriteHosts?: boolean;
}

async function defaultResolveHost(host: string): Promise<string | null> {
  try {
    return (await lookup(host, { family: 4 })).address;
  } catch {
    return null;
  }
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export class OpenShellAgentLauncher {
  private readonly guest: GuestLayout;
  private readonly resolveHost: (host: string) => Promise<string | null>;
  /** sandbox name -> absolute workspace dir inside it */
  private readonly workspaceRoots = new Map<string, string>();

  constructor(private readonly deps: LauncherDeps) {
    this.guest = deps.guest ?? DEFAULT_GUEST_LAYOUT;
    this.resolveHost = deps.resolveHost ?? defaultResolveHost;
  }

  /**
   * Compose service names (litellm, graph-rag, …) only resolve on the
   * server's networks, not inside a sandbox: rewrite a URL's host to the IP
   * the server sees when it is a private address. Public hosts stay as-is.
   */
  async sandboxUrl(rawUrl: string): Promise<string> {
    if (this.deps.rewriteHosts === false) return rawUrl;
    const u = new URL(rawUrl);
    if (isIP(u.hostname)) return rawUrl;
    const ip = await this.resolveHost(u.hostname);
    if (!ip || !isPrivateIpv4(ip)) return rawUrl;
    u.hostname = ip;
    return u.toString().replace(/\/$/, rawUrl.endsWith("/") ? "/" : "");
  }

  async prepare(inp: LaunchInputs): Promise<Launch> {
    const { record, dirs } = inp;
    const { providers } = this.deps;
    const providerNames: string[] = [];
    const openUrls: Array<{ url: string; match: "prefix" | "exact" }> = [];

    // model providers: rewrite base URLs, move keys into OpenShell providers
    const gen = JSON.parse(await readFile(path.join(dirs.home, "providers.gen.json"), "utf8")) as GeneratedProvidersFile;
    for (const [id, def] of Object.entries(gen.providers)) {
      def.baseUrl = await this.sandboxUrl(def.baseUrl);
      const key = inp.resolveKey(id);
      if (!key) {
        openUrls.push({ url: def.baseUrl, match: "prefix" });
        continue;
      }
      const profile = inferenceProfile({ id, type: def.type, baseUrl: def.baseUrl }, def.apiKeyEnv);
      const name = providerNameFor(this.deps.instance, "llm", id);
      await providers.ensureProfile(profile);
      await providers.ensureProvider(name, profile.id!, { [def.apiKeyEnv]: key });
      providerNames.push(name);
    }

    // MCP servers: rewrite URLs; bearer tokens become providers, the rest open rules
    const mcpPath = path.join(dirs.workspace, ".mcp.json");
    const mcp = (await readFile(mcpPath, "utf8").then(JSON.parse).catch(() => null)) as {
      mcpServers: Record<string, { url?: string; auth?: unknown; bearerTokenEnv?: string }>;
    } | null;
    for (const [server, def] of Object.entries(mcp?.mcpServers ?? {})) {
      if (!def.url) continue; // stdio servers run inside the sandbox as-is
      def.url = await this.sandboxUrl(def.url);
      const token = def.auth === "bearer" && def.bearerTokenEnv ? inp.resolveSecret(def.bearerTokenEnv) : undefined;
      if (def.bearerTokenEnv && token) {
        const profile = mcpProfile({ name: server, url: def.url }, def.bearerTokenEnv);
        const name = providerNameFor(this.deps.instance, "mcp", server);
        await providers.ensureProfile(profile);
        await providers.ensureProvider(name, profile.id!, { [def.bearerTokenEnv]: token });
        providerNames.push(name);
      } else {
        if (def.auth === "bearer") log.warn(`mcp ${server}: no value for ${def.bearerTokenEnv ?? "bearer token"}; calls will be unauthenticated`);
        openUrls.push({ url: def.url, match: "exact" });
      }
    }

    const policy = sandboxPolicy({ openUrls, allowedHosts: record.gondolin.allowedHosts });
    const { name: sandbox, created } = await this.deps.runtime.ensureSandbox(record.id, {
      providers: providerNames,
      policy,
      labels: { "gwarestrin.instance": this.deps.instance },
    });
    if (!created) await this.refreshSandbox(sandbox, policy, providerNames);

    // sandbox-side layout under the sandbox's working directory (writable by policy)
    const scope = this.deps.workspace ? { workspace: this.deps.workspace } : {};
    const pwd = await this.deps.sandbox.exec(sandbox, ["pwd"], { ...scope, noLoginShell: true });
    const root = pwd.stdout.toString("utf8").trim() || "/sandbox";
    const g = { home: `${root}/.gw/home`, sessions: `${root}/.gw/sessions`, workspace: `${root}/workspace` };
    this.workspaceRoots.set(sandbox, g.workspace);

    const files: Array<[string, string]> = [
      [`${g.home}/settings.json`, await readFile(path.join(dirs.home, "settings.json"), "utf8")],
      [`${g.home}/providers.gen.json`, JSON.stringify(gen, null, 2) + "\n"],
      [`${g.home}/agent-config.json`, JSON.stringify({ workspaceDir: g.workspace }, null, 2) + "\n"],
    ];
    const context = await readFile(path.join(dirs.home, "context-injection.md"), "utf8").catch(() => null);
    if (context !== null) files.push([`${g.home}/context-injection.md`, context]);
    if (mcp) files.push([`${g.workspace}/.mcp.json`, JSON.stringify(mcp, null, 2) + "\n"]);
    for (const [file, content] of files) await this.writeFile(sandbox, file, content);
    await this.exec(sandbox, ["mkdir", "-p", g.sessions, g.workspace]);

    const ext = this.guest.extensionsDir;
    const argv = [
      "node",
      this.guest.piCli,
      "--no-extensions",
      "--no-context-files",
      "--session-dir",
      g.sessions,
      "-e",
      `${ext}/provider-bridge/index.js`,
      "-e",
      `${ext}/graph-context/index.ts`,
    ];
    if (record.mcpServers.length > 0) argv.push("-e", this.guest.mcpAdapterDir);
    // a session file from the local runtime is a host path: only resume sandbox sessions
    if (record.sessionFile?.startsWith(`${g.sessions}/`)) argv.push("--session", record.sessionFile);
    if (record.enabledModels?.length) argv.push("--models", record.enabledModels.join(","));

    const transport = this.deps.runtime.transport(sandbox, argv, {
      workdir: g.workspace,
      environment: {
        PI_CODING_AGENT_DIR: g.home,
        PI_SKIP_VERSION_CHECK: "1",
        PI_OFFLINE: "1",
        GWARESTRIN_PROVIDERS_GEN: `${g.home}/providers.gen.json`,
        GWARESTRIN_AGENT_CONFIG: `${g.home}/agent-config.json`,
      },
    });
    log.info(`agent ${record.name}: sandbox ${sandbox} (${created ? "created" : "reused"}), ${providerNames.length} provider(s), ${openUrls.length} open url(s)`);
    return { sandbox, created, transport, sessionsDir: g.sessions };
  }

  async deleteSandbox(agentId: string): Promise<void> {
    this.workspaceRoots.delete(sandboxNameFor(agentId));
    await this.deps.runtime.deleteSandbox(agentId);
  }

  /** File access to the agent's workspace inside its sandbox (the files API on this runtime). */
  async workspaceFs(agentId: string): Promise<SandboxFs> {
    const sandbox = sandboxNameFor(agentId);
    const scope = this.deps.workspace ? { workspace: this.deps.workspace } : {};
    let root = this.workspaceRoots.get(sandbox);
    if (!root) {
      try {
        const pwd = await this.deps.sandbox.exec(sandbox, ["pwd"], { ...scope, noLoginShell: true });
        root = `${pwd.stdout.toString("utf8").trim() || "/sandbox"}/workspace`;
      } catch (err) {
        if (errorCode(err) === "not_found") throw new HttpPathError(409, "agent has no sandbox yet; start it once");
        throw err;
      }
      this.workspaceRoots.set(sandbox, root);
    }
    return new SandboxFs(this.deps.sandbox, sandbox, root, this.deps.workspace);
  }

  /** A reused sandbox keeps its create-time policy; bring network rules and attachments up to date. */
  private async refreshSandbox(sandbox: string, policy: ReturnType<typeof sandboxPolicy>, providerNames: string[]): Promise<void> {
    const scope = this.deps.workspace ? { workspace: this.deps.workspace } : {};
    try {
      // no wait: the effective hash includes provider-derived layers, so waiting
      // for the submitted hash times out (60s) although the policy applies; the
      // sandbox polls for changes and pi only reaches MCP after startup
      await this.deps.sandbox.setPolicy(sandbox, policy, { ...scope, wait: false });
    } catch (err) {
      log.warn(`policy refresh for ${sandbox} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const name of providerNames) {
      try {
        await this.deps.sandbox.attachProvider(sandbox, name, scope);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already/i.test(msg)) log.warn(`attach ${name} to ${sandbox} failed: ${msg}`);
      }
    }
  }

  private async exec(sandbox: string, argv: string[], stdin?: string): Promise<void> {
    const scope = this.deps.workspace ? { workspace: this.deps.workspace } : {};
    const res = await this.deps.sandbox.exec(sandbox, argv, {
      ...scope,
      noLoginShell: true,
      ...(stdin !== undefined ? { stdin: Buffer.from(stdin, "utf8") } : {}),
    });
    if (res.exitCode !== 0) throw new Error(`sandbox exec ${argv[0]} failed (${res.exitCode}): ${res.stderr.toString("utf8").slice(0, 300)}`);
  }

  private async writeFile(sandbox: string, file: string, content: string): Promise<void> {
    await this.exec(sandbox, ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", file], content);
  }
}
