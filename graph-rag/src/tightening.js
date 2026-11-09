/**
 * An authority rule tightens over what is already written (docs/ORGANIZATION-MODEL.md, decision 5): every
 * entry holding a claim the rule now covers moves to the stricter home, its text with it, so plain reads
 * stop showing the sentence the claim came from. Loosening moves nothing.
 *
 * Each change to the map is a PolicyChange row that stays `pending` until every entry it covers is done,
 * so a restart picks it up where the graph stands. Finding what to move is a query over what the map
 * now says and each entry's commit is its own home written last, so running a change twice does nothing
 * the second time. Whatever changed the map, the settings route or a direct edit of the stored policy,
 * shows up as a difference from the last map a change recorded.
 */
import { ancestors, commonAncestor, effectiveHome, EVERYONE, homeName } from "./positions.js";
import { authorityRule, claimHome, tightens } from "./model/authority.js";
import { canonical } from "./documents.js";
import { log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { claimsFollowEntry } from "./floor.js";
import { thingSeenFrom } from "./linker.js";
import { EMPTY_AUTHORITY_MAP } from "./policy.js";
import { loadPolicy, policy, policyMeta, serialized } from "./org-policy.js";
import { positionMap, SCOPED } from "./scope.js";

/** who a change is put down to when nobody saved it through the settings */
const OUTSIDE = "a change outside the settings (AUTHORITY_MAP or a direct edit of the stored policy)";
const NO_LIMIT = 5_000_000;

const mapIn = (json) => {
  try {
    return JSON.parse(json).authorityMap ?? EMPTY_AUTHORITY_MAP;
  } catch {
    return EMPTY_AUTHORITY_MAP;
  }
};

/** does this change of the map need going through (status for its PolicyChange row) */
export const changeStatus = (prev, next) => (SCOPED && positionMap && canonical(prev) !== canonical(next) ? "pending" : null);

/** a difference between the map in force and the last one a change recorded becomes a change of its own */
async function noteChange() {
  await loadPolicy();
  const last = (await adbQuery("SELECT changed_at, next_json FROM PolicyChange WHERE rehome_status IS NOT NULL ORDER BY changed_at DESC LIMIT 1"))[0];
  const now = new Date().toISOString();
  const row = (status, by, prev) =>
    adbCommand("INSERT INTO PolicyChange SET changed_at = :now, changed_by = :by_user, prev_json = :prev, next_json = :next, rehome_status = :status", "sql", {
      now,
      by_user: by,
      prev: JSON.stringify({ ...policy, authorityMap: prev }),
      next: JSON.stringify(policy),
      status,
    });
  // a graph from before this: what is written stays as it is, and later changes count from here
  if (!last) return row("baseline", "re-homing starts from this map", policy.authorityMap);
  const before = mapIn(last.next_json);
  if (canonical(before) === canonical(policy.authorityMap)) return;
  // the settings write the row, then the change with the same time: a row newer than any change is a crash between them, and says who
  const logged = (await adbQuery("SELECT changed_at FROM PolicyChange ORDER BY changed_at DESC LIMIT 1"))[0];
  const saved = policyMeta.updated_at && policyMeta.updated_at > logged.changed_at;
  await row("pending", saved ? (policyMeta.updated_by ?? OUTSIDE) : OUTSIDE, before);
}

/** the homes an entry leaves going up: where it was and the positions between, not where it lands */
function homesLeft(from, to) {
  if (from === to) return [];
  if (from === EVERYONE) return [EVERYONE];
  const up = [from, ...ancestors(positionMap, from)];
  const i = up.indexOf(to);
  return i < 0 ? [from] : up.slice(0, i);
}

const thingsOf = async (rid) => {
  const out = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('CLAIMS', 'ABOUT')) FROM ${rid})`);
  return [...new Set(out.map((e) => String(e.dst)).filter((d) => RID_RE.test(d) && d !== rid))];
};

/** a thing stops being seen from a home once no statement there is about it (it follows the statements, things.js) */
async function thingLeaves(thing, left, except) {
  if (!left.length) return;
  const row = (await adbQuery(`SELECT _homes FROM ${thing}`))[0];
  const homes = Array.isArray(row?._homes) ? row._homes : [];
  if (!left.some((h) => homes.includes(h))) return;
  const edges = await adbQuery(`SELECT _home FROM (SELECT expand(inE('CLAIMS')) FROM ${thing})`);
  const entries = await adbQuery(`SELECT @rid AS rid, _home FROM (SELECT expand(in('ABOUT')) FROM ${thing})`);
  const held = new Set([...edges.map((e) => e._home), ...entries.filter((e) => String(e.rid) !== except).map((e) => e._home)].map((h) => effectiveHome(positionMap, h)));
  const keep = homes.filter((h) => !left.includes(h) || held.has(h));
  if (keep.length !== homes.length) await adbCommand(`UPDATE ${thing} SET _homes = :homes`, "sql", { homes: keep });
}

/**
 * One entry up: its claims and the things they are about first, its own home last. Until that last
 * write it still counts as not moved, so a restart does the whole of it again. What waits for the
 * grader goes on waiting from its new home (regradeTick compares with `held`).
 */
async function raise(row, to, note) {
  const rid = String(row.rid);
  const from = effectiveHome(positionMap, row._home);
  await claimsFollowEntry(rid, to);
  for (const thing of await thingsOf(rid)) {
    await thingSeenFrom(thing, to);
    await thingLeaves(thing, homesLeft(from, to), rid);
  }
  let waiting = null;
  try {
    waiting = row._ungraded ? JSON.stringify({ ...JSON.parse(row._ungraded), held: to, raised: note }) : null;
  } catch {
    /* unreadable: regradeTick clears it */
  }
  await adbCommand(`UPDATE ${rid} SET _home = :to, _grade = :note${waiting ? ", _ungraded = :waiting" : ""}`, "sql", { to, note, waiting });
  log.info(`${row.name ?? rid}: ${homeName(positionMap, from)} -> ${homeName(positionMap, to)} (${note})`);
}

/**
 * The document entry, once none of its sections is left where it stands: people there would see a title
 * and nothing under it, so it goes up to the lowest home one of its sections has. Sections are never
 * lower than their document, and any section still seen where the document is keeps the document there.
 */
async function documentFollows(section, to, note) {
  if (!section._doc_id) return;
  const doc = (await adbQuery(`SELECT @rid AS rid, name, _home, _ungraded FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: section._doc_id }))[0];
  if (!doc) return;
  const rows = await adbQuery(`SELECT @rid AS rid, _home FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :d LIMIT ${NO_LIMIT}`, { d: section._doc_id });
  const homes = rows.map((s) => (String(s.rid) === String(section.rid) ? to : effectiveHome(positionMap, s._home)));
  const from = effectiveHome(positionMap, doc._home);
  const above = (h) => h !== EVERYONE && (from === EVERYONE || ancestors(positionMap, from).includes(h));
  if (!homes.length || !homes.every(above)) return;
  const depth = (h) => ancestors(positionMap, h).length;
  await raise(doc, homes.reduce((a, b) => (depth(b) > depth(a) ? b : a)), `${note}; none of its sections is left below that`);
}

