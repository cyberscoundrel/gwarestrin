/**
 * Instances and what relates sections to them: the few helpers left from the linker, which the rulings
 * removed (R4: every record gets a worker, and the worker resolves names against the source while filing).
 * An instance is visible wherever a section about it is (R11): its `_homes` grow with the sections that
 * relate to it, and scope.js `homeFilter` reads them.
 *
 * The classes and discovery stream owns this module.
 */
import { EVERYONE, visibleHomes } from "./positions.js";
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { positionMap } from "./scope.js";
import { parseKey } from "./model/schema.js";
import { dependencyVisible, mayMakeNode, normalizeDependency, normalizeInstanceEdge, strictestHome, unrelated } from "./model/classes.js";
import { ShapeError } from "./model/text.js";
import { allClasses, evidenceContext, seesHome, visibleClass } from "./classes.js";
import { connectionHome, noteHome } from "./discovery.js";

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
 * The classes and discovery stream: instances of classes and dependency between them (R1, R3, R11).
 * Workers and the orchestrator create instances and relate them to existing classes; nothing else mints
 * (R7). A transactional row gets a node only when the graph must say something its source can't (R3).
 * ------------------------------------------------------------------------------------------------- */

const bad = (field, message, status = 400) => Object.assign(new ShapeError(field, message), { status });

/** does a reader see this node: a thing by any of its homes (R11: wherever a section about it is), anything else by its home */
export function seesNode(scope, row) {
  if (!row) return false;
  if (row._kind === "thing") return [row._home, ...(row._homes ?? [])].filter(Boolean).some((h) => seesHome(scope, h));
  return seesHome(scope, row._home);
}

const NODE = "@rid AS rid, _kind, _home, _homes, label, name, _keys";

/** an instance a reader sees, by record id, record key or name; null when none it can see */
export async function findInstance({ instance, key, name } = {}, scope) {
  let rows = [];
  if (instance) {
    if (!RID_RE.test(String(instance))) throw bad("instance", "a record id (#12:3)");
    rows = await adbQuery(`SELECT ${NODE} FROM ${instance} WHERE _kind = 'thing'`).catch(() => []);
  } else if (key) {
    rows = await adbQuery(`SELECT ${NODE} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS :k LIMIT 5`, { k: String(key).trim() });
  } else if (name) {
    rows = await adbQuery(`SELECT ${NODE} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _norm = :n LIMIT 5`, { n: normalize(name) });
  }
  const r = rows.find((x) => seesNode(scope, x));
  return r ? { ...r, rid: String(r.rid) } : null;
}

/**
 * Where a new instance is seen from (NEEDS A RULING, an instance discovery makes has no section yet):
 * smallest choice, from its evidence, as a class is (R11): a row's key, the home of the connection that
 * reads it; notes, the strictest of theirs; nothing, the root. Sections about it add their homes later
 * (instanceSeenFrom).
 */
export function instanceHome({ key, notes = [] }, { positions, connectionHome: homeOfConnection = connectionHome, noteHome: homeOfNote = (n) => noteHome(n, positions) }) {
  const k = parseKey(key);
  if (k) return homeOfConnection(k.system) ?? positions.root;
  if (notes.length) return strictestHome(positions, notes.map((n) => homeOfNote(n) ?? positions.root));
  return positions.root;
}

async function makeNode({ key, name, home, run, by }) {
  const label = String(name ?? parseKey(key)?.row_key ?? key).trim().slice(0, 200);
  await adbCommand(
    `CREATE VERTEX ${ENTITY_LABEL} SET name = :label, label = :label, _norm = :norm, _kind = 'thing', _keys = :keys, _home = :home, _homes = [:home], _origin = :home, _run = :run, _written_by = :who`,
    "sql",
    { label, norm: normalize(label), keys: key ? [String(key).trim()] : [], home, run: run ?? null, who: by },
  );
  const r = (await adbQuery(`SELECT ${NODE} FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _norm = :n AND _home = :home ORDER BY @rid DESC LIMIT 1`, { n: normalize(label), home }))[0];
  return { ...r, rid: String(r.rid) };
}

/**
 * Relate an instance to a class (the instance edge, R1), making the instance when it doesn't exist: by
 * record id, record key (`system:table:row`) or name. The class must be one the caller sees and not
 * retired; a person who took this instance out of the class is respected (R11); a transactional row's
 * node needs a reason the source can't hold (R3). `actor`: { user, run? }.
 */
