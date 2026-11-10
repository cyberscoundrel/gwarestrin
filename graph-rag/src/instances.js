/**
 * Instances and what relates sections to them: the few helpers left from the linker, which the rulings
 * removed (R4: every record gets a worker, and the worker resolves names against the source while filing).
 * An instance is visible wherever a section about it is (R11): its `_homes` grow with the sections that
 * relate to it, and scope.js `homeFilter` reads them.
 *
 * The classes and discovery stream owns this module.
 */
import { randomUUID } from "node:crypto";
import { effectiveHome, EVERYONE, visibleHomes } from "./positions.js";
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { positionMap } from "./scope.js";
import { parseKey } from "./model/schema.js";
import { dependencyVisible, mayMakeNode, normalizeDependency, normalizeInstanceEdge, strictestHome, unrelated } from "./model/classes.js";
import { ShapeError } from "./model/text.js";
import { allClasses, discoveryPartOf, evidenceContext, seesHome, visibleClass } from "./classes.js";
import { connectionHome } from "./discovery.js";
import { derivedFloor, recordReads } from "./floor.js";

/** "Toro Co." / "TORO" / "toro" -> "toro co" / "toro" */
export const normalize = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** two spellings of one record key: a source's row keys don't differ by case */
export const sameKey = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/** what counts as an entry (not an instance or a class) */
export const ENTRY_KINDS = "(_kind IS NULL OR _kind IN ['document', 'section', 'task'])";

/** can a reader at `home` already see this instance */
export function seenInstance(t, home) {
  if (!positionMap || !home) return true;
  const homes = visibleHomes(positionMap, [home]);
  return homes === null || (t._homes ?? []).some((h) => h === EVERYONE || homes.has(h));
}

/**
 * An instance is seen from one more home: a section there relates to it. Only from where it could already
 * be seen (`from`, the section's own home unless it just moved), so relating a section to an instance it
 * can't see doesn't bring that instance's name down with it.
 */
export async function instanceSeenFrom(rid, home, { from = home } = {}) {
  const row = (await adbQuery(`SELECT _homes FROM ${rid}`))[0];
  const homes = Array.isArray(row?._homes) ? row._homes : [];
  if (!homes.includes(home) && seenInstance({ _homes: homes }, from)) await adbCommand(`UPDATE ${rid} SET _homes = :homes`, "sql", { homes: [...homes, home] });
}