/** every entry holding a claim this change tightened, with the claims' class and attribute */
async function entriesTightened(prev, next) {
  const tight = (k) => tightens(prev, next, k.class ?? null, k.attribute ?? null, positionMap);
  const found = new Map();
  const add = (rid, k) => found.set(rid, [...(found.get(rid) ?? []), { class: k.class ?? null, attribute: k.attribute ?? null }]);
  const keys = (await adbQuery(`SELECT class, attribute FROM CLAIMS GROUP BY class, attribute LIMIT ${NO_LIMIT}`)).filter(tight);
  for (const k of keys) {
    const field = (name) => (k[name] === null || k[name] === undefined ? `${name} IS NULL` : `${name} = :${name}`);
    const rows = await adbQuery(`SELECT @out AS src FROM CLAIMS WHERE ${field("class")} AND ${field("attribute")} LIMIT ${NO_LIMIT}`, { class: k.class, attribute: k.attribute });
    for (const r of rows) add(String(r.src), k);
  }
  // written but with no CLAIMS edge yet (an ingest still running): the summary its write stored
  for (const r of await adbQuery(`SELECT @rid AS rid, _claim_classes FROM ${ENTITY_LABEL} WHERE _claim_classes IS NOT NULL LIMIT ${NO_LIMIT}`)) {
    let list = [];
    try {
      list = JSON.parse(r._claim_classes);
    } catch {
      /* unreadable: its edges were counted above */
    }
    for (const k of Array.isArray(list) ? list.filter((c) => c && tight(c)) : []) add(String(r.rid), k);
  }
  return found;
}

