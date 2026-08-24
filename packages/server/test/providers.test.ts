import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import { buildGeneratedProviders, envVarForProviderKey, writeGeneratedProviders } from "../src/providers/generate.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "gw-test-"));
});

afterEach(() => {
  delete process.env.TEST_ZAI_KEY;
  delete process.env.OPENAI_API_KEY;
});

describe("ProviderRegistry", () => {
  it("rejects invalid providers.json", async () => {
    const file = path.join(dir, "providers.json");
    await writeFile(file, JSON.stringify({ providers: { bad: { type: "nope", baseUrl: "x" } } }), "utf8");
    const reg = new ProviderRegistry();
    await expect(reg.load(file)).rejects.toThrow(/invalid providers file/);
  });

  it("missing file is not an error (first-party only)", async () => {
    const reg = new ProviderRegistry();
    await reg.load(path.join(dir, "absent.json"));
    expect(reg.list()).toEqual([]);
  });

  it("loads file providers, resolves keys via env, filters per agent", async () => {
    process.env.TEST_ZAI_KEY = "sk-test";
    const file = path.join(dir, "providers.json");
    await writeFile(
      file,
      JSON.stringify({
        providers: {
          "zai-glm": {
            type: "openai-completions",
            baseUrl: "https://api.z.ai/api/paas/v4",
            apiKeyEnv: "TEST_ZAI_KEY",
            models: [{ id: "glm-4.7", reasoning: true, contextWindow: 200000 }],
          },
          "keyless-local": {
            type: "openai-completions",
            baseUrl: "http://localhost:9/v1",
            apiKey: "dummy",
          },
        },
        defaultProvider: "zai-glm",
        defaultModel: "glm-4.7",
      }),
      "utf8",
    );
    const reg = new ProviderRegistry();
    await reg.load(file);

    expect(reg.list().map((p) => p.id).sort()).toEqual(["keyless-local", "zai-glm"]);
    expect(reg.resolveKey("zai-glm")).toBe("sk-test");
    expect(reg.hasKey("zai-glm")).toBe(true);
    expect(reg.defaultProvider).toBe("zai-glm");
    const zai = reg.get("zai-glm")!;
    expect(zai.models[0]).toMatchObject({ id: "glm-4.7", reasoning: true, contextWindow: 200000, source: "static" });

    // agent allowlist
    expect(reg.forAgent(["keyless-local"]).map((p) => p.id)).toEqual(["keyless-local"]);
    expect(reg.forAgent(undefined).length).toBe(2);

    // sanitized view must not contain key material
    expect(JSON.stringify(reg.list())).not.toContain("sk-test");
  });

  it("auto-registers first-party providers from env keys", async () => {
    process.env.OPENAI_API_KEY = "sk-fp";
    const reg = new ProviderRegistry();
    await reg.load(undefined);
    expect(reg.list().map((p) => p.id)).toEqual(["openai"]);
    expect(reg.get("openai")!.firstParty).toBe(true);
    expect(reg.get("openai")!.models.length).toBeGreaterThan(0);
  });
});

describe("generate", () => {
  it("generated file carries no key material and maps key env", async () => {
    process.env.TEST_ZAI_KEY = "sk-test";
    const file = path.join(dir, "providers.json");
    await writeFile(
      file,
      JSON.stringify({
        providers: {
          "zai-glm": {
            type: "openai-completions",
            baseUrl: "https://api.z.ai/api/paas/v4",
            apiKeyEnv: "TEST_ZAI_KEY",
            models: [{ id: "glm-4.7" }],
          },
        },
      }),
      "utf8",
    );
    const reg = new ProviderRegistry();
    await reg.load(file);

    expect(envVarForProviderKey("zai-glm")).toBe("GWARESTRIN_KEY_ZAI_GLM");

    const gen = buildGeneratedProviders(reg);
    expect(gen.providers["zai-glm"]!.apiKeyEnv).toBe("GWARESTRIN_KEY_ZAI_GLM");
    expect(JSON.stringify(gen)).not.toContain("sk-test");
    // defaults resolve to first available model when file has none
    expect(gen.defaultProvider).toBe("zai-glm");
    expect(gen.defaultModel).toBe("glm-4.7");

    const dest = path.join(dir, "providers.gen.json");
    await writeGeneratedProviders(dest, gen);
    const onDisk = await readFile(dest, "utf8");
    expect(onDisk).not.toContain("sk-test");
  });
});
