// Per-instance settings: what an organization's admin decides per workspace,
// delivered to the instance in its metadata (`settings`) and enforced live by
// its server. Infrastructure (runtime, tier, positions) is not here: that is
// set at deploy.
//
//   maxAgents  how many agents may run at once (1..32)
//   mcp        tool connections the workspace may use: "all" or a list of names
//   providers  model providers it may use: "all" or a list of provider ids
//              (e.g. only local inference: nothing leaves the premises)

export const MAX_AGENTS_LIMIT = 32;

export function defaultSettings(env = process.env) {
  const n = Number(env.TENANT_MAX_AGENTS);
  return { maxAgents: Number.isInteger(n) && n >= 1 && n <= MAX_AGENTS_LIMIT ? n : 2, mcp: "all", providers: "all" };
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function allowList(key, v) {
  if (v === "all") return "all";
  if (!Array.isArray(v) || v.length > 64 || v.some((x) => typeof x !== "string" || !NAME_RE.test(x))) {
    throw new Error(`${key} must be "all" or a list of names`);
  }
  return [...new Set(v)].sort();
}

/** validate a (partial) update; throws a person-readable message */
export function applySettingsUpdate(current, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("settings must be an object");
  const next = { ...current };
  for (const [k, v] of Object.entries(input)) {
    if (k === "maxAgents") {
      if (!Number.isInteger(v) || v < 1 || v > MAX_AGENTS_LIMIT) throw new Error(`maxAgents must be a whole number from 1 to ${MAX_AGENTS_LIMIT}`);
      next.maxAgents = v;
    } else if (k === "mcp" || k === "providers") {
      next[k] = allowList(k, v);
    } else {
      throw new Error(`unknown setting: ${k}`);
    }
  }
  if (Array.isArray(next.providers) && next.providers.length === 0) throw new Error("allow at least one model provider");
  return next;
}

/** stored settings may be partial or stale: fill from the defaults, drop what's invalid */
export function normalizeSettings(stored, defaults) {
  try {
    return applySettingsUpdate(defaults, Object.fromEntries(Object.entries(stored ?? {}).filter(([k]) => k in defaults)));
  } catch {
    return defaults;
  }
}
