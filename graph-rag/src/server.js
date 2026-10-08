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
  ancestors,
  canSee,
  commonAncestor,
  defaultHome,
  effectiveHome,
  heldPositions,
  moveKind,
  parsePositionMap,
  visibleHomes,
  writableHomes,
} from "./positions.js";
import { PREFIX as AGENT_TOKEN_PREFIX, resolveAgentToken } from "./delegation.js";
import { chooseValidity, isExpired, liveClause, parseValidUntil } from "./extent.js";
import { createSink, ledgerLine, preview, pruneCutoff, pruneRecord } from "./prune.js";
import { danglingGrants, entityPredicate, grantedView, grantShows, isActive, resolveExpiry } from "./grants.js";
import { askerView, JOIN_MIN, MATCH_MAX, MATCH_MIN, needName, openUntil, ownersFor, ownerView, pickPositions } from "./needs.js";
import { decide, gradingPrompt, parseVerdicts } from "./grading.js";
import { applyPolicyUpdate, defaultPolicy, normalizeStored } from "./policy.js";
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
  // semantic grading of new writes against the position tree (empty = off)
  GRADER_MODEL = "",
  GRADER_TIMEOUT_MS = "30000",
  EMBED_TIMEOUT_MS = "30000",
  // where pruned entries go before deletion; "discard" keeps nothing (see prune.js)
  PRUNE_SINK = "discard",
  // policy defaults (MAX_GRANT_DAYS, DEFAULT_SHARE_DAYS, STANDING_GRANTS,
  // PEOPLE_SHARE_DIRECTLY, GRADING_ENABLED, GRADING_CONFIDENCE,
  // DERIVED_WINDOW_HOURS) are read by policy.js
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
function homeFilter(scope, { own = false } = {}) {
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
  if (entities) conds.push(entities);
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
/** a user-typed term inside an ILIKE pattern: escaped, with its own wildcards removed */
const likeTerm = (s) => esc(String(s).replace(/[%_]/g, ""));

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
    // a stalled backend fails the call (search falls back to lexical) instead of hanging it
    signal: AbortSignal.timeout(Number(EMBED_TIMEOUT_MS)),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  const vecs = (j.data ?? []).map((d) => d.embedding);
  if (vecs.length !== texts.length || vecs.some((v) => !Array.isArray(v))) {
    throw new Error("embeddings response shape mismatch");
  }
  return vecs;
}

/** a question in results: who asked, until when; it's a request, not a fact */
const questionOf = (row) => (row?._kind === "need" ? { kind: "question", asked_by: row._asker, open_until: row._open_until ?? null } : {});

/** an entry's end date in results (lasting entries carry none) */
const validityOf = (row) => (row?._valid_until ? { valid_until: row._valid_until, ...(isExpired(row._valid_until) ? { expired: true } : {}) } : {});

/** strip vector props; keep human-readable facet texts */
function publicProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k.startsWith("embed_") || k.startsWith("_")) continue;
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

