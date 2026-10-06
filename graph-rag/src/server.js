/**
 * graph-rag MCP sidecar — facet-indexed vector retrieval over ArcadeDB.
 *
 * Each node facet (identity, location, state, temporal, relations, + any
 * custom name) gets an LSM_VECTOR index over `n.embed_<facet>`; facet texts
 * are authored by the calling model via upsert_entities. search_graph embeds
 * the query and fans out over facet indexes, merging nearest-per-node.
 * A periodic sweep backfills the deterministic identity facet for nodes that
 * were written via raw queries (model-authored facets are never synthesized).
 *
 * Storage: ArcadeDB (HTTP JSON API, basic auth). Also exposes query_graph /
 * execute_graph / schema_graph pass-throughs so agents keep raw read/write
 * access without needing credentials (ArcadeDB's own MCP requires auth,
 * which pi-mcp-adapter cannot send).
 */
import express from "express";
import { readFileSync, watchFile } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  canSee,
  defaultHome,
  effectiveHome,
  heldPositions,
  moveKind,
  parsePositionMap,
  visibleHomes,
  writableHomes,
} from "./positions.js";
import { PREFIX as AGENT_TOKEN_PREFIX, resolveAgentToken } from "./delegation.js";
import { grantedView, isActive, resolveExpiry } from "./grants.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const {
  ARCADEDB_URL = "http://arcadedb:2480",
  ARCADEDB_DB = "gwarestrin",
  ARCADEDB_USER = "root",
  ARCADEDB_PASSWORD = "",
  LITELLM_BASE_URL = "http://litellm:4000/v1",
  LITELLM_API_KEY = "",
  EMBED_MODEL = "embed-minilm",
  EMBED_DIM = "384",
  SWEEP_INTERVAL_MS = "600000",
  PORT = "8000",
  TOKEN_MAP_PATH = "",
  GRAPH_RAG_OPEN_MODE = "",
  POSITION_MAP_PATH = "",
} = process.env;

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
let entriesByUser = new Map(); // for agent tokens (signed with the tenant's delegationKey)

