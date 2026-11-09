// Triage with a decision model (Jev-style: typed questions in, probabilities
// out; TypeSafe's Jev through OpenRouter, or a compatible open-weight one
// such as Cloudflare's Clef). When a section with claims arrives, one call asks:
//   level   how much work it needs: 0 nothing, 1 a quick check, 2 an
//           investigation, 3 a broad matter
//   reason  why (when there's work)
// and nothing else: whether a claim contradicts what was recorded is a query
// over the claims (model/claims.js `overlaps`), and which instance a subject
// means is the resolver's (worker-pool.js `resolveSubjectStub`, the Admission
// stream's `resolveSubject` when it lands). Both come in as facts and raise the
// level; the model never answers them. Code decides from the probabilities
// (thresholds below), so every decision can be shown as numbers, and outcomes
// (what the worker then did) can tune them.

export const LEVELS = [
  "Nothing: its claims are plain, every subject resolved, nothing to confirm or enter",
  "A quick check: one claim to confirm against one source row",
  "An investigation: several claims, a subject to resolve, a conflict with a prior claim, or data to enter",
  "A broad matter: many sections or claims on one instance or class, or a process rather than a record",
];

export const REASONS = {
  record_lookup: "A claim should be confirmed against a row in a connected system",
  unresolved_subject: "A claim's subject is not resolved to an instance",
  conflict: "A claim gives a different value from a prior claim on the same attribute over the same time",
  data_entry: "A claim says something a source row should hold and may not",
  judgement: "It calls for a business judgement or decision",
  plain_fact: "Nothing to check: plain claims, resolved and consistent",
};

/** thresholds: a section needs no work at this P(level 0) */
export const NOTHING_MIN = 0.6;
export const PLAIN_MIN = 0.5;
/** this share of no-work sections still goes to the master, so misses can be measured */
export const SAMPLE_RATE = 0.05;

/**
 * The request for one section. `facts` are what the queries found: how many
 * claims it makes, how many subjects are unresolved, how many claims
 * conflict with a prior one, how many subjects have a record key.
 */
export function triageRequest(entry, facts = {}) {
  const f = { claims: 0, unresolved: 0, conflicts: 0, keyed: 0, ...facts };
  const state = {
    entry: `${entry.name}: ${entry.text}`,
    facts: `${f.claims} claim(s); ${f.keyed} subject(s) with a record key; ${f.unresolved} unresolved subject(s); ${f.conflicts} conflict(s) with prior claims`,
  };
  const questions = {
    level: { type: "score", instructions: "How much work does the section in `entry` need, given `facts`, before its claims are reconciled with the source systems and what was recorded before?", criteria: LEVELS },
    reason: { type: "choice", instructions: "What is the main reason `entry` needs work?", criteria: REASONS },
  };
  return { state, questions };
}

/**
 * What to do with the answers: the section's level and reason, and whether
 * it goes to the master. The queries' facts rule: an unresolved subject or a
 * conflict is work whatever the model says. `random` is injectable for the
 * exploration sample.
 */
export function triageVerdict(answers, facts = {}, { random = Math.random } = {}) {
  const f = { claims: 0, unresolved: 0, conflicts: 0, keyed: 0, ...facts };
  const probs = answers?.level?.probabilities ?? {};
  const pNothing = Number(probs["0"] ?? 0);
  const score = Number(answers?.level?.score ?? 0);
  const reason = answers?.reason?.choice ?? null;
  const reasonP = Number(answers?.reason?.probabilities?.[reason] ?? 0);
  // nothing to do: nothing the queries found, and either the model is sure of level 0 or it calls it
  // plain and scores it under a quick check (Jev spreads probability across neighbouring levels, so
  // P(level 0) alone rarely clears the bar)
  const plain = reason === "plain_fact" && reasonP >= PLAIN_MIN && score < 1;
  const found = f.unresolved > 0 || f.conflicts > 0;
  const nothing = !found && (pNothing >= NOTHING_MIN || plain);
  const level = nothing ? 0 : Math.max(1, Math.min(3, Math.round(score)));
  const sample = nothing && random() < SAMPLE_RATE;
  return {
    level,
    reason: nothing ? "plain_fact" : f.conflicts > 0 ? "conflict" : f.unresolved > 0 ? "unresolved_subject" : reason && reason !== "plain_fact" ? reason : f.keyed > 0 ? "record_lookup" : "judgement",
    score,
    pNothing,
    reasonP,
    toMaster: !nothing || sample,
    sample,
  };
}

/** one decision call; null when it isn't configured or it fails (the section then goes to the master untriaged) */
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
