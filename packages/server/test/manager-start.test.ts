import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { PiProcess } from "../src/agents/pi-process.js";
import { AgentStore } from "../src/agents/store.js";
import type { ServerConfig } from "../src/config.js";
import { ProviderRegistry } from "../src/providers/registry.js";

/** pi that writes a load error to stderr and exits 1 right after spawn */
function dyingPi(): PiProcess {
  return new PiProcess({
    requestTimeoutMs: 5_000,
    transport: (h) => {
      setTimeout(() => {
        h.stderr("Error: Failed to load extension gondolin-vm: Cannot find module './write-script.ts'\n");
        h.stdoutEnd();
        h.exit({ code: 1, signal: null, crashed: true });
      }, 10);
      return { pid: 4242, writable: true, async write() {}, kill() {} };
    },
  });
}

async function managerWith(spawn: () => PiProcess) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "gw-start-"));
  const providersFile = path.join(stateDir, "providers.json");
  await writeFile(
    providersFile,
    JSON.stringify({
      providers: { mock: { type: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "dummy", models: [{ id: "m" }] } },
      defaultProvider: "mock",
      defaultModel: "m",
    }),
  );
  const registry = new ProviderRegistry();
  await registry.load(providersFile);
  const config: ServerConfig = { port: 0, host: "127.0.0.1", stateDir, providersFile, maxAgents: 2, webDistDir: path.join(stateDir, "web") };
  const store = new AgentStore(stateDir);
  await store.load();
  const manager = new AgentManager(config, registry, store);
  (manager as unknown as { localProcess: () => PiProcess }).localProcess = spawn;
  return { manager, store };
}

describe("AgentManager.start", () => {
  it("a pi that dies during startup is a failed start, not a crash to auto-restart", async () => {
    let spawns = 0;
    const { manager, store } = await managerWith(() => (spawns++, dyingPi()));
    const record = await manager.createAgent({ name: "dies-at-start", gondolin: { enabled: false } });

    // the reason from stderr reaches the caller (and so the create/start response)
    await expect(manager.start(record.id)).rejects.toThrow(/exited.*Failed to load extension gondolin-vm/);

    // past the first auto-restart delay (2s): a misclassified exit would have respawned
    await new Promise((r) => setTimeout(r, 2_500));
    expect(spawns).toBe(1);
    expect(store.get(record.id)!.status).toBe("error");
    expect(manager.getRunning(record.id)).toBeUndefined();
  });
});
