/**
 * provider-bridge: registers gwarestrin-managed providers with pi.
 *
 * Reads a generated providers.gen.json (path in GWARESTRIN_PROVIDERS_GEN env)
 * containing provider definitions WITHOUT key material; keys arrive via the
 * per-provider env vars (GWARESTRIN_KEY_<ID>) injected by the server at spawn.
 *
 * Runs as an async factory: pi awaits it before session_start, so registered
 * models are available for --provider/--model resolution at startup.
 */
import { readFile } from "node:fs/promises";

export default async function providerBridge(pi) {
  const genPath = process.env.GWARESTRIN_PROVIDERS_GEN;
  if (!genPath) {
    throw new Error("provider-bridge: GWARESTRIN_PROVIDERS_GEN env not set");
  }

  let file;
  try {
    file = JSON.parse(await readFile(genPath, "utf8"));
  } catch (err) {
    throw new Error(`provider-bridge: cannot read ${genPath}: ${err.message}`);
  }

  for (const [id, def] of Object.entries(file.providers ?? {})) {
    const apiKey = process.env[def.apiKeyEnv];
    if (!apiKey) {
      // register anyway so the model catalogue is visible; pi surfaces auth
      // errors on first use if the endpoint actually requires a key
      console.warn(`[provider-bridge] ${id}: env ${def.apiKeyEnv} not set; auth may fail`);
    }
    pi.registerProvider(id, {
      baseUrl: def.baseUrl,
      apiKey: apiKey ?? "missing",
      api: def.type,
      ...(def.headers ? { headers: def.headers } : {}),
      models: def.models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        input: m.input,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    });
  }
}
