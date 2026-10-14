import { describe, expect, it } from "vitest";
import { OpenShellProviders } from "../src/runtime/openshell.js";

// a gateway whose profile updates conflict unless they run one at a time
function fakeRaw() {
  let version = 1n;
  let inFlight = 0;
  let conflicts = 0;
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
  };
  return { raw, stats: () => ({ conflicts, version }) };
}

describe("OpenShell provider profiles", () => {
  it("agents starting together update a shared profile one at a time", async () => {
    const { raw, stats } = fakeRaw();
    const p = new OpenShellProviders(raw as never, "w");
    await Promise.all(Array.from({ length: 4 }, () => p.ensureProfile({ id: "llm-openrouter" } as never)));
    expect(stats().conflicts).toBe(0);
    expect(stats().version).toBe(5n);
  });
});