/** relate a section to an instance once (an ABOUT edge, model/schema.js) */
export async function aboutOnce(sectionRid, instanceRid, role) {
  const out = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${sectionRid})`).catch(() => []);
  if (out.some((e) => String(e.dst) === instanceRid)) return;
  await adbCommand(`CREATE EDGE ABOUT FROM ${sectionRid} TO ${instanceRid} SET role = :role`, "sql", { role });
}

/* ---------------------------------------------------------------------------------------------------
 * The classes and discovery stream: instances of classes and dependency between them (R1, R3, R11). The one
 * implementation: the orchestrator's tools and the filing stream's worker tools both call these.
 *
 * Where a new instance lives (one rule): `opts.home` when the caller gives one (a filing worker gives its
 * section's home: "an instance is visible wherever a section about it is", R11.8); else its evidence (a
 * row's key, the home of the connection that reads it; notes, the strictest of those the writer sees, R11.9);
 * else the writer's own home. Then the write floor (R11.13, "an agent cannot write lower than what it read"):
 * never below what the writer read, nor below its own record's home. An edge to something that exists is
 * refused when it would be seen lower than that floor.
 * ------------------------------------------------------------------------------------------------- */

const bad = (field, message, status = 400) => Object.assign(new ShapeError(field, message), { status });

/** does a reader see this node: a thing by any of its homes (R11: wherever a section about it is), anything else by its home */
export function seesNode(scope, row) {
  if (!row) return false;
  if (row._kind === "thing") return [row._home, ...(row._homes ?? [])].filter(Boolean).some((h) => seesHome(scope, h));
  return seesHome(scope, row._home);
}

/** every home a node is seen from */
const homesOf = (row) => [...new Set([row._home, ...(row._homes ?? [])].filter(Boolean))];

const NODE = "@rid AS rid, _kind, _home, _homes, label, name, _keys, _norm";

/** an instance a reader sees, by record id, record key or name; null when none it can see */
export async function findInstance({ instance, key, name } = {}, scope) {
  let rows = [];
  if (instance) {
    if (!RID_RE.test(String(instance))) throw bad("instance", "a record id (#12:3)");
    rows = await adbQuery(`SELECT ${NODE} FROM ${instance} WHERE _kind = 'thing'`).catch(() => []);
  } else if (key) {
    rows = await adbQuery(`SELECT ${NODE} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS :k ORDER BY @rid LIMIT 5`, { k: String(key).trim() });
  } else if (name) {
    rows = await adbQuery(`SELECT ${NODE} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _norm = :n ORDER BY @rid LIMIT 20`, { n: normalize(name) });
  }
  const r = rows.find((x) => seesNode(scope, x));
  return r ? { ...r, rid: String(r.rid) } : null;
}

/** the home a writer writes from when nothing else says: a discovery part's home, a worker's record's, else the root */
async function writerHome(identity) {
  const entry = identity?.role?.kind === "worker" ? identity.role.entry : null;
  if (!entry || !RID_RE.test(String(entry))) return positionMap.root;
  const part = await discoveryPartOf(entry);
  if (part) return part.home ?? positionMap.root;
  return (await adbQuery(`SELECT _home FROM ${entry}`).catch(() => []))[0]?._home ?? positionMap.root;
}

/**
 * The lowest home a write may land at, from `base` (R11.13): at or above it, at or above everything the writer
 * read in the window (floor.js derivedFloor), and, when the caller gave no home of its own, at or above the
 * writer's own record.
 */
export async function writeFloor(identity, base, { given = false } = {}) {
  const homes = [base, derivedFloor(identity, base) ?? base];
  if (!given && identity?.role?.kind === "worker") homes.push(await writerHome(identity));
  return strictestHome(positionMap, homes);
}

/**
 * The home of a link, an INSTANCE_OF or DEPENDS_ON edge: the strictest of its two ends and the home of the
 * record or evidence that states it. Ruled: R13 (the user: "Yes, that's right", 2026-11-10), which also says the rule
 * that an agent cannot write lower than what it read applies to text an agent writes, not to the orchestrator's
 * links (the re-review of c1323a3, C2-B1, had found that flooring a link by everything its writer read leaves the
 * orchestrator, which reads everything, able to relate nothing below the root). The ends are checked when the link is read
 * (a reader must see both); the edge stores the evidence's home: `home` (the section a filing worker files
 * from), else the records it cites (`refs`, a record the writer can't see counting as the root's), else the
 * writer's own home. Text the writer puts on the link (a note) is still floored by what it read (R11.13).
 */
export async function linkHome(identity, scope, { home = null, refs = [], note = null } = {}) {
  let h;
  if (home) h = effectiveHome(positionMap, home);
  else if (refs.length) {
    const ctx = await evidenceContext(refs.map((ref) => ({ kind: "notes", ref })), scope);
    h = strictestHome(positionMap, refs.map((r) => ctx.noteHome(r) ?? positionMap.root));
  } else h = await writerHome(identity);
  if (note && identity) h = strictestHome(positionMap, [h, derivedFloor(identity, h) ?? h]);
  return h;
}

/** the cited records a reader can't see: a new node isn't made from them, where its writer couldn't find it again */
async function unseenRefs(refs, scope) {
  const rids = [...new Set(refs.filter((r) => RID_RE.test(String(r))))];
  if (!rids.length) return [];
  const rows = await adbQuery(`SELECT @rid AS rid, _home, _homes, _kind FROM [${rids.join(",")}]`).catch(() => []);
  const seen = new Set(rows.filter((r) => seesNode(scope, r)).map((r) => String(r.rid)));
  return rids.filter((r) => !seen.has(r));
}

/**
 * Where a new instance lives (the rule above). `ctx` is evidenceContext's (connection and note homes).
 * NEEDS A RULING (where an instance with no section is seen): smallest choice, from its evidence as a class is
 * (R11.9), else from the writer's own home; every writer's instances are floored by what it read.
 */
export function instanceHome({ key, notes = [], home = null, writer }, { positions, connectionHome: homeOfConnection = connectionHome, noteHome: homeOfNote = () => null }) {
  if (home) return effectiveHome(positions, home);
  const k = parseKey(key);
  if (k) return homeOfConnection(k.system) ?? positions.root;
  if (notes.length) return strictestHome(positions, notes.map((n) => homeOfNote(n) ?? positions.root));
  return writer ?? positions.root;
}

/** a new instance node, found again by a token only it has (two made at once never swap rids) */
async function makeNode({ key, name, home, run, by }) {
  const label = String(name ?? parseKey(key)?.row_key ?? key).trim().slice(0, 200);
  const mint = randomUUID();
  await adbCommand(
    `CREATE VERTEX ${ENTITY_LABEL} SET name = :label, label = :label, _norm = :norm, _kind = 'thing', _keys = :keys, _home = :home, _homes = [:home], _origin = :home, _run = :run, _mint = :mint, _written_by = :who`,
    "sql",
    { label, norm: normalize(label), keys: key ? [String(key).trim()] : [], home, run: run ?? null, mint, who: by },
  );
  const r = (await adbQuery(`SELECT ${NODE} FROM ${ENTITY_LABEL} WHERE _mint = :mint`, { mint }))[0];
  return { ...r, rid: String(r.rid) };
}

async function instanceOf(rid, clsRid) {
  return (await adbQuery(`SELECT @rid AS rid FROM INSTANCE_OF WHERE @out = ${rid} AND @in = ${clsRid}`).catch(() => [])).length > 0;
}

/**
 * Relate an instance to a class (the instance edge, R1), making the instance when it doesn't exist: by record
 * id, record key (`system:table:row`) or name. One node per key in the whole graph, and one per name under a
 * class among what the writer sees, so relating the same individual twice reuses it. The class must be one
 * the writer sees, not retired, not a mirror (R6); a person who took this instance out of the class is
 * respected (R11.10); a transactional row's node needs a reason the source can't hold (R3).
 * `actor`: { user, agent?, run?, identity }. `opts.home`: the home a caller files from (a section's).
 */
export async function relateInstance(args, scope, actor, opts = {}) {
  const cls = await visibleClass(args.class ?? "", scope);
  if (!cls) throw bad("class", `no class ${args.class} that you can see`, 404);
  if (cls.status === "retired") throw bad("class", `${cls.name} was retired by a person`);
  if (cls.mirror) throw bad("class", `${cls.name} mirrors a position from authentik (R6): its people come from there`);
  const key = args.key ? String(args.key).trim() : null;
  if (key && !parseKey(key)) throw bad("key", "a record key is system:table:row");
  let node = null;
  if (args.instance) {
    node = await findInstance({ instance: args.instance }, scope);
    if (!node) throw bad("instance", `no instance ${args.instance} that you can see`, 404);
  } else if (key) {
    // one node per key: a node for this row the writer can't see is not made again beside it
    const any = (await adbQuery(`SELECT ${NODE} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS :k ORDER BY @rid LIMIT 1`, { k: key }))[0];
    if (any && !seesNode(scope, any)) {
      // NEEDS A RULING (a row's node above the writer): smallest choice, refuse without naming it; the source row is the writer's to read anyway
      throw bad("key", `${key} is held where you can't see it: ask the orchestrator`);
    }
    node = any ? { ...any, rid: String(any.rid) } : null;
  } else if (args.name) {
    const n = normalize(args.name);
    const rows = await adbQuery(`SELECT ${NODE} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _norm = :n ORDER BY @rid LIMIT 20`, { n });
    for (const r of rows.filter((x) => seesNode(scope, x))) {
      if (await instanceOf(String(r.rid), cls.rid)) {
        node = { ...r, rid: String(r.rid) };
        break;
      }
    }
  } else {
    throw bad("name", "an instance needs its record key or its name");
  }
  const gone = unrelated(cls);
  if (node && (gone.has(node.rid.toLowerCase()) || (node._keys ?? []).some((k) => gone.has(String(k).toLowerCase())))) throw bad("instance", `a person took ${node.label ?? node.name} out of ${cls.name}: it isn't related again on its own`);
  if (key && gone.has(key.toLowerCase())) throw bad("instance", `a person took ${key} out of ${cls.name}: it isn't related again on its own`);
  let created = false;
  const identity = actor.identity ?? null;
  if (!node) {
    const ok = mayMakeNode(cls, { key, dependency: args.dependency === true, reason: args.reason });
    if (!ok.ok) throw bad("key", ok.reason);
    if (!key && !args.name) throw bad("name", "an instance needs its record key or its name");
    if ((await unseenRefs(args.notes ?? [], scope)).length) throw bad("notes", "you cite a record you can't see: an instance is made only from what you can read");
    const ctx = await evidenceContext((args.notes ?? []).map((ref) => ({ kind: "notes", ref })), scope);
    const base = instanceHome({ key, notes: args.notes ?? [], home: opts.home ?? null, writer: await writerHome(identity) }, ctx);
    const home = identity ? await writeFloor(identity, base, { given: Boolean(opts.home) }) : base;
    node = await makeNode({ key, name: args.name, home, run: actor.run, by: actor.user });
    created = true;
  }
  const edge = normalizeInstanceEdge({ instance: node.rid, class: cls.key, added_by: actor.user });
  const had = await instanceOf(node.rid, cls.rid);
  const home = await linkHome(identity, scope, { home: opts.home, refs: args.source ? [args.source] : (args.notes ?? []) });
  if (!had) await adbCommand(`CREATE EDGE INSTANCE_OF FROM ${node.rid} TO ${cls.rid} SET added_by = :who, at = :at, home = :home`, "sql", { who: edge.added_by, at: edge.at, home });
  return { instance: node.rid, name: node.label ?? node.name, class: cls.key, created, related: !had, ...(had ? {} : { link_home: home }) };
}