async function searchGraph({ query, facets, k = 8, temporal_filter, include_expired = false, assertions_only = false }, scope = { homes: null }, readHomes = []) {
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

  // every read path below carries the caller's home filter, and (unless
  // history is asked for) leaves out entries past their end date
  // questions show while open (history: any but drafts); never where only knowledge is wanted
  const kinds = assertions_only ? ASSERTIONS : include_expired ? " AND (_kind IS NULL OR _status <> 'proposed')" : openNeedsClause();
  const visible = homeFilter(scope) + (include_expired ? "" : liveClause()) + kinds;
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
    // exact cosine, scored and ranked by ArcadeDB over every row the caller
    // may see (the visibility and temporal predicates ride in the same
    // query). Earlier this fetched the first k*8 rows and ranked only those,
    // which misses the right entities once a graph outgrows a few dozen.
    const innerK = temporal_filter ? Math.min(k * 3, 96) : k;
    const vec = `[${embedding.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
    const best = new Map(); // rid -> { score, facets }
    for (const facet of facetList) {
      if (!knownIndexes.has(facet)) continue; // nothing ever embedded under it
      let rows;
      try {
        rows = await adbQuery(
          `SELECT @rid AS rid, vectorCosineSimilarity(embed_${facet}, ${vec}) AS score FROM ${ENTITY_LABEL} ` +
            `WHERE embed_${facet} IS NOT NULL${where} ORDER BY score DESC LIMIT ${innerK}`,
        );
      } catch {
        continue; // facet property not in schema yet
      }
      vectorWorked = true; // authoritative: ranked over everything visible (temporal included)
      for (const row of rows) {
        const rid = String(row.rid);
        const score = Number(row.score);
        if (!RID_RE.test(rid) || !Number.isFinite(score)) continue;
        const b = best.get(rid) ?? { score: -2, facets: [] };
        if (score > b.score) b.score = score;
        if (!b.facets.includes(facet)) b.facets.push(facet);
        best.set(rid, b);
      }
    }
    const top = [...best].sort((a, b) => b[1].score - a[1].score).slice(0, k);
    if (top.length) {
      const rows = await adbQuery(`SELECT FROM [${top.map(([rid]) => rid).join(",")}]`);
      const byId = new Map(rows.map((r) => [String(r["@rid"]), r]));
      for (const [rid, b] of top) {
        const row = byId.get(rid);
        if (!row?.name) continue;
        byRid.set(rid, {
          name: row.name,
          labels: row["@type"] ? [row["@type"]] : [],
          properties: publicProps(row),
          ...(homeLabel(row._home) ? { home: homeLabel(row._home) } : {}),
          ...(SCOPED && positionMap && !ownsHome(scope, row._home) ? { via: "grant" } : {}),
          ...validityOf(row),
          ...questionOf(row),
          score: b.score,
          facets: b.facets,
          rid,
        });
      }
    }
  }

  let results = [...byRid.values()].sort((a, b) => b.score - a.score);

  // lexical fallback when embeddings are unavailable or the index is empty —
  // never when a temporal_filter is set (lexical matching can't honor it)
  if (!vectorWorked && !temporal_filter) {
    const terms = query.split(/\s+/).filter((t) => t.length > 2).slice(0, 6);
    if (terms.length > 0) {
      // ILIKE: ArcadeDB's CONTAINS is a collection operator and never matches substrings
      const conds = terms.map((t) => `(name ILIKE '%${likeTerm(t)}%' OR text_identity ILIKE '%${likeTerm(t)}%')`);
      const rows = await adbQuery(
        `SELECT FROM ${ENTITY_LABEL} WHERE (${conds.join(" OR ")})${visible} LIMIT ${k}`,
      );
      results = rows.map((row) => ({
        name: row.name,
        properties: publicProps(row),
        ...(homeLabel(row._home) ? { home: homeLabel(row._home) } : {}),
        ...(SCOPED && positionMap && !ownsHome(scope, row._home) ? { via: "grant" } : {}),
        ...validityOf(row),
        ...questionOf(row),
        score: null,
        facets: ["lexical"],
        rid: row["@rid"],
      }));
    }
  }

  // 1-hop relationships for the top results: by record id, and only to
  // neighbours the caller may see (an edge must not reveal a hidden node)
  let relationships = [];
  const neighbourHomes = [];
  const top = results.slice(0, k).filter((r) => RID_RE.test(String(r.rid)));
  if (top.length > 0) {
    try {
      const raw = await adbQuery(`SELECT @rid AS rid, @type AS rel, @out AS src, @in AS dst FROM (SELECT expand(bothE()) FROM [${top.map((r) => r.rid).join(",")}]) LIMIT 50`);
      // an edge between two top results comes back once per end
      const edges = [...new Map(raw.map((e) => [String(e.rid), e])).values()];
      const ends = [...new Set(edges.flatMap((e) => [String(e.src), String(e.dst)]).filter((r) => RID_RE.test(r)))];
      const nodes = ends.length
        ? await adbQuery(`SELECT @rid AS rid, name, _home, _kind FROM [${ends.join(",")}] WHERE name IS NOT NULL${visible}`)
        : [];
      const nameOf = new Map(nodes.map((n) => [String(n.rid), n.name]));
      // reading a question gives no knowledge: it doesn't bound where later writes land
      for (const n of nodes) if (!n._kind) neighbourHomes.push(n._home);
      relationships = edges
        .filter((e) => nameOf.has(String(e.src)) && nameOf.has(String(e.dst)))
        .map((e) => ({ from: nameOf.get(String(e.src)), rel: e.rel, to: nameOf.get(String(e.dst)) }));
    } catch (e) {
      log.warn(`traversal failed: ${String(e).slice(0, 160)}`); // best-effort
    }
  }

  // what the caller has now seen (derived-data tracking; not returned)
  readHomes.push(...results.slice(0, k).filter((r) => r.kind !== "question").map((r) => r.home?.id), ...neighbourHomes.map((h) => (SCOPED && positionMap ? effectiveHome(positionMap, h) : h)));
  return {
    query,
    // exactly k results (the schema allows 1..32, default 8)
    results: results.slice(0, k).map(({ rid: _rid, ...r }) => r),
    relationships,
    ...(embedFailed ? { note: "embedding backend unavailable; lexical fallback used" } : {}),
  };
}

/** ---- derived data: what an identity read bounds where its writes land ---- */

const readMarks = new Map(); // identity -> Map(home -> last read ms)
const windowMs = () => policy.derivedWindowHours * 3_600_000;

async function ensureReadMarkSchema() {
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
function recordReads(identity, homes) {
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
function derivedFloor(identity, origin) {
  if (!SCOPED || !positionMap || origin === undefined || identity.open || policy.derivedWindowHours === 0) return origin;
  const cutoff = Date.now() - windowMs();
  const read = [...(readMarks.get(markKey(identity)) ?? new Map())].filter(([, t]) => t > cutoff).map(([h]) => h);
  return commonAncestor(positionMap, [origin, ...read]);
}

/**
 * Apply a derived-data floor to a placement. The floor is at or above the
 * origin, so it and the placement lie on one line through the origin. The
 * entry goes at least as high as the floor, and nothing is proposed below it
 * (a release or a review back to the origin would widen derived data).
 */
function applyFloor(place, origin, floor) {
  if (!floor || floor === origin) return place;
  const { release: _release, review: _review, ...rest } = place;
  const raises = floor !== place.home && ancestors(positionMap, place.home).includes(floor);
  if (!raises) return rest;
  return {
    home: floor,
    note: `held at ${positionMap.positions[floor]?.name}: built from what its writer read there or below (${place.note})`,
  };
}

/** one grading call (chunks of up to 16 entities); null per entity when it fails */
async function gradeBatch(origin, entities, writtenAt = Date.now()) {
  const out = [];
  for (let i = 0; i < entities.length; i += 16) {
    const chunk = entities.slice(i, i + 16);
    const { messages, byLabel } = gradingPrompt(positionMap, origin, chunk, writtenAt);
    let text = null;
    try {
      const res = await fetch(`${LITELLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${LITELLM_API_KEY}` },
        body: JSON.stringify({ model: GRADER_MODEL, messages, temperature: 0 }),
        signal: AbortSignal.timeout(Number(GRADER_TIMEOUT_MS)),
      });
      if (!res.ok) throw new Error(`grader HTTP ${res.status}`);
      text = (await res.json()).choices?.[0]?.message?.content ?? null;
    } catch (e) {
      log.warn(`grading failed (entities held one level up): ${String(e).slice(0, 160)}`);
    }
    out.push(...(text === null ? chunk.map(() => null) : parseVerdicts(text, byLabel, positionMap, origin, chunk.map((e) => e.name), writtenAt)));
  }
  return out;
}

/**
 * Where each entity of a scoped write lands. `origin` is the writer's
 * resolved position (provenance); an existing entity is (name, origin).
 * Without a grader: new entities at the origin, existing ones where they are.
 */
async function placeEntities(entities, origin, floor, writtenAt = Date.now()) {
  const existing = await Promise.all(
    entities.map((e) =>
      adbQuery(`SELECT _home FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin LIMIT 1`, { name: e.name, origin }).then(
        (rows) => (rows[0] ? effectiveHome(positionMap, rows[0]._home) : undefined),
      ),
    ),
  );
  const grading = Boolean(GRADER_MODEL) && policy.gradingEnabled;
  if (!grading) return entities.map((_, i) => applyFloor({ home: existing[i] ?? origin, note: "not graded (grading off)" }, origin, floor));
  const verdicts = await gradeBatch(origin, entities, writtenAt);
  // the end date the grader judged; an unsure verdict means lasting, a failed one leaves it be
  const until = (v) => (v ? (v.confidence >= policy.gradingConfidence ? v.until : null) : undefined);
  if (origin === positionMap.root) {
    // nothing above the root to restrict to: graded for its end date only
    return entities.map((_, i) => ({ ...applyFloor({ home: existing[i] ?? origin, note: "at the root" }, origin, floor), until: until(verdicts[i]) }));
  }
  return entities.map((_, i) => ({ ...applyFloor(decide(positionMap, origin, verdicts[i], existing[i], policy.gradingConfidence), origin, floor), until: until(verdicts[i]) }));
}

/** `home` is already resolved by the caller (resolveWriteHome); undefined = unscoped */
async function upsertEntities({ entities, home, floor, written_at }) {
  if (!Array.isArray(entities) || entities.length === 0) throw new Error("entities[] required");
  if (entities.length > 64) throw new Error("max 64 entities per call");
  // dates in the content ("next Friday") mean the day it was written, not approved
  const writtenAt = Number.isFinite(Date.parse(written_at)) ? Date.parse(written_at) : Date.now();
  // scoped: `home` is the origin; grading decides where each entity is seen from
  const placements = home === undefined || !positionMap ? null : await placeEntities(entities, home, floor ?? home, writtenAt);

  let merged = 0;
  const validities = []; // per entity: the end date this write set (ISO / null), if any
  const jobs = []; // {name, facet, text}
  for (const [idx, e] of entities.entries()) {
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
    // an entity is (name, origin): a write never touches a same-named entity
    // written from another position; where it is seen from is _home
    const key = home === undefined ? `{name: '${esc(e.name)}'}` : `{name: '${esc(e.name)}', \`_origin\`: '${esc(home)}'}`;
    const place = placements?.[idx];
    const placeSql = place ? `, n.\`_home\` = '${esc(place.home)}', n.\`_grade\` = '${esc(place.note)}'` : "";
    // its end date: the writer's word, else the grader's, else unchanged
    const stored = (
      await adbQuery(`SELECT _valid_until, _valid_by FROM ${ENTITY_LABEL} WHERE name = :name${home === undefined ? "" : " AND _origin = :origin"} LIMIT 1`, { name: e.name, origin: home })
    )[0];
    const validity = chooseValidity(
      parseValidUntil(e.valid_until, writtenAt),
      stored ? { valid_until: stored._valid_until ?? null, valid_by: stored._valid_by ?? null } : undefined,
      place?.until,
    );
    const validSql = validity
      ? `, n.\`_valid_until\` = ${validity.valid_until ? `'${esc(validity.valid_until)}'` : "null"}, n.\`_valid_by\` = '${validity.valid_by}'`
      : "";
    if (validity) validities[idx] = validity.valid_until;
    await adbCommand(
      `MERGE (n:${ENTITY_LABEL} ${key}) ` +
        `SET n.updated_at = datetime() ${propSql ? ", " + propSql : ""}${placeSql}${validSql} ${labelClause}`,
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
      const homeCond = home === undefined ? "" : ` AND _origin = '${esc(home)}'`;
      await adbCommand(
        `UPDATE (SELECT FROM ${ENTITY_LABEL} WHERE name = '${esc(name)}'${homeCond}) ` +
          `SET embed_${facet} = [${vecs[i].join(",")}], text_${facet} = '${esc(text)}'`,
      );
      embedded++;
    }
    // what was just written meets the open questions near it (after the write; never fails it)
    if (home !== undefined) {
      for (let i = 0; i < jobs.length; i++) {
        if (jobs[i].facet !== "identity") continue;
        const vec = vecs[i];
        void adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin LIMIT 1`, { name: jobs[i].name, origin: home })
          .then((rows) => rows[0] && meetAssertion(String(rows[0].rid), vec))
          .catch((e) => log.warn(`meeting questions for ${jobs[i].name}: ${String(e).slice(0, 120)}`));
      }
    }
  }

  // grading's proposals go to a person: release lower, or review an unsure call
  const placed = [];
  if (placements) {
    for (const [i, e] of entities.entries()) {
      const p = placements[i];
      placed.push({ name: e.name, home: positionMap.positions[p.home]?.name, note: p.note, ...(validities[i] !== undefined ? { valid_until: validities[i] } : {}) });
      const ask = p.release ?? p.review;
      if (!ask) continue;
      const rows = await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin LIMIT 1`, { name: e.name, origin: home });
      if (!rows[0]) continue;
      await queueWrite({
        kind: "rehome",
        payload: JSON.stringify({ rid: String(rows[0].rid), name: e.name, from: p.home, to: ask.to, reason: ask.reason }),
        user: "graph-rag grader",
        home: p.home,
      }).catch((err) => log.warn(`grading proposal for ${e.name} not queued: ${String(err).slice(0, 120)}`));
    }
  }
  return { merged, embedded, facets_indexed: [...knownIndexes], ...(placements ? { placed } : {}) };
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
  if (DELETE_RE.test(command)) await refreshGrants(); // revoke grants on what it deleted
  return { result };
}

/** a raw command that may delete entities (their grants are swept after it) */
const DELETE_RE = /\b(DELETE|TRUNCATE)\b/i;

/** execute a queued write (admin approval path) */
async function executePending(rec) {
  // upsert payloads carry the home resolved when the write was requested
  if (rec.kind === "upsert") return upsertEntities(JSON.parse(rec.payload));
  if (rec.kind === "rehome") return applyRehome(JSON.parse(rec.payload));
  if (rec.kind === "grant") return storeGrant(JSON.parse(rec.payload));
  if (rec.kind === "backfill") return backfillIdentity(Number(JSON.parse(rec.payload).limit) || 64);
  const result = await adbCommand(rec.payload, rec.language ?? "sql");
  if (DELETE_RE.test(rec.payload)) await refreshGrants();
  return result;
}

/** move entities to another home: restricting applies, widening needs a person */
async function setHome({ entities, to }, identity, scope) {
  if (!SCOPED || !positionMap) throw new Error("position scoping is not enabled");
  const target = positionId(to);
  const results = [];
  for (const ref of entities) {
    const from = ref.home === undefined ? undefined : positionId(ref.home);
    const rows = await adbQuery(
      `SELECT @rid AS rid, name, _home FROM ${ENTITY_LABEL} WHERE name = :name${homeFilter(scope, { own: true })}${ASSERTIONS}`,
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
  for (const prop of ["id", "kind", "target", "target_name", "target_origin", "target_home", "to_pos", "to_user", "reason", "granted_by", "created_at", "expires_at", "status", "revoked_at", "revoked_by"]) {
    await adbCommand(`CREATE PROPERTY AccessGrant.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
}

async function refreshGrants() {
  if (!SCOPED) return;
  try {
    const rows = await adbQuery("SELECT FROM AccessGrant WHERE status = 'active' LIMIT 5000");
    const active = rows.map((r) => ({ ...r, to: r.to_pos })).filter((g) => isActive(g));
    // a failed sweep keeps them: the read predicate still checks each entity
    const gone = new Set(
      (await danglingEntityGrants(active).catch((e) => (log.warn(`grant sweep failed: ${String(e).slice(0, 160)}`), []))).map((g) => g.id),
    );
    grantCache = active.filter((g) => !gone.has(g.id));
  } catch (e) {
    log.warn(`grant refresh failed (keeping ${grantCache.length}): ${String(e).slice(0, 160)}`);
  }
}

/**
 * Entity grants whose entry was deleted (or whose record id now holds another
 * entity: ArcadeDB reuses ids) are revoked, whatever deleted it.
 */
async function danglingEntityGrants(grants) {
  const rids = [...new Set(grants.filter((g) => g.kind === "entity" && RID_RE.test(String(g.target))).map((g) => g.target))];
  if (rids.length === 0) return [];
  const found = [];
  for (let i = 0; i < rids.length; i += 500) {
    const chunk = rids.slice(i, i + 500);
    found.push(...(await adbQuery(`SELECT @rid AS rid, name, _origin FROM ${ENTITY_LABEL} WHERE @rid IN [${chunk.join(",")}]`)));
  }
  const gone = danglingGrants(grants, found);
  for (const g of gone) {
    await adbCommand("UPDATE AccessGrant SET status = 'revoked', revoked_at = :now, revoked_by = :actor WHERE id = :id", "sql", {
      now: new Date().toISOString(),
      actor: "graph-rag: entry deleted",
      id: g.id,
    });
    log.info(`grant ${g.id} revoked: ${g.target_name} (${g.target}) was deleted`);
  }
  return gone;
}

const positionName = (id) => positionMap?.positions[id]?.name ?? id;

/** the people a share can go to: everyone in the token map (tenants) */
const peopleNames = () => [...entriesByUser.keys()].sort();

/** what a person sees by their own positions (null: unknown person) */
function personScope(name) {
  const entry = entriesByUser.get(name);
  return entry ? scopeOf({ user: entry.user, positions: entry.positions ?? [], caps: {} }) : null;
}

/**
 * Who a share goes to: a position (`to`, by id or name) or one person
 * (`person`, by user name). A `to` that names no position but a person
 * counts as that person (agents often say "to": "bob").
 */
function recipientOf({ to, person }, identity) {
  if (to && person) throw new Error("share with a position (to) or a person (person), not both");
  if (!to && !person) throw new Error("say who to share with: a position (to) or a person (person)");
  let name = person ? String(person).trim() : null;
  if (!name) {
    try {
      return { to_pos: positionId(to), to_user: null };
    } catch (err) {
      if (!entriesByUser.has(String(to).trim())) throw err;
      name = String(to).trim();
    }
  }
  if (!entriesByUser.has(name)) throw new Error(`unknown person: ${name}`);
  if (name === personOf(identity.user)) throw new Error("that's you: you already see what you own");
  return { to_pos: null, to_user: name };
}

const recipientName = (g) => g.to_user ?? positionName(g.to_pos);
const recipientKind = (g) => (g.to_user ? "person" : "position");

/** everyone else, with where they sit (for matching "let bob know") */
function peopleView(self) {
  return peopleNames()
    .filter((n) => n !== self)
    .map((name) => ({
      name,
      positions: heldPositions(positionMap, entriesByUser.get(name)?.positions).map((id) => (id === positionMap.root ? "Whole organization" : positionName(id))),
    }));
}

/** does the recipient already see data homed at `home` by its own positions */
function recipientSees(r, home) {
  // homes null = sees everything (the root)
  const homes = r.to_user ? personScope(r.to_user)?.homes : visibleHomes(positionMap, [r.to_pos]);
  if (homes === undefined) return false; // unknown person: sees nothing
  return homes === null || homes.has(home);
}

/** propose or make a grant; owners only, agents and queued writers propose */
async function grantAccess({ entities, subtree: subtreeRef, to, person, reason, until }, identity, scope) {
  if (!SCOPED || !positionMap) throw new Error("position scoping is not enabled");
  if (!!entities === !!subtreeRef) throw new Error("grant either entities or a subtree, not both");
  const recipient = recipientOf({ to, person }, identity);
  const who = recipientName(recipient);
  const expires_at = resolveExpiry(until, expiryRules(identity, scope));
  const base = { ...recipient, reason: String(reason).slice(0, 500), granted_by: identity.user, expires_at };
  const targets = [];
  if (subtreeRef) {
    const p = positionId(subtreeRef);
    if (!ownsHome(scope, p)) throw new Error(`you can only grant what you own: ${subtreeRef} is outside your positions`);
    if (recipientSees(recipient, p)) throw new Error(`${who} already sees ${positionName(p)}`);
    targets.push({ kind: "subtree", target: p, target_name: positionName(p), target_home: p });
  } else {
    for (const ref of entities) {
      const from = ref.home === undefined ? undefined : positionId(ref.home);
      const rows = await adbQuery(
        `SELECT @rid AS rid, name, _home, _origin FROM ${ENTITY_LABEL} WHERE name = :name${homeFilter(scope, { own: true })}`,
        { name: ref.name },
      );
      const hits = rows.filter((r) => from === undefined || effectiveHome(positionMap, r._home) === from);
      if (hits.length === 0) {
        // not written yet? a share may wait on the person's own pending write
        const pend = await pendingEntityWrite(identity, ref.name);
        if (pend) {
          if (recipientSees(recipient, pend.origin)) throw new Error(`${who} already sees ${ref.name}`);
          targets.push({ kind: "entity", target: null, target_name: ref.name, target_origin: pend.origin, target_home: pend.origin, origin: pend.origin, after: pend.id });
          continue;
        }
        throw new Error(`no entity ${ref.name} you own${from ? ` at ${ref.home}` : ""} (granted entities can't be granted onward)`);
      }
      if (hits.length > 1) throw new Error(`${ref.name} exists at several homes you own; pass its home`);
      const home = effectiveHome(positionMap, hits[0]._home);
      if (recipientSees(recipient, home)) throw new Error(`${who} already sees ${ref.name}`);
      targets.push({ kind: "entity", target: String(hits[0].rid), target_name: ref.name, target_origin: hits[0]._origin ?? null, target_home: home });
    }
  }
  const results = [];
  for (const t of targets) {
    const grant = { id: randomUUID(), ...base, ...t };
    if (t.after) {
      // waits on the entity's pending write: a person's own share is confirmed
      // already (applies on approval); an agent's waits for the person too
      const q = await queueWrite({
        kind: "grant",
        payload: JSON.stringify(grant),
        user: identity.user,
        home: t.target_home,
        status: identity.agent || !(policy.peopleShareDirectly || scope.root) ? "waiting" : "confirmed",
      });
      results.push({ proposed: true, waits_for_write: t.after, target: t.target_name, to: who, to_kind: recipientKind(recipient), ...q });
      continue;
    }
    // people share what they own directly (it's theirs to share; time-limited
    // and recorded) unless the organization routes shares through review;
    // agents only propose, and a person confirms
    if (!identity.agent && (policy.peopleShareDirectly || scope.root)) {
      await storeGrant(grant);
      results.push({ granted: true, id: grant.id, target: t.target_name, to: who, to_kind: recipientKind(recipient), expires_at });
    } else {
      const q = await queueWrite({ kind: "grant", payload: JSON.stringify(grant), user: identity.user, home: t.target_home });
      results.push({ proposed: true, target: t.target_name, to: who, to_kind: recipientKind(recipient), ...q });
    }
  }
  return { results };
}

async function storeGrant(g) {
  if (g.expires_at && Date.parse(g.expires_at) <= Date.now()) throw new Error("this grant has already expired");
  await adbCommand(
    "INSERT INTO AccessGrant SET id = :id, kind = :kind, target = :target, target_name = :target_name, target_origin = :target_origin, target_home = :target_home, " +
      "to_pos = :to_pos, to_user = :to_user, reason = :reason, granted_by = :granted_by, created_at = :created_at, expires_at = :expires_at, status = 'active'",
    "sql",
    { ...g, target_origin: g.target_origin ?? null, to_pos: g.to_pos ?? null, to_user: g.to_user ?? null, created_at: new Date().toISOString(), expires_at: g.expires_at ?? null },
  );
  log.info(`grant ${g.id}: ${g.kind} ${g.target_name} -> ${g.to_user ? `person ${g.to_user}` : positionName(g.to_pos)} by ${g.granted_by} until ${g.expires_at ?? "revoked"}`);
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
    // a question shown to its owners isn't a share anyone made: listing it
    // would tell the asker who was asked (owners see it under Asked of you)
    if (g.granted_by === QUESTION_GRANTOR) continue;
    const outgoing = ownsHome(scope, g.target_home);
    const incoming = g.to_user ? g.to_user === scope.person : vis === null || vis.has(g.to_pos);
    if (!outgoing && !incoming) continue;
    out.push({
      id: g.id,
      kind: g.kind,
      target: g.target_name,
      target_home: positionName(g.target_home),
      to: recipientName(g),
      to_kind: recipientKind(g),
      reason: g.reason,
      granted_by: g.granted_by,
      expires_at: g.expires_at ?? null,
      direction: outgoing ? "outgoing" : "incoming",
    });
  }
  return { grants: out };
}

/** the person behind an identity ("alice" for alice and her agents) */
const personOf = (user) => String(user ?? "").split("/agent:")[0];

/** a pending upsert by the same person (or their agents) that would create `name` */
async function pendingEntityWrite(identity, name) {
  const person = personOf(identity.user);
  const rows = await adbQuery("SELECT id, payload, requested_by FROM PendingWrite WHERE kind = 'upsert' AND status = 'pending' ORDER BY created_at DESC LIMIT 200");
  for (const r of rows) {
    if (personOf(r.requested_by) !== person) continue;
    try {
      const p = JSON.parse(r.payload);
      if (p.home && (p.entities ?? []).some((e) => e?.name === name)) return { id: r.id, origin: p.home };
    } catch {
      /* not an upsert payload */
    }
  }
  return null;
}

/**
 * A write was approved: shares waiting on it now point at the real entity.
 * Grading may have homed it above the person; then it isn't theirs to share.
 */
async function resolveWaitingShares(writeId) {
  const rows = await adbQuery(
    "SELECT FROM PendingWrite WHERE kind = 'grant' AND status IN ['waiting', 'confirmed'] AND payload LIKE :pat",
    { pat: `%"after":"${writeId}"%` },
  );
  for (const rec of rows) {
    const g = JSON.parse(rec.payload);
    const ent = (await adbQuery(`SELECT @rid AS rid, _home FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin LIMIT 1`, { name: g.target_name, origin: g.origin }))[0];
    const entry = entriesByUser.get(personOf(rec.requested_by));
    const owner = entry ? scopeOf({ user: entry.user, positions: entry.positions ?? [], caps: {} }) : null;
    if (!ent || !owner || !ownsHome(owner, ent._home)) {
      const why = !ent ? "the entry wasn't written" : "the entry was filed above the person, so it isn't theirs to share";
      await adbCommand("UPDATE PendingWrite SET status = 'failed', executed_at = :now, note = :why WHERE id = :id", "sql", { now: new Date().toISOString(), why, id: rec.id });
      log.info(`share ${rec.id} not made: ${why}`);
      continue;
    }
    const resolved = { ...g, target: String(ent.rid), target_origin: g.origin, target_home: effectiveHome(positionMap, ent._home), after: undefined };
    if (rec.status === "confirmed" && !(policy.peopleShareDirectly || owner.root)) {
      // shares go through review: an ordinary request in Approvals now
      await adbCommand("UPDATE PendingWrite SET status = 'pending', payload = :payload, note = :note WHERE id = :id", "sql", {
        payload: JSON.stringify(resolved),
        note: "said yes; waiting for review",
        id: rec.id,
      });
      continue;
    }
    if (rec.status === "confirmed") {
      try {
        await storeGrant({ ...resolved, granted_by: rec.approved_by || personOf(rec.requested_by) });
        await adbCommand("UPDATE PendingWrite SET status = 'approved', payload = :payload, executed_at = :now WHERE id = :id", "sql", {
          payload: JSON.stringify(resolved),
          now: new Date().toISOString(),
          id: rec.id,
        });
      } catch (e) {
        await adbCommand("UPDATE PendingWrite SET status = 'failed' WHERE id = :id", "sql", { id: rec.id }).catch(() => {});
        log.warn(`share ${rec.id} failed: ${String(e).slice(0, 120)}`);
      }
    } else {
      // the person hasn't decided yet: an ordinary proposal now
      await adbCommand("UPDATE PendingWrite SET status = 'pending', payload = :payload WHERE id = :id", "sql", { payload: JSON.stringify(resolved), id: rec.id });
    }
  }
}

/** a write was rejected: shares waiting on it go with it */
async function dropWaitingShares(writeId) {
  await adbCommand(
    "UPDATE PendingWrite SET status = 'rejected', executed_at = :now WHERE kind = 'grant' AND status IN ['waiting', 'confirmed'] AND payload LIKE :pat",
    "sql",
    { now: new Date().toISOString(), pat: `%"after":"${writeId}"%` },
  );
}

/** a share proposed by one of this person's own agents, on data the person owns */
function ownProposal(identity, scope, rec) {
  if (identity.agent || rec?.kind !== "grant") return null;
  if (!String(rec.requested_by ?? "").startsWith(`${identity.user}/agent:`)) return null;
  let g;
  try {
    g = JSON.parse(rec.payload);
  } catch {
    return null;
  }
  return ownsHome(scope, g.target_home) ? g : null;
}

function proposalView(rec, g) {
  return {
    id: rec.id,
    status: rec.status,
    // waiting/confirmed: the entry's write isn't approved yet
    ...(g.after ? { waits_for_write: true } : {}),
    ...(rec.note ? { note: rec.note } : {}),
    max_days: policy.maxGrantDays,
    target: g.kind === "subtree" ? `everything under ${positionName(g.target)}` : g.target_name,
    to: recipientName(g),
    to_kind: recipientKind(g),
    reason: g.reason,
    expires_at: g.expires_at ?? null,
  };
}

async function proposalStatus(id, identity, scope) {
  if (!PENDING_ID_RE.test(id)) throw new Error("invalid id");
  const rec = (await adbQuery("SELECT FROM PendingWrite WHERE id = :id", { id }))[0];
  const g = rec && ownProposal(identity, scope, rec);
  if (!g) throw new Error(`no share proposal ${id} of yours`);
  return proposalView(rec, g);
}

/** the person confirms (optionally with another end date or recipient) */
async function confirmProposal(id, { until, to, person } = {}, identity, scope) {
  if (!PENDING_ID_RE.test(id)) throw new Error("invalid id");
  const rec = (await adbQuery("SELECT FROM PendingWrite WHERE id = :id AND status IN ['pending', 'waiting']", { id }))[0];
  const g = rec && ownProposal(identity, scope, rec);
  if (!g) throw new Error(`no pending share proposal ${id} of yours`);
  const grant = { ...g, granted_by: identity.user };
  if (until !== undefined) grant.expires_at = resolveExpiry(until, expiryRules(identity, scope));
  if (to !== undefined || person !== undefined) {
    Object.assign(grant, recipientOf({ to, person }, identity));
    if (recipientSees(grant, grant.target_home)) throw new Error(`${recipientName(grant)} already sees it`);
  }
  if (!policy.peopleShareDirectly && !scope.root) {
    // the organization routes people's shares through review: the person's yes
    // is recorded; an approver makes it (it stays in Approvals)
    await adbCommand("UPDATE PendingWrite SET payload = :payload, note = :note WHERE id = :id AND status IN ['pending', 'waiting']", "sql", {
      payload: JSON.stringify(grant),
      note: `${identity.user} said yes; waiting for review`,
      id,
    });
    return proposalView({ ...rec, note: `${identity.user} said yes; waiting for review` }, grant);
  }
  if (rec.status === "waiting") {
    // the entry isn't written yet: remember the yes; it applies on approval
    const done = await adbCommand(
      "UPDATE PendingWrite SET status = 'confirmed', approved_by = :actor, payload = :payload WHERE id = :id AND status = 'waiting'",
      "sql",
      { actor: identity.user, payload: JSON.stringify(grant), id },
    );
    if (Number(done?.[0]?.count ?? 0) !== 1) throw new Error("this share was already handled");
    return proposalView({ ...rec, status: "confirmed" }, grant);
  }
  const claimed = await adbCommand(
    "UPDATE PendingWrite SET status = 'executing', approved_by = :actor WHERE id = :id AND status = 'pending'",
    "sql",
    { actor: identity.user, id },
  );
  if (Number(claimed?.[0]?.count ?? 0) !== 1) throw new Error("this share was already handled");
  try {
    await storeGrant(grant);
  } catch (err) {
    await adbCommand("UPDATE PendingWrite SET status = 'failed' WHERE id = :id", "sql", { id }).catch(() => {});
    throw err;
  }
  await adbCommand("UPDATE PendingWrite SET status = 'approved', executed_at = :now WHERE id = :id", "sql", { now: new Date().toISOString(), id });
  return proposalView({ ...rec, status: "approved" }, grant);
}

async function declineProposal(id, identity, scope) {
  if (!PENDING_ID_RE.test(id)) throw new Error("invalid id");
  const rec = (await adbQuery("SELECT FROM PendingWrite WHERE id = :id AND status IN ['pending', 'waiting', 'confirmed']", { id }))[0];
  const g = rec && ownProposal(identity, scope, rec);
  if (!g) throw new Error(`no pending share proposal ${id} of yours`);
  await adbCommand("UPDATE PendingWrite SET status = 'rejected', executed_at = :now, approved_by = :actor WHERE id = :id AND status IN ['pending', 'waiting', 'confirmed']", "sql", {
    now: new Date().toISOString(),
    actor: identity.user,
    id,
  });
  return proposalView({ ...rec, status: "rejected" }, g);
}

/** semantic search over what the caller owns (what it may share) */
async function findShareable({ query, k = 8 }, identity, scope) {
  const own = { ...scope, granted: undefined };
  const read = [];
  const res = await searchGraph({ query, k, assertions_only: true }, own, read);
  recordReads(identity, read);
  return {
    results: res.results.map((r) => ({
      name: r.name,
      home: r.home?.name,
      snippet: String(r.properties?.text_identity ?? "").slice(0, 240),
      score: r.score,
    })),
    related: res.relationships,
    // where things can be shared to (match the person's wording to these)
    positions: Object.values(positionMap?.positions ?? {}).filter((p) => p.parent !== null).map((p) => p.name),
    people: positionMap ? peopleView(personOf(identity.user)) : [],
  };
}

async function schemaGraph() {
  const types = await adbQuery("SELECT FROM schema:types").catch(() => []);
  if (types.length > 0) return { types };
  const indexes = await adbQuery("SELECT FROM schema:indexes").catch(() => []);
  return { types: [], indexes };
}

/** ---- needs: questions as entries (see needs.js) ---- */

const QUESTION_GRANTOR = "graph-rag: question";
const REQUEST_MATCH_MIN = Number.isFinite(Number(process.env.REQUEST_MATCH_MIN)) && process.env.REQUEST_MATCH_MIN ? Number(process.env.REQUEST_MATCH_MIN) : MATCH_MIN;
/** reads of assertions only (questions aren't knowledge to search, share or match) */
const ASSERTIONS = " AND _kind IS NULL";
/** in search: assertions, and questions only while open */
const openNeedsClause = (now = Date.now()) => ` AND (_kind IS NULL OR (_status = 'open' AND _open_until > '${new Date(now).toISOString()}'))`;

async function ensureNeedSchema() {
  for (const prop of ["_kind", "_qid", "_asker", "_asked_by", "_status", "_open_until", "_joined_into", "_questions", "_dismissed"]) {
    await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._asked IF NOT EXISTS INTEGER`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (_qid) NOTUNIQUE`).catch(() => {});
  await adbCommand("CREATE EDGE TYPE NEAR IF NOT EXISTS").catch(() => {});
  for (const [prop, type] of [["score", "DOUBLE"], ["state", "STRING"], ["at", "STRING"]]) await adbCommand(`CREATE PROPERTY NEAR.${prop} IF NOT EXISTS ${type}`).catch(() => {});
}

const needOf = (r) => ({
  rid: String(r["@rid"] ?? r.rid),
  qid: r._qid,
  name: r.name,
  question: r.text_identity ?? "",
  asker: r._asker,
  asked_by: r._asked_by,
  status: r._status,
  home: r._home,
  origin: r._origin,
  open_until: r._open_until ?? null,
  valid_until: r._valid_until ?? null,
  joined_into: r._joined_into ?? null,
  asked: Number(r._asked ?? 1),
  questions: JSON.parse(r._questions || "[]"),
  dismissed: JSON.parse(r._dismissed || "[]"),
});

async function loadNeed(qid) {
  if (!PENDING_ID_RE.test(String(qid))) throw new Error("invalid request id");
  const row = (await adbQuery(`SELECT FROM ${ENTITY_LABEL} WHERE _kind = 'need' AND _qid = :qid LIMIT 1`, { qid }))[0];
  return row ? needOf(row) : null;
}

/** a need's meetings: [{ erid, rid, name, home, state, score }] */
async function needEdges(rid) {
  const edges = await adbQuery(`SELECT @rid AS erid, @in AS dst, state, score FROM (SELECT expand(outE('NEAR')) FROM ${rid})`).catch(() => []);
  const dsts = [...new Set(edges.map((e) => String(e.dst)).filter((r) => RID_RE.test(r)))];
  const rows = dsts.length ? await adbQuery(`SELECT @rid AS rid, name, _home FROM [${dsts.join(",")}]`) : [];
  const at = new Map(rows.map((r) => [String(r.rid), r]));
  return edges
    .filter((e) => at.has(String(e.dst)))
    .map((e) => ({ erid: String(e.erid), rid: String(e.dst), name: at.get(String(e.dst)).name, home: effectiveHome(positionMap, at.get(String(e.dst))._home), state: e.state, score: Number(e.score) }));
}

/** who holds which positions (people only; for routing) */
const holdersMap = () => new Map([...entriesByUser].map(([name, e]) => [name, heldPositions(positionMap, e.positions)]));

/** does this person see the assertion (by position, or through a share) */
function personSees(person, row) {
  const s = personScope(person);
  if (!s) return false;
  return ownsHome(s, row._home) || s.granted?.homes.has(effectiveHome(positionMap, row._home)) || grantShows(s.granted, { rid: String(row.rid ?? row["@rid"]), name: row.name, origin: row._origin ?? null });
}

/** show a need to someone: a share of the question itself, for as long as it's open */
async function shareNeed(need, recipient) {
  const already = grantCache.some(
    (g) => g.kind === "entity" && g.target === need.rid && (recipient.to_user ? g.to_user === recipient.to_user : g.to_pos === recipient.to_pos),
  );
  if (already) return;
  await storeGrant({
    id: randomUUID(),
    kind: "entity",
    target: need.rid,
    target_name: need.name,
    target_origin: need.origin,
    target_home: need.home,
    to_pos: recipient.to_pos ?? null,
    to_user: recipient.to_user ?? null,
    reason: `Asked by ${need.asker}`,
    granted_by: QUESTION_GRANTOR,
    expires_at: need.open_until,
  });
}

/** is the question shown to this person: an active share of it to them or a position they reach */
function shownTo(need, person, scope) {
  const vis = scope.homes;
  return grantCache.some(
    (g) => isActive(g) && g.kind === "entity" && g.target === need.rid && (g.to_user ? g.to_user === person : vis === null || vis.has(g.to_pos)),
  );
}

/** record a meeting (once per pair) */
async function meet(need, assertionRid, score, state) {
  const edges = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('NEAR')) FROM ${need.rid})`).catch(() => []);
  if (edges.some((e) => String(e.dst) === assertionRid)) return false;
  await adbCommand(`CREATE EDGE NEAR FROM ${need.rid} TO ${assertionRid} SET score = :score, state = :state, at = :at`, "sql", {
    score: Math.round(score * 1000) / 1000,
    state,
    at: new Date().toISOString(),
  });
  return true;
}

/** the assertions closest to `vec` that `askerScope` can't see (never reaches the asker) */
async function matchHidden(vec, askerScope) {
  if (askerScope.homes === null) return []; // sees everything already
  const v = `[${vec.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
  const best = new Map();
  for (const facet of Object.keys(FACETS)) {
    if (!knownIndexes.has(facet)) continue;
    const rows = await adbQuery(
      `SELECT @rid AS rid, vectorCosineSimilarity(embed_${facet}, ${v}) AS score FROM ${ENTITY_LABEL} WHERE embed_${facet} IS NOT NULL${ASSERTIONS}${liveClause()} ORDER BY score DESC LIMIT 32`,
    ).catch(() => []);
    for (const row of rows) {
      const rid = String(row.rid);
      const score = Number(row.score);
      if (RID_RE.test(rid) && Number.isFinite(score) && score >= REQUEST_MATCH_MIN && score > (best.get(rid) ?? -2)) best.set(rid, score);
    }
  }
  if (best.size === 0) return [];
  const rows = await adbQuery(`SELECT @rid AS rid, name, _home, _origin FROM [${[...best.keys()].join(",")}]`);
  const granted = askerScope.granted ?? { homes: new Set(), entities: [] };
  return rows
    .map((r) => ({ rid: String(r.rid), name: r.name, origin: r._origin ?? null, home: effectiveHome(positionMap, r._home), score: best.get(String(r.rid)) ?? 0 }))
    .filter((m) => m.name && !askerScope.homes.has(m.home) && !granted.homes.has(m.home) && !grantShows(granted, m))
    .sort((a, b) => b.score - a.score)
    .slice(0, MATCH_MAX);
}

/** positions' description vectors (for posting unmatched needs); refreshed with the map */
let positionVecs = { map: null, list: [] };
async function describedPositions() {
  if (positionVecs.map === positionMap) return positionVecs.list;
  const described = Object.entries(positionMap.positions).filter(([id, p]) => id !== positionMap.root && p.description);
  const vecs = described.length ? await embedBatch(described.map(([, p]) => `${p.name}: ${p.description}`)) : [];
  positionVecs = { map: positionMap, list: described.map(([id], i) => ({ id, vec: vecs[i] })) };
  return positionVecs.list;
}

async function needVec(rid) {
  const row = (await adbQuery(`SELECT embed_identity FROM ${rid}`))[0];
  return Array.isArray(row?.embed_identity) ? row.embed_identity : null;
}

/**
 * A need opens: join the same person's open need if it's nearly the same
 * question; else meet the hidden assertions near it (their owners are shown
 * the question), or, if none, post it for the positions its words fit.
 */
async function openNeed(need, askerScope) {
  const vec = await needVec(need.rid);
  const now = Date.now();
  if (vec) {
    const v = `[${vec.join(",")}]`;
    const twin = (
      await adbQuery(
        `SELECT _qid, vectorCosineSimilarity(embed_identity, ${v}) AS score FROM ${ENTITY_LABEL} WHERE _kind = 'need' AND _asker = :asker AND _status = 'open' AND _open_until > :now AND _qid <> :qid ORDER BY score DESC LIMIT 1`,
        { asker: need.asker, now: new Date(now).toISOString(), qid: need.qid },
      ).catch(() => [])
    )[0];
    if (twin && Number(twin.score) >= JOIN_MIN) {
      const t = await loadNeed(twin._qid);
      const until = openUntil(now, policy.requestDays, t.valid_until);
      await adbCommand(`UPDATE ${t.rid} SET _asked = :asked, _questions = :q, _open_until = :until`, "sql", {
        asked: t.asked + 1,
        q: JSON.stringify([...t.questions, { text: need.question, at: new Date(now).toISOString() }].slice(-20)),
        until: until > t.open_until ? until : t.open_until,
      });
      await adbCommand(`UPDATE ${need.rid} SET _status = 'joined', _joined_into = :into`, "sql", { into: t.qid });
      log.info(`question ${need.qid} joined ${t.qid} (same asker, same question)`);
      return;
    }
  }
  // how long it matters: the grader judges the question's subject (Friday's visit ends Friday)
  let validUntil = null;
  let validBy = "grader";
  if (GRADER_MODEL && policy.gradingEnabled) {
    const [v] = await gradeBatch(need.origin, [{ name: need.name, facets: { identity: need.question } }], now);
    validUntil = v ? (v.confidence >= policy.gradingConfidence ? v.until : null) : undefined;
  }
  const open_until = openUntil(now, policy.requestDays, validUntil ?? null);
  // a failed or absent grading: kept only as long as it's open (then pruned)
  if (validUntil === undefined || !(GRADER_MODEL && policy.gradingEnabled)) {
    validUntil = open_until;
    validBy = "question";
  }
  await adbCommand(`UPDATE ${need.rid} SET _status = 'open', _open_until = :open_until, _valid_until = :valid_until, _valid_by = :valid_by`, "sql", {
    open_until,
    valid_until: validUntil,
    valid_by: validBy,
  });
  const opened = { ...need, status: "open", open_until };
  const matches = vec ? await matchHidden(vec, askerScope) : [];
  const holders = holdersMap();
  const owners = new Set();
  for (const m of matches) {
    await meet(opened, m.rid, m.score, "open");
    for (const person of ownersFor(positionMap, m.home, holders, need.asker)) owners.add(person);
  }
  for (const person of owners) await shareNeed(opened, { to_user: person });
  let posted = [];
  if (matches.length === 0 && vec) {
    // nobody's data matches: post it where its words fit, for someone who knows to add it
    const seesAlready = new Set([effectiveHome(positionMap, need.home), ...ancestors(positionMap, effectiveHome(positionMap, need.home))]);
    posted = pickPositions(vec, await describedPositions(), seesAlready);
    for (const p of posted) await shareNeed(opened, { to_pos: p.id });
  }
  log.info(
    `question ${need.qid} by ${need.asker}: ${matches.length} match(es)${owners.size ? ` shown to ${[...owners].join(", ")}` : ""}${posted.length ? `; posted for ${posted.map((p) => positionName(p.id)).join(", ")}` : ""}; open until ${open_until.slice(0, 10)}`,
  );
}

/**
 * A new or changed assertion meets the open needs near it: the asker is told
 * if they can see it; otherwise its owners are shown the question.
 */
async function meetAssertion(rid, vec) {
  if (!SCOPED || !positionMap || !Array.isArray(vec)) return;
  const row = (await adbQuery(`SELECT @rid AS rid, name, _home, _origin, _kind, _valid_until FROM ${rid}`))[0];
  if (!row || row._kind || isExpired(row._valid_until)) return;
  const now = new Date().toISOString();
  const near = await adbQuery(
    `SELECT @rid AS rid, vectorCosineSimilarity(embed_identity, [${vec.join(",")}]) AS score FROM ${ENTITY_LABEL} WHERE _kind = 'need' AND _status = 'open' AND _open_until > :now AND embed_identity IS NOT NULL ORDER BY score DESC LIMIT 16`,
    { now },
  ).catch(() => []);
  const holders = holdersMap();
  for (const n of near) {
    if (!(Number(n.score) >= REQUEST_MATCH_MIN)) continue;
    const need = needOf((await adbQuery(`SELECT FROM ${String(n.rid)}`))[0]);
    if (personSees(need.asker, row)) {
      if (await meet(need, rid, Number(n.score), "visible")) log.info(`question ${need.qid}: ${row.name} answers it, and ${need.asker} can see it`);
      continue;
    }
    if (!(await meet(need, rid, Number(n.score), "open"))) continue;
    const owners = ownersFor(positionMap, effectiveHome(positionMap, row._home), holders, need.asker);
    for (const person of owners) await shareNeed(need, { to_user: person });
    log.info(`question ${need.qid}: new entry ${row.name} may answer it; shown to ${owners.join(", ") || "nobody"}`);
  }
}

/** ask: an agent drafts it (the person confirms on a card); a person's ask goes out at once */
async function requestAccess({ question }, identity, scope) {
  if (!SCOPED || !positionMap) throw new Error("position scoping is not enabled");
  const text = String(question ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (text.length < 3) throw new Error("say what you'd like to know");
  const home = scope.writeHome ?? heldPositions(positionMap, entriesByUser.get(personOf(identity.user))?.positions)[0];
  if (!home) throw new Error("this identity holds no position, so it can't ask");
  const qid = randomUUID();
  const now = new Date().toISOString();
  const name = needName(qid, text);
  await adbCommand(
    `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, _kind = 'need', _qid = :qid, _asker = :asker, _asked_by = :asked_by, _status = 'proposed', ` +
      "_home = :home, _origin = :home, _asked = 1, _questions = :questions, _dismissed = '[]', text_identity = :text, updated_at = :now",
    "sql",
    { name, qid, asker: personOf(identity.user), asked_by: identity.user, home, questions: JSON.stringify([{ text, at: now }]), text, now },
  );
  const need = await loadNeed(qid);
  try {
    const [vec] = await embedBatch([text]);
    await adbCommand(`UPDATE ${need.rid} SET embed_identity = [${vec.join(",")}]`);
  } catch (e) {
    log.warn(`question ${qid}: embedding failed, it won't meet anything: ${String(e).slice(0, 120)}`);
  }
  if (identity.agent) return { proposed: true, requestId: qid, note: "waiting for the person to confirm the request in the chat" };
  await openNeed(need, scope);
  return askerRequest(qid, identity);
}

/** the asker's side: their own questions only (a joined one shows the one it joined) */
async function askerRequest(qid, identity) {
  const need = await loadNeed(qid);
  if (!need || need.asker !== personOf(identity.user)) throw new Error(`no request ${qid} of yours`);
  if (need.status === "joined" && need.joined_into) {
    const target = await loadNeed(need.joined_into);
    if (target) return { ...askerView(target, await needEdges(target.rid)), id: need.qid, joined_into: target.qid };
  }
  return askerView(need, await needEdges(need.rid));
}

async function confirmRequest(qid, identity, scope) {
  if (identity.agent) throw new Error("the person confirms a request, not an agent");
  const need = await loadNeed(qid);
  if (!need || need.asker !== identity.user) throw new Error(`no request ${qid} waiting for you`);
  // claim it: a second confirm finds nothing to do
  const claimed = await adbCommand(`UPDATE ${ENTITY_LABEL} SET _status = 'opening' WHERE _kind = 'need' AND _qid = :qid AND _status = 'proposed'`, "sql", { qid });
  if (Number(claimed?.[0]?.count ?? 0) !== 1) throw new Error("this request was already handled");
  await openNeed(need, scope);
  return askerRequest(qid, identity);
}

async function closeNeed(need, status) {
  await adbCommand(`UPDATE ${need.rid} SET _status = :status`, "sql", { status });
  // owners and positions stop seeing it
  await adbCommand("UPDATE AccessGrant SET status = 'revoked', revoked_at = :now, revoked_by = 'graph-rag: question closed' WHERE target = :rid AND status = 'active'", "sql", {
    now: new Date().toISOString(),
    rid: need.rid,
  });
  await refreshGrants();
}

async function withdrawRequest(qid, identity) {
  if (identity.agent) throw new Error("only the person can withdraw a request");
  const need = await loadNeed(qid);
  if (!need || need.asker !== identity.user) throw new Error(`no request ${qid} of yours`);
  if (!["proposed", "open"].includes(need.status)) throw new Error("this request is already closed");
  await closeNeed(need, "withdrawn");
  return askerRequest(qid, identity);
}

/** the owners' side: open questions shown to this person, with their own entries that meet them */
async function incomingRequests(identity) {
  const person = personOf(identity.user);
  const scope = personScope(person);
  if (!scope) return { requests: [] };
  const rows = await adbQuery(
    `SELECT FROM ${ENTITY_LABEL} WHERE _kind = 'need' AND _status = 'open' AND _open_until > :now AND _asker <> :me LIMIT 300`,
    { now: new Date().toISOString(), me: person },
  );
  const out = [];
  for (const row of rows) {
    const need = needOf(row);
    // shown to me through a share of the question (not merely below me in the tree)
    if (!shownTo(need, person, scope) || need.dismissed.includes(person)) continue;
    const mine = (await needEdges(need.rid)).filter((e) => e.state !== "visible" && ownsHome(scope, e.home));
    out.push({ ...ownerView(need, mine), entries: ownerView(need, mine).entries.map((e) => ({ ...e, home: positionName(e.home) })) });
  }
  return { requests: out.sort((a, b) => Number(b.status === "open") - Number(a.status === "open")) };
}

/** the owner shares (some of) their entries that meet the question with the asker */
async function answerRequest(qid, { entries, until }, identity, scope) {
  if (identity.agent) throw new Error("the person who owns the data answers a request");
  const person = personOf(identity.user);
  const need = await loadNeed(qid);
  if (!need || need.status !== "open" || (need.open_until && Date.parse(need.open_until) <= Date.now())) throw new Error("this request is closed");
  const mine = (await needEdges(need.rid)).filter((e) => e.state === "open" && ownsHome(scope, e.home));
  const keys = new Set(Array.isArray(entries) ? entries.map(String) : []);
  const chosen = mine.filter((e) => keys.has(e.rid));
  if (chosen.length === 0) throw new Error(mine.length ? "pick at least one of the matching entries" : `no request ${qid} for you to answer`);
  const results = [];
  for (const e of chosen) {
    let done = false;
    try {
      const r = (await grantAccess({ entities: [{ name: e.name, home: e.home }], person: need.asker, reason: `Asked: ${need.question}`.slice(0, 500), until }, identity, scope)).results[0];
      results.push({ name: e.name, ...(r.granted ? { granted: true, expires_at: r.expires_at } : { proposed: true }) });
      done = true;
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      done = /already sees/.test(msg); // the asker got it some other way meanwhile
      results.push({ name: e.name, error: msg.slice(0, 200) });
    }
    if (done) await adbCommand(`UPDATE ${e.erid} SET state = 'shared'`);
  }
  void person;
  const view = (await incomingRequests(identity)).requests.find((r) => r.id === qid) ?? null;
  return { request: view, results };
}

async function dismissRequest(qid, identity) {
  if (identity.agent) throw new Error("the person who owns the data answers a request");
  const person = personOf(identity.user);
  const scope = personScope(person);
  const need = await loadNeed(qid);
  if (!need || !scope || !shownTo(need, person, scope)) throw new Error(`no request ${qid} for you`);
  for (const e of await needEdges(need.rid)) if (e.state === "open" && ownsHome(scope, e.home)) await adbCommand(`UPDATE ${e.erid} SET state = 'declined'`);
  await adbCommand(`UPDATE ${need.rid} SET _dismissed = :d`, "sql", { d: JSON.stringify([...new Set([...need.dismissed, person])]) });
  return { dismissed: true, id: qid };
}

async function expireRequests() {
  await adbCommand(`UPDATE ${ENTITY_LABEL} SET _status = 'expired' WHERE _kind = 'need' AND _status IN ['proposed', 'open'] AND _open_until < :now`, "sql", {
    now: new Date().toISOString(),
  }).catch((e) => log.warn(`question expiry sweep: ${String(e).slice(0, 120)}`));
}

/** ---- pruning (see prune.js): expired entries leave for good after a window ---- */

const pruneSink = createSink(PRUNE_SINK);
let pruneRunning = false;

async function ensurePruneSchema() {
  await adbCommand("CREATE DOCUMENT TYPE PruneRecord IF NOT EXISTS").catch(() => {});
  for (const prop of ["name", "home", "kind", "valid_until", "pruned_at", "sink"]) {
    await adbCommand(`CREATE PROPERTY PruneRecord.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
}

/** one batch: hand expired entries to the sink, delete what it accepted, leave a line each */
async function pruneExpired(limit = 100) {
  const cutoff = pruneCutoff(policy.pruneAfterDays);
  if (!cutoff || !pruneSink || pruneRunning) return { pruned: 0 };
  pruneRunning = true;
  try {
    // only entries with a definite end date; lasting ones never come here
    const rows = await adbQuery(`SELECT FROM ${ENTITY_LABEL} WHERE _valid_until IS NOT NULL AND _valid_until < :cutoff LIMIT ${Math.max(1, Math.min(500, limit))}`, { cutoff });
    if (rows.length === 0) return { pruned: 0 };
    const records = [];
    for (const row of rows) {
      const rid = String(row["@rid"]);
      if (!RID_RE.test(rid)) continue;
      const raw = await adbQuery(`SELECT @type AS type, @out AS src, @in AS dst FROM (SELECT expand(bothE()) FROM ${rid}) LIMIT 200`).catch(() => []);
      const others = [...new Set(raw.map((e) => String(String(e.src) === rid ? e.dst : e.src)).filter((r) => RID_RE.test(r)))];
      const names = new Map(others.length ? (await adbQuery(`SELECT @rid AS rid, name FROM [${others.join(",")}]`).catch(() => [])).map((n) => [String(n.rid), n.name]) : []);
      const edges = raw.map((e) => {
        const out = String(e.src) === rid;
        const other = String(out ? e.dst : e.src);
        return { type: e.type, direction: out ? "out" : "in", other: names.get(other) ?? other };
      });
      const grants = await adbQuery("SELECT id, to_pos, to_user, expires_at FROM AccessGrant WHERE target = :rid AND status = 'active'", { rid }).catch(() => []);
      records.push(pruneRecord(row, edges, grants));
    }
    const accepted = new Set(await pruneSink.archive(records));
    let pruned = 0;
    const now = new Date().toISOString();
    for (const rec of records) {
      if (!accepted.has(rec.rid)) continue;
      // still expired? (an owner may have extended it since the batch was read)
      const gone = await adbCommand(`DELETE FROM ${ENTITY_LABEL} WHERE @rid = ${rec.rid} AND _valid_until < :cutoff`, "sql", { cutoff });
      if (Number(gone?.[0]?.count ?? 0) !== 1) continue;
      pruned++;
      await adbCommand("UPDATE AccessGrant SET status = 'revoked', revoked_at = :now, revoked_by = 'graph-rag: entry pruned' WHERE target = :rid AND status = 'active'", "sql", { now, rid: rec.rid }).catch(() => {});
      const line = ledgerLine(rec, pruneSink);
      await adbCommand(
        "INSERT INTO PruneRecord SET name = :name, home = :home, kind = :kind, valid_until = :valid_until, pruned_at = :pruned_at, sink = :sink, kept = :kept",
        "sql",
        line,
      ).catch((e) => log.warn(`prune record for ${rec.name}: ${String(e).slice(0, 120)}`));
    }
    if (pruned) {
      await refreshGrants();
      log.info(`pruned ${pruned} expired entr${pruned === 1 ? "y" : "ies"} (ended before ${cutoff.slice(0, 10)}; sink ${pruneSink.name}${pruneSink.keeps ? "" : ": nothing kept"})`);
    }
    return { pruned };
  } finally {
    pruneRunning = false;
  }
}

/** for Organization settings: what's waiting to be pruned, and when */
async function prunePreview() {
  const rows = await adbQuery(`SELECT _valid_until AS valid_until FROM ${ENTITY_LABEL} WHERE _valid_until IS NOT NULL AND _valid_until <= :now LIMIT 100000`, { now: new Date().toISOString() }).catch(() => []);
  return { ...preview(rows, policy.pruneAfterDays), sink: pruneSink ? { name: pruneSink.name, keeps: pruneSink.keeps } : { name: PRUNE_SINK, unknown: true } };
}

/** ---- pending-write queue (audited writes for low-capability identities) ---- */

async function ensurePendingSchema() {
  await adbCommand("CREATE DOCUMENT TYPE PendingWrite").catch(() => {});
  for (const prop of ["id", "kind", "payload", "language", "requested_by", "created_at", "status", "executed_at", "approved_by", "home", "note"]) {
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
      "requested_by = :user, created_at = :created, status = :status, home = :home",
    "sql",
    { id, kind: entry.kind, payload, lang: language, user: entry.user, created, home: entry.home ?? null, status: entry.status ?? "pending" },
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
  // shares that waited on this write can now point at its entities
  if (rec.kind === "upsert") await resolveWaitingShares(id).catch((e) => log.warn(`waiting shares for ${id}: ${String(e).slice(0, 160)}`));
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
  if (rows[0].kind === "upsert") await dropWaitingShares(id).catch((e) => log.warn(`waiting shares for ${id}: ${String(e).slice(0, 160)}`));
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
a datetime property. Entries past their end date (valid_until) are left out; include_expired
shows them too, marked expired (for history: "who was on shift last Friday?"). Falls back to
lexical matching if embeddings are unavailable.${homeNote}`,
    {
      query: z.string().min(1),
      include_expired: z.boolean().optional(),
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
      const read = [];
      const result = await searchGraph(args, scope, read);
      recordReads(identity, read);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
inside facet texts.
Things that stop mattering on a date (a visit, an event, this week's schedule, a temporary state)
get valid_until: an ISO date or e.g. "7d"; after it they drop out of searches and are later
removed. Leave it out for what lasts (where things are, how things are done, decisions); grading
fills it in when the content clearly ends, and "lasting" keeps an entry from ever expiring. To
change an existing entry's end date, upsert it again with valid_until.${SCOPED ? `
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
            valid_until: z.string().optional(),
          }),
        )
        .max(64),
    },
    async (args) => {
      need("write");
      const home = resolveWriteHome(scope, args.home);
      // end dates resolve now ("7d" from today), not when a queued write is approved
      const now = Date.now();
      const entities = args.entities.map((e) => {
        const v = parseValidUntil(e.valid_until, now);
        return v === undefined ? e : { ...e, valid_until: v.valid_until ?? "lasting" };
      });
      // fixed at request time: what the requester read, not the approver
      const write = { entities, home, floor: derivedFloor(identity, home), written_at: new Date(now).toISOString() };
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

  if (SCOPED) server.tool(
    "find_shareable",
    `Find knowledge-graph entries you own (and so may share) by describing them; also lists the
positions and the people things can be shared with.

When the person asks you to let a position or a person know about something ("let Sales know what
this email said", "share the line 2 plan with the floor", "show bob the Toro schedule"):
1. Work out what "this" is from the conversation. If it isn't in the knowledge graph yet (e.g. text
   pasted into the chat), save it first with upsert_entities, then use the name you saved.
2. Otherwise call find_shareable with a short description and pick the matching entries; mention
   related entries only if the person seems to want them too.
3. Match who they named: a team or role to one of the returned positions ("to"), one named person
   to one of the returned people ("person"). Only that person (and their agents) will see it.
4. Propose with grant_access: the entries, that position or person and a one-sentence reason in
   the person's words; leave "until" out unless they said how long (the organization's default
   applies).
5. Tell them the share is waiting for their confirmation in the chat (and, if the entry's save was
   queued, for that approval too). Nothing is shared until they confirm.`,
    { query: z.string().min(1), k: z.number().int().min(1).max(32).optional() },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await findShareable(args, identity, scope)) }] };
    },
  );

  if (SCOPED && caps.write !== "deny") server.tool(
    "grant_access",
    `Show data you own to another position, or to one person, for a while: either named entities or
a whole subtree (a position and everything below it). Name the recipient with "to" (a position:
its holders and those above it see the data) or "person" (one person and their agents only). Give a
reason; "until" ("14d" or an ISO date) is optional,
the organization's default length applies without it, and its maximum always does. People share what they own at once; agents propose and
the person confirms (a card in their chat). Data you only see through a grant can't be granted
onward. To find what to share, use find_shareable.`,
    {
      entities: z.array(z.object({ name: z.string().min(1), home: z.string().optional() })).min(1).max(32).optional(),
      subtree: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      person: z.string().min(1).optional(),
      reason: z.string().min(3).max(500),
      until: z.string().optional(),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await grantAccess(args, identity, scope)) }] };
    },
  );

  if (SCOPED) server.tool(
    "request_access",
    `Ask for information the person can't see. When the knowledge graph doesn't answer their
question (search_graph finds nothing that answers it), offer to ask; if they agree, call this
with their question in their own words. graph-rag checks the whole graph, including parts the
person can't see, and quietly asks the people who own anything that matches; an owner may then
share it with them. If nothing matches yet, the question is posted for the people most likely to
know, and anything saved later that answers it is offered to them. The person confirms the request
on a card in the chat first, since it carries their question and name to others.

You never learn whether anything matched, who was asked, or whether anyone said no: never say
that the information exists or that someone has it. Say the request is waiting for their
confirmation; once confirmed, if someone shares an answer it shows up in their searches (and on
the card), and you can search again.`,
    { question: z.string().min(3).max(500) },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await requestAccess(args, identity, scope)) }] };
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
  res.json({ scoped: true, root: positionMap.root, held, positions, tree, people: peopleView(personOf(identity.user)), canGrantStanding: reach === null && !identity.agent && policy.standingGrants === "root" });
});

