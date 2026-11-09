/**
 * Triage (see decisions.js): what a section on record needs, decided before the master sees it. The
 * decision model answers level and reason only; whether a claim's subject is resolved comes from the
 * resolver, and whether a claim conflicts with a prior one from a query over the claims
 * (model/claims.js). Every decision is a Triage row with the verdict's numbers and, later, what the
 * worker did, so thresholds can be tuned from outcomes.
 */
import { randomUUID } from "node:crypto";
import { askDecisionModel, triageRequest, triageVerdict } from "./decisions.js";
import { DECISION_API_KEY, DECISION_MODEL, DECISION_URL, health, log } from "./context.js";
import { adbCommand, adbQuery, RID_RE } from "./db.js";
import { claimsOfSection, claimsOnAttribute, enqueue } from "./worker-pool.js";
import { closeIntervals, overlaps } from "./model/claims.js";

const decisionConfig = () => ({ url: DECISION_URL, key: DECISION_API_KEY, model: DECISION_MODEL });

export async function ensureTriageSchema() {
  await adbCommand("CREATE DOCUMENT TYPE Triage IF NOT EXISTS").catch(() => {});
  for (const prop of ["id", "rid", "name", "reason", "verdict", "outcome", "model", "created_at"]) await adbCommand(`CREATE PROPERTY Triage.${prop} IF NOT EXISTS STRING`).catch(() => {});
  for (const prop of ["level", "claims", "unresolved", "conflicts"]) await adbCommand(`CREATE PROPERTY Triage.${prop} IF NOT EXISTS INTEGER`).catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON Triage (name) NOTUNIQUE").catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON Triage (rid) NOTUNIQUE").catch(() => {});
}

/** a claim as model/claims.js computes over it: the same fields, the subject keyed by its thing */
const forQuery = (c) => ({ ...c, subject: c.thing ? { key: c.thing } : { name: c.subject?.name ?? c.id, class: c.class } });

/**
 * The conflicts a section's claims have with prior claims on the same attribute of the same subject: a
 * query, not a judgement. After closing intervals (decision 3) what one claim supersedes is no conflict;
 * two values in force over the same time are. Returns [{ claim, other }] pairs of ids.
 */
export async function sectionConflicts(claims) {
  const out = [];
  for (const c of claims) {
    if (!c.resolved || c.kind === "event") continue;
    const prior = (await claimsOnAttribute(c.thing, c.attribute, { limit: 50 })).filter((p) => p.id !== c.id && p.section !== c.section);
    if (!prior.length) continue;
    const pairs = overlaps(closeIntervals([...prior, c].map(forQuery)));
    for (const [a, b] of pairs) if (a.id === c.id || b.id === c.id) out.push({ claim: c.id, other: a.id === c.id ? b.id : a.id, attribute: c.attribute });
  }
  return out;
}

/** what the queries know about a section before any model is asked */
export async function sectionFacts(rid) {
  const claims = await claimsOfSection(rid);
  const conflicts = await sectionConflicts(claims);
  const keyed = new Set();
  for (const c of claims) {
    if (!c.resolved) continue;
    const t = (await adbQuery(`SELECT _keys FROM ${c.thing}`).catch(() => []))[0];
    if (Array.isArray(t?._keys) && t._keys.length) keyed.add(c.thing);
  }
  return {
    claims,
    facts: { claims: claims.length, unresolved: claims.filter((c) => !c.resolved).length, conflicts: conflicts.length, keyed: keyed.size },
    conflicts,
    classes: [...new Set(claims.map((c) => c.class))],
    attributes: [...new Set(claims.map((c) => `${c.class}/${c.attribute}`))],
  };
}

/**
 * A section on record joins the next batch, triaged first when a decision model is configured: the
 * queries' facts (unresolved subjects, conflicts, keyed subjects) and the model's level and reason go
 * with it; a section that needs nothing stays out of the batch (but for a small sample). `linked` is
 * what the linker couldn't settle (legacy entries); its unsure names count as unresolved subjects.
 */
