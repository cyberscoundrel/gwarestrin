/**
 * Derived data and placement: what an identity read bounds where its writes land (read marks, the floor,
 * the worker lift), grading, and where each entity of a write is placed (placement.js decides).
 */
import { commonAncestor, effectiveHome, EVERYONE, homeName, visibleHomes } from "./positions.js";
import { gradingPrompt, parseVerdicts } from "./grading.js";
import { applyFloor, claimsSettle, floorLifts, hasClaims, place as placeOne, placeByClaims } from "./placement.js";
import { authorityOf, claimHome, claimHomes } from "./model/authority.js";
import { GRADER_MODEL, GRADER_TIMEOUT_MS, health, log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { modelPost } from "./models.js";
import { positionMap, SCOPED } from "./scope.js";
import { decideWrite, queueWrite } from "./write.js";
import { thingSeenFrom } from "./linker.js";
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

/** the home a read item is seen from: a home id, or a claim/entry read (its `_home`, else its section's) */
const readHome = (x) => (typeof x === "string" ? x : x && typeof x === "object" ? (x._home ?? x.home ?? x.section_home ?? undefined) : undefined);

/**
 * Remember the homes an identity was shown (persisted, so a restart forgets nothing). Each item
 * is a home id, or a claim (or entry row) that was read: a read of a claim marks the home it is
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
 * else floored by what it read. `lives` may be a claim (or entry row) instead of a home: the
 * write is then judged against the home that claim is seen from.
 */
export function workerWriteFloor(identity, lives) {
  const at = readHome(lives);
  const home = at === undefined || !positionMap ? at : effectiveHome(positionMap, at);
  const lift = workerLift(identity, home);
  return { lift, home, floor: lift ? lift.home : derivedFloor(identity, home) };
}

/**
 * The derived-data floor restated on claims: the lowest home a write of these claims from
 * `origin` may get is where both what the writer read and every claim's authority are visible
 * (claimHome never goes below the origin). Without claims it is derivedFloor.
 */
export function claimWriteFloor(identity, origin, claims, rules = policy.authorityMap) {
  if (!SCOPED || !positionMap || origin === undefined) return origin;
  const keys = (Array.isArray(claims) ? claims : []).map((c) => ({ class: c?.class ?? c?.subject?.class ?? null, attribute: c?.attribute ?? null }));
  return commonAncestor(positionMap, [derivedFloor(identity, origin), ...claimHomes(keys, origin, rules, positionMap)]);
}

/**
 * The claims an entry carries, for the authority rule: its CLAIMS edges (class, attribute, the
 * home each is seen from) when the model's schema is in place, else the summary a claim-bearing
 * write stored on it (`_claim_classes`). Empty for residue: an entry no claim was extracted from.
 */
export async function claimsOfEntry(rid) {
  if (!RID_RE.test(String(rid ?? ""))) return [];
  const edges = await adbQuery(`SELECT class, attribute, _home FROM (SELECT expand(outE('CLAIMS')) FROM ${rid})`).catch(() => []);
  if (edges.length) return edges.map((e) => ({ class: e.class ?? null, attribute: e.attribute ?? null, _home: e._home ?? undefined }));
  const row = (await adbQuery(`SELECT _claim_classes, _home FROM ${rid}`).catch(() => []))[0];
  try {
    const list = JSON.parse(row?._claim_classes || "[]");
    return Array.isArray(list) ? list.filter((c) => c && typeof c === "object").map((c) => ({ class: c.class ?? null, attribute: c.attribute ?? null, _home: row?._home ?? undefined })) : [];
  } catch {
    return [];
  }
}

/**
 * An entry's home changed: every claim it carries follows, to the stricter of its new home and the
 * claim's authority under today's rule, and the thing a claim is about is seen from where the claim
 * now is. Every write of a section's home ends here (the regrade, a move, an update, an ingest
 * finishing), so a claim is never stranded above or below the section it came from (decision 5).
 * Idempotent. A database failure is thrown, so the caller doesn't record a move its claims missed.
 */
export async function claimsFollowEntry(rid, to) {
  if (!positionMap || !RID_RE.test(String(rid))) return;
  const edges = await adbQuery(`SELECT @rid AS rid, @in AS dst, class, attribute, _home FROM (SELECT expand(outE('CLAIMS')) FROM ${rid})`);
  for (const e of edges) {
    const home = claimHome(positionMap, to, authorityOf(policy.authorityMap, e.class ?? null, e.attribute ?? null));
    if (e._home === home) continue;
    await adbCommand(`UPDATE ${e.rid} SET _home = :home`, "sql", { home });
    // an unresolved claim points back at its own section: no thing to show
    if (RID_RE.test(String(e.dst)) && String(e.dst) !== String(rid)) await thingSeenFrom(String(e.dst), home);
  }
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
 * (name, origin). An entity carrying claims (`claims`, the contract's shape)
 * is placed by its claims' authority. The grader runs on the residue (entities
 * with no claims) and on any entity whose claims don't settle it (claimsSettle:
 * a claim with no rule, or a sentence no claim states), where the claims'
 * placement holds as the floor under its verdict. Without a grader: new residue
 * at the origin, existing ones where they are.
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
  // the claim-bearing entities: placed by the rule; the ones whose claims settle them get no model call
  const byClaims = new Map();
  const unsettled = new Set(); // claim-bearing, and the grader judges them too
  for (const [i, e] of entities.entries()) {
    if (!hasClaims(e)) continue;
    const placed = placeByClaims(positionMap, { origin, claims: e.claims, policy: policy.authorityMap, existing: at(i), awaiting: existing[i]?.awaiting, floor });
    byClaims.set(i, placed);
    // at the top already (or written for everyone on purpose) there is nothing above to restrict to
    if (origin !== EVERYONE && placed.home !== positionMap.root && !claimsSettle(e, policy.authorityMap)) unsettled.add(i);
  }
  const residue = entities.map((e, i) => (byClaims.has(i) && !unsettled.has(i) ? null : e));
  const merge = (placed) => entities.map((_, i) => byClaims.get(i) ?? placed[i]);
  const grading = Boolean(GRADER_MODEL) && policy.gradingEnabled;
  if (!grading) return merge(entities.map((_, i) => applyFloor(positionMap, { home: at(i) ?? origin, note: "not graded (grading off)" }, origin, floor)));
  // written for everyone: graded from the top for its end date only (everyone isn't a position to describe)
  const verdicts = await gradeResidue(origin === EVERYONE ? positionMap.root : origin, residue, writtenAt);
  if (origin === EVERYONE) {
    // written for everyone on purpose (the admin, or a survey for everyone): graded for its end date only
    return merge(entities.map((_, i) => ({ ...applyFloor(positionMap, { home: at(i) ?? origin, note: "for everyone" }, origin, floor), until: graderUntil(verdicts[i]) })));
  }
  if (origin === positionMap.root) {
    // nothing above the root to restrict to: graded for its end date only
    return merge(entities.map((_, i) => ({ ...applyFloor(positionMap, { home: at(i) ?? origin, note: "at the root" }, origin, floor), until: graderUntil(verdicts[i]) })));
  }
  return entities.map((_, i) => {
    if (byClaims.has(i) && !unsettled.has(i)) return byClaims.get(i);
    const ruled = byClaims.get(i);
    const p = placeOne(positionMap, {
      origin,
      verdict: verdicts[i],
      graded: verdicts[i] !== undefined,
      existing: at(i),
      // still awaiting grading: this write's grading settles it like a new one
      awaiting: existing[i]?.awaiting && verdicts[i] !== undefined,
      // the claims' placement holds under the verdict: the grader may only restrict further
      floor: ruled ? commonAncestor(positionMap, [floor, ruled.home]) : floor,
      threshold: policy.gradingConfidence,
    });
    return {
      ...p,
      graded: verdicts[i] !== undefined,
      // claims carry their own intervals: the grader's end date is for residue only
      ...(ruled
        ? { note: ruled.authority && p.home === ruled.home ? ruled.note : p.note, claims: ruled.claims, authority: ruled.authority }
        : { until: graderUntil(verdicts[i]) }),
    };
  });
}

