/**
 * Re-homing (R6): when a class map entry tightens, sections related to instances of that class move to the
 * stricter home (the user's words: "Re-home sections"). Loosening moves nothing.
 * NEEDS A RULING (re-homing reach): smallest choice, the class's own instances only, by its class-level
 * entry; instances of its subclasses, and per-column entries, move nothing here.
 *
 * The record stream owns this module.
 *
 * Each change to the map is a PolicyChange row that stays `pending` until every entry it covers is done,
 * so a restart picks it up where the graph stands. Finding what to move is a query over what the map
 * now says and each entry's commit is its own home written last, so running a change twice does nothing
 * the second time. Whatever changed the map, the settings route or a direct edit of the stored policy,
 * shows up as a difference from the last map a change recorded.
 */
import { ancestors, commonAncestor, effectiveHome, EVERYONE, homeName } from "./positions.js";
import { tightens } from "./model/class-map.js";
import { canonical } from "./documents.js";
import { log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { instanceSeenFrom } from "./instances.js";
import { settleDocument } from "./document-home.js";
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
  const out = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`);
  return [...new Set(out.map((e) => String(e.dst)).filter((d) => RID_RE.test(d) && d !== rid))];
};

/** an instance stops being seen from a home once no section there is about it (R11: visible wherever a section about it is) */
async function thingLeaves(thing, left, except) {
  if (!left.length) return;
  const row = (await adbQuery(`SELECT _homes FROM ${thing}`))[0];
  const homes = Array.isArray(row?._homes) ? row._homes : [];
  if (!left.some((h) => homes.includes(h))) return;
  const entries = await adbQuery(`SELECT @rid AS rid, _home FROM (SELECT expand(in('ABOUT')) FROM ${thing})`);
  const held = new Set(entries.filter((e) => String(e.rid) !== except).map((e) => effectiveHome(positionMap, e._home)));
  const keep = homes.filter((h) => !left.includes(h) || held.has(h));
  if (keep.length !== homes.length) await adbCommand(`UPDATE ${thing} SET _homes = :homes`, "sql", { homes: keep });
}

/**
 * One entry up: the instances it is about first, its own home last. Until that last
 * write it still counts as not moved, so a restart does the whole of it again. What waits for its
 * check goes on waiting from its new home (regradeTick compares with `held`), and its recheck keeps it no
 * lower than `rule`, the home the class map now requires.
 */
async function raise(row, to, note, rule = to) {
  const rid = String(row.rid);
  const from = effectiveHome(positionMap, row._home);
  for (const thing of await thingsOf(rid)) {
    await instanceSeenFrom(thing, to);
    await thingLeaves(thing, homesLeft(from, to), rid);
  }
  let waiting = null;
  try {
    waiting = row._ungraded ? waitingWith(row._ungraded, { held: to, rule, raised: note }) : null;
  } catch {
    /* unreadable: regradeTick clears it */
  }
  await adbCommand(`UPDATE ${rid} SET _home = :to, _grade = :note${waiting ? ", _ungraded = :waiting" : ""}`, "sql", { to, note, waiting });
  log.info(`${row.name ?? rid}: ${homeName(positionMap, from)} -> ${homeName(positionMap, to)} (${note})`);
}

/** what a waiting entry carries for its recheck (floor.js regradeTick), with these fields set; the stricter rule wins */
function waitingWith(json, { held, rule, raised }) {
  const w = JSON.parse(json);
  const strictest = w.rule && positionMap.positions[w.rule] ? commonAncestor(positionMap, [w.rule, rule]) : rule;
  return JSON.stringify({ ...w, ...(held ? { held } : {}), rule: strictest, raised });
}

/**
 * R11.13: a document's title takes the strictest home among its sections. Settled after every raise, and again
 * for a section already where the rule puts it, so a restart between the raise and the settling still settles it.
 */
async function titleFollows(section) {
  if (!section._doc_id) return;
  await settleDocument(section._doc_id);
}

/** a map with only its class-level entries: what re-homing reads (R6: a map from classes to positions) */
const classLevel = (m) => ({ classes: Object.fromEntries(Object.entries(m?.classes ?? {}).filter(([, r]) => r?.authority).map(([k, r]) => [k, { authority: r.authority }])) });

/** every section related to an instance of a class whose entry this change tightened: rid -> [{ class, authority }] */
async function sectionsTightened(prev, next) {
  const [before, after] = [classLevel(prev), classLevel(next)];
  const found = new Map();
  for (const key of Object.keys(after.classes)) {
    if (!tightens(before, after, key, null, positionMap)) continue;
    const named = after.classes[key].authority;
    const authority = positionMap.positions[named] ? named : positionMap.root;
    const cls = (await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'class' AND _class_key = :k LIMIT 1`, { k: key }))[0];
    if (!cls) continue;
    const instances = await adbQuery(`SELECT @rid AS rid FROM (SELECT expand(in('INSTANCE_OF')) FROM ${cls.rid}) LIMIT ${NO_LIMIT}`);
    for (const i of instances) {
      const sections = await adbQuery(`SELECT @rid AS rid FROM (SELECT expand(in('ABOUT')) FROM ${i.rid}) WHERE _kind = 'section' LIMIT ${NO_LIMIT}`);
      for (const s of sections) found.set(String(s.rid), [...(found.get(String(s.rid)) ?? []), { class: key, authority }]);
    }
  }
  return found;
}

/** go through one change: returns how many sections it raised */
async function applyChange(change) {
  const [prev, next] = [mapIn(change.prev_json), mapIn(change.next_json)];
  const stamp = `tightened by ${change.changed_by} on ${String(change.changed_at).slice(0, 10)}`;
  let moved = 0;
  for (const [rid, keys] of await sectionsTightened(prev, next)) {
    if (!RID_RE.test(rid)) continue;
    const row = (await adbQuery(`SELECT @rid AS rid, name, _home, _doc_id, _ungraded, _placed_at FROM ${rid} WHERE name IS NOT NULL`))[0];
    // a person placed it after this rule changed: their call stands
    if (!row || (row._placed_at && row._placed_at > change.changed_at)) continue;
    const from = effectiveHome(positionMap, row._home);
    // the home the map now requires, and the stricter home: the lowest position at or above both where it is and that
    const rule = commonAncestor(positionMap, keys.map((k) => k.authority));
    const to = commonAncestor(positionMap, [from, rule]);
    const by = keys.find((k) => commonAncestor(positionMap, [from, k.authority]) === to) ?? keys[0];
    const note = `raised to ${homeName(positionMap, to)}: the map now puts ${by.class} at ${homeName(positionMap, by.authority)}, ${stamp}`;
    if (to === from) {
      // already there: one waiting for its check (held admin-only) keeps the rule for when it is checked
      if (row._ungraded) {
        try {
          await adbCommand(`UPDATE ${rid} SET _ungraded = :w`, "sql", { w: waitingWith(row._ungraded, { rule, raised: note }) });
        } catch {
          /* unreadable: regradeTick clears it */
        }
      }
      await titleFollows(row);
      continue;
    }
    await raise(row, to, note, rule);
    await titleFollows(row);
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
    if (moved) log.info(`class map tightened by ${change.changed_by}: ${moved} sections re-homed`);
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