/** ---- organization policy (Organization settings; see policy.js) ---- */

const policyDefaults = defaultPolicy();
let policy = policyDefaults;
let policyMeta = { updated_by: null, updated_at: null };

const expiryRules = (identity, scope) => ({
  root: scope.root,
  agent: Boolean(identity.agent),
  maxDays: policy.maxGrantDays,
  defaultDays: policy.defaultShareDays,
  standing: policy.standingGrants,
});

async function ensurePolicySchema() {
  await adbCommand("CREATE DOCUMENT TYPE OrgPolicy IF NOT EXISTS").catch(() => {});
  await adbCommand("CREATE DOCUMENT TYPE PolicyChange IF NOT EXISTS").catch(() => {});
  for (const prop of ["scope", "json", "updated_by", "updated_at"]) await adbCommand(`CREATE PROPERTY OrgPolicy.${prop} IF NOT EXISTS STRING`).catch(() => {});
  // (no "by"/"before"/"after": reserved words in ArcadeDB SQL)
  for (const prop of ["changed_at", "changed_by", "prev_json", "next_json"]) await adbCommand(`CREATE PROPERTY PolicyChange.${prop} IF NOT EXISTS STRING`).catch(() => {});
}

async function loadPolicy() {
  try {
    const row = (await adbQuery("SELECT FROM OrgPolicy WHERE scope = 'org' LIMIT 1"))[0];
    policy = row ? normalizeStored(JSON.parse(row.json), policyDefaults) : policyDefaults;
    policyMeta = { updated_by: row?.updated_by ?? null, updated_at: row?.updated_at ?? null };
  } catch (e) {
    log.warn(`policy load failed (keeping the current one): ${String(e).slice(0, 120)}`);
  }
}

