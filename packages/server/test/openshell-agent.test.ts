import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRecord } from "@gwarestrin/shared";
import { describe, expect, it } from "vitest";
import type { AgentDirs } from "../src/agents/scaffold.js";
import { DEFAULT_GUEST_LAYOUT, type LauncherDeps, OpenShellAgentLauncher } from "../src/runtime/openshell-agent.js";

const KEYS: Record<string, string> = { openrouter: "sk-or-REAL-openrouter", litellm: "sk-REAL-litellm" };
const GRAPH_TOKEN = "REAL-graph-token";
const HOSTS: Record<string, string> = { litellm: "172.31.99.11", "graph-rag": "172.31.99.7", dab: "172.31.99.14", "openrouter.ai": "104.18.2.3" };

async function fixture(): Promise<AgentDirs> {
  const root = await mkdtemp(path.join(tmpdir(), "gw-osa-"));
  const dirs = { root, workspace: path.join(root, "workspace"), home: path.join(root, "home"), sessions: path.join(root, "sessions") };
  await Promise.all([mkdir(dirs.workspace, { recursive: true }), mkdir(dirs.home, { recursive: true })]);
  await writeFile(path.join(dirs.home, "settings.json"), JSON.stringify({ defaultProvider: "openrouter" }));
  await writeFile(path.join(dirs.home, "context-injection.md"), "graph facts\n");
  await writeFile(
    path.join(dirs.home, "providers.gen.json"),
    JSON.stringify({
      providers: {
        openrouter: { type: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "GWARESTRIN_KEY_OPENROUTER", models: [] },
        litellm: { type: "openai-completions", baseUrl: "http://litellm:4000/v1", apiKeyEnv: "GWARESTRIN_KEY_LITELLM", models: [] },
        vllm: { type: "openai-completions", baseUrl: "http://100.96.0.11:8000/v1", apiKeyEnv: "GWARESTRIN_KEY_VLLM", models: [] },
      },
    }),
  );
  await writeFile(
    path.join(dirs.workspace, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "graph-rag": { url: "http://graph-rag:8000/mcp", auth: "bearer", bearerTokenEnv: "GWARESTRIN_GRAPH_TOKEN" },
        mssql: { url: "http://dab:5000/mcp" },
      },
    }),
  );
  return dirs;
}

function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    name: "ux-test",
    createdAt: "",
    status: "starting",
    model: null,
    mcpServers: ["graph-rag", "mssql"],
    gondolin: { allowedHosts: ["github.com"], secrets: {} },
    ...over,
  };
}

function fakes(created: boolean) {
  const calls: Array<[string, unknown]> = [];
  const written = new Map<string, string>();
  let transportArgs: unknown[] = [];
  const deps: LauncherDeps = {
    instance: "alice",
    resolveHost: async (h) => HOSTS[h] ?? null,
    providers: {
      ensureProfile: async (p) => void calls.push(["profile", p]),
      ensureProvider: async (name, type, creds) => void calls.push(["provider", { name, type, creds }]),
    },
    runtime: {
      ensureSandbox: async (id, spec) => (calls.push(["sandbox", { id, spec }]), { name: `gw-${id}`, created }),
      transport: (...args: unknown[]) => ((transportArgs = args), (() => ({})) as never),
      deleteSandbox: async () => {},
    },
    sandbox: {
      exec: (async (_name: string, argv: string[], opts?: { stdin?: Buffer }) => {
        if (argv[0] === "pwd") return { exitCode: 0, stdout: Buffer.from("/sandbox\n"), stderr: Buffer.alloc(0) };
        if (argv[0] === "sh") written.set(argv[4]!, opts?.stdin?.toString("utf8") ?? "");
        calls.push(["exec", argv[0]]);
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }) as never,
      execStream: (async function* () {}) as never,
      setPolicy: (async (name: string) => (calls.push(["setPolicy", name]), {})) as never,
      attachProvider: (async (name: string, provider: string) => (calls.push(["attach", { name, provider }]), {})) as never,
    },
  };
  return { deps, calls, written, transport: () => transportArgs };
}

const inputs = (dirs: AgentDirs, rec = record()) => ({
  record: rec,
  dirs,
  resolveKey: (id: string) => KEYS[id],
  resolveSecret: (env: string) => (env === "GWARESTRIN_GRAPH_TOKEN" ? GRAPH_TOKEN : undefined),
});

