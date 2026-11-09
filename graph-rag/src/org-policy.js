/**
 * The organization policy (see policy.js): loaded from the graph, changed by a root person, and the rules
 * derived from it.
 */
import { applyPolicyUpdate, defaultPolicy, normalizeStored } from "./policy.js";
import { log } from "./context.js";
import { adbCommand, adbQuery } from "./db.js";
import { positionMap, SCOPED } from "./scope.js";
import { authorityOf } from "./model/authority.js";

/** ---- organization policy (Organization settings; see policy.js) ---- */

export const policyDefaults = defaultPolicy();
export let policy = policyDefaults;
export let policyMeta = { updated_by: null, updated_at: null };

export const expiryRules = (identity, scope) => ({
  root: scope.root,
  agent: Boolean(identity.agent),
  maxDays: policy.maxGrantDays,
  defaultDays: policy.defaultShareDays,
  standing: policy.standingGrants,
});

export async function ensurePolicySchema() {
  await adbCommand("CREATE DOCUMENT TYPE OrgPolicy IF NOT EXISTS").catch(() => {});
  await adbCommand("CREATE DOCUMENT TYPE PolicyChange IF NOT EXISTS").catch(() => {});
  for (const prop of ["scope", "json", "updated_by", "updated_at"]) await adbCommand(`CREATE PROPERTY OrgPolicy.${prop} IF NOT EXISTS STRING`).catch(() => {});
  // (no "by"/"before"/"after": reserved words in ArcadeDB SQL)
  for (const prop of ["changed_at", "changed_by", "prev_json", "next_json"]) await adbCommand(`CREATE PROPERTY PolicyChange.${prop} IF NOT EXISTS STRING`).catch(() => {});
}

/** what the last load warned about: the policy reloads every minute, a stale entry is logged once */
let warned = "";

export async function loadPolicy() {
  try {
    const row = (await adbQuery("SELECT FROM OrgPolicy WHERE scope = 'org' LIMIT 1"))[0];
    const warnings = [];
    policy = row ? normalizeStored(JSON.parse(row.json), policyDefaults, positionMap, (m) => warnings.push(m)) : policyDefaults;
    if (warnings.join("|") !== warned) for (const m of warnings) log.warn(m);
    warned = warnings.join("|");
    policyMeta = { updated_by: row?.updated_by ?? null, updated_at: row?.updated_at ?? null };
  } catch (e) {
    log.warn(`policy load failed (keeping the current one): ${String(e).slice(0, 120)}`);
  }
}

/** a root person changes the policy; every change is recorded */
export async function savePolicy(input, identity) {
  const next = applyPolicyUpdate(policy, input, positionMap);
  const now = new Date().toISOString();
  const updated = await adbCommand("UPDATE OrgPolicy SET json = :json, updated_by = :by_user, updated_at = :now WHERE scope = 'org'", "sql", {
    json: JSON.stringify(next),
    by_user: identity.user,
    now,
  });
  if (Number(updated?.[0]?.count ?? 0) === 0) {
    await adbCommand("INSERT INTO OrgPolicy SET scope = 'org', json = :json, updated_by = :by_user, updated_at = :now", "sql", {
      json: JSON.stringify(next),
      by_user: identity.user,
      now,
    });
  }
  await adbCommand("INSERT INTO PolicyChange SET changed_at = :now, changed_by = :by_user, prev_json = :prev, next_json = :next", "sql", {
    now,
    by_user: identity.user,
    prev: JSON.stringify(policy),
    next: JSON.stringify(next),
  }).catch((e) => log.warn(`policy change not logged: ${String(e).slice(0, 120)}`));
  log.info(`organization policy changed by ${identity.user}: ${JSON.stringify(input)}`);
  policy = next;
  policyMeta = { updated_by: identity.user, updated_at: now };
  return policy;
}

export const canEditPolicy = (identity, scope) => !identity.agent && !identity.open && scope.root && SCOPED;

/** the position holding authority over a class (and attribute) under the current policy, or null when no rule applies */
export const authorityFor = (cls, attribute) => authorityOf(policy.authorityMap, cls, attribute);
