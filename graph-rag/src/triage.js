/**
 * Triage (see decisions.js): what a saved entry needs, decided before the master sees it.
 */
import { randomUUID } from "node:crypto";
import { normalize } from "./things.js";
import { askDecisionModel, triageRequest, triageVerdict } from "./decisions.js";
import { DECISION_API_KEY, DECISION_MODEL, DECISION_URL, health, log } from "./context.js";
import { adbCommand, adbQuery, RID_RE } from "./db.js";
import { aboutOnce, linkMentions, NOT_A_THING, thingSeenFrom } from "./linker.js";
import { enqueue } from "./worker-pool.js";

/** ---- triage (see decisions.js): what a saved entry needs, decided before the master sees it ---- */

const decisionConfig = () => ({ url: DECISION_URL, key: DECISION_API_KEY, model: DECISION_MODEL });

export async function ensureTriageSchema() {
  await adbCommand("CREATE DOCUMENT TYPE Triage IF NOT EXISTS").catch(() => {});
  for (const prop of ["id", "rid", "name", "reason", "verdict", "outcome", "model", "created_at"]) await adbCommand(`CREATE PROPERTY Triage.${prop} IF NOT EXISTS STRING`).catch(() => {});
  for (const prop of ["level"]) await adbCommand(`CREATE PROPERTY Triage.${prop} IF NOT EXISTS INTEGER`).catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON Triage (name) NOTUNIQUE").catch(() => {});
}

/**
 * A linked entry joins the next batch, triaged first when a decision model
 * is configured: confident name choices are linked now; an entry that needs
 * nothing stays out of the batch (but for a small sample); the rest go with
 * their level and reason.
 */