function loadTokenMap() {
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
const SCOPED = POSITION_MAP_PATH !== "";
let positionMap = null;

function loadPositionMap() {
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
function scopeOf(identity) {
  if (!SCOPED || identity.open) return { homes: null, writeHome: undefined, root: true };
  if (!positionMap) return { homes: new Set(), writeHome: null, root: false };
  const held = heldPositions(positionMap, identity.positions);
  const homes = visibleHomes(positionMap, held);
  // grants add homes (subtree grants) and single records (entity grants)
  const granted = grantedView(positionMap, held, grantCache);
  return { homes, writeHome: defaultHome(positionMap, held), root: homes === null, held, granted };
}

/**
 * SQL predicate (prefixed with AND) limiting rows to what the caller sees:
 * its homes plus what grants show it. `own: true` = by home only: what the
 * caller owns (may move, grant onward), never what it was granted.
 */
function homeFilter(scope, { own = false } = {}) {
  if (scope.homes === null) return "";
  const homes = new Set(scope.homes);
  const rids = [];
  if (!own && scope.granted) {
    for (const h of scope.granted.homes) homes.add(h);
    for (const r of scope.granted.rids) if (RID_RE.test(r)) rids.push(r);
  }
  const conds = [];
  if (homes.size) conds.push(`_home IN [${[...homes].map((h) => `'${esc(h)}'`).join(",")}]`);
  if (rids.length) conds.push(`@rid IN [${rids.join(",")}]`);
  return conds.length ? ` AND (${conds.join(" OR ")})` : " AND 1 = 0";
}

/** does the caller see this home by its own positions (not through a grant) */
const ownsHome = (scope, home) => scope.homes === null || scope.homes.has(effectiveHome(positionMap, home));

/** where a write lands: the caller's choice if it may write there, else its default */
function resolveWriteHome(scope, requested) {
  if (!SCOPED || scope.writeHome === undefined) return undefined;
  if (!positionMap) throw new Error("position map not loaded; graph writes are refused");
  if (requested === undefined || requested === null || requested === "") {
    if (!scope.writeHome) throw new Error("this identity holds no position; graph writes are refused");
    return scope.writeHome;
  }
  const id = positionId(requested);
  if (!writableHomes(positionMap, scope.held).has(id)) {
    throw new Error(`cannot home a write at ${requested}: only at your own positions or above them`);
  }
  return id;
}

/** accept a position id or its exact name */
function positionId(ref) {
  if (positionMap?.positions[ref]) return ref;
  const hit = Object.entries(positionMap?.positions ?? {}).find(([, p]) => p.name === ref);
  if (!hit) throw new Error(`unknown position: ${ref}`);
  return hit[0];
}

const homeLabel = (home) => {
  if (!SCOPED || !positionMap) return undefined;
  const id = effectiveHome(positionMap, home);
  return { id, name: positionMap.positions[id].name };
};

/** resolve an Authorization header to capabilities; null = unauthenticated */
function resolveIdentity(authorization) {
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

function requireCap(caps, cap) {
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

const EMBED_DIM_N = Number(EMBED_DIM);
const ENTITY_LABEL = "Entity";
const FACET_RE = /^[a-z][a-z0-9_-]*$/i;
const PROP_RE = /^[a-z][a-z0-9_]*$/i;

/** advertised facets — upsert may add custom ones (lazily indexed) */
const FACETS = {
  identity: "what the entity is — type, purpose, defining attributes",
  location: "where it is / where it lives / where it runs",
  state: "current status, condition, availability",
  temporal: "when things happened — ordered, arrived, installed, updated",
  relations: "how it connects to other entities",
};

const knownIndexes = new Set();
const log = { warn: (...a) => console.warn("[graph-rag]", ...a), info: (...a) => console.log("[graph-rag]", ...a) };
const BASIC = "Basic " + Buffer.from(`${ARCADEDB_USER}:${ARCADEDB_PASSWORD}`).toString("base64");

/** ArcadeDB HTTP JSON API */
async function adb(endpoint, body) {
  const res = await fetch(`${ARCADEDB_URL.replace(/\/+$/, "")}/api/v1/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: BASIC },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`arcadedb ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`arcadedb non-JSON: ${text.slice(0, 120)}`);
  }
}

/** read query (sql or cypher); params use :name markers */
async function adbQueryLang(query, language = "sql", params) {
  const body = { language, command: query };
  if (params) body.params = params;
  const j = await adb(`query/${ARCADEDB_DB}`, body);
  return j.result ?? j.records ?? [];
}

/** read query (sql) */
async function adbQuery(sql, params) {
  return adbQueryLang(sql, "sql", params);
}

/** write command (sql or cypher) */
async function adbCommand(command, language = "sql", params) {
  const body = { language, command };
  if (params) body.params = params;
  const j = await adb(`command/${ARCADEDB_DB}`, body);
  return j.result ?? [];
}

/** escape a string literal for embedding in sql/cypher */
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function ensureIndex(facet) {
  if (knownIndexes.has(facet)) return;
  const prop = `embed_${facet}`;
  try {
    await adbCommand("CREATE VERTEX TYPE Entity IF NOT EXISTS");
  } catch {
    /* exists */
  }
  try {
    await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} LIST OF FLOAT`);
  } catch {
    /* property may already exist */
  }
  await adbCommand(
    `CREATE INDEX ON ${ENTITY_LABEL} (${prop}) LSM_VECTOR METADATA ` +
      `{dimensions: ${EMBED_DIM_N}, similarity: 'COSINE', quantization: 'INT8', buildGraphNow: false}`,
  ).catch((e) => {
    if (!/already exists/i.test(String(e))) throw e;
  });
  knownIndexes.add(facet);
}

async function ensureFullText() {
  try {
    await adbCommand(`CREATE INDEX ON ${ENTITY_LABEL} (text_identity) FULL_TEXT`);
  } catch {
    /* exists */
  }
}

async function embedBatch(texts) {
  const res = await fetch(`${LITELLM_BASE_URL.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LITELLM_API_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  const vecs = (j.data ?? []).map((d) => d.embedding);
  if (vecs.length !== texts.length || vecs.some((v) => !Array.isArray(v))) {
    throw new Error("embeddings response shape mismatch");
  }
  return vecs;
}

/** strip vector props; keep human-readable facet texts */
function publicProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k.startsWith("embed_") || k === "_home") continue;
    out[k] = v;
  }
  return out;
}

/** deterministic identity text for the sweep/backfill */
function identityText(name, labels, props) {
  const l = labels.filter((x) => x !== ENTITY_LABEL).join(",");
  const kv = Object.entries(props)
    .filter(([k]) => k !== "updated_at")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("; ");
  return `${l ? `[${l}] ` : ""}${name}${kv ? " — " + kv : ""}`;
}

/** ---- tool implementations ---- */

async function searchGraph({ query, facets, k = 8, temporal_filter }, scope = { homes: null }) {
  console.log(`[graph-rag] search_graph: ${JSON.stringify({ query: query.slice(0, 80), facets, temporal_filter })}`);
  const facetList = (facets?.length ? facets : Object.keys(FACETS)).map((f) => {
    if (typeof f !== "string" || !FACET_RE.test(f)) throw new Error(`invalid facet: ${f}`);
    return f.toLowerCase();
  });
  for (const f of facetList) {
    // advertised facets get their index ensured on demand; custom facets are
    // only searchable if an upsert already created one
    if (!knownIndexes.has(f) && FACETS[f]) await ensureIndex(f);
  }

  // every read path below carries the caller's home filter
  const visible = homeFilter(scope);
  let where = visible;
  if (temporal_filter) {
    const p = temporal_filter.property;
    if (!PROP_RE.test(p)) throw new Error(`invalid temporal property: ${p}`);
    const conds = [`${p} IS NOT NULL`];
    if (temporal_filter.after) conds.push(`${p} >= '${esc(temporal_filter.after)}'`);
    if (temporal_filter.before) conds.push(`${p} <= '${esc(temporal_filter.before)}'`);
    // appended to a query that already has WHERE embed_<facet> IS NOT NULL
    where = visible + " AND " + conds.join(" AND ");
  }

  // keyed by record id: the same name can exist once per home
  const byRid = new Map();
  let vectorWorked = false;
  let embedFailed = false;

  let embedding = null;
  try {
    embedding = (await embedBatch([query]))[0];
  } catch {
    embedFailed = true;
  }

  if (embedding) {
    // brute-force cosine over persisted facet vectors — homelab scale makes
    // this free, and it sidesteps version-dependent HNSW query APIs. The
    // temporal predicate rides in SQL so filtered-empty stays authoritative.
    const innerK = temporal_filter ? Math.min(k * 3, 96) : k;
    for (const facet of facetList) {
      if (!knownIndexes.has(facet)) continue; // nothing ever embedded under it
      let rows;
      try {
        rows = await adbQuery(
          `SELECT FROM ${ENTITY_LABEL} WHERE embed_${facet} IS NOT NULL${where} LIMIT ${innerK * 8}`,
        );
      } catch {
        continue; // facet property not in schema yet
      }
      vectorWorked = true; // authoritative: cosine over what exists (temporal included)
      for (const row of rows) {
        const vec = row[`embed_${facet}`];
        if (!Array.isArray(vec) || vec.length !== embedding.length) continue;
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (let i = 0; i < vec.length; i++) {
          dot += vec[i] * embedding[i];
          na += vec[i] * vec[i];
          nb += embedding[i] * embedding[i];
        }
        const denom = Math.sqrt(na) * Math.sqrt(nb);
        const score = denom === 0 ? 0 : dot / denom;
        const name = row.name;
        const rid = row["@rid"];
        if (!name || !rid) continue;
        const entry =
          byRid.get(rid) ??
          {
            name,
            labels: row["@type"] ? [row["@type"]] : [],
            properties: publicProps(row),
            ...(homeLabel(row._home) ? { home: homeLabel(row._home) } : {}),
            ...(SCOPED && positionMap && !ownsHome(scope, row._home) ? { via: "grant" } : {}),
            score: -2,
            facets: [],
            rid,
          };
        if (score > entry.score) entry.score = score;
        if (!entry.facets.includes(facet)) entry.facets.push(facet);
        byRid.set(rid, entry);
      }
    }
  }

  let results = [...byRid.values()].sort((a, b) => b.score - a.score);

  // lexical fallback when embeddings are unavailable or the index is empty —
  // never when a temporal_filter is set (lexical matching can't honor it)
  if (!vectorWorked && !temporal_filter) {
    const terms = query.split(/\s+/).filter((t) => t.length > 2).slice(0, 6);
    if (terms.length > 0) {
      const conds = terms.map((t) => `(name CONTAINS '${esc(t)}' OR text_identity CONTAINS '${esc(t)}')`);
      const rows = await adbQuery(
        `SELECT FROM ${ENTITY_LABEL} WHERE (${conds.join(" OR ")})${visible} LIMIT ${k}`,
      );
      results = rows.map((row) => ({
        name: row.name,
        properties: publicProps(row),
        ...(homeLabel(row._home) ? { home: homeLabel(row._home) } : {}),
        ...(SCOPED && positionMap && !ownsHome(scope, row._home) ? { via: "grant" } : {}),
        score: null,
        facets: ["lexical"],
        rid: row["@rid"],
      }));
    }
  }

  // 1-hop relationships for the top results: by record id, and only to
  // neighbours the caller may see (an edge must not reveal a hidden node)
  let relationships = [];
  const top = results.slice(0, 12).filter((r) => RID_RE.test(String(r.rid)));
  if (top.length > 0) {
    try {
      const raw = await adbQuery(`SELECT @rid AS rid, @type AS rel, @out AS src, @in AS dst FROM (SELECT expand(bothE()) FROM [${top.map((r) => r.rid).join(",")}]) LIMIT 50`);
      // an edge between two top results comes back once per end
      const edges = [...new Map(raw.map((e) => [String(e.rid), e])).values()];
      const ends = [...new Set(edges.flatMap((e) => [String(e.src), String(e.dst)]).filter((r) => RID_RE.test(r)))];
      const nodes = ends.length
        ? await adbQuery(`SELECT @rid AS rid, name FROM [${ends.join(",")}] WHERE name IS NOT NULL${visible}`)
        : [];
      const nameOf = new Map(nodes.map((n) => [String(n.rid), n.name]));
      relationships = edges
        .filter((e) => nameOf.has(String(e.src)) && nameOf.has(String(e.dst)))
        .map((e) => ({ from: nameOf.get(String(e.src)), rel: e.rel, to: nameOf.get(String(e.dst)) }));
    } catch (e) {
      log.warn(`traversal failed: ${String(e).slice(0, 160)}`); // best-effort
    }
  }

  return {
    query,
    results: results.slice(0, 12).map(({ rid: _rid, ...r }) => r),
    relationships,
    ...(embedFailed ? { note: "embedding backend unavailable; lexical fallback used" } : {}),
  };
}

/** `home` is already resolved by the caller (resolveWriteHome); undefined = unscoped */
async function upsertEntities({ entities, home }) {
  if (!Array.isArray(entities) || entities.length === 0) throw new Error("entities[] required");
  if (entities.length > 64) throw new Error("max 64 entities per call");

  let merged = 0;
  const jobs = []; // {name, facet, text}
  for (const e of entities) {
    if (!e?.name || typeof e.name !== "string") throw new Error("entity.name required");
    const labels = (e.labels ?? []).map(String).filter((l) => l !== ENTITY_LABEL && /^[A-Za-z_][A-Za-z0-9_]*$/.test(l));
    const props = {};
    for (const [k, v] of Object.entries(e.properties ?? {})) {
      if (!PROP_RE.test(k)) throw new Error(`invalid property name: ${k}`);
      if (["string", "number", "boolean"].includes(typeof v)) props[k] = v;
    }
      const propSql = Object.entries(props)
        .map(([k, v]) => `n.${k} = ${typeof v === "string" ? `'${esc(v)}'` : v}`)
        .join(", ");
      // declare properties in the schema first — undeclared properties are
      // writable but invisible to SQL WHERE clauses (e.g. temporal filters)
      for (const k of Object.keys(props)) {
        const type = typeof props[k] === "string" ? "STRING" : typeof props[k] === "boolean" ? "BOOLEAN" : "DOUBLE";
        await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${k} IF NOT EXISTS ${type}`).catch(() => {});
      }
      const labelClause = labels.map((l) => `SET n:\`${l}\``).join(" ");
    // an entity is (name, home): a write never touches a same-named entity
    // homed where the writer may not write
    const key = home === undefined ? `{name: '${esc(e.name)}'}` : `{name: '${esc(e.name)}', \`_home\`: '${esc(home)}'}`;
    await adbCommand(
      `MERGE (n:${ENTITY_LABEL} ${key}) ` +
        `SET n.updated_at = datetime() ${propSql ? ", " + propSql : ""} ${labelClause}`,
      "cypher",
    );
    merged++;
    for (const [facet, text] of Object.entries(e.facets ?? {})) {
      const f = sanitizeFacet(facet);
      if (typeof text !== "string" || !text.trim()) continue;
      await ensureIndex(f);
      jobs.push({ name: e.name, facet: f, text: text.slice(0, 4000) });
    }
  }

  // one batched embeddings call for all facet texts
  let embedded = 0;
  if (jobs.length > 0) {
    const vecs = await embedBatch(jobs.map((j) => j.text));
    for (let i = 0; i < jobs.length; i++) {
      const { name, facet, text } = jobs[i];
      const homeCond = home === undefined ? "" : ` AND _home = '${esc(home)}'`;
      await adbCommand(
        `UPDATE (SELECT FROM ${ENTITY_LABEL} WHERE name = '${esc(name)}'${homeCond}) ` +
          `SET embed_${facet} = [${vecs[i].join(",")}], text_${facet} = '${esc(text)}'`,
      );
      embedded++;
    }
  }

  return { merged, embedded, facets_indexed: [...knownIndexes] };
}

async function backfillIdentity(limit = 64) {
  const lim = Math.max(1, Math.min(256, Number(limit) || 64));
  const nodes = await adbQuery(
    `SELECT FROM ${ENTITY_LABEL} WHERE embed_identity IS NULL LIMIT ${lim}`,
  );
  if (nodes.length === 0) return { backfilled: 0 };

  const texts = [];
  const names = [];
  const rids = [];
  for (const n of nodes) {
    const props = publicProps(n);
    const labels = Object.keys(n).filter((k) => k.startsWith(ENTITY_LABEL) === false && k.startsWith("@") === false && k === k.toLowerCase() === false);
    // ArcadeDB rows expose the type via @type; keep labels implicit
    void labels;
    texts.push(identityText(n.name, n["@type"] ? [n["@type"]] : [], props));
    names.push(n.name);
    rids.push(n["@rid"]);
  }
  const vecs = await embedBatch(texts);
  for (let i = 0; i < names.length; i++) {
    if (!RID_RE.test(String(rids[i]))) continue;
    await adbCommand(
      `UPDATE ${rids[i]} SET embed_identity = [${vecs[i].join(",")}], text_identity = '${esc(texts[i])}'`,
    );
  }
  await ensureFullText();
  return { backfilled: names.length, ...(nodes.length === lim ? { note: "more may remain; run again" } : {}) };
}

/** ---- pass-through: raw graph access for agents (credentials stay here) ---- */

async function queryGraph({ query, language = "cypher" }) {
  if (!["cypher", "sql"].includes(language)) throw new Error("language must be cypher or sql");
  if (typeof query !== "string" || !query.trim()) throw new Error("query required");
  // defense in depth: ArcadeDB's /query endpoint already rejects writes
  if (/^\s*(CREATE|MERGE|DELETE|SET|DROP|REMOVE|DETACH|INSERT|UPDATE)\b/i.test(query)) {
    throw new Error("query_graph is read-only; use execute_graph for writes");
  }
  const rows = await adbQueryLang(query, language);
  return { rows };
}

async function executeGraph({ command, language = "cypher" }, identity) {
  if (!["cypher", "sql"].includes(language)) throw new Error("language must be cypher or sql");
  if (typeof command !== "string" || !command.trim()) throw new Error("command required");
  if (/^\s*(DROP DATABASE|DROP TYPE|TRUNCATE)/i.test(command)) {
    throw new Error("destructive schema/database operations are not permitted");
  }
  if (identity.caps.write === "queued") {
    return queueWrite({ kind: "command", command, language, user: identity.user });
  }
  const result = await adbCommand(command, language);
  return { result };
}

/** execute a queued write (admin approval path) */
async function executePending(rec) {
  // upsert payloads carry the home resolved when the write was requested
  if (rec.kind === "upsert") return upsertEntities(JSON.parse(rec.payload));
  if (rec.kind === "rehome") return applyRehome(JSON.parse(rec.payload));
  if (rec.kind === "grant") return storeGrant(JSON.parse(rec.payload));
  if (rec.kind === "backfill") return backfillIdentity(Number(JSON.parse(rec.payload).limit) || 64);
  return adbCommand(rec.payload, rec.language ?? "sql");
}

/** move entities to another home: restricting applies, widening needs a person */
async function setHome({ entities, to }, identity, scope) {
  if (!SCOPED || !positionMap) throw new Error("position scoping is not enabled");
  const target = positionId(to);
  const results = [];
  for (const ref of entities) {
    const from = ref.home === undefined ? undefined : positionId(ref.home);
    const rows = await adbQuery(
      `SELECT @rid AS rid, name, _home FROM ${ENTITY_LABEL} WHERE name = :name${homeFilter(scope, { own: true })}`,
      { name: ref.name },
    );
    const candidates = rows.filter((r) => from === undefined || effectiveHome(positionMap, r._home) === from);
    if (candidates.length === 0) throw new Error(`no visible entity ${ref.name}${from ? ` homed at ${ref.home}` : ""} (granted entities can't be moved)`);
    if (candidates.length > 1) throw new Error(`${ref.name} exists at several homes you can see; pass its home`);
    const node = candidates[0];
    const current = effectiveHome(positionMap, node._home);
    if (current === target) {
      results.push({ name: ref.name, unchanged: true });
      continue;
    }
    const clash = await adbQuery(`SELECT @rid FROM ${ENTITY_LABEL} WHERE name = :name AND _home = :to`, { name: ref.name, to: target });
    if (clash.length) throw new Error(`${ref.name} already exists at ${positionMap.positions[target].name}`);
    const move = { rid: String(node.rid), name: ref.name, from: current, to: target };
    const kind = moveKind(positionMap, current, target);
    if (kind === "restrict" && identity.caps.write === "direct") {
      results.push({ name: ref.name, ...(await applyRehome(move)) });
    } else {
      // only people widen who sees what; queued writers queue restrictions too
      results.push({ name: ref.name, [kind === "widen" ? "widening" : "restricting"]: true, ...(await queueWrite({ kind: "rehome", payload: JSON.stringify(move), user: identity.user, home: current })) });
    }
  }
  return { results };
}

async function applyRehome({ rid, name, from, to }) {
  if (!RID_RE.test(rid)) throw new Error("invalid record id");
  const rows = await adbQuery(`SELECT _home FROM ${rid}`);
  if (!rows.length) throw new Error(`entity ${name} no longer exists`);
  if (effectiveHome(positionMap, rows[0]._home) !== from) throw new Error(`entity ${name} moved since the request`);
  await adbCommand(`UPDATE ${rid} SET _home = :to`, "sql", { to });
  log.info(`entity ${name} rehomed ${positionMap.positions[from]?.name} -> ${positionMap.positions[to]?.name}`);
  return { moved: true, from: positionMap.positions[from]?.name, to: positionMap.positions[to]?.name };
}

/** ---- grants (see grants.js) ---- */

let grantCache = []; // active grants, refreshed on change and every minute

async function ensureGrantSchema() {
  await adbCommand("CREATE DOCUMENT TYPE AccessGrant IF NOT EXISTS").catch(() => {});
  for (const prop of ["id", "kind", "target", "target_name", "target_home", "to_pos", "reason", "granted_by", "created_at", "expires_at", "status", "revoked_at", "revoked_by"]) {
    await adbCommand(`CREATE PROPERTY AccessGrant.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
}

async function refreshGrants() {
  if (!SCOPED) return;
  try {
    const rows = await adbQuery("SELECT FROM AccessGrant WHERE status = 'active' LIMIT 5000");
    grantCache = rows.map((r) => ({ ...r, to: r.to_pos })).filter((g) => isActive(g));
  } catch (e) {
    log.warn(`grant refresh failed (keeping ${grantCache.length}): ${String(e).slice(0, 160)}`);
  }
}

const positionName = (id) => positionMap?.positions[id]?.name ?? id;

/** propose or make a grant; owners only, agents and queued writers propose */
async function grantAccess({ entities, subtree: subtreeRef, to, reason, until }, identity, scope) {
  if (!SCOPED || !positionMap) throw new Error("position scoping is not enabled");
  if (!!entities === !!subtreeRef) throw new Error("grant either entities or a subtree, not both");
  const toPos = positionId(to);
  const expires_at = resolveExpiry(until, { root: scope.root });
  const base = { to_pos: toPos, reason: String(reason).slice(0, 500), granted_by: identity.user, expires_at };
  const targets = [];
  if (subtreeRef) {
    const p = positionId(subtreeRef);
    if (!ownsHome(scope, p)) throw new Error(`you can only grant what you own: ${subtreeRef} is outside your positions`);
    const toView = visibleHomes(positionMap, [toPos]); // null = the root, sees everything
    if (toView === null || toView.has(p)) throw new Error(`${positionName(toPos)} already sees ${positionName(p)}`);
    targets.push({ kind: "subtree", target: p, target_name: positionName(p), target_home: p });
  } else {
    for (const ref of entities) {
      const from = ref.home === undefined ? undefined : positionId(ref.home);
      const rows = await adbQuery(
        `SELECT @rid AS rid, name, _home FROM ${ENTITY_LABEL} WHERE name = :name${homeFilter(scope, { own: true })}`,
        { name: ref.name },
      );
      const hits = rows.filter((r) => from === undefined || effectiveHome(positionMap, r._home) === from);
      if (hits.length === 0) throw new Error(`no entity ${ref.name} you own${from ? ` at ${ref.home}` : ""} (granted entities can't be granted onward)`);
      if (hits.length > 1) throw new Error(`${ref.name} exists at several homes you own; pass its home`);
      const home = effectiveHome(positionMap, hits[0]._home);
      if (visibleHomes(positionMap, [toPos])?.has(home) ?? true) throw new Error(`${positionName(toPos)} already sees ${ref.name}`);
      targets.push({ kind: "entity", target: String(hits[0].rid), target_name: ref.name, target_home: home });
    }
  }
  const results = [];
  for (const t of targets) {
    const grant = { id: randomUUID(), ...base, ...t };
    // only people grant directly: agents (and queued writers) propose
    if (identity.caps.write === "direct" && !identity.agent) {
      await storeGrant(grant);
      results.push({ granted: true, id: grant.id, target: t.target_name, to: positionName(toPos), expires_at });
    } else {
      const q = await queueWrite({ kind: "grant", payload: JSON.stringify(grant), user: identity.user, home: t.target_home });
      results.push({ proposed: true, target: t.target_name, to: positionName(toPos), ...q });
    }
  }
  return { results };
}

async function storeGrant(g) {
  if (g.expires_at && Date.parse(g.expires_at) <= Date.now()) throw new Error("this grant has already expired");
  await adbCommand(
    "INSERT INTO AccessGrant SET id = :id, kind = :kind, target = :target, target_name = :target_name, target_home = :target_home, " +
      "to_pos = :to_pos, reason = :reason, granted_by = :granted_by, created_at = :created_at, expires_at = :expires_at, status = 'active'",
    "sql",
    { ...g, created_at: new Date().toISOString(), expires_at: g.expires_at ?? null },
  );
  log.info(`grant ${g.id}: ${g.kind} ${g.target_name} -> ${positionName(g.to_pos)} by ${g.granted_by} until ${g.expires_at ?? "revoked"}`);
  await refreshGrants();
  return { granted: true, id: g.id };
}

/** revoking only restricts: the grantor or any owner of the data may */
async function revokeGrant({ id }, identity, scope) {
  if (!positionMap) throw new Error("position map not loaded");
  if (!PENDING_ID_RE.test(id)) throw new Error("invalid grant id");
  const rows = await adbQuery("SELECT FROM AccessGrant WHERE id = :id AND status = 'active'", { id });
  const g = rows[0];
  if (!g || !(g.granted_by === identity.user || ownsHome(scope, g.target_home))) throw new Error(`no grant ${id} you can revoke`);
  await adbCommand("UPDATE AccessGrant SET status = 'revoked', revoked_at = :now, revoked_by = :actor WHERE id = :id", "sql", {
    now: new Date().toISOString(),
    actor: identity.user,
    id,
  });
  log.info(`grant ${id} revoked by ${identity.user}`);
  await refreshGrants();
  return { revoked: true, id };
}

/** grants on data the caller owns (outgoing) and grants it receives (incoming) */
function listGrants(scope) {
  if (!positionMap) return { grants: [] };
  const vis = scope.homes;
  const out = [];
  for (const g of grantCache) {
    if (!isActive(g)) continue;
    const outgoing = ownsHome(scope, g.target_home);
    const incoming = vis === null || vis.has(g.to_pos);
    if (!outgoing && !incoming) continue;
    out.push({
      id: g.id,
      kind: g.kind,
      target: g.target_name,
      target_home: positionName(g.target_home),
      to: positionName(g.to_pos),
      reason: g.reason,
      granted_by: g.granted_by,
      expires_at: g.expires_at ?? null,
      direction: outgoing ? "outgoing" : "incoming",
    });
  }
  return { grants: out };
}

async function schemaGraph() {
  const types = await adbQuery("SELECT FROM schema:types").catch(() => []);
  if (types.length > 0) return { types };
  const indexes = await adbQuery("SELECT FROM schema:indexes").catch(() => []);
  return { types: [], indexes };
}

/** ---- pending-write queue (audited writes for low-capability identities) ---- */

async function ensurePendingSchema() {
  await adbCommand("CREATE DOCUMENT TYPE PendingWrite").catch(() => {});
  for (const prop of ["id", "kind", "payload", "language", "requested_by", "created_at", "status", "executed_at", "approved_by", "home"]) {
    await adbCommand(`CREATE PROPERTY PendingWrite.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
}

const RID_RE = /^#\d+:\d+$/;
const PENDING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function queueWrite(entry) {
  const id = randomUUID();
  const created = new Date().toISOString();
  const payload = entry.payload ?? entry.command ?? "";
  const language = entry.language ?? "sql";
  // awaited: a write is only reported as queued once the record exists
  await adbCommand(
    "INSERT INTO PendingWrite SET id = :id, kind = :kind, payload = :payload, language = :lang, " +
      "requested_by = :user, created_at = :created, status = 'pending', home = :home",
    "sql",
    { id, kind: entry.kind, payload, lang: language, user: entry.user, created, home: entry.home ?? null },
  );
  console.log(`[graph-rag] write queued by ${entry.user}: ${String(payload).slice(0, 80)} (${id})`);
  return { queued: true, pendingId: id };
}

/** pending writes the approver may review (it must be able to see where each lands) */
async function listPending(identity) {
  const rows = await adbQuery("SELECT FROM PendingWrite WHERE status = 'pending' ORDER BY created_at DESC LIMIT 100");
  return rows.filter((r) => mayReview(identity, r));
}

function mayReview(identity, rec) {
  if (!SCOPED || identity.open) return true;
  if (!positionMap) return false;
  const held = heldPositions(positionMap, identity.positions);
  if (!canSee(positionMap, held, rec.home ?? undefined)) return false;
  if (rec.kind === "rehome") {
    const { to } = JSON.parse(rec.payload);
    return canSee(positionMap, held, to);
  }
  return true;
}

async function approvePending(id, identity) {
  const approver = identity.user;
  if (!PENDING_ID_RE.test(id)) throw new Error("invalid pending id");
  const rows = await adbQuery("SELECT FROM PendingWrite WHERE id = :id AND status = 'pending'", { id });
  const rec = rows[0];
  if (!rec || !mayReview(identity, rec)) throw new Error(`no pending write ${id}`);
  // claim it first: a write runs once, even with two approvals racing
  // (note: "by" is reserved in ArcadeDB SQL, so parameters avoid it)
  const claimed = await adbCommand(
    "UPDATE PendingWrite SET status = 'executing', approved_by = :actor WHERE id = :id AND status = 'pending'",
    "sql",
    { actor: approver, id },
  );
  if (Number(claimed?.[0]?.count ?? 0) !== 1) throw new Error(`pending write ${id} was already handled`);
  let result;
  try {
    // upsert/backfill payloads are JSON for their handlers, not SQL
    result = await executePending(rec);
  } catch (err) {
    await adbCommand("UPDATE PendingWrite SET status = 'failed', executed_at = :now WHERE id = :id", "sql", {
      now: new Date().toISOString(),
      id,
    }).catch(() => {});
    throw err;
  }
  await adbCommand("UPDATE PendingWrite SET status = 'approved', executed_at = :now WHERE id = :id", "sql", {
    now: new Date().toISOString(),
    id,
  });
  console.log(`[graph-rag] write ${id} approved by ${approver}`);
  return { approved: true, result };
}
async function rejectPending(id, identity) {
  const rejector = identity.user;
  if (!PENDING_ID_RE.test(id)) throw new Error("invalid pending id");
  const rows = await adbQuery("SELECT FROM PendingWrite WHERE id = :id AND status = 'pending'", { id });
  if (!rows[0] || !mayReview(identity, rows[0])) throw new Error(`no pending write ${id}`);
  const done = await adbCommand(
    "UPDATE PendingWrite SET status = 'rejected', executed_at = :now, approved_by = :actor WHERE id = :id AND status = 'pending'",
    "sql",
    { now: new Date().toISOString(), actor: rejector, id },
  );
  if (Number(done?.[0]?.count ?? 0) !== 1) throw new Error(`pending write ${id} was already handled`);
  return { rejected: true };
}

function sanitizeFacet(name) {
  if (typeof name !== "string" || !FACET_RE.test(name)) throw new Error(`invalid facet name: ${String(name)}`);
  return name.toLowerCase();
}

/** ---- MCP server (fresh instance per request: stateless) ---- */
const facetDoc = Object.entries(FACETS)
  .map(([f, d]) => `- ${f}: ${d}`)
  .join("\n");

function createServer(identity) {
  const caps = identity.caps;
  const scope = scopeOf(identity);
  const need = (cap) => {
    requireCap(caps, cap);
    // raw queries bypass the home filter: only for the root of the tree
    if (cap === "raw" && !scope.root) throw new Error("raw graph queries require the root position");
  };
  const homeNote = SCOPED
    ? `\nEach entity has a home position; you only see entities homed at your positions or below them.`
    : "";
  const server = new McpServer({ name: "graph-rag", version: "0.3.0" });
  // each identity is only shown the tools its capabilities allow (the
  // handlers check again: listing is not the boundary)

  // raw Cypher/SQL bypasses every read filter: only listed for raw identities
  if (caps.raw === true && scope.root) server.tool(
    "query_graph",
    `Run a READ-ONLY query against the knowledge graph (openCypher or SQL). Use for exact identifiers, structure, and schema exploration. Returns JSON rows.`,
    {
      query: z.string().min(1),
      language: z.enum(["cypher", "sql"]).optional(),
    },
    async (args) => {
      need("read");
      need("raw");
      return { content: [{ type: "text", text: JSON.stringify(await queryGraph(args)) }] };
    },
  );

  server.tool(
    "search_graph",
    `Semantic (embedding) search over per-facet vector indexes of the knowledge graph. Facets:
${facetDoc}
Custom facets created via upsert_entities are also searchable. Use for conceptual or
paraphrased questions; temporal_filter (property + after/before ISO datetimes) narrows by
a datetime property. Falls back to lexical matching if embeddings are unavailable.${homeNote}`,
    {
      query: z.string().min(1),
      facets: z.array(z.string()).optional(),
      k: z.number().int().min(1).max(32).optional(),
      temporal_filter: z
        .object({
          property: z.string(),
          after: z.string().optional(),
          before: z.string().optional(),
        })
        .optional(),
    },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await searchGraph(args, scope)) }] };
    },
  );

  server.tool(
    "schema_graph",
    "List the knowledge-graph types and indexes.",
    {},
    async () => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await schemaGraph()) }] };
    },
  );

  if (caps.write !== "deny") server.tool(
    "upsert_entities",
    `Create or update graph entities with per-facet semantic indexes. For each entity provide
facet texts — a concise natural-language sentence per facet capturing that aspect (facet
list below). Provide only facets you have information for. Unknown facet names are allowed
and indexed lazily. Include datetime facts BOTH as properties (for temporal_filter) and
inside facet texts.${SCOPED ? `
Entities land at your position by default; \`home\` may name one of your positions or one above it
(restricting who sees them), never one below or beside yours.` : ""}
${facetDoc}`,
    {
      ...(SCOPED ? { home: z.string().optional() } : {}),
      entities: z
        .array(
          z.object({
            name: z.string().min(1),
            labels: z.array(z.string()).optional(),
            properties: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
            facets: z.record(z.string()).optional(),
          }),
        )
        .max(64),
    },
    async (args) => {
      need("write");
      const home = resolveWriteHome(scope, args.home);
      const write = { entities: args.entities, home };
      if (caps.write === "queued") {
        const pending = await queueWrite({ kind: "upsert", payload: JSON.stringify(write), user: identity.user, home });
        return { content: [{ type: "text", text: JSON.stringify(pending) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(await upsertEntities(write)) }] };
    },
  );

  if (caps.raw === true && scope.root) server.tool(
    "execute_graph",
    "Execute a WRITE command against the knowledge graph (openCypher or SQL). Depending on your identity capabilities this executes immediately or is queued for review.",
    {
      command: z.string().min(1),
      language: z.enum(["cypher", "sql"]).optional(),
    },
    async (args) => {
      need("write");
      need("raw");
      return { content: [{ type: "text", text: JSON.stringify(await executeGraph(args, identity)) }] };
    },
  );

  if (caps.write !== "deny") server.tool(
    "embed_backfill",
    "Embed the identity facet for graph nodes written without embeddings. Requires write capability; queued-mode identities store it for approval.",
    { limit: z.number().int().min(1).max(256).optional() },
    async (args) => {
      need("write");
      if (caps.write === "queued") {
        const pending = await queueWrite({ kind: "backfill", payload: JSON.stringify({ limit: args?.limit ?? 64 }), user: identity.user });
        return { content: [{ type: "text", text: JSON.stringify(pending) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(await backfillIdentity(args?.limit ?? 64)) }] };
    },
  );

  if (SCOPED && caps.write !== "deny") server.tool(
    "set_home",
    `Move entities to another home position. Moving one up (to a position above its home) restricts
who sees it and applies directly; moving it anywhere else widens who sees it and is queued for a
person to approve. Identify each entity by name (and its current home if the name exists at several
homes you can see).`,
    {
      entities: z.array(z.object({ name: z.string().min(1), home: z.string().optional() })).min(1).max(32),
      to: z.string().min(1),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await setHome(args, identity, scope)) }] };
    },
  );

  if (SCOPED && caps.write !== "deny") server.tool(
    "grant_access",
    `Show data you own to another position for a while: either named entities or a whole subtree
(a position and everything below it). Give a reason and an expiry (until, ISO date; at most 90
days unless you hold the root). People with direct write rights grant at once; agents and queued
writers propose, and a person approves. Data you only see through a grant can't be granted onward.`,
    {
      entities: z.array(z.object({ name: z.string().min(1), home: z.string().optional() })).min(1).max(32).optional(),
      subtree: z.string().min(1).optional(),
      to: z.string().min(1),
      reason: z.string().min(3).max(500),
      until: z.string().optional(),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await grantAccess(args, identity, scope)) }] };
    },
  );

  if (SCOPED) server.tool(
    "list_grants",
    "List active grants on data you own (outgoing) and grants that show you data (incoming).",
    {},
    async () => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(listGrants(scope)) }] };
    },
  );

  if (SCOPED && caps.write !== "deny") server.tool(
    "revoke_grant",
    "Revoke a grant (takes effect at once). The person who granted it or any owner of the data may revoke.",
    { id: z.string().min(1) },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await revokeGrant(args, identity, scope)) }] };
    },
  );

  if (caps.approve === true) server.tool(
    "list_pending_writes",
    "List queued graph writes awaiting approval (requires approve capability).",
    {},
    async () => {
      need("approve");
      return { content: [{ type: "text", text: JSON.stringify({ pending: await listPending(identity) }) }] };
    },
  );

  if (caps.approve === true) server.tool(
    "approve_write",
    "Approve and execute a queued graph write.",
    { id: z.string().min(1) },
    async (args) => {
      need("approve");
      return { content: [{ type: "text", text: JSON.stringify(await approvePending(args.id, identity)) }] };
    },
  );

  if (caps.approve === true) server.tool(
    "reject_write",
    "Reject a queued graph write without executing it.",
    { id: z.string().min(1) },
    async (args) => {
      need("approve");
      return { content: [{ type: "text", text: JSON.stringify(await rejectPending(args.id, identity)) }] };
    },
  );

  return server;
}