describe("OpenShellAgentLauncher", () => {
  it("rewrites compose hostnames to the server's view and keeps public hosts", async () => {
    const l = new OpenShellAgentLauncher(fakes(true).deps);
    expect(await l.sandboxUrl("http://litellm:4000/v1")).toBe("http://172.31.99.11:4000/v1");
    expect(await l.sandboxUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1");
    expect(await l.sandboxUrl("http://unknown-host:1/x")).toBe("http://unknown-host:1/x");
    expect(await l.sandboxUrl("http://100.96.0.11:8000/v1")).toBe("http://100.96.0.11:8000/v1");
  });

  it("keeps service names when the gateway resolves them itself", async () => {
    const f = fakes(true);
    const l = new OpenShellAgentLauncher({ ...f.deps, rewriteHosts: false });
    expect(await l.sandboxUrl("http://litellm:4000/v1")).toBe("http://litellm:4000/v1");
    await l.prepare(inputs(await fixture()));
    const mcp = JSON.parse(f.written.get("/sandbox/workspace/.mcp.json")!);
    expect(mcp.mcpServers["graph-rag"].url).toBe("http://graph-rag:8000/mcp");
    const { spec } = f.calls.find((c) => c[0] === "sandbox")![1] as {
      spec: { policy: { networkPolicies: Record<string, { endpoints: Array<{ host: string; allowedIps?: string[]; path?: string }> }> } };
    };
    const dab = Object.values(spec.policy.networkPolicies).flatMap((r) => r.endpoints).find((e) => e.host === "dab");
    expect(dab).toMatchObject({ host: "dab", port: 5000, path: "/mcp" });
    expect(dab?.allowedIps).toBeUndefined();
  });

  it("turns keys and tokens into instance-scoped providers, never into sandbox files or env", async () => {
    const f = fakes(true);
    const launch = await new OpenShellAgentLauncher(f.deps).prepare(inputs(await fixture()));

    const providers = f.calls.filter((c) => c[0] === "provider").map((c) => c[1]);
    expect(providers).toEqual([
      { name: "gw-alice-llm-openrouter", type: "gw-llm-openrouter", creds: { GWARESTRIN_KEY_OPENROUTER: KEYS.openrouter } },
      { name: "gw-alice-llm-litellm", type: "gw-llm-litellm", creds: { GWARESTRIN_KEY_LITELLM: KEYS.litellm } },
      { name: "gw-alice-mcp-graph-rag", type: "gw-mcp-graph-rag", creds: { GWARESTRIN_GRAPH_TOKEN: GRAPH_TOKEN } },
    ]);
    const litellmProfile = f.calls.find((c) => c[0] === "profile" && (c[1] as { id: string }).id === "gw-llm-litellm")![1] as {
      endpoints: Array<{ host: string; allowedIps?: string[] }>;
    };
    expect(litellmProfile.endpoints[0]).toMatchObject({ host: "172.31.99.11", allowedIps: ["172.31.99.11/32"] });

    const everything = [...f.written.values(), JSON.stringify(f.transport())].join("\n");
    for (const secret of [...Object.values(KEYS), GRAPH_TOKEN]) expect(everything).not.toContain(secret);

    expect(launch).toMatchObject({ sandbox: "gw-a1", created: true, sessionsDir: "/sandbox/.gw/sessions" });
  });

  it("creates the sandbox with providers and a policy for keyless and token-less destinations", async () => {
    const f = fakes(true);
    await new OpenShellAgentLauncher(f.deps).prepare(inputs(await fixture()));
    const { spec } = f.calls.find((c) => c[0] === "sandbox")![1] as {
      spec: { providers: string[]; policy: { networkPolicies: Record<string, { endpoints: Array<{ host: string; path?: string }> }> } };
    };
    expect(spec.providers).toEqual(["gw-alice-llm-openrouter", "gw-alice-llm-litellm", "gw-alice-mcp-graph-rag"]);
    const eps = Object.values(spec.policy.networkPolicies).flatMap((r) => r.endpoints);
    expect(eps.map((e) => e.host)).toEqual(expect.arrayContaining(["100.96.0.11", "172.31.99.14", "github.com"]));
    // keyless model API: prefix; MCP endpoint: exact
    expect(eps.find((e) => e.host === "100.96.0.11")).toMatchObject({ path: "/v1/**" });
    expect(eps.find((e) => e.host === "172.31.99.14")).toMatchObject({ path: "/mcp" });
    expect(f.calls.some((c) => c[0] === "setPolicy")).toBe(false);
  });

  it("pushes rewritten config into the sandbox", async () => {
    const f = fakes(true);
    await new OpenShellAgentLauncher(f.deps).prepare(inputs(await fixture()));
    expect([...f.written.keys()].sort()).toEqual([
      "/sandbox/.gw/home/agent-config.json",
      "/sandbox/.gw/home/context-injection.md",
      "/sandbox/.gw/home/providers.gen.json",
      "/sandbox/.gw/home/settings.json",
      "/sandbox/workspace/.mcp.json",
    ]);
    const gen = JSON.parse(f.written.get("/sandbox/.gw/home/providers.gen.json")!);
    expect(gen.providers.litellm.baseUrl).toBe("http://172.31.99.11:4000/v1");
    const mcp = JSON.parse(f.written.get("/sandbox/workspace/.mcp.json")!);
    expect(mcp.mcpServers["graph-rag"].url).toBe("http://172.31.99.7:8000/mcp");
    expect(mcp.mcpServers.mssql.url).toBe("http://172.31.99.14:5000/mcp");
    expect(JSON.parse(f.written.get("/sandbox/.gw/home/agent-config.json")!)).toEqual({ workspaceDir: "/sandbox/workspace" });
  });

  it("runs pi from the image layout with sandbox paths and no secrets in env", async () => {
    const f = fakes(true);
    const rec = record({ sessionFile: "/sandbox/.gw/sessions/s1.jsonl", enabledModels: ["x/*"] });
    await new OpenShellAgentLauncher(f.deps).prepare(inputs(await fixture(), rec));
    const [sandbox, argv, opts] = f.transport() as [string, string[], { workdir: string; environment: Record<string, string> }];
    expect(sandbox).toBe("gw-a1");
    expect(argv.slice(0, 2)).toEqual(["node", DEFAULT_GUEST_LAYOUT.piCli]);
    expect(argv).toEqual(expect.arrayContaining(["--session-dir", "/sandbox/.gw/sessions", DEFAULT_GUEST_LAYOUT.mcpAdapterDir, "--models", "x/*"]));
    expect(argv.join(" ")).toContain("--session /sandbox/.gw/sessions/s1.jsonl");
    expect(opts.workdir).toBe("/sandbox/workspace");
    expect(Object.keys(opts.environment).sort()).toEqual([
      "GWARESTRIN_AGENT_CONFIG",
      "GWARESTRIN_PROVIDERS_GEN",
      "PI_CODING_AGENT_DIR",
      "PI_OFFLINE",
      "PI_SKIP_VERSION_CHECK",
    ]);
  });

  it("does not resume a host-path session from the local runtime", async () => {
    const f = fakes(true);
    await new OpenShellAgentLauncher(f.deps).prepare(inputs(await fixture(), record({ sessionFile: "/var/lib/gwarestrin/agents/a1/sessions/s.jsonl" })));
    expect((f.transport()[1] as string[]).includes("--session")).toBe(false);
  });

  it("carries an existing local workspace into a new sandbox, once", async () => {
    const run = async (created: boolean) => {
      const f = fakes(created);
      const scripts: string[][] = [];
      let uploaded = "";
      const exec = f.deps.sandbox.exec;
      f.deps.sandbox.exec = (async (name: string, argv: string[], opts?: { stdin?: Buffer }) => {
        scripts.push(argv);
        if (argv[2] === 'cat >> "$1"' && argv[4]?.endsWith(".gw-seed.tar")) uploaded += opts?.stdin?.toString("latin1") ?? "";
        return (exec as (...a: unknown[]) => unknown)(name, argv, opts);
      }) as never;
      const dirs = await fixture();
      await mkdir(path.join(dirs.workspace, "notes"), { recursive: true });
      await writeFile(path.join(dirs.workspace, "notes", "ops.md"), "hello from the local runtime\n");
      await new OpenShellAgentLauncher(f.deps).prepare(inputs(dirs));
      return { scripts, uploaded: () => uploaded };
    };

    const fresh = await run(true);
    const tar = fresh.uploaded();
    expect(tar).toContain("notes/ops.md");
    expect(tar).toContain("hello from the local runtime");
    // the generated MCP config is pushed separately, never from the host copy
    expect(tar).not.toContain(".mcp.json");
    const extract = fresh.scripts.find((a) => a[0] === "sh" && a[2]!.startsWith("tar -xf"));
    expect(extract?.slice(4)).toEqual(["/sandbox/workspace/.gw-seed.tar", "/sandbox/workspace"]);

    const reused = await run(false);
    expect(reused.uploaded()).toBe("");
    expect(reused.scripts.some((a) => a[2]?.startsWith("tar -xf"))).toBe(false);
  });

  it("refreshes policy and attachments on a reused sandbox", async () => {
    const f = fakes(false);
    await new OpenShellAgentLauncher(f.deps).prepare(inputs(await fixture()));
    expect(f.calls.filter((c) => c[0] === "setPolicy")).toHaveLength(1);
    expect(f.calls.filter((c) => c[0] === "attach").map((c) => (c[1] as { provider: string }).provider)).toEqual([
      "gw-alice-llm-openrouter",
      "gw-alice-llm-litellm",
      "gw-alice-mcp-graph-rag",
    ]);
  });
});
