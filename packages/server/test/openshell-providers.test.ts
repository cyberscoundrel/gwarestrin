import { describe, expect, it } from "vitest";
import { SdkError } from "@nvidia/openshell-sdk";
import { OpenShellProviders } from "../src/runtime/openshell.js";

const notFound = () => new SdkError("not_found", "no such provider");

// a gateway whose profile updates conflict unless they run one at a time
function fakeRaw() {
  let version = 1n;
  let inFlight = 0;
  let conflicts = 0;
  const providers = new Map<string, unknown>();
  const writes: string[] = [];
  const raw = {
    async importProviderProfiles() {
      return { imported: false, diagnostics: [] };
    },
    async getProviderProfile() {
      return { profile: { resourceVersion: version } };
    },
    async updateProviderProfiles({ expectedResourceVersion }: { expectedResourceVersion: bigint }) {
      inFlight++;
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (expectedResourceVersion !== version || inFlight > 0) {
        conflicts++;
        throw new Error(`provider profile was modified concurrently (current resource_version: ${version})`);
      }
      version++;
    },
    async getProvider({ name }: { name: string }) {
      if (!providers.has(name)) throw notFound();
      return { provider: providers.get(name) };
    },
    async createProvider({ provider }: { provider: { metadata: { name: string } } }) {
      providers.set(provider.metadata.name, provider);
      writes.push(`create ${provider.metadata.name}`);
    },
    async updateProvider({ provider }: { provider: { metadata: { name: string } } }) {
      providers.set(provider.metadata.name, provider);
      writes.push(`update ${provider.metadata.name}`);
    },
    async deleteProvider({ name }: { name: string }) {
      providers.delete(name);
    },
  };
  return { raw, providers, writes, stats: () => ({ conflicts, version }) };
}

describe("OpenShell provider profiles", () => {
  it("agents starting together write a shared profile once, one at a time", async () => {
    const { raw, stats } = fakeRaw();
    const p = new OpenShellProviders(raw as never, "w");
    await Promise.all(Array.from({ length: 4 }, () => p.ensureProfile({ id: "llm-openrouter" } as never)));
    expect(stats().conflicts).toBe(0);
    expect(stats().version).toBe(2n);
  });

  it("a changed profile is written again", async () => {
    const { raw, stats } = fakeRaw();
    const p = new OpenShellProviders(raw as never, "w");
    await p.ensureProfile({ id: "llm-local", baseUrl: "http://a" } as never);
    await p.ensureProfile({ id: "llm-local", baseUrl: "http://a" } as never);
    await p.ensureProfile({ id: "llm-local", baseUrl: "http://b" } as never);
    expect(stats().version).toBe(3n);
  });
});

describe("OpenShell provider instances", () => {
  // the gateway hands each update to every sandbox using the provider, which cut their model calls
  it("an agent start leaves an unchanged shared provider alone", async () => {
    const { raw, writes } = fakeRaw();
    const p = new OpenShellProviders(raw as never, "w");
    for (let i = 0; i < 3; i++) await p.ensureProvider("gw-admin-llm-local", "llm-local", { KEY: "k1" });
    expect(writes).toEqual(["create gw-admin-llm-local"]);
  });

  it("new credentials are written; a provider the gateway lost is created again", async () => {
    const { raw, providers, writes } = fakeRaw();
    const p = new OpenShellProviders(raw as never, "w");
    await p.ensureProvider("gw-admin-llm-local", "llm-local", { KEY: "k1" });
    await p.ensureProvider("gw-admin-llm-local", "llm-local", { KEY: "k2" });
    providers.clear();
    await p.ensureProvider("gw-admin-llm-local", "llm-local", { KEY: "k2" });
    expect(writes).toEqual(["create gw-admin-llm-local", "update gw-admin-llm-local", "create gw-admin-llm-local"]);
  });

  it("a provider this server didn't write yet is written once, even if it exists", async () => {
    const { raw, providers, writes } = fakeRaw();
    providers.set("gw-admin-llm-local", {});
    const p = new OpenShellProviders(raw as never, "w");
    await p.ensureProvider("gw-admin-llm-local", "llm-local", { KEY: "k1" });
    await p.ensureProvider("gw-admin-llm-local", "llm-local", { KEY: "k1" });
    expect(writes).toEqual(["update gw-admin-llm-local"]);
  });
});