/** ---- http ---- */
const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/mcp", async (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthenticated" }, id: null });
    return;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: each POST is self-contained
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  try {
    await createServer(identity).connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null });
    }
  }
});

app.get("/mcp", (_req, res) => res.status(405).json({ error: "POST only (stateless)" }));
app.get("/health", (_req, res) => res.json({ ok: true, facets_indexed: [...knownIndexes] }));

/** write-approval queue HTTP (for review UIs); approve-capability required */
function queueIdentity(req) {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity || identity.caps.approve !== true) return null;
  return identity;
}
app.get("/api/queue", (req, res) => {
  const identity = queueIdentity(req);
  if (!identity) return res.status(403).json({ error: "requires approve capability" });
  void listPending(identity).then(
    (pending) => res.json({ pending }),
    (err) => res.status(500).json({ error: String(err).slice(0, 200) }),
  );
});
app.post("/api/queue/:id/approve", (req, res) => {
  const identity = queueIdentity(req);
  if (!identity) return res.status(403).json({ error: "requires approve capability" });
  void approvePending(req.params.id, identity).then(
    (result) => res.json({ result }),
    (err) => res.status(400).json({ error: String(err).slice(0, 200) }),
  );
});
app.post("/api/queue/:id/reject", (req, res) => {
  const identity = queueIdentity(req);
  if (!identity) return res.status(403).json({ error: "requires approve capability" });
  void rejectPending(req.params.id, identity).then(
    (result) => res.json({ result }),
    (err) => res.status(400).json({ error: String(err).slice(0, 200) }),
  );
});