export async function relateInstance(args, scope, actor) {
  const cls = await visibleClass(args.class ?? "", scope);
  if (!cls) throw bad("class", `no class ${args.class} that you can see`, 404);
  if (cls.status === "retired") throw bad("class", `${cls.name} was retired by a person`);
  const key = args.key ? String(args.key).trim() : null;
  if (key && !parseKey(key)) throw bad("key", "a record key is system:table:row");
  let node = await findInstance({ instance: args.instance, key, name: key ? null : args.name }, scope);
  if (args.instance && !node) throw bad("instance", `no instance ${args.instance} that you can see`, 404);
  const gone = unrelated(cls);
  if (node && (gone.has(node.rid.toLowerCase()) || (node._keys ?? []).some((k) => gone.has(String(k).toLowerCase())))) throw bad("instance", `a person took ${node.label ?? node.name} out of ${cls.name}: it isn't related again on its own`);
  if (key && gone.has(key.toLowerCase())) throw bad("instance", `a person took ${key} out of ${cls.name}: it isn't related again on its own`);
  let created = false;
  if (!node) {
    const ok = mayMakeNode(cls, { key, dependency: args.dependency === true, reason: args.reason });
    if (!ok.ok) throw bad("key", ok.reason);
    if (!key && !args.name) throw bad("name", "an instance needs its record key or its name");
    node = await makeNode({ key, name: args.name, home: instanceHome({ key, notes: args.notes ?? [] }, await evidenceContext((args.notes ?? []).map((ref) => ({ kind: "notes", ref })))), run: actor.run, by: actor.user });
    created = true;
  }
  const edge = normalizeInstanceEdge({ instance: node.rid, class: cls.key, added_by: actor.user });
  const have = await adbQuery(`SELECT @rid AS rid FROM INSTANCE_OF WHERE @out = ${node.rid} AND @in = ${cls.rid}`).catch(() => []);
  if (!have.length) await adbCommand(`CREATE EDGE INSTANCE_OF FROM ${node.rid} TO ${cls.rid} SET added_by = :who, at = :at`, "sql", { who: edge.added_by, at: edge.at });
  return { instance: node.rid, name: node.label ?? node.name, class: cls.key, created, related: !have.length };
}

/** one end of a dependency: an instance the caller sees, or a row's node made for it (R3: a dependency the source can't hold) */
async function dependencyEnd(end, field, scope, actor) {
  const e = typeof end === "string" ? (RID_RE.test(end) ? { instance: end } : parseKey(end) ? { key: end } : { name: end }) : (end ?? {});
  const found = await findInstance(e, scope);
  if (found) return found;
  const k = parseKey(e.key);
  if (!k) throw bad(field, `no instance ${e.instance ?? e.name ?? e.key ?? ""} that you can see`, 404);
  const table = `${k.system}:${k.table}`.toLowerCase();
  const cls = (await allClasses()).find((c) => c.status !== "retired" && c.record_table?.toLowerCase() === table && seesHome(scope, c.home));
  if (!cls) throw bad(field, `no class you can see records ${k.system}:${k.table}: a row's node needs its class`, 404);
  const r = await relateInstance({ class: cls.key, key: e.key, name: e.name, dependency: true }, scope, actor);
  return findInstance({ instance: r.instance }, scope);
}

/**
 * State a dependency between two instances (R1): `from` depends on `to`. Both ends must be instances the
 * caller sees; a transactional row's node is made for it, by key (R3). The edge is visible only to someone
 * who sees both ends (R11, readDependencies). `actor`: { user, agent?, run? }.
 */
export async function addDependency(args, scope, actor) {
  const from = await dependencyEnd(args.from, "from", scope, actor);
  const to = await dependencyEnd(args.to, "to", scope, actor);
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
    `CREATE EDGE DEPENDS_ON FROM ${d.from} TO ${d.to} SET stated_as = :stated_as, stated_by = :stated_by, source = :source, note = :note, stated_at = :stated_at, valid_from = :valid_from, valid_until = :valid_until`,
    "sql",
    d,
  );
  return { dependency: { ...d, from_name: from.label ?? from.name, to_name: to.label ?? to.name } };
}

/**
 * The dependencies of an instance the caller sees, both ways: only those whose other end it sees too
 * (R11: "A dependency edge is visible only to someone who can see both ends"). Nothing says how many it
 * didn't see.
 */
export async function readDependencies({ instance }, scope) {
  const node = await findInstance({ instance }, scope);
  if (!node) throw bad("instance", `no instance ${instance} that you can see`, 404);
  const edges = [
    ...(await adbQuery(`SELECT @out AS src, @in AS dst, stated_as, stated_by, source, note, stated_at, valid_from, valid_until FROM DEPENDS_ON WHERE @out = ${node.rid}`)),
    ...(await adbQuery(`SELECT @out AS src, @in AS dst, stated_as, stated_by, source, note, stated_at, valid_from, valid_until FROM DEPENDS_ON WHERE @in = ${node.rid}`)),
  ].map(({ src, dst, ...e }) => ({ ...e, from: String(src), to: String(dst) }));
  const ends = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  const rows = ends.length ? await adbQuery(`SELECT ${NODE} FROM [${ends.join(",")}]`) : [];
  const byRid = new Map(rows.map((r) => [String(r.rid), r]));
  const sees = (rid) => seesNode(scope, byRid.get(rid));
  const label = (rid) => byRid.get(rid)?.label ?? byRid.get(rid)?.name ?? rid;
  return {
    instance: node.rid,
    depends_on: edges.filter((e) => e.from === node.rid && dependencyVisible(e, sees)).map((e) => ({ ...e, to_name: label(e.to) })),
    depended_on_by: edges.filter((e) => e.to === node.rid && dependencyVisible(e, sees)).map((e) => ({ ...e, from_name: label(e.from) })),
  };
}

