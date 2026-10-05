import { NetworkAccessPreset, NetworkEnforcementMode, ProviderProfileCategory } from "@nvidia/openshell-sdk/raw";
import { describe, expect, it } from "vitest";
import {
  AGENT_NODE,
  endpointFromUrl,
  inferenceProfile,
  mcpProfile,
  profileIdFor,
  providerNameFor,
  sandboxPolicy,
} from "../src/runtime/openshell-policy.js";

describe("endpointFromUrl", () => {
  it("scopes public https URLs to their path prefix", () => {
    expect(endpointFromUrl("https://openrouter.ai/api/v1")).toEqual({
      host: "openrouter.ai",
      port: 443,
      protocol: "rest",
      access: NetworkAccessPreset.READ_WRITE,
      enforcement: NetworkEnforcementMode.ENFORCE,
      path: "/api/v1/**",
    });
  });

  it("pins private IP literals with an exact allowed_ips entry", () => {
    const ep = endpointFromUrl("http://172.31.99.7:8000/mcp");
    expect(ep).toMatchObject({ host: "172.31.99.7", port: 8000, path: "/mcp/**", allowedIps: ["172.31.99.7/32"] });
    expect(endpointFromUrl("http://100.96.0.11:8000/v1").allowedIps).toEqual(["100.96.0.11/32"]);
  });

  it("does not add allowed_ips for public hosts or a bare root path", () => {
    const ep = endpointFromUrl("https://api.z.ai/");
    expect(ep.allowedIps).toBeUndefined();
    expect(ep.path).toBe("/**");
  });
});

describe("profiles", () => {
  it("binds an OpenAI-style key as bearer to the provider base URL, node only", () => {
    const p = inferenceProfile({ id: "openrouter", type: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" }, "GWARESTRIN_KEY_OPENROUTER");
    expect(p).toMatchObject({
      id: "gw-llm-openrouter",
      category: ProviderProfileCategory.INFERENCE,
      inferenceCapable: true,
      credentials: [{ name: "api_key", envVars: ["GWARESTRIN_KEY_OPENROUTER"], required: true, authStyle: "bearer", headerName: "authorization" }],
      binaries: [{ path: AGENT_NODE }],
    });
    expect(p.endpoints?.[0]).toMatchObject({ host: "openrouter.ai", path: "/api/v1/**" });
  });

  it("uses the vendor header for anthropic and google APIs", () => {
    const a = inferenceProfile({ id: "a", type: "anthropic-messages", baseUrl: "https://api.anthropic.com" }, "K");
    const g = inferenceProfile({ id: "g", type: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }, "K");
    expect(a.credentials?.[0]).toMatchObject({ authStyle: "header", headerName: "x-api-key" });
    expect(g.credentials?.[0]).toMatchObject({ authStyle: "header", headerName: "x-goog-api-key" });
  });

  it("binds an MCP bearer token to the server URL", () => {
    const p = mcpProfile({ name: "graph-rag", url: "http://172.31.99.7:8000/mcp" }, "GWARESTRIN_GRAPH_TOKEN");
    expect(p.id).toBe("gw-mcp-graph-rag");
    expect(p.credentials?.[0]).toMatchObject({ envVars: ["GWARESTRIN_GRAPH_TOKEN"], authStyle: "bearer" });
    expect(p.endpoints?.[0]).toMatchObject({ host: "172.31.99.7", allowedIps: ["172.31.99.7/32"] });
  });

  it("names are slugged and instance-scoped", () => {
    expect(profileIdFor("llm", "Homelab vLLM")).toBe("gw-llm-homelab-vllm");
    expect(providerNameFor("alice", "llm", "zai-glm")).toBe("gw-alice-llm-zai-glm");
    expect(providerNameFor("bob", "llm", "zai-glm")).not.toBe(providerNameFor("alice", "llm", "zai-glm"));
  });
});

describe("sandboxPolicy", () => {
  it("always carries the filesystem baseline and no rules by default", () => {
    const p = sandboxPolicy({});
    expect(p.filesystem).toMatchObject({ includeWorkdir: true, readWrite: ["/tmp", "/dev/null"] });
    expect(p.filesystem?.readOnly).toContain("/usr");
    expect(p.networkPolicies).toEqual({});
  });

  it("opens credential-free destinations to node only, deduplicated", () => {
    const p = sandboxPolicy({ openUrls: ["http://172.31.99.14:5000/mcp", "http://172.31.99.14:5000/mcp"] });
    expect(Object.keys(p.networkPolicies ?? {})).toEqual(["gw_open_0"]);
    expect(p.networkPolicies?.gw_open_0).toMatchObject({
      endpoints: [{ host: "172.31.99.14", port: 5000, allowedIps: ["172.31.99.14/32"] }],
      binaries: [{ path: AGENT_NODE }],
    });
  });

  it("maps allowedHosts to https rules for the agent's tools, dropping junk", () => {
    const p = sandboxPolicy({ allowedHosts: ["github.com", "github.com", "registry.npmjs.org", "bad host;rm"] });
    const rule = p.networkPolicies?.gw_allowed_hosts;
    expect(rule?.endpoints?.map((e) => e.host)).toEqual(["github.com", "registry.npmjs.org"]);
    expect(rule?.endpoints?.[0]).toMatchObject({ port: 443, access: NetworkAccessPreset.FULL });
    expect(rule?.binaries?.map((b) => b.path)).toContain("/usr/bin/*");
  });
});