/** one end of a dependency: an instance the caller sees, or a row's node made for it (R3: a dependency the source can't hold) */
async function dependencyEnd(end, field, scope, actor, opts) {
  const e = typeof end === "string" ? (RID_RE.test(end) ? { instance: end } : parseKey(end) ? { key: end } : { name: end }) : (end ?? {});
  const found = await findInstance(e, scope);
  if (found) return found;
  const k = parseKey(e.key);
  if (!k) throw bad(field, `no instance ${e.instance ?? e.name ?? e.key ?? ""} that you can see`, 404);
  const table = `${k.system}:${k.table}`.toLowerCase();
  const cls = (await allClasses()).find((c) => c.status !== "retired" && c.record_table?.toLowerCase() === table && seesHome(scope, c.home));
  if (!cls) throw bad(field, `no class you can see records ${k.system}:${k.table}: a row's node needs its class`, 404);
  const r = await relateInstance({ class: cls.key, key: e.key, name: e.name, dependency: true }, scope, actor, opts);
  return findInstance({ instance: r.instance }, scope);
}

/**
 * State a dependency between two instances (R1): `from` depends on `to`. Both ends must be instances the
 * caller sees; a transactional row's node is made for it, by key (R3). The edge is seen by whoever sees both
 * ends and the home of what states it (linkHome; R11.8). `actor`: { user, agent?, run?, identity };
 * `opts.home`: the home a caller files from.
 */