/** go through one change: returns how many entries it raised */
async function applyChange(change) {
  const [prev, next] = [mapIn(change.prev_json), mapIn(change.next_json)];
  const stamp = `tightened by ${change.changed_by} on ${String(change.changed_at).slice(0, 10)}`;
  let moved = 0;
  for (const [rid, keys] of await entriesTightened(prev, next)) {
    if (!RID_RE.test(rid)) continue;
    const row = (await adbQuery(`SELECT @rid AS rid, name, _home, _doc_id, _ungraded, _placed_at FROM ${rid} WHERE name IS NOT NULL`))[0];
    // a person placed it after this rule changed: their call stands
    if (!row || (row._placed_at && row._placed_at > change.changed_at)) continue;
    const from = effectiveHome(positionMap, row._home);
    const homes = keys.map((k) => ({ ...k, home: claimHome(positionMap, from, authorityRule(next, k.class, k.attribute)?.authority ?? null) }));
    const to = commonAncestor(positionMap, homes.map((h) => h.home));
    if (to === from) {
      await claimsFollowEntry(rid, to);
      continue;
    }
    const by = homes.find((h) => h.home === to);
    const note = `raised to ${homeName(positionMap, to)}: the rule ${authorityRule(next, by.class, by.attribute).field} now covers ${[by.class, by.attribute].filter(Boolean).join("/")}, ${stamp}`;
    // what was extracted from it says the same things, and is homed no lower than it
    for (const fact of await adbQuery(`SELECT @rid AS rid, name, _home, _ungraded FROM (SELECT expand(in('SOURCED_FROM')) FROM ${rid})`)) {
      const above = commonAncestor(positionMap, [fact._home, to]);
      if (above !== effectiveHome(positionMap, fact._home)) await raise(fact, above, note);
    }
    await documentFollows(row, to, note);
    await raise(row, to, note);
    moved++;
  }
  return moved;
}

async function workThrough() {
  if (!SCOPED || !positionMap) return;
  await serialized(noteChange);
  for (;;) {
    const change = (await adbQuery("SELECT @rid AS rid, changed_at, changed_by, prev_json, next_json FROM PolicyChange WHERE rehome_status = 'pending' ORDER BY changed_at ASC LIMIT 1"))[0];
    if (!change) return;
    const moved = await applyChange(change);
    await adbCommand(`UPDATE ${change.rid} SET rehome_status = 'done', rehome_moved = :moved, rehome_done_at = :at`, "sql", { moved: String(moved), at: new Date().toISOString() });
    if (moved) log.info(`authority rule tightened by ${change.changed_by}: ${moved} entries re-homed`);
  }
}

let running = null;
let again = false;

/** finish whatever changes wait: at boot, on a timer, and on every save. One at a time. */
export function settleTightening() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await workThrough();
    } while (again);
  })().finally(() => {
    running = null;
  });
  return running;
}

/** is re-homing still going (a large graph outlasts the save that started it) */
export const tighteningRunning = () => running !== null;