/**
 * The part of the position tree the caller can reach (its positions and
 * everything below): what a tenant may place its agents at.
 */
app.get("/api/positions", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!SCOPED) return res.json({ scoped: false, held: [], positions: [] });
  if (!positionMap) return res.status(503).json({ error: "position map not loaded" });
  const held = heldPositions(positionMap, identity.positions);
  const reach = visibleHomes(positionMap, held);
  const positions = Object.entries(positionMap.positions)
    .filter(([id]) => reach === null || reach.has(id))
    .map(([id, p]) => ({ id, name: p.name, parent: p.parent, ...(p.description ? { description: p.description } : {}) }));
  // the whole tree's names: grants may go to positions outside the caller's
  // reach (that is their point); this says nothing about anyone's data
  const tree = Object.entries(positionMap.positions).map(([id, p]) => ({ id, name: p.name, parent: p.parent }));
  res.json({ scoped: true, root: positionMap.root, held, positions, tree, canGrantStanding: reach === null });
});

/** ---- grants + owned-entity search over HTTP (the people-facing UI) ---- */
function httpScope(req, res) {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  if (!SCOPED || !positionMap) {
    res.status(409).json({ error: "the knowledge graph isn't divided into positions" });
    return null;
  }
  return { identity, scope: scopeOf(identity) };
}
const httpError = (res, err) => res.status(400).json({ error: String(err instanceof Error ? err.message : err).slice(0, 300) });