/** a root person changes the policy; every change is recorded */
async function savePolicy(input, identity) {
  const next = applyPolicyUpdate(policy, input);
  const now = new Date().toISOString();
  const updated = await adbCommand("UPDATE OrgPolicy SET json = :json, updated_by = :by_user, updated_at = :now WHERE scope = 'org'", "sql", {
    json: JSON.stringify(next),
    by_user: identity.user,
    now,
  });
  if (Number(updated?.[0]?.count ?? 0) === 0) {
    await adbCommand("INSERT INTO OrgPolicy SET scope = 'org', json = :json, updated_by = :by_user, updated_at = :now", "sql", {
      json: JSON.stringify(next),
      by_user: identity.user,
      now,
    });
  }
  await adbCommand("INSERT INTO PolicyChange SET changed_at = :now, changed_by = :by_user, prev_json = :prev, next_json = :next", "sql", {
    now,
    by_user: identity.user,
    prev: JSON.stringify(policy),
    next: JSON.stringify(next),
  }).catch((e) => log.warn(`policy change not logged: ${String(e).slice(0, 120)}`));
  log.info(`organization policy changed by ${identity.user}: ${JSON.stringify(input)}`);
  policy = next;
  policyMeta = { updated_by: identity.user, updated_at: now };
  return policy;
}

