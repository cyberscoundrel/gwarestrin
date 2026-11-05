/**
 * Derived data and placement: what an identity read bounds where its writes land (read marks, the floor,
 * the worker lift), grading, and where each entity of a write is placed (placement.js decides).
 */
import { commonAncestor, effectiveHome, EVERYONE, homeName, visibleHomes } from "./positions.js";
import { gradingPrompt, parseVerdicts } from "./grading.js";
import { applyFloor, floorLifts, place as placeOne } from "./placement.js";
import { GRADER_MODEL, GRADER_TIMEOUT_MS, health, log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { modelPost } from "./models.js";
import { positionMap, SCOPED } from "./scope.js";
import { queueWrite } from "./write.js";
import { thingSeenFrom } from "./linker.js";
import { policy } from "./server.js";

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

/** remember the homes an identity was shown (persisted, so a restart forgets nothing) */
export function recordReads(identity, homes) {
  if (!SCOPED || !positionMap || identity.open) return;
  const now = Date.now();
  const who = markKey(identity);
  if (!readMarks.has(who)) readMarks.set(who, new Map());
  const mine = readMarks.get(who);
  for (const h of new Set(homes.filter((x) => typeof x === "string"))) {
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
 * else floored by what it read.
 */
export function workerWriteFloor(identity, lives) {
  const home = lives === undefined || !positionMap ? lives : effectiveHome(positionMap, lives);
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
 * One grading call (chunks of up to 16 entities). Per entity: a verdict,
 * null when the grader answered but not usably (a person reviews), or
 * undefined when it couldn't be reached (the entity is graded again later).
 */
export async function gradeBatch(origin, entities, writtenAt = Date.now()) {
  const out = [];
  for (let i = 0; i < entities.length; i += 16) {
    const chunk = entities.slice(i, i + 16);
    const { messages, byLabel } = gradingPrompt(positionMap, origin, chunk, writtenAt, policy.restrictedTopics);
    let text;
    try {
      text = (await modelPost(GRADER_MODEL, "/chat/completions", { messages, temperature: 0 }, Number(GRADER_TIMEOUT_MS))).choices?.[0]?.message?.content ?? "";
    } catch (e) {
      // unreached: held where it can't widen anything, and graded again when the grader is back (regradeTick)
      if (!e.outage) log.warn(`grading failed (entities held until graded): ${String(e).slice(0, 160)}`);
    }
    out.push(...(text === undefined ? chunk.map(() => undefined) : parseVerdicts(text, byLabel, positionMap, origin, chunk.map((e) => e.name), writtenAt, policy.restrictedTopics)));
  }
  return out;
}

/** the end date the grader judged: an unsure verdict means lasting, none leaves it be */
const graderUntil = (v) => (v ? (v.confidence >= policy.gradingConfidence ? v.until : null) : undefined);

/**
 * Where each entity of a scoped write lands (placement.js decides). `origin`
 * is the writer's resolved position (provenance); an existing entity is
 * (name, origin). Without a grader: new entities at the origin, existing
 * ones where they are.
 */
export async function placeEntities(entities, origin, floor, writtenAt = Date.now()) {
  const existing = await Promise.all(
    entities.map((e) =>
      adbQuery(`SELECT _home, _ungraded FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin LIMIT 1`, { name: e.name, origin }).then((rows) =>
        rows[0] ? { home: effectiveHome(positionMap, rows[0]._home), awaiting: Boolean(rows[0]._ungraded) } : undefined,
      ),
    ),
  );
  const at = (i) => existing[i]?.home;
  const grading = Boolean(GRADER_MODEL) && policy.gradingEnabled;
  if (!grading) return entities.map((_, i) => applyFloor(positionMap, { home: at(i) ?? origin, note: "not graded (grading off)" }, origin, floor));
  // written for everyone: graded from the top for its end date only (everyone isn't a position to describe)
  const verdicts = await gradeBatch(origin === EVERYONE ? positionMap.root : origin, entities, writtenAt);
  if (origin === EVERYONE) {
    // written for everyone on purpose (the admin, or a survey for everyone): graded for its end date only
    return entities.map((_, i) => ({ ...applyFloor(positionMap, { home: at(i) ?? origin, note: "for everyone" }, origin, floor), until: graderUntil(verdicts[i]) }));
  }
  if (origin === positionMap.root) {
    // nothing above the root to restrict to: graded for its end date only
    return entities.map((_, i) => ({ ...applyFloor(positionMap, { home: at(i) ?? origin, note: "at the root" }, origin, floor), until: graderUntil(verdicts[i]) }));
  }
  return entities.map((_, i) => ({
    ...placeOne(positionMap, {
      origin,
      verdict: verdicts[i],
      graded: verdicts[i] !== undefined,
      existing: at(i),
      // still awaiting grading: this write's grading settles it like a new one
      awaiting: existing[i]?.awaiting && verdicts[i] !== undefined,
      floor,
      threshold: policy.gradingConfidence,
    }),
    graded: verdicts[i] !== undefined,
    until: graderUntil(verdicts[i]),
  }));
}

/** grading's proposals go to a person: release lower, or review an unsure call */
export async function askAboutPlacement(rid, name, p) {
  const ask = p.release ?? p.review;
  if (!ask) return;
  await queueWrite({
    kind: "rehome",
    payload: JSON.stringify({ rid, name, from: p.home, to: ask.to, reason: ask.reason }),
    user: "graph-rag grader",
    home: p.home,
  }).catch((err) => log.warn(`grading proposal for ${name} not queued: ${String(err).slice(0, 120)}`));
}

/**
 * Entries written while the grader couldn't be reached wait one level up,
 * marked _ungraded. When the grader answers again they're graded as when
 * they were written and placed by the same rules (placement.js): no person
 * has to move them back. One that someone moved meanwhile stays where they
 * put it.
 */
export async function regradeTick() {
  if (!SCOPED || !positionMap || !GRADER_MODEL || !policy.gradingEnabled || health.down(`model:${GRADER_MODEL}`)) return;
  const rows = await adbQuery(`SELECT @rid AS rid, name, _home, _ungraded, _valid_by FROM ${ENTITY_LABEL} WHERE _ungraded IS NOT NULL LIMIT 16`);
  const waiting = [];
  for (const r of rows) {
    let w = null;
    try {
      w = JSON.parse(r._ungraded);
    } catch {
      /* unreadable: nothing to grade from */
    }
    // its origin is gone from the tree: it stays where it waits (no lower home to return to)
    if (w && positionMap.positions[w.origin]) waiting.push({ ...r, w });
    else await adbCommand(`UPDATE ${r.rid} SET _ungraded = null`);
  }
  const byOrigin = Map.groupBy(waiting, (r) => `${r.w.origin}|${r.w.written_at}`);
  for (const group of byOrigin.values()) {
    const { origin, written_at } = group[0].w;
    const entities = [];
    for (const r of group) {
      const full = (await adbQuery(`SELECT FROM ${r.rid}`))[0] ?? {};
      entities.push({ name: r.name, facets: Object.fromEntries(Object.keys(full).filter((k) => k.startsWith("text_") && full[k]).map((k) => [k.slice(5), full[k]])) });
    }
    const verdicts = await gradeBatch(origin, entities, Date.parse(written_at) || Date.now());
    if (verdicts.some((v) => v === undefined)) return; // still unreachable: next time
    for (const [i, r] of group.entries()) {
      const rid = String(r.rid);
      if (effectiveHome(positionMap, r._home) !== r.w.held) {
        // someone moved it while it waited: their call stands
        await adbCommand(`UPDATE ${rid} SET _ungraded = null`);
        continue;
      }
      const p = placeOne(positionMap, { origin, verdict: verdicts[i], floor: r.w.floor, threshold: policy.gradingConfidence });
      const until = graderUntil(verdicts[i]);
      // the grader's end date, unless its writer gave one
      const validSql = until !== undefined && r._valid_by !== "writer" ? ", _valid_until = :until, _valid_by = 'grader'" : "";
      await adbCommand(`UPDATE ${rid} SET _home = :home, _grade = :note, _ungraded = null${validSql}`, "sql", { home: p.home, note: p.note, until });
      if (p.home !== r.w.held) {
        const about = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`).catch(() => []);
        for (const a of about) if (RID_RE.test(String(a.dst))) await thingSeenFrom(String(a.dst), p.home).catch(() => {});
      }
      await askAboutPlacement(rid, r.name, p);
      log.info(`graded ${r.name} after waiting: ${homeName(positionMap, p.home)} (${p.note})`);
    }
  }
}