/** grade the residue only (null slots are claim-bearing and skipped); verdicts come back by the original index */
async function gradeResidue(origin, residue, writtenAt) {
  const idx = residue.map((e, i) => (e ? i : -1)).filter((i) => i >= 0);
  const out = new Array(residue.length).fill(undefined);
  if (!idx.length) return out;
  const verdicts = await gradeBatch(origin, idx.map((i) => residue[i]), writtenAt);
  for (const [k, i] of idx.entries()) out[i] = verdicts[k];
  return out;
}

/** the grader as an identity: an agent with no position, whose every write is a proposal */
const GRADER_IDENTITY = { user: "graph-rag grader", caps: { write: "queued" }, positions: [], agent: true };

/** grading's proposals go to a person: release lower, or review an unsure call */
export async function askAboutPlacement(rid, name, p) {
  const ask = p.release ?? p.review;
  if (!ask) return;
  // the grader never moves anything itself: the rule says propose (a queued identity, widening)
  const d = decideWrite(GRADER_IDENTITY, { kind: "rehome", lives: p.home }, { to: ask.to, reason: ask.reason });
  if (d.action === "direct") return log.warn(`grading proposal for ${name} not queued: the rule allowed it directly (never expected)`);
  await queueWrite({
    kind: "rehome",
    payload: JSON.stringify({ rid, name, from: p.home, to: ask.to, reason: ask.reason }),
    user: GRADER_IDENTITY.user,
    home: d.home,
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
  const rows = await adbQuery(`SELECT @rid AS rid, name, _home, _kind, _doc_id, _ungraded, _valid_by, _claim_classes FROM ${ENTITY_LABEL} WHERE _ungraded IS NOT NULL LIMIT 16`);
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
    // a document before its sections: a section is homed no lower than its document, as the document now stands
    group.sort((a, b) => Number(b._kind === "document") - Number(a._kind === "document"));
    const { origin, written_at } = group[0].w;
    const entities = [];
    for (const r of group) {
      const full = (await adbQuery(`SELECT FROM ${r.rid}`))[0] ?? {};
      // a claim-bearing section's whole text was kept with what it waits on (its stored facet is a preview)
      entities.push({ name: r.name, facets: Object.fromEntries(Object.keys(full).filter((k) => k.startsWith("text_") && full[k]).map((k) => [k.slice(5), full[k]])), ...(typeof r.w.text === "string" ? { _text: r.w.text } : {}) });
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
      // a section waits for its document, then stays no lower than where it settled
      let docHome = [];
      if (r._kind === "section" && r._doc_id) {
        const doc = (await adbQuery(`SELECT _home, _doc_base, _ungraded FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: r._doc_id }))[0];
        if (doc?._ungraded) continue;
        // the document's own grade: its _home has been raised to this very section's while it waits (document-home.js)
        if (doc) docHome = [effectiveHome(positionMap, doc._doc_base ?? doc._home)];
      }
      // an entry that also carries claims stays no lower than their authority puts it
      let claimed = [];
      try {
        claimed = claimHomes(JSON.parse(r._claim_classes || "[]"), origin, policy.authorityMap, positionMap);
      } catch {
        /* unreadable: the recorded floor is all there is */
      }
      const p = placeOne(positionMap, { origin, verdict: verdicts[i], floor: commonAncestor(positionMap, [r.w.floor ?? origin, ...docHome, ...claimed]), threshold: policy.gradingConfidence });
      const until = graderUntil(verdicts[i]);
      // the grader's end date, unless its writer gave one
      const validSql = until !== undefined && r._valid_by !== "writer" ? ", _valid_until = :until, _valid_by = 'grader'" : "";
      // the claims first: if this fails the section is still waiting and the next tick does both
      await claimsFollowEntry(rid, p.home);
      // raised by a tightened rule while it waited, and the grader adds nothing: the rule is still why it is here
      const note = r.w.raised && p.home === r.w.held ? r.w.raised : p.note;
      await adbCommand(`UPDATE ${rid} SET _home = :home, _grade = :note, _ungraded = null${validSql}`, "sql", { home: p.home, note, until });
      // a document's title goes with its most restricted section: its graded home or a section's has changed
      if (r._kind === "document") await adbCommand(`UPDATE ${rid} SET _doc_base = :home`, "sql", { home: p.home });
      if (r._doc_id) await settleDocument(r._doc_id).catch((e) => log.warn(`document ${r._doc_id} not settled after grading: ${String(e).slice(0, 160)}`));
      if (p.home !== r.w.held) {
        const about = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`).catch(() => []);
        for (const a of about) if (RID_RE.test(String(a.dst))) await thingSeenFrom(String(a.dst), p.home).catch(() => {});
      }
      await askAboutPlacement(rid, r.name, p);
      log.info(`graded ${r.name} after waiting: ${homeName(positionMap, p.home)} (${p.note})`);
    }
  }
}