const canEditPolicy = (identity, scope) => !identity.agent && !identity.open && scope.root && SCOPED;

app.get("/api/policy", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  const scope = scopeOf(identity);
  void Promise.all([
    adbQuery("SELECT changed_at, changed_by, prev_json, next_json FROM PolicyChange ORDER BY changed_at DESC LIMIT 10").catch(() => []),
    canEditPolicy(identity, scope) ? prunePreview() : null,
  ])
    .then(([history, pruning]) =>
      res.json({
        policy,
        defaults: policyDefaults,
        ...policyMeta,
        canEdit: canEditPolicy(identity, scope),
        history: canEditPolicy(identity, scope) ? history : [],
        ...(canEditPolicy(identity, scope) ? { pruning } : {}),
        // set at deploy, not here
        infra: {
          scoped: SCOPED,
          positions: positionMap ? Object.keys(positionMap.positions).length : 0,
          graderModel: GRADER_MODEL || null,
          embedModel: EMBED_MODEL,
        },
      }),
    );
});
/** the pruning record: what was removed, when (names only, never content; the root only) */
app.get("/api/pruned", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sees what was pruned" });
  void adbQuery("SELECT name, home, kind, valid_until, pruned_at, sink, kept FROM PruneRecord ORDER BY pruned_at DESC LIMIT 100")
    .catch(() => [])
    .then((rows) => res.json({ pruned: rows.map((r) => ({ ...r, home: r.home ? homeLabel(r.home)?.name ?? r.home : null })) }));
});
/** prune what's due now instead of at the next sweep (the root only) */
app.post("/api/pruned/run", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root prunes" });
  void pruneExpired(500).then(async (r) => res.json({ ...r, preview: await prunePreview() }), (e) => httpError(res, e));
});
app.put("/api/policy", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root can change these settings" });
  void savePolicy(req.body, identity).then(
    (p) => res.json({ policy: p, ...policyMeta }),
    (e) => res.status(400).json({ error: String(e instanceof Error ? e.message : e).slice(0, 300) }),
  );
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
  if (ctx) res.json({ ...listGrants(ctx.scope), canGrantStanding: ctx.scope.root && !ctx.identity.agent && policy.standingGrants === "root" });
});
app.post("/api/grants", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  if (ctx.identity.caps.write === "deny") return res.status(403).json({ error: "graph writes are denied for this identity" });
  const b = req.body ?? {};
  const args = {
    ...(Array.isArray(b.entities) ? { entities: b.entities.slice(0, 32).map((e) => ({ name: String(e?.name ?? ""), ...(e?.home ? { home: String(e.home) } : {}) })) } : {}),
    ...(typeof b.subtree === "string" ? { subtree: b.subtree } : {}),
    ...(typeof b.to === "string" && b.to ? { to: b.to } : {}),
    ...(typeof b.person === "string" && b.person ? { person: b.person } : {}),
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
/** shares proposed by this person's agents: status, confirm, decline (the chat card) */
app.get("/api/grants/proposals/:id", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void proposalStatus(req.params.id, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/grants/proposals/:id/confirm", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  const b = req.body ?? {};
  const changes = {
    ...(typeof b.until === "string" && b.until ? { until: b.until } : {}),
    ...(typeof b.to === "string" && b.to ? { to: b.to } : {}),
    ...(typeof b.person === "string" && b.person ? { person: b.person } : {}),
  };
  void confirmProposal(req.params.id, changes, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/grants/proposals/:id/decline", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void declineProposal(req.params.id, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});

/** access requests: the asker's card (their own) and the owners' side (routed to them) */
app.get("/api/requests", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void incomingRequests(ctx.identity).then((r) => res.json(r), (e) => httpError(res, e));
});
app.get("/api/requests/:id", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void askerRequest(req.params.id, ctx.identity).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/requests/:id/confirm", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void confirmRequest(req.params.id, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/requests/:id/withdraw", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void withdrawRequest(req.params.id, ctx.identity).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/requests/:id/answer", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  if (ctx.identity.caps.write === "deny") return res.status(403).json({ error: "graph writes are denied for this identity" });
  const b = req.body ?? {};
  const args = {
    entries: Array.isArray(b.entries) ? b.entries.slice(0, 32).map(String) : [],
    ...(typeof b.until === "string" && b.until ? { until: b.until } : {}),
  };
  void answerRequest(req.params.id, args, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/requests/:id/dismiss", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void dismissRequest(req.params.id, ctx.identity).then((r) => res.json(r), (e) => httpError(res, e));
});

/** entities the caller owns (by home), for picking what to grant */
app.get("/api/entities", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  // case-insensitive: people type "thinkcentre" for "ThinkCentre"
  const match = q ? ` AND (name ILIKE '%${likeTerm(q)}%' OR text_identity ILIKE '%${likeTerm(q)}%')` : "";
  void adbQuery(`SELECT name, _home FROM ${ENTITY_LABEL} WHERE name IS NOT NULL${match}${homeFilter(ctx.scope, { own: true })}${liveClause()}${ASSERTIONS} ORDER BY name LIMIT 25`).then(
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
  for (const prop of ["_origin", "_grade", "_valid_until", "_valid_by"]) await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (name, _origin) NOTUNIQUE`).catch(() => {});
  if (SCOPED && positionMap) {
    // entities from before origins: their origin is where they are (legacy, unhomed ones: the root)
    await adbCommand(`UPDATE ${ENTITY_LABEL} SET _origin = _home WHERE _origin IS NULL AND _home IS NOT NULL`).catch((e) => log.warn(`origin migration: ${e}`));
    await adbCommand(`UPDATE ${ENTITY_LABEL} SET _origin = :root WHERE _origin IS NULL`, "sql", { root: positionMap.root }).catch((e) => log.warn(`origin migration: ${e}`));
  }
  await ensurePolicySchema();
  await loadPolicy();
  setInterval(() => void loadPolicy(), 60_000);
  await ensurePruneSchema();
  if (!pruneSink) log.warn(`PRUNE_SINK=${PRUNE_SINK} isn't a known sink: pruning is off (nothing is deleted)`);
  // every 10 minutes, a batch at a time; the first a minute after boot
  const prune = () => void pruneExpired().catch((e) => log.warn(`pruning failed: ${String(e).slice(0, 160)}`));
  setTimeout(prune, 60_000);
  setInterval(prune, 600_000);
  if (SCOPED) log.info(`semantic grading: ${GRADER_MODEL && policy.gradingEnabled ? `on (${GRADER_MODEL}, confidence ${policy.gradingConfidence})` : "off"}`);
  if (SCOPED) await ensureReadMarkSchema();
  if (SCOPED) {
    await ensureGrantSchema();
    await refreshGrants();
    await ensureNeedSchema();
    await expireRequests();
    setInterval(() => void refreshGrants().then(expireRequests), 60_000);
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
