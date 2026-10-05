/**
 * Live check of the OpenShell runtime against a real gateway (no mocks):
 *   1. profile + provider for an OpenRouter key, created from code (raw RPCs)
 *   2. sandbox with that provider and a generated policy
 *   3. pi --mode rpc over the exec-stream transport; pi's own bash sees only a
 *      placeholder key, and a request from inside the sandbox succeeds with
 *      the real key substituted in flight
 *   4. cleanup
 *
 * Never prints the key; compares SHA-256 prefixes instead.
 *
 * Env: OS_GATEWAY (https://127.0.0.1:17670), OS_PKI (dir with ca.crt,
 *      client/tls.crt, client/tls.key), OS_IMAGE (node+pi image),
 *      OS_KEY_FILE (file holding the OpenRouter key)
 *
 *   npx tsx scripts/live-openshell.ts
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PiProcess } from "../src/agents/pi-process.js";
import { inferenceProfile, providerNameFor, sandboxPolicy } from "../src/runtime/openshell-policy.js";
import { OpenShellProviders, OpenShellRuntime, connectOpenShell } from "../src/runtime/openshell.js";

const PKI = process.env.OS_PKI ?? "/pki";
const IMAGE = process.env.OS_IMAGE ?? "gw-pi-spike:check4";
const KEY_FILE = process.env.OS_KEY_FILE ?? "/spike/.openrouterkey";
const AGENT_ID = "live-check";
const KEY_ENV = "GWARESTRIN_KEY_OPENROUTER";
const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js";

const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const results: Record<string, unknown> = {};
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const realKey = (await readFile(KEY_FILE, "utf8")).trim();
results.hostKeySha16 = sha16(realKey);

const client = await connectOpenShell({
  gateway: process.env.OS_GATEWAY ?? "https://127.0.0.1:17670",
  caCertPath: path.join(PKI, "ca.crt"),
  clientCertPath: path.join(PKI, "client/tls.crt"),
  clientKeyPath: path.join(PKI, "client/tls.key"),
  image: IMAGE,
});
const providers = new OpenShellProviders(client.raw);
const runtime = new OpenShellRuntime(client, { image: IMAGE });

const profile = inferenceProfile({ id: "openrouter", type: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" }, KEY_ENV);
const providerName = providerNameFor("live", "llm", "openrouter");

let proc: PiProcess | undefined;
try {
  await providers.ensureProfile(profile);
  await providers.ensureProfile(profile); // second call exercises the update path
  log("profile ensured (import + update)", profile.id);
  await providers.ensureProvider(providerName, profile.id!, { [KEY_ENV]: realKey });
  await providers.ensureProvider(providerName, profile.id!, { [KEY_ENV]: realKey });
  log("provider ensured (create + update)", providerName);

  const { name } = await runtime.ensureSandbox(AGENT_ID, { providers: [providerName], policy: sandboxPolicy({}) });
  log("sandbox ready", name);

  proc = new PiProcess({
    requestTimeoutMs: 60_000,
    transport: runtime.transport(name, ["node", PI, "--no-extensions", "--no-context-files", "--session-dir", "/tmp/pi-sessions"], {
      workdir: "/tmp",
      environment: { PI_CODING_AGENT_DIR: "/tmp/pi-home", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
    }),
  });
  const state = await proc.send("get_state", {}, 60_000);
  results.piGetState = state.success;
  log("pi get_state", state.success);

  // pi's own bash tool: what does the agent see in its environment?
  const envProbe = await proc.send("bash", {
    command: `node -e 'const v=process.env.${KEY_ENV}||"";console.log(JSON.stringify({len:v.length,sha16:require("crypto").createHash("sha256").update(v).digest("hex").slice(0,16),real:v.startsWith("sk-or-")}))'`,
  });
  const envOut = String((envProbe.data as { output?: string } | undefined)?.output ?? "").trim();
  results.agentSeesKey = JSON.parse(envOut.split("\n").pop() ?? "{}");
  log("agent env", results.agentSeesKey);

  // request from inside the sandbox with the placeholder: proxy must substitute
  const fetchProbe = await proc.send("bash", {
    command: `node -e 'fetch("https://openrouter.ai/api/v1/key",{headers:{authorization:"Bearer "+process.env.${KEY_ENV}}}).then(r=>console.log("status",r.status)).catch(e=>console.log("error",String(e.cause?.code??e)))'`,
  }, 60_000);
  results.keyEndpoint = String((fetchProbe.data as { output?: string } | undefined)?.output ?? "").trim();
  log("GET /api/v1/key from sandbox:", results.keyEndpoint);
} catch (err) {
  results.error = String(err);
  log("ERROR", err);
} finally {
  if (proc && !proc.hasExited) {
    const exited = new Promise((r) => proc!.once("exit", r));
    proc.kill("SIGTERM");
    results.stopExit = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 10_000))]);
  }
  await runtime.deleteSandbox(AGENT_ID).catch((e) => (results.cleanupSandbox = String(e)));
  await providers.deleteProvider(providerName).catch((e) => (results.cleanupProvider = String(e)));
  await providers.deleteProfile(profile.id!).catch((e) => (results.cleanupProfile = String(e)));
  log("cleanup done");
}

const seen = results.agentSeesKey as { sha16?: string; real?: boolean } | undefined;
results.verdict = {
  piRpc: results.piGetState === true,
  keyHiddenFromAgent: !!seen && seen.real === false && seen.sha16 !== results.hostKeySha16,
  keySubstitutedInFlight: results.keyEndpoint === "status 200",
};
console.log("RESULTS " + JSON.stringify(results, null, 2));
process.exit(0);
