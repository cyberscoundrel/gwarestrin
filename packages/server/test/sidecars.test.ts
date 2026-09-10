import { describe, expect, it } from "vitest";
import { sidecarDefFromLabels, syncSidecars, type ContainerSummary } from "../src/discovery/sidecars.js";

/** registry stub (no persistence) */
function stubRegistry(existing: Record<string, { url?: string }> = {}) {
  const store = { ...existing };
  return {
    get: (name: string) => store[name],
    put: async (name: string, def: { url: string }) => {
      store[name] = def;
    },
    store,
  };
}

describe("sidecarDefFromLabels", () => {
  it("builds a def from mcp labels", () => {
    const d = sidecarDefFromLabels("my-mcp", {
      "gwarestrin.mcp.enable": "true",
      "gwarestrin.mcp.port": "9000",
      "gwarestrin.mcp.path": "/mcp/",
      "gwarestrin.mcp.description": "test sidecar",
    });
    expect(d).toEqual({
      key: "my-mcp",
      url: "http://my-mcp:9000/mcp/",
      description: "test sidecar (managed)",
    });
  });

  it("honors the name label and bearer auth", () => {
    const d = sidecarDefFromLabels("container-x", {
      "gwarestrin.mcp.enable": "true",
      "gwarestrin.mcp.name": "api-key",
      "gwarestrin.mcp.auth": "bearer",
      "gwarestrin.mcp.bearer-env": "API_KEY",
    });
    expect(d?.key).toBe("api-key");
    expect(d?.auth).toBe("bearer");
    expect(d?.bearerTokenEnv).toBe("API_KEY");
  });

  it("returns null for bearer auth without an env label", () => {
    const d = sidecarDefFromLabels("c", { "gwarestrin.mcp.enable": "true", "gwarestrin.mcp.auth": "bearer" });
    expect(d).toBeNull();
  });
});

describe("syncSidecars", () => {
  const container = (name: string, labels: Record<string, string>, ip = "172.31.99.50"): ContainerSummary => ({
    Names: [`/${name}`],
    Labels: labels,
    NetworkSettings: { Networks: { backend: { IPAddress: ip } } },
  });

  it("registers labeled mcp containers and skips net-only ones", async () => {
    const reg = stubRegistry();
    await syncSidecars(
      [
        container("a-mcp", { "gwarestrin.mcp.enable": "true", "gwarestrin.mcp.port": "8000" }),
        container("litellm", { "gwarestrin.net": "true" }),
      ],
      reg,
    );
    expect(reg.store["a-mcp"]?.url).toBe("http://a-mcp:8000/mcp");
    expect(reg.store["litellm"]).toBeUndefined();
  });

  it("adopts a matching hand-registered entry but never foreign ones", async () => {
    const reg = stubRegistry({
      graphrag: { url: "http://graph-rag:8000/mcp", description: "hand-made" },
      other: { url: "http://elsewhere:1/x" },
    });
    await syncSidecars(
      [
        container("graph-rag", { "gwarestrin.mcp.enable": "true", "gwarestrin.mcp.port": "8000", "gwarestrin.mcp.name": "graphrag" }),
        container("rogue", { "gwarestrin.mcp.enable": "true", "gwarestrin.mcp.name": "other", "gwarestrin.mcp.port": "1" }),
      ],
      reg,
    );
    expect(reg.store.graphrag?.description).toContain("(managed)");
    // 'other' points at elsewhere:1, not //rogue: — untouched
    expect(reg.store.other?.url).toBe("http://elsewhere:1/x");
  });
});