export async function intakeWithTriage(rid, row, linked = [], home) {
  const { facts, conflicts, classes, attributes } = await sectionFacts(rid);
  const unsure = (linked ?? []).filter((l) => l.unsure).length;
  const f = { ...facts, unresolved: facts.unresolved + unsure };
  const shape = { claims: f.claims, unresolved: f.unresolved, conflicts: f.conflicts, keyed: f.keyed, classes, attributes, ...(conflicts.length ? { conflict_pairs: conflicts } : {}) };
  if (!DECISION_API_KEY) return void (await enqueue("intake", { rid, ...shape }, { key: `intake:${rid}` }));
  const text = Object.keys(row ?? {}).filter((k) => k.startsWith("text_") && row[k]).map((k) => row[k]).join(" ");
  let verdict = null;
  let model = null;
  // the decision API out: the section goes to the master untriaged (it isn't held for it)
  if (!health.down("decisions")) {
    try {
      const res = await askDecisionModel(decisionConfig(), triageRequest({ name: row?.name ?? rid, text }, f));
      if (res) {
        verdict = triageVerdict(res.answers, f);
        model = res.model;
        health.ok("decisions");
      }
    } catch (e) {
      if (!health.fail("decisions", e, e.status)) log.warn(`triage ${row?.name ?? rid}: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  if (!verdict) return void (await enqueue("intake", { rid, ...shape }, { key: `intake:${rid}` }));
  await adbCommand("INSERT INTO Triage SET id = :id, rid = :rid, name = :name, level = :level, reason = :reason, claims = :claims, unresolved = :unresolved, conflicts = :conflicts, verdict = :v, model = :m, created_at = :now", "sql", {
    id: randomUUID(),
    rid,
    name: row?.name ?? null,
    level: verdict.level,
    reason: verdict.reason ?? "",
    claims: f.claims,
    unresolved: f.unresolved,
    conflicts: f.conflicts,
    v: JSON.stringify({ score: verdict.score, pNothing: verdict.pNothing, reasonP: verdict.reasonP, sample: verdict.sample, facts: f }),
    m: model ?? "",
    now: new Date().toISOString(),
  }).catch((e) => log.warn(`triage record: ${String(e).slice(0, 120)}`));
  if (!verdict.toMaster) return;
  await enqueue("intake", { rid, ...shape, triage: { level: verdict.level, reason: verdict.reason, ...(verdict.sample ? { sample: true } : {}) } }, { key: `intake:${rid}` });
}

/** what the worker then did with triaged sections (by their ids): the labels triage is tuned on */
export async function recordTriageOutcome(rids, outcome) {
  for (const rid of (rids ?? []).slice(0, 25)) {
    if (!RID_RE.test(String(rid))) continue;
    const t = (await adbQuery("SELECT id FROM Triage WHERE rid = :r ORDER BY created_at DESC LIMIT 1", { r: String(rid) }).catch(() => []))[0];
    if (t) await adbCommand("UPDATE Triage SET outcome = :o WHERE id = :id", "sql", { o: JSON.stringify(outcome), id: t.id }).catch(() => {});
  }
}

/** today's triage: sections by level, how many went to the master, conflicts and unresolved subjects found, and how its levels matched what workers did */
export async function triageStats() {
  const day = new Date().toISOString().slice(0, 10);
  const rows = await adbQuery("SELECT level, verdict, outcome, conflicts, unresolved FROM Triage WHERE created_at >= :d LIMIT 5000", { d: day }).catch(() => []);
  const byLevel = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let sampled = 0;
  let conflicts = 0;
  let unresolved = 0;
  const outcomes = { needed: 0, nothing_done: 0 };
  for (const r of rows) {
    byLevel[r.level] = (byLevel[r.level] ?? 0) + 1;
    const v = JSON.parse(r.verdict || "{}");
    if (v.sample) sampled++;
    conflicts += Number(r.conflicts ?? 0);
    unresolved += Number(r.unresolved ?? 0);
    if (r.outcome) {
      const o = JSON.parse(r.outcome);
      if (o.changes > 0 || o.stopped) outcomes.needed++;
      else outcomes.nothing_done++;
    }
  }
  return { on: !!DECISION_API_KEY, model: DECISION_API_KEY ? DECISION_MODEL : null, today: rows.length, byLevel, sampled, conflicts, unresolved, outcomes };
}
