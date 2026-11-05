/**
 * Model calls through litellm (embeddings, chat) under the dependency rule in health.js.
 */
import { EMBED_MODEL, EMBED_TIMEOUT_MS, GRADER_TIMEOUT_MS, health, LITELLM_API_KEY, LITELLM_BASE_URL } from "./context.js";

/**
 * One call to a model route (through litellm), under the dependency rule
 * (health.js): an outage (out of credit, rate-limited, down, timed out)
 * pauses the route and throws an Outage, which puts work off without
 * spending its retries; while it's paused, calls fail at once.
 */
export async function modelPost(model, path, body, timeoutMs) {
  const dep = `model:${model}`;
  const paused = health.outage(dep);
  if (paused) throw paused;
  let res;
  try {
    res = await fetch(`${LITELLM_BASE_URL.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${LITELLM_API_KEY}` },
      body: JSON.stringify({ model, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw health.fail(dep, e) ?? e;
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 120);
    throw health.fail(dep, null, res.status) ?? Object.assign(new Error(`${model} HTTP ${res.status}: ${text}`), { status: res.status });
  }
  const j = await res.json();
  health.ok(dep);
  return j;
}

export async function embedBatch(texts) {
  // a stalled backend fails the call (search falls back to lexical) instead of hanging it
  const j = await modelPost(EMBED_MODEL, "/embeddings", { input: texts }, Number(EMBED_TIMEOUT_MS));
  const vecs = (j.data ?? []).map((d) => d.embedding);
  if (vecs.length !== texts.length || vecs.some((v) => !Array.isArray(v))) {
    throw new Error("embeddings response shape mismatch");
  }
  return vecs;
}

/** one model call (the extraction model: EXTRACT_MODEL, else the grader's) */
export async function chat(model, messages, timeoutMs = Number(GRADER_TIMEOUT_MS) * 2) {
  return (await modelPost(model, "/chat/completions", { messages, temperature: 0 }, timeoutMs)).choices?.[0]?.message?.content ?? "";
}
