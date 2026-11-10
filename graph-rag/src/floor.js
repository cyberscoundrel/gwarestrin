/**
 * Derived data and placement: what an identity read bounds where its writes land (read marks, the floor,
 * the worker lift), grading, and where each entity of a write is placed (placement.js decides).
 */
import { commonAncestor, effectiveHome, EVERYONE, homeName, visibleHomes } from "./positions.js";
import { askWith, checkEntities, decisionConfig } from "./check.js";
import { applyFloor, floorLifts, place as placeOne, placeOverWaiting } from "./placement.js";
import * as context from "./context.js";
import { health, log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { positionMap, SCOPED } from "./scope.js";
import { decideWrite, queueWrite } from "./write.js";
import { instanceSeenFrom } from "./instances.js";
import { settleDocument } from "./document-home.js";
import { policy } from "./org-policy.js";

/** ---- derived data: what an identity read bounds where its writes land ---- */

const readMarks = new Map(); // identity -> Map(home -> last read ms)
const windowMs = () => policy.derivedWindowHours * 3_600_000;

export async function ensureReadMarkSchema() {
  await adbCommand("CREATE DOCUMENT TYPE ReadMark IF NOT EXISTS").catch(() => {});
  for (const prop of ["who", "pos", "at"]) await adbCommand(`CREATE PROPERTY ReadMark.${prop} IF NOT EXISTS STRING`).catch(() => {});
  // UPSERT needs an index on what it matches
  await adbCommand("CREATE INDEX IF NOT EXISTS ON ReadMark (who, pos) UNIQUE").catch((e) => log.warn(`read mark index: ${String(e).slice(0, 120)}`));
  const since = new Date(Date.now() - windowMs()).toISOString();
  const rows = await adbQuery("SELECT who, pos, at FROM ReadMark WHERE at > :since LIMIT 100000", { since }).catch(() => []);
  for (const r of rows) {
    if (!readMarks.has(r.who)) readMarks.set(r.who, new Map());
    readMarks.get(r.who).set(r.pos, Date.parse(r.at));
  }
  await adbCommand("DELETE FROM ReadMark WHERE at <= :since", "sql", { since }).catch(() => {});
}

/** whose reads these are: each agent on its own (full id), people by name */
const markKey = (identity) => identity.key ?? identity.user;

/** the home a read item is seen from: a home id, or an entry row read (its `_home`, else its section's) */
const readHome = (x) => (typeof x === "string" ? x : x && typeof x === "object" ? (x._home ?? x.home ?? x.section_home ?? undefined) : undefined);

/**
 * Remember the homes an identity was shown (persisted, so a restart forgets nothing). Each item
 * is a home id, or an entry row that was read: a read of a row marks the home it is
 * seen from, exactly as a read of an entry does.
 */
export function recordReads(identity, homes) {
  if (!SCOPED || !positionMap || identity.open) return;
  const now = Date.now();
  const who = markKey(identity);
  if (!readMarks.has(who)) readMarks.set(who, new Map());
  const mine = readMarks.get(who);
  for (const h of new Set(homes.map(readHome).filter((x) => typeof x === "string"))) {
    const last = mine.get(h) ?? 0;
    mine.set(h, now);
    if (now - last < 10 * 60_000) continue; // persisted recently enough
    void adbCommand("UPDATE ReadMark SET who = :who, pos = :pos, at = :at UPSERT WHERE who = :who AND pos = :pos", "sql", {
      who,
      pos: h,
      at: new Date(now).toISOString(),
    }).catch((e) => log.warn(`read mark not stored: ${String(e).slice(0, 120)}`));
  }
}

/**
 * The lowest home a write by this identity may get: the deepest position from
 * which both its own origin and everything it read in the window are
 * visible. What was read through a grant pulls this above the grantee.
 */
export function derivedFloor(identity, origin) {
  if (!SCOPED || !positionMap || origin === undefined || identity.open || policy.derivedWindowHours === 0) return origin;
  const cutoff = Date.now() - windowMs();
  const read = [...(readMarks.get(markKey(identity)) ?? new Map())].filter(([, t]) => t > cutoff).map(([h]) => h);
  return commonAncestor(positionMap, [origin, ...read]);
}

/**
 * Would the floor hold this worker's write above where the entry lives? Then
 * not silently: the worker is told what it read, and either leaves the entry
 * or proposes the write (an admin decides who sees it). Null when it wouldn't.
 */
function workerLift(identity, home) {
  if (!SCOPED || !positionMap || home === undefined) return null;
  const at = effectiveHome(positionMap, home);
  const floor = derivedFloor(identity, at);
  if (!floorLifts(positionMap, at, floor)) return null;
  const cutoff = Date.now() - windowMs();
  const above = [...(readMarks.get(markKey(identity)) ?? new Map())]
    .filter(([h, t]) => t > cutoff && commonAncestor(positionMap, [at, h]) !== at)
    .map(([h]) => homeName(positionMap, h));
  return { floor, home: at, read: [...new Set(above)] };
}

/**
 * Where a worker's write to an entry that lives at `lives` lands, judged the one way for every
 * worker write tool: lifted (refused or proposed) when what it read is hidden from people there,
 * else floored by what it read. `lives` may be an entry row instead of a home: the write is then
 * judged against the home that row is seen from.
 */
export function workerWriteFloor(identity, lives) {
  const at = readHome(lives);
  const home = at === undefined || !positionMap ? at : effectiveHome(positionMap, at);
  const lift = workerLift(identity, home);
  return { lift, home, floor: lift ? lift.home : derivedFloor(identity, home) };
}

/**
 * What the people who see a worker's entry see (a scope), or null when that can't be told. A
 * master's task sits at the root (only the admin sees it): its audience is what the people who
 * see all of the entries it's about see.
 */
export async function entryAudience(role) {
  const rid = role?.entry;
  if (!SCOPED || !positionMap || !RID_RE.test(String(rid ?? ""))) return null;
  const rec = (await adbQuery(`SELECT _home, _kind FROM ${rid}`).catch(() => []))[0];
  if (!rec?._home) return null;
  let homes = [rec._home];
  if (rec._kind === "task") {
    const payload = JSON.parse((await adbQuery("SELECT payload FROM Job WHERE id = :id", { id: role.job }).catch(() => []))[0]?.payload || "{}");
    const names = (payload.entries ?? []).slice(0, 25);
    if (!names.length) return null;
    homes = [];
    for (const n of names) homes.push(...(await adbQuery(`SELECT _home FROM ${ENTITY_LABEL} WHERE name = :n AND _kind IS NULL`, { n }).catch(() => [])).map((r) => r._home));
    if (!homes.length) return null;
  }
  const seen = homes.map((h) => visibleHomes(positionMap, [effectiveHome(positionMap, h)]));
  if (seen.every((v) => v === null)) return { homes: null, root: false };
  const sets = seen.filter((v) => v !== null);
  return { homes: new Set([...sets[0]].filter((h) => sets.every((v) => v.has(h)))), root: false };
}

/** a worker's update grading found more sensitive: it stays where it's seen from, and says how to hide it if it must be */
export const heldNote = (from, reason) =>
  `kept where it's seen from: grading judged this update more sensitive (${reason}), but a worker's update never hides an entry from its people. If people at ${homeName(positionMap, from)} mustn't see it, move it with set_home and a reason`;

export const liftRefusal = (name, lift) =>
  `Not written: "${name}" lives at ${homeName(positionMap, lift.home)}, but in the last ${policy.derivedWindowHours} hours you read entries at ${lift.read.join(", ") || homeName(positionMap, lift.floor)} that people there can't see, so this write would be held at ${homeName(positionMap, lift.floor)} instead. Either leave the entry as it is, or write it again with propose: true and a reason that says what it rests on: an admin then decides whether it's written at ${homeName(positionMap, lift.home)}.`;

/**
 * The check's calls for one write (check.js): per entity a verdict, or undefined when there is no answer.
 * Unconfigured, switched off (policy.gradingEnabled) or paused after failures is no answer too: whatever it
 * writes waits admin-only until the check answers (R11.11). A failure pauses the decision model (health), so
 * an outage costs one call, not one per section.
 */
async function checkBatch(origin, entities) {
  const config = decisionConfig(context);
  if (!checkReady() || health.down("decisions")) return entities.map(() => undefined);
  let failed = false;
  const out = await checkEntities(positionMap, origin, entities, {
    topics: policy.restrictedTopics,
    threshold: policy.gradingConfidence,
    ask: async (req) => (failed || health.down("decisions") ? null : askWith(config)(req)),
    onError: (e, ent) => {
      failed = true;
      if (!health.fail("decisions", e, e.status)) log.warn(`check of ${ent.name} gave no answer (admin-only until checked): ${String(e?.message ?? e).slice(0, 160)}`);
    },
  });
  if (!failed && out.some((v) => v !== undefined)) health.ok("decisions");
  return out;
}

/** the check is on and can be asked (else every write waits admin-only and nothing rechecks) */
export function checkReady() {
  const c = decisionConfig(context);
  return Boolean(policy.gradingEnabled && c.url && c.key && c.model);
}

/**
 * The language-model grader is gone (R4: the language-model fallback goes), and with it the end dates it
 * judged. Kept for requests.js, which asked it how long a question matters: it now always gives no answer,
 * so a question lasts as long as it is open. (The integrator can drop that call.)
 * NEEDS A RULING (record 10): no typed question judges end dates; a writer's own valid_until still stands.
 */
export async function gradeBatch(_origin, entities) {
  return entities.map(() => undefined);
}

/**
 * Where each entity of a scoped write lands. `origin` is the writer's resolved position (provenance: a
 * section starts at the position of the person who put it on record, R11.5); an existing entity is (name,
 * origin). Each one is checked once (check.js), and the check only restricts (R4); `floor` (what the writer
 * read) holds it no lower than that (R11.13). No answer: admin-only until checked (R11.11).
 *
 * NEEDS A RULING (record 11): R4 says once per section; every entity written through upsertEntities is
 * checked the same way here, sections or not (the restrict-only side). Nothing at the root or for everyone
 * is checked: nothing is above it to restrict to.
 */
export async function placeEntities(entities, origin, floor) {
  const existing = await Promise.all(
    entities.map((e) =>
      adbQuery(`SELECT _home, _ungraded FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin LIMIT 1`, { name: e.name, origin }).then((rows) =>
        rows[0] ? { home: effectiveHome(positionMap, rows[0]._home), awaiting: Boolean(rows[0]._ungraded), marker: markerOf(rows[0]._ungraded) } : undefined,
      ),
    ),
  );
  const at = (i) => existing[i]?.home;
  if (origin === EVERYONE || origin === positionMap.root) {
    const note = origin === EVERYONE ? "for everyone" : "at the root: nothing above it to restrict to";
    return entities.map((_, i) => ({ ...applyFloor(positionMap, { home: at(i) ?? origin, note }, origin, floor), graded: true }));
  }
  const verdicts = await checkBatch(origin, entities);
  return entities.map((_, i) => {
    // still waiting for its check: the marker is rewritten with this write's text (placement.js placeOverWaiting)
    const p = existing[i]?.awaiting
      ? placeOverWaiting(positionMap, { origin, verdict: verdicts[i], held: at(i), marker: existing[i].marker, floor })
      : placeOne(positionMap, { origin, verdict: verdicts[i], existing: at(i), floor });
    return { ...p, graded: verdicts[i] !== undefined };
  });
}

/** an entry's waiting marker, parsed ({} when unreadable) */
function markerOf(json) {
  try {
    const w = JSON.parse(json || "{}");
    return w && typeof w === "object" ? w : {};
  } catch {
    return {};
  }
}

/** the check as an identity: an agent with no position, whose every write is a proposal */
const CHECK_IDENTITY = { user: "graph-rag check", caps: { write: "queued" }, positions: [], agent: true };

/** an unsure check is flagged to a person: a proposal to bring the entry back to its origin (R11.11) */
export async function askAboutPlacement(rid, name, p) {
  const ask = p.review;
  if (!ask) return;
  // the check never moves anything lower itself: the rule says propose (a queued identity, widening)
  const d = decideWrite(CHECK_IDENTITY, { kind: "rehome", lives: p.home }, { to: ask.to, reason: ask.reason });
  if (d.action === "direct") return log.warn(`check proposal for ${name} not queued: the rule allowed it directly (never expected)`);
  await queueWrite({
    kind: "rehome",
    payload: JSON.stringify({ rid, name, from: p.home, to: ask.to, reason: ask.reason }),
    user: CHECK_IDENTITY.user,
    home: d.home,
  }).catch((err) => log.warn(`check proposal for ${name} not queued: ${String(err).slice(0, 120)}`));
}

/**
 * Entries the check gave no answer for wait admin-only, marked _ungraded ({ origin, floor, held, written_at,
 * text }). Once the decision model answers they are checked as when they were written and placed by the same
 * rules: no person has to move them. One that someone moved meanwhile stays where they put it. A document's
 * title follows its sections (R11.13).
 */
export async function regradeTick() {
  if (!SCOPED || !positionMap || !checkReady() || health.down("decisions")) return;
  const rows = await adbQuery(`SELECT @rid AS rid, name, _home, _kind, _doc_id, _ungraded, heading FROM ${ENTITY_LABEL} WHERE _ungraded IS NOT NULL LIMIT 16`);
  for (const r of rows) {
    const rid = String(r.rid);
    let w = null;
    try {
      w = JSON.parse(r._ungraded);
    } catch {
      /* unreadable: nothing to check from */
    }
    // its origin is gone from the tree: it stays where it waits (no lower home to return to)
    if (!w || !positionMap.positions[w.origin]) {
      await adbCommand(`UPDATE ${rid} SET _ungraded = null`);
      continue;
    }
    if (effectiveHome(positionMap, r._home) !== w.held) {
      // someone moved it while it waited: their call stands
      await adbCommand(`UPDATE ${rid} SET _ungraded = null`);
      continue;
    }
    const full = (await adbQuery(`SELECT FROM ${rid}`))[0] ?? {};
    const entity = {
      name: r.name,
      facets: Object.fromEntries(Object.keys(full).filter((k) => k.startsWith("text_") && full[k]).map((k) => [k.slice(5), full[k]])),
      ...(typeof w.text === "string" ? { _text: w.text } : {}),
      ...(r.heading ? { properties: { heading: r.heading } } : {}),
    };
    const [verdict] = await checkBatch(w.origin, [entity]);
    if (verdict === undefined) return; // still no answer: next time
    const p = placeOne(positionMap, { origin: w.origin, verdict, floor: w.floor ?? w.origin });
    // a class map entry that tightened while it waited (tightening.js): no lower than the home the rule requires
    // (`rule`; an older marker has only `held`, where the rule put it)
    const rule = w.rule && positionMap.positions[w.rule] ? w.rule : w.raised ? w.held : null;
    // an update that got no answer: never below where it was before the new text (`keep`, check.js placeChecked)
    const keep = w.keep && positionMap.positions[w.keep] ? w.keep : null;
    const home = commonAncestor(positionMap, [p.home, ...(rule ? [rule] : []), ...(keep ? [keep] : [])]);
    const note = w.raised && rule && home === rule && home !== p.home ? w.raised : p.note;
    await adbCommand(`UPDATE ${rid} SET _home = :home, _grade = :note, _ungraded = null`, "sql", { home, note });
    if (r._doc_id) await settleDocument(r._doc_id).catch((e) => log.warn(`document ${r._doc_id} not settled after its check: ${String(e).slice(0, 160)}`));
    if (home !== w.held) {
      const about = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`).catch(() => []);
      for (const a of about) if (RID_RE.test(String(a.dst))) await instanceSeenFrom(String(a.dst), home, { from: w.held }).catch(() => {});
    }
    await askAboutPlacement(rid, r.name, { ...p, home });
    log.info(`checked ${r.name} after waiting: ${homeName(positionMap, home)} (${note})`);
  }
}
