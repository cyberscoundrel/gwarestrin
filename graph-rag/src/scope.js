/**
 * Identity and scope: the token map, the position map, what a caller sees (scopeOf, homeFilter) and
 * where it writes (resolveWriteHome), capabilities, and who the person behind an identity is.
 */
import { readFileSync } from "node:fs";
import { defaultHome, effectiveHome, EVERYONE, heldPositions, homeName, ROOT_NAME, parsePositionMap, visibleHomes, writableHomes } from "./positions.js";
import { PREFIX as AGENT_TOKEN_PREFIX, resolveAgentToken } from "./delegation.js";
import { entityPredicate, grantedView } from "./grants.js";
import { GRAPH_RAG_OPEN_MODE, POSITION_MAP_PATH, TOKEN_MAP_PATH } from "./context.js";
import { esc, RID_RE } from "./db.js";
import { grantCache } from "./sharing.js";

/**
 * Identity model: callers present a bearer token (issued by the surrounding
 * infrastructure); the token map (infra-authored JSON) resolves it to
 * capabilities. Fails closed: a configured token map that is missing or
 * unreadable denies everyone (a broken reload keeps the last good map). Open
 * mode (anonymous, full caps) needs an explicit GRAPH_RAG_OPEN_MODE=1 and no
 * token map: standalone development only.
 */

const OPEN_CAPS = { read: true, write: "direct", approve: true, raw: true };
const OPEN_MODE = !TOKEN_MAP_PATH && GRAPH_RAG_OPEN_MODE === "1";
let tokenMap = new Map(); // empty = nobody authenticates
export let entriesByUser = new Map(); // for agent tokens (signed with the tenant's delegationKey)

export function loadTokenMap() {
  if (!TOKEN_MAP_PATH) {
    if (!OPEN_MODE) console.warn("[graph-rag] no TOKEN_MAP_PATH and GRAPH_RAG_OPEN_MODE!=1: every request is refused");
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(TOKEN_MAP_PATH, "utf8"));
    if (!Array.isArray(parsed.tokens)) throw new Error("token map has no tokens array");
    const entries = parsed.tokens.filter((e) => typeof e?.token === "string" && e.token);
    tokenMap = new Map(entries.map((e) => [e.token, e]));
    entriesByUser = new Map(entries.filter((e) => typeof e.user === "string").map((e) => [e.user, e]));
    console.log(`[graph-rag] token map loaded: ${tokenMap.size} token(s)`);
  } catch (err) {
    console.warn(`[graph-rag] token map load failed (keeping ${tokenMap.size} previously loaded token(s)): ${String(err).slice(0, 160)}`);
  }
}

/**
 * Position scoping (see positions.js): enabled when POSITION_MAP_PATH is set.
 * Fails closed: until a valid map is loaded nobody sees or writes anything
 * (a broken reload keeps the last good map).
 */
export const SCOPED = POSITION_MAP_PATH !== "";
export let positionMap = null;

export function loadPositionMap() {
  if (!SCOPED) {
    console.warn("[graph-rag] POSITION_MAP_PATH not set: no position scoping (every identity sees the whole graph)");
    return;
  }
  try {
    positionMap = parsePositionMap(JSON.parse(readFileSync(POSITION_MAP_PATH, "utf8")));
    console.log(`[graph-rag] position map loaded: ${Object.keys(positionMap.positions).length} position(s), root ${positionMap.positions[positionMap.root].name}`);
  } catch (err) {
    console.warn(`[graph-rag] position map load failed (${positionMap ? "keeping the previous map" : "nothing is visible until it loads"}): ${String(err).slice(0, 160)}`);
  }
}

/**
 * The caller's view of the graph: `homes` null = everything, else the set of
 * visible position ids; `writeHome` = where its writes land by default.
 * Unscoped deployments and open mode see everything.
 */
export function scopeOf(identity) {
  if (!SCOPED || identity.open) return { homes: null, writeHome: undefined, root: true };
  if (!positionMap) return { homes: new Set(), writeHome: null, root: false };
  const held = heldPositions(positionMap, identity.positions);
  const homes = visibleHomes(positionMap, held);
  // grants add homes (subtree grants) and single entities (entity grants);
  // a share to a person reaches them and the agents acting for them
  const person = personOf(identity.user);
  const granted = grantedView(positionMap, held, grantCache, Date.now(), person);
  return { homes, writeHome: defaultHome(positionMap, held), root: homes === null, held, granted, person };
}

/**
 * SQL predicate (prefixed with AND) limiting rows to what the caller sees:
 * its homes plus what grants show it. `own: true` = by home only: what the
 * caller owns (may move, grant onward), never what it was granted.
 */
export function homeFilter(scope, { own = false } = {}) {
  if (scope.homes === null) return "";
  const homes = new Set(scope.homes);
  let entities = "";
  if (!own && scope.granted) {
    for (const h of scope.granted.homes) homes.add(h);
    // a granted record id counts only while it holds the granted entity
    entities = entityPredicate(scope.granted.entities, esc, RID_RE);
  }
  const conds = [];
  if (homes.size) conds.push(`_home IN [${[...homes].map((h) => `'${esc(h)}'`).join(",")}]`);
  // a person always reads what they wrote, wherever grading put it (they know what it says);
  // reading isn't owning: moving or sharing it onward still goes by home
  if (!own && scope.person) conds.push(`_written_by = '${esc(scope.person)}'`);
  // a thing: seen from the homes of the statements about it
  if (homes.size) conds.push(`(_kind = 'thing' AND _homes CONTAINSANY [${[...homes].map((h) => `'${esc(h)}'`).join(",")}])`);
  if (entities) conds.push(entities);
  return conds.length ? ` AND (${conds.join(" OR ")})` : " AND 1 = 0";
}

