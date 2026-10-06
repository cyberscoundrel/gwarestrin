import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SandboxClient, errorCode, fromConnect } from "@nvidia/openshell-sdk";
import type { PiExitInfo, PiTransport, PiTransportFactory } from "../agents/pi-transport.js";
import { scoped } from "../util/log.js";
import type { PolicyInit, ProfileInit } from "./openshell-policy.js";

const log = scoped("openshell");

/** Grace period between closing pi's stdin (graceful) and cancelling the exec. */
const STOP_GRACE_MS = 5_000;

export interface OpenShellConfig {
  /** Gateway URL, e.g. https://127.0.0.1:17670 */
  gateway: string;
  /** PEM paths for the gateway's mTLS bundle */
  caCertPath: string;
  clientCertPath: string;
  clientKeyPath: string;
  /** OpenShell workspace (isolation boundary); one per gwarestrin instance */
  workspace?: string;
  /** Sandbox image containing node + pi + the gwarestrin extensions */
  image: string;
}

export async function connectOpenShell(cfg: OpenShellConfig): Promise<SandboxClient> {
  const [caCert, clientCert, clientKey] = await Promise.all([
    readFile(cfg.caCertPath),
    readFile(cfg.clientCertPath),
    readFile(cfg.clientKeyPath),
  ]);
  return SandboxClient.connect({ gateway: cfg.gateway, caCert, clientCert, clientKey });
}

/**
 * OpenShell caps sandbox names at 19 characters, so a UUID doesn't fit:
 * use a stable hash of the agent id ("gw-" + 16 hex). The full id rides
 * along as the `gwarestrin.agent` label.
 */
export function sandboxNameFor(agentId: string): string {
  if (!agentId) throw new Error("empty agent id");
  return `gw-${createHash("sha256").update(agentId).digest("hex").slice(0, 16)}`;
}

export interface SandboxSpecInput {
  environment?: Record<string, string>;
  providers?: string[];
  labels?: Record<string, string>;
  /** create-time policy (filesystem/landlock/process are fixed after creation) */
  policy?: PolicyInit;
}

/** Normalized error code for SDK and raw Connect errors alike. */
function codeOf(err: unknown): string | null {
  return errorCode(err) ?? errorCode(fromConnect(err));
}

type RawClient = SandboxClient["raw"];

/**
 * Provider profiles + instances on the gateway. Profiles describe where a
 * credential may be used; instances hold the real values (gateway-side,
 * encrypted). Both calls are idempotent: create, or update in place.
 */
export class OpenShellProviders {
  private readonly scope: { workspaceScope: { selection: { case: "workspace"; value: string } } };

  constructor(
    private readonly raw: RawClient,
    private readonly workspace = "default",
  ) {
    this.scope = { workspaceScope: { selection: { case: "workspace", value: workspace } } };
  }

  async ensureProfile(profile: ProfileInit): Promise<void> {
    const id = profile.id ?? "";
    const res = await this.raw.importProviderProfiles({ ...this.scope, profiles: [{ profile, source: "gwarestrin" }] });
    if (res.imported) return;
    const diag = res.diagnostics.map((d) => JSON.stringify(d)).join("; ");
    let existing;
    try {
      existing = await this.raw.getProviderProfile({ ...this.scope, id });
    } catch (err) {
      if (codeOf(err) === "not_found") throw new Error(`profile ${id} import rejected: ${diag}`);
      throw err;
    }
    await this.raw.updateProviderProfiles({
      ...this.scope,
      id,
      profile: { profile, source: "gwarestrin" },
      expectedResourceVersion: existing.profile?.resourceVersion ?? 0n,
    });
  }

  /** Create or replace a provider instance's credentials. Values never leave the server except to the gateway. */
  async ensureProvider(name: string, profileId: string, credentials: Record<string, string>): Promise<void> {
    // profiles are imported workspace-scoped; without profileWorkspace the
    // gateway resolves the type at platform scope and rejects it
    const provider = { metadata: { name }, type: profileId, credentials, profileWorkspace: this.workspace };
    try {
      await this.raw.getProvider({ ...this.scope, name });
    } catch (err) {
      if (codeOf(err) !== "not_found") throw err;
      await this.raw.createProvider({ ...this.scope, provider });
      log.info(`created provider ${name} (${profileId})`);
      return;
    }
    await this.raw.updateProvider({ ...this.scope, provider });
  }

  async deleteProvider(name: string): Promise<void> {
    await this.raw.deleteProvider({ ...this.scope, name, allowMissing: true });
  }

  async deleteProfile(id: string): Promise<void> {
    await this.raw.deleteProviderProfile({ ...this.scope, id, allowMissing: true });
  }
}

/** The slice of SandboxClient the runtime uses (keeps tests free of a gateway). */
export type SandboxApi = Pick<SandboxClient, "get" | "create" | "waitReady" | "delete" | "waitDeleted" | "execInteractive">;

/**
 * One persistent sandbox per agent: created on first start, reused after.
 * The sandbox idles on `sleep infinity`; pi itself runs as an exec session.
 */
