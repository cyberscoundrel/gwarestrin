// A decision model (Jev-style: typed questions in, probabilities out; TypeSafe's Jev through OpenRouter,
// or a compatible open-weight one such as Cloudflare's Clef). Triage, which asked it how much work a
// section needed, is gone (R4: every record gets a worker). What stays is the call: the restrict-only
// check per section is a typed decision model with real probabilities, so uncertainty holds the section
// higher (R4). A locally served one for on-prem is unproven and is tested in the first real batch.
//
// The record stream owns this module and builds the check on it.

/** one decision call; null when it isn't configured. Throws on an error answer (the caller holds the section higher). */
export async function askDecisionModel({ url, key, model, timeoutMs = 15_000 }, { state, questions }) {
  if (!url || !key || !model) return null;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw Object.assign(new Error(`decision model ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
  const body = await res.json();
  return { model: body.model, answers: body.answers ?? {}, cost: body.usage?.cost ?? null };
}