/** how the caller sees a row it can read but doesn't own: as its writer, or through a share */
export const viaOf = (scope, row) => (!SCOPED || !positionMap || ownsHome(scope, row._home) ? {} : { via: scope.person && row._written_by === scope.person ? "writer" : "grant" });

/** does the caller see this home by its own positions (not through a grant) */
export const ownsHome = (scope, home) => scope.homes === null || scope.homes.has(effectiveHome(positionMap, home));

/** where a write lands: the caller's choice if it may write there, else its default */
export function resolveWriteHome(scope, requested, { everyoneOk = true } = {}) {
  if (!SCOPED || scope.writeHome === undefined) return undefined;
  if (!positionMap) throw new Error("position map not loaded; graph writes are refused");
  if (requested === undefined || requested === null || requested === "") {
    if (!scope.writeHome) throw new Error("this identity holds no position; graph writes are refused");
    return scope.writeHome;
  }
  const id = positionId(requested);
  // writing for everyone: the organization's root (its admin) decides that; anyone
  // else writes at their position and moves it to Everyone, which a person approves
  if (id === EVERYONE) {
    if (scope.root && everyoneOk) return EVERYONE;
    throw new Error(`only the organization's admin writes for Everyone directly: write at your position, then move it to Everyone (set_home), which asks for approval`);
  }
  if (!writableHomes(positionMap, scope.held).has(id)) {
    throw new Error(`cannot home a write at ${requested}: only at your own positions or above them`);
  }
  return id;
}

/** accept a position id or its exact name */
export function positionId(ref) {
  if (String(ref).trim().toLowerCase() === EVERYONE) return EVERYONE;
  if (positionMap && (ref === ROOT_NAME || ref === "Top of the organization")) return positionMap.root;
  if (positionMap?.positions[ref]) return ref;
  const hit = Object.entries(positionMap?.positions ?? {}).find(([, p]) => p.name === ref);
  if (!hit) throw new Error(`unknown position: ${ref}`);
  return hit[0];
}

export const homeLabel = (home) => {
  if (!SCOPED || !positionMap) return undefined;
  const id = effectiveHome(positionMap, home);
  return { id, name: homeName(positionMap, id) };
};

/** resolve an Authorization header to capabilities; null = unauthenticated */
export function resolveIdentity(authorization) {
  if (OPEN_MODE) return { user: "anonymous", caps: { ...OPEN_CAPS }, open: true, positions: [] };
  const token = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : null;
  if (!token) return null;
  // an agent's own token: the tenant placed it at its profile's positions
  if (token.startsWith(AGENT_TOKEN_PREFIX)) return resolveAgentToken(token, (u) => entriesByUser.get(u), positionMap);
  const entry = tokenMap.get(token);
  if (!entry) return null;
  return {
    user: entry.user ?? "unknown",
    caps: {
      read: entry.caps?.read === true,
      write: entry.caps?.write ?? "deny",
      approve: entry.caps?.approve === true,
      // raw Cypher/SQL bypasses every read filter: root-level identities only
      raw: entry.caps?.raw === true,
    },
    positions: Array.isArray(entry.positions) ? entry.positions.filter((p) => typeof p === "string") : [],
  };
}

export function requireCap(caps, cap) {
  if (cap === "read" && caps.read !== true) throw new Error("requires read capability");
  if (cap === "write") {
    if (caps.write === "deny") throw new Error("graph writes are denied for this identity");
    if (caps.write !== "direct" && caps.write !== "queued") {
      throw new Error("write capability misconfigured (expected direct|queued|deny)");
    }
  }
  if (cap === "approve" && caps.approve !== true) throw new Error("requires approve capability");
  if (cap === "raw" && caps.raw !== true) throw new Error("raw graph queries require the raw capability");
}

/** execute a queued write (admin approval path) */
/** a person (not an agent or a worker thread): their placement of an entry stands until a person changes it */
export const isPerson = (identity) => !identity.agent && !identity.role && !identity.open;

/** who a write is recorded as written by: a person, or the person an agent acts for (graph roles and open mode: nobody) */
export const writerOf = (identity) => {
  const person = identity.role || identity.open ? "" : personOf(identity.user);
  return person ? { written_by: person } : {};
};

export const positionName = (id) => (positionMap && (id === EVERYONE || positionMap.positions[id]) ? homeName(positionMap, id) : id);

/** the people a share can go to: everyone in the token map (tenants) */
const peopleNames = () => [...entriesByUser.keys()].sort();

/** what a person sees by their own positions (null: unknown person) */
export function personScope(name) {
  const entry = entriesByUser.get(name);
  return entry ? scopeOf({ user: entry.user, positions: entry.positions ?? [], caps: {} }) : null;
}

/** everyone else, with where they sit (for matching "let bob know") */
export function peopleView(self) {
  return peopleNames()
    .filter((n) => n !== self)
    .map((name) => ({
      name,
      positions: heldPositions(positionMap, entriesByUser.get(name)?.positions).map((id) => (id === positionMap.root ? "Top of the organization" : positionName(id))),
    }));
}

/** the person behind an identity ("alice" for alice and her agents) */
export const personOf = (user) => String(user ?? "").split("/agent:")[0];