export async function addDependency(args, scope, actor, opts = {}) {
  const from = await dependencyEnd(args.from, "from", scope, actor, opts);
  const to = await dependencyEnd(args.to, "to", scope, actor, opts);
  const home = await linkHome(actor.identity ?? null, scope, { home: opts.home, refs: args.source && RID_RE.test(String(args.source)) ? [args.source] : [], note: args.note });
  const d = normalizeDependency({
    from: from.rid,
    to: to.rid,
    stated_as: args.stated_as ?? (actor.agent ? "agent" : "person"),
    stated_by: args.stated_by ?? actor.user,
    source: args.source,
    note: args.note,
    stated_at: args.stated_at,
    valid_from: args.valid_from,
    valid_until: args.valid_until,
  });
  await adbCommand(
    `CREATE EDGE DEPENDS_ON FROM ${d.from} TO ${d.to} SET stated_as = :stated_as, stated_by = :stated_by, source = :source, note = :note, stated_at = :stated_at, valid_from = :valid_from, valid_until = :valid_until, home = :home`,
    "sql",
    { ...d, home },
  );
  return { dependency: { ...d, home, from_name: from.label ?? from.name, to_name: to.label ?? to.name } };
}

/**
 * The dependencies of an instance the caller sees, both ways: only those whose other end it sees too
 * (R11.8: "A dependency edge is visible only to someone who can see both ends") and whose own home it sees
 * (linkHome), and the classes it is an instance of by links the caller sees. Nothing says how many it didn't
 * see. What it shows counts as read (R11.13). An edge with no home counts as the root's.
 */