export async function intakeWithTriage(rid, row, linked, home) {
  const plain = linked.filter((l) => l.unsure).map((l) => `"${l.name}" (${l.type}) may be ${l.unsure}`);
  // names linking found no thing for (it made none: see jobMentions)
  const fresh = linked.filter((l) => l.skipped === NOT_A_THING).map(({ name, type, role, key }) => ({ name, type, role, ...(key ? { key } : {}) }));
  const freshNames = fresh.map((f) => `${f.name} (${f.type})`);
  if (!DECISION_API_KEY) return void (await enqueue("intake", { rid, unsure: plain }, { key: `intake:${rid}` }));
  // the names linking couldn't settle, with what each candidate is
  const unsure = [];
  for (const u of linked.filter((l) => l.unsure && l.candidates?.length)) {
    const cands = await adbQuery(`SELECT @rid AS rid, label, _thing_type, _keys FROM [${u.candidates.filter((c) => RID_RE.test(String(c))).join(",")}]`).catch(() => []);
    const candidates = [];
    for (const c of cands) {
      const about = (await adbQuery(`SELECT name FROM (SELECT expand(in('ABOUT')) FROM ${c.rid}) WHERE name IS NOT NULL LIMIT 1`).catch(() => []))[0]?.name;
      candidates.push({ rid: String(c.rid), label: c.label, type: c._thing_type, detail: [(c._keys ?? [])[0], about ? `known from "${about}"` : ""].filter(Boolean).join("; ") });
    }
    if (candidates.length) unsure.push({ name: u.name, type: u.type, role: u.role, candidates });
  }
  // a few entries about the same things, to tell an update or a contradiction
  const dsts = (await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`).catch(() => [])).map((e) => String(e.dst)).filter((x) => RID_RE.test(x));
  const related = dsts.length
    ? (await adbQuery(`SELECT @rid AS rid, name, text_identity FROM (SELECT expand(in('ABOUT')) FROM [${dsts.slice(0, 6).join(",")}]) WHERE name IS NOT NULL AND text_identity IS NOT NULL LIMIT 8`).catch(() => []))
        .filter((r) => String(r.rid) !== rid)
        .slice(0, 3)
        .map((r) => ({ name: r.name, text: r.text_identity }))
    : [];
  const text = Object.keys(row).filter((k) => k.startsWith("text_") && row[k]).map((k) => row[k]).join(" ");
  let verdict = null;
  let model = null;
  // the decision API out: the entry goes to the master untriaged (it isn't held for it)
  if (!health.down("decisions")) {
    try {
      const res = await askDecisionModel(decisionConfig(), triageRequest({ name: row.name, text }, unsure, related));
      if (res) {
        verdict = triageVerdict(res.answers, unsure);
        model = res.model;
        health.ok("decisions");
      }
    } catch (e) {
      if (!health.fail("decisions", e, e.status)) log.warn(`triage ${row.name}: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  // untriaged: a worker decides which new names are things
  if (!verdict) return void (await enqueue("intake", { rid, unsure: plain, ...(freshNames.length ? { fresh: freshNames } : {}) }, { key: `intake:${rid}` }));
  // names it's confident about: linked now, the name kept as an alias
  for (const st of verdict.settled) {
    const u = unsure.find((x) => x.name === st.name);
    await thingSeenFrom(st.rid, home).catch(() => {});
    await aboutOnce(rid, st.rid, u?.role || "mentions").catch(() => {});
    const t = (await adbQuery(`SELECT _norm, _alias_norms FROM ${st.rid}`).catch(() => []))[0];
    const n = normalize(st.name);
    if (t && t._norm !== n && !(t._alias_norms ?? []).includes(n)) await adbCommand(`UPDATE ${st.rid} SET _alias_norms = :a`, "sql", { a: [...(t._alias_norms ?? []), n] }).catch(() => {});
  }
  await adbCommand("INSERT INTO Triage SET id = :id, rid = :rid, name = :name, level = :level, reason = :reason, verdict = :v, model = :m, created_at = :now", "sql", {
    id: randomUUID(),
    rid,
    name: row.name,
    level: verdict.level,
    reason: verdict.reason ?? "",
    v: JSON.stringify({ score: verdict.score, pNothing: verdict.pNothing, reasonP: verdict.reasonP, contradiction: verdict.contradiction, settled: verdict.settled.map((x) => ({ name: x.name, label: x.label, p: x.p })), open: verdict.open, sample: verdict.sample }),
    m: model ?? "",
    now: new Date().toISOString(),
  }).catch((e) => log.warn(`triage record: ${String(e).slice(0, 120)}`));
  // nothing for a worker: its new names become things now, as linking would have made them
  if (!verdict.toMaster) {
    if (fresh.length) await linkMentions(rid, fresh, home, { unsure: "skip" });
    return;
  }
  await enqueue(
    "intake",
    {
      rid,
      ...(freshNames.length ? { fresh: freshNames } : {}),
      unsure: verdict.open.map((o) => `"${o.name}" unsettled${o.pick ? ` (perhaps ${o.pick}, p ${o.p.toFixed(2)})` : ""}`),
      triage: { level: verdict.level, reason: verdict.reason, ...(verdict.sample ? { sample: true } : {}), ...(verdict.settled.length ? { settled: verdict.settled.map((x) => `"${x.name}" = ${x.label}`) } : {}) },
    },
    { key: `intake:${rid}` },
  );
}

/** what the worker then did with triaged entries: the labels triage is tuned on */
export async function recordTriageOutcome(names, outcome) {
  for (const name of (names ?? []).slice(0, 25)) {
    const t = (await adbQuery("SELECT id FROM Triage WHERE name = :n ORDER BY created_at DESC LIMIT 1", { n: name }).catch(() => []))[0];
    if (t) await adbCommand("UPDATE Triage SET outcome = :o WHERE id = :id", "sql", { o: JSON.stringify(outcome), id: t.id }).catch(() => {});
  }
}

/** today's triage: entries by level, how many went to the master, names settled, and how its levels matched what workers did */
export async function triageStats() {
  const day = new Date().toISOString().slice(0, 10);
  const rows = await adbQuery("SELECT level, verdict, outcome FROM Triage WHERE created_at >= :d LIMIT 5000", { d: day }).catch(() => []);
  const byLevel = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let settled = 0;
  let sampled = 0;
  const outcomes = { needed: 0, nothing_done: 0 };
  for (const r of rows) {
    byLevel[r.level] = (byLevel[r.level] ?? 0) + 1;
    const v = JSON.parse(r.verdict || "{}");
    settled += (v.settled ?? []).length;
    if (v.sample) sampled++;
    if (r.outcome) {
      const o = JSON.parse(r.outcome);
      if (o.changes > 0 || o.stopped) outcomes.needed++;
      else outcomes.nothing_done++;
    }
  }
  return { on: !!DECISION_API_KEY, model: DECISION_API_KEY ? DECISION_MODEL : null, today: rows.length, byLevel, settledNames: settled, sampled, outcomes };
}