export class OpenShellRuntime {
  constructor(
    private readonly client: SandboxApi,
    private readonly cfg: Pick<OpenShellConfig, "workspace" | "image">,
  ) {}

  /** Returns the sandbox name and whether it was created now (vs reused). */
  async ensureSandbox(agentId: string, spec: SandboxSpecInput = {}, readyTimeoutSecs = 300): Promise<{ name: string; created: boolean }> {
    const name = sandboxNameFor(agentId);
    const scope = this.cfg.workspace ? { workspace: this.cfg.workspace } : {};
    let created = false;
    try {
      await this.client.get(name, scope);
      log.info(`reusing sandbox ${name}`);
    } catch (err) {
      if (errorCode(err) !== "not_found") throw err;
      log.info(`creating sandbox ${name} (${this.cfg.image})`);
      await this.client.create({
        name,
        ...scope,
        image: this.cfg.image,
        command: ["sleep", "infinity"],
        labels: { "gwarestrin.agent": agentId, ...spec.labels },
        ...(spec.environment ? { environment: spec.environment } : {}),
        ...(spec.providers?.length ? { providers: spec.providers } : {}),
        ...(spec.policy ? { policy: spec.policy } : {}),
      });
      created = true;
    }
    await this.client.waitReady(name, readyTimeoutSecs, scope);
    return { name, created };
  }

  /** Deletion is asynchronous on the gateway; wait so attached providers can be removed after. */
  async deleteSandbox(agentId: string, timeoutSecs = 120): Promise<void> {
    const name = sandboxNameFor(agentId);
    const scope = this.cfg.workspace ? { workspace: this.cfg.workspace } : {};
    try {
      await this.client.delete(name, { ...scope, allowMissing: true });
      await this.client.waitDeleted(name, timeoutSecs, scope);
    } catch (err) {
      if (errorCode(err) !== "not_found") throw err;
    }
  }

  transport(sandboxName: string, argv: string[], opts: { workdir?: string; environment?: Record<string, string> } = {}): PiTransportFactory {
    return openShellTransport(this.client, sandboxName, argv, {
      ...opts,
      ...(this.cfg.workspace ? { workspace: this.cfg.workspace } : {}),
    });
  }
}

/**
 * PiTransport over an OpenShell interactive exec (tty off, so stdout stays
 * byte-exact and LF-framed). Writes issued before the session opens are
 * queued by awaiting the session promise.
 */
export function openShellTransport(
  client: Pick<SandboxClient, "execInteractive">,
  sandboxName: string,
  argv: string[],
  opts: { workdir?: string; environment?: Record<string, string>; workspace?: string } = {},
): PiTransportFactory {
  return (handlers) => {
    let exited = false;
    let killSignal: NodeJS.Signals | null = null;
    let graceTimer: NodeJS.Timeout | undefined;

    const sessionPromise = client.execInteractive(sandboxName, argv, {
      tty: false,
      noLoginShell: true,
      ...(opts.workdir ? { workdir: opts.workdir } : {}),
      ...(opts.environment ? { environment: opts.environment } : {}),
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
    });

    const finish = (code: number | null, crashedHint: boolean): void => {
      if (exited) return;
      exited = true;
      if (graceTimer) clearTimeout(graceTimer);
      const info: PiExitInfo = killSignal
        ? { code, signal: killSignal, crashed: true }
        : { code, signal: null, crashed: crashedHint || (code !== 0 && code !== null) };
      handlers.exit(info);
    };

    void (async () => {
      let exitCode: number | null = null;
      try {
        const session = await sessionPromise;
        for await (const ev of session.output) {
          if ("type" in ev) {
            exitCode = ev.exitCode;
          } else if (ev.stream === "stderr") {
            handlers.stderr(ev.data.toString("utf8"));
          } else {
            handlers.stdout(ev.data);
          }
        }
        handlers.stdoutEnd();
        finish(exitCode ?? session.exitCode ?? null, exitCode === null);
      } catch (err) {
        if (!killSignal) {
          log.error(`exec stream to ${sandboxName} failed`, err);
          handlers.stderr(`openshell exec failed: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        handlers.stdoutEnd();
        finish(exitCode, true);
      }
    })();

    const transport: PiTransport = {
      pid: undefined,
      get writable() {
        return !exited;
      },
      async write(data) {
        // a failed exec start is reported once, through exit; nothing to write to
        const session = await sessionPromise.catch(() => undefined);
        if (session && !exited) session.write(Buffer.from(data, "utf8"));
      },
      kill(signal) {
        if (exited || killSignal) return;
        killSignal = signal;
        void sessionPromise.then(
          (session) => {
            if (signal === "SIGKILL") {
              session.cancel();
              return;
            }
            // pi exits cleanly on stdin EOF; cancel only if it lingers
            session.closeInput();
            graceTimer = setTimeout(() => session.cancel(), STOP_GRACE_MS);
          },
          () => finish(null, true),
        );
      },
    };
    return transport;
  };
}