export async function readDependencies({ instance }, scope, identity = null) {
  const node = await findInstance({ instance }, scope);
  if (!node) throw bad("instance", `no instance ${instance} that you can see`, 404);
  const edges = [
    ...(await adbQuery(`SELECT @out AS src, @in AS dst, stated_as, stated_by, source, note, stated_at, valid_from, valid_until, home FROM DEPENDS_ON WHERE @out = ${node.rid}`)),
    ...(await adbQuery(`SELECT @out AS src, @in AS dst, stated_as, stated_by, source, note, stated_at, valid_from, valid_until, home FROM DEPENDS_ON WHERE @in = ${node.rid}`)),
  ].map(({ src, dst, ...e }) => ({ ...e, from: String(src), to: String(dst) }));
  const ends = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  const rows = ends.length ? await adbQuery(`SELECT ${NODE} FROM [${ends.join(",")}]`) : [];
  const byRid = new Map(rows.map((r) => [String(r.rid), r]));
  const sees = (rid) => seesNode(scope, byRid.get(rid));
  const label = (rid) => byRid.get(rid)?.label ?? byRid.get(rid)?.name ?? rid;
  const shown = edges.filter((e) => dependencyVisible(e, sees) && seesHome(scope, e.home ?? positionMap.root));
  const links = await adbQuery(`SELECT @in AS c, home FROM INSTANCE_OF WHERE @out = ${node.rid}`).catch(() => []);
  const classes = (await allClasses()).filter((c) => seesHome(scope, c.home) && links.some((l) => String(l.c) === c.rid && seesHome(scope, l.home ?? positionMap.root))).map((c) => c.name);
  if (identity) recordReads(identity, shown.flatMap((e) => [e.from, e.to]).flatMap((rid) => homesOf(byRid.get(rid) ?? {})).filter((h) => seesHome(scope, h)));
  return {
    instance: node.rid,
    classes,
    depends_on: shown.filter((e) => e.from === node.rid).map((e) => ({ ...e, to_name: label(e.to) })),
    depended_on_by: shown.filter((e) => e.to === node.rid).map((e) => ({ ...e, from_name: label(e.from) })),
  };
}
