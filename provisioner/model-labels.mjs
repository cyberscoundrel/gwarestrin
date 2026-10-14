// Model labels: the organization's admin says, per model, what it is. Only a
// labeled model may run agents (every workspace enforces it), so a model
// nobody has looked at can't be picked by accident, and a provider adding a
// model doesn't put it in front of anyone.
//
//   key      "<provider>/<model id>" (the model id may itself contain "/")
//   tier     how capable it is, as the admin judges it:
//              basic     short, simple work (classifying, extracting)
//              standard  everyday agent work with tools
//              frontier  long, open-ended work across many tools
//   hosting  where prompts go:
//              on-prem        the organization's own hardware
//              private-cloud  a dedicated or contracted deployment
//              public-api     a shared public API
//   notes    anything else worth knowing (data terms, quirks), optional
//
// Policies built on these (which tier for which job, which hosting for which
// data) come later; for now a label is what admits a model.

export const TIERS = ["basic", "standard", "frontier"];
export const HOSTING = ["on-prem", "private-cloud", "public-api"];
export const MAX_LABELS = 500;

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}\/[^\s]{1,200}$/i;

function label(key, v, actor, now) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${key}: a label is an object`);
  if (!TIERS.includes(v.tier)) throw new Error(`${key}: tier is one of ${TIERS.join(", ")}`);
  if (!HOSTING.includes(v.hosting)) throw new Error(`${key}: hosting is one of ${HOSTING.join(", ")}`);
  const notes = v.notes === undefined || v.notes === null ? "" : v.notes;
  if (typeof notes !== "string" || notes.length > 500) throw new Error(`${key}: notes of up to 500 characters`);
  return { tier: v.tier, hosting: v.hosting, ...(notes.trim() ? { notes: notes.trim() } : {}), by: actor, at: now };
}

/**
 * apply the admin's changes: { "<provider>/<model>": label | null } (null
 * removes a label). Unchanged labels keep who set them and when.
 */
export function applyLabelUpdate(current, input, actor = "unknown", now = new Date().toISOString()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("labels must be an object");
  const next = { ...current };
  for (const [key, v] of Object.entries(input)) {
    if (!KEY_RE.test(key)) throw new Error(`invalid model ${key.slice(0, 80)} (expected provider/model)`);
    if (v === null) {
      delete next[key];
      continue;
    }
    const l = label(key, v, actor, now);
    const prev = current[key];
    next[key] = prev && prev.tier === l.tier && prev.hosting === l.hosting && (prev.notes ?? "") === (l.notes ?? "") ? prev : l;
  }
  if (Object.keys(next).length > MAX_LABELS) throw new Error(`at most ${MAX_LABELS} labeled models`);
  return next;
}

/** stored labels may be stale or hand-edited: keep only valid ones */
export function normalizeLabels(stored) {
  const out = {};
  for (const [key, v] of Object.entries(stored && typeof stored === "object" ? stored : {})) {
    try {
      if (!KEY_RE.test(key)) continue;
      const l = label(key, v, typeof v.by === "string" ? v.by : "unknown", typeof v.at === "string" ? v.at : "");
      out[key] = l;
    } catch {
      // dropped: an invalid label admits nothing
    }
  }
  return out;
}