app.get("/api/grants", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) res.json({ ...listGrants(ctx.scope), canGrantStanding: ctx.scope.root });
});
app.post("/api/grants", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  if (ctx.identity.caps.write === "deny") return res.status(403).json({ error: "graph writes are denied for this identity" });
  const b = req.body ?? {};
  const args = {
    ...(Array.isArray(b.entities) ? { entities: b.entities.slice(0, 32).map((e) => ({ name: String(e?.name ?? ""), ...(e?.home ? { home: String(e.home) } : {}) })) } : {}),
    ...(typeof b.subtree === "string" ? { subtree: b.subtree } : {}),
    to: String(b.to ?? ""),
    reason: String(b.reason ?? ""),
    ...(typeof b.until === "string" && b.until ? { until: b.until } : {}),
  };
  if (args.reason.trim().length < 3) return httpError(res, "give a reason");
  void grantAccess(args, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/grants/:id/revoke", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void revokeGrant({ id: req.params.id }, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
/** entities the caller owns (by home), for picking what to grant */
app.get("/api/entities", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  const match = q ? ` AND (name CONTAINS '${esc(q)}' OR text_identity CONTAINS '${esc(q)}')` : "";
  void adbQuery(`SELECT name, _home FROM ${ENTITY_LABEL} WHERE name IS NOT NULL${match}${homeFilter(ctx.scope, { own: true })} ORDER BY name LIMIT 25`).then(
    (rows) => res.json({ entities: rows.map((r) => ({ name: r.name, home: homeLabel(r._home) })) }),
    (e) => httpError(res, e),
  );
});

/** boot: ensure advertised indexes + periodic identity sweep */
async function boot() {
  loadTokenMap();
  loadPositionMap();
  if (SCOPED) {
    watchFile(POSITION_MAP_PATH, { interval: 5000 }, () => {
      console.log("[graph-rag] position map changed; reloading");
      loadPositionMap();
    });
  }
  if (TOKEN_MAP_PATH) {
    watchFile(TOKEN_MAP_PATH, { interval: 5000 }, () => {
      console.log("[graph-rag] token map changed; reloading");
      loadTokenMap();
    });
  }
  for (const facet of Object.keys(FACETS)) await ensureIndex(facet);
  // declared, or SQL WHERE can't see it (see upsertEntities)
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._home IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (_home) NOTUNIQUE`).catch(() => {});
  if (SCOPED) {
    await ensureGrantSchema();
    await refreshGrants();
    setInterval(() => void refreshGrants(), 60_000);
  }
  await ensurePendingSchema();
  console.log(`[graph-rag] indexes ready: ${[...knownIndexes].join(", ")}`);
  const sweep = async () => {
    try {
      const r = await backfillIdentity(64);
      if (r.backfilled > 0) console.log(`[graph-rag] sweep backfilled ${r.backfilled} identity embeddings`);
    } catch (e) {
      console.warn(`[graph-rag] sweep failed: ${String(e).slice(0, 160)}`);
    }
  };
  setInterval(sweep, Number(SWEEP_INTERVAL_MS));
  app.listen(Number(PORT), () => console.log(`[graph-rag] listening on :${PORT}`));
}

boot().catch((e) => {
  console.error("[graph-rag] boot failed:", e);
  process.exit(1);
});
