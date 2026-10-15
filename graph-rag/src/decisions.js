// Triage with a decision model (Jev-style: typed questions in, probabilities
// out; TypeSafe's Jev through OpenRouter, or a compatible open-weight one
// such as Cloudflare's Clef). After a saved entry is linked, one call asks:
//   who_<n>       for each name linking couldn't settle, which candidate it means
//   level         how much work it needs: 0 nothing, 1 a quick check, 2 an
//                 investigation, 3 a broad or structural matter
//   reason        why (when there's work)
//   contradiction whether it changes or contradicts what was recorded
// Code decides from the probabilities (thresholds below), so every decision
// can be shown as numbers, and outcomes (what the worker then did) can tune
// them.

export const LEVELS = [
  "Nothing: a plain, self-contained statement, its names settled",
  "A quick check: one name or one record to confirm",
  "An investigation: several records, an update or correction to what was known, or a source to consult",
  "A broad or structural matter: a pattern, a process, or something touching many entries",
];

export const REASONS = {
  ambiguous_name: "A name could mean more than one person, company, machine or record",
  record_lookup: "It mentions a record (order, part, customer code) that should be checked against a connected system",
  contradiction: "It changes or contradicts something previously recorded",
  update_to_existing: "It updates the state of something already known (a date moved, a status changed)",
  judgement: "It calls for a business judgement or decision",
  plain_fact: "Nothing to check: a plain fact",
};

/** thresholds: a name is settled at this probability; an entry needs no work at this P(level 0) */
export const SETTLE_MIN = 0.75;
export const NOTHING_MIN = 0.6;
export const CONTRADICTION_MIN = 0.5;
export const PLAIN_MIN = 0.5;
/** this share of no-work entries still goes to the master, so misses can be measured */
export const SAMPLE_RATE = 0.05;

/**
 * The request for one entry. `unsure`: [{ name, type, candidates: [{ rid,
 * label, type, detail }] }] (names linking couldn't settle); `related`: a few
 * existing entries about the same things ({ name, text }).
 */
export function triageRequest(entry, unsure = [], related = []) {
  const state = {
    entry: `${entry.name}: ${entry.text}`,
    ...(related.length ? { related: related.map((r) => `${r.name}: ${String(r.text).slice(0, 400)}`).join("\n") } : {}),
  };
  const questions = {
    level: { type: "score", instructions: "How much work does `entry` need before it can be trusted and linked to what it's about?", criteria: LEVELS },
    reason: { type: "choice", instructions: "What is the main reason `entry` needs a closer look?", criteria: REASONS },
    ...(related.length ? { contradiction: { type: "noul", instructions: "Does `entry` change or contradict anything in `related`?" } } : {}),
  };
  unsure.slice(0, 6).forEach((u, i) => {
    state[`candidates_${i}`] = u.candidates.map((c, k) => `c${k}: ${c.label} (${c.type})${c.detail ? `, ${c.detail}` : ""}`).join("\n");
    questions[`who_${i}`] = {
      type: "choice",
      instructions: `Which of \`candidates_${i}\` does \`entry\` mean by "${u.name}"?`,
      criteria: { ...Object.fromEntries(u.candidates.map((c, k) => [`c${k}`, `${c.label} (${c.type})`])), none: "None of them, or it can't be told" },
    };
  });
  return { state, questions };
}

/**
 * What to do with the answers: names to settle (and link), the entry's level
 * and reason, and whether it goes to the master. `random` is injectable for
 * the exploration sample.
 */
export function triageVerdict(answers, unsure = [], { random = Math.random } = {}) {
  const settled = [];
  const open = [];
  unsure.slice(0, 6).forEach((u, i) => {
    const a = answers?.[`who_${i}`];
    const pick = a?.choice;
    const p = a?.probabilities?.[pick] ?? 0;
    const k = /^c(\d+)$/.exec(String(pick ?? ""));
    if (k && p >= SETTLE_MIN && u.candidates[Number(k[1])]) settled.push({ name: u.name, rid: u.candidates[Number(k[1])].rid, label: u.candidates[Number(k[1])].label, p });
    else open.push({ name: u.name, p, pick: k ? u.candidates[Number(k[1])]?.label : null });
  });
  for (const u of unsure.slice(6)) open.push({ name: u.name, p: 0, pick: null });
  const probs = answers?.level?.probabilities ?? {};
  const pNothing = Number(probs["0"] ?? 0);
  const score = Number(answers?.level?.score ?? 0);
  const contradiction = Number(answers?.contradiction?.noul ?? 0);
  const reason = answers?.reason?.choice ?? null;
  const reasonP = Number(answers?.reason?.probabilities?.[reason] ?? 0);
  // nothing to do: every name settled, nothing contradicts, and either the model is sure
  // of level 0 or it calls it a plain fact and scores it under a quick check (Jev spreads
  // probability across neighbouring levels, so P(level 0) alone rarely clears the bar)
  const plain = reason === "plain_fact" && reasonP >= PLAIN_MIN && score < 1;
  const nothing = open.length === 0 && contradiction < CONTRADICTION_MIN && (pNothing >= NOTHING_MIN || plain);
  const level = nothing ? 0 : Math.max(1, Math.min(3, Math.round(score)));
  const sample = nothing && random() < SAMPLE_RATE;
  return {
    level,
    reason: nothing ? "plain_fact" : contradiction >= CONTRADICTION_MIN ? "contradiction" : open.length ? "ambiguous_name" : reason,
    score,
    pNothing,
    reasonP,
    contradiction,
    settled,
    open,
    toMaster: !nothing || sample,
    sample,
  };
}

/** one decision call; null when it isn't configured or it fails (the entry then goes to the master as before) */
export async function askDecisionModel({ url, key, model, timeoutMs = 15_000 }, { state, questions }) {
  if (!url || !key || !model) return null;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`decision model ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return { model: body.model, answers: body.answers ?? {}, cost: body.usage?.cost ?? null };
}
