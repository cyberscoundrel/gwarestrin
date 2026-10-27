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
  EVERYONE,
  heldPositions,
  homeName,
  moveKind,
  ROOT_NAME,
  parsePositionMap,
  visibleHomes,
  writableHomes,
} from "./positions.js";
import { PREFIX as AGENT_TOKEN_PREFIX, resolveAgentToken } from "./delegation.js";
import { chooseValidity, isExpired, liveClause, parseValidUntil } from "./extent.js";
import { createSink, ledgerLine, preview as prunePreviewDays, pruneCutoff, pruneRecord } from "./prune.js";
import { createDocStore } from "./docstore.js";
import { duplicateEntries, entryId, mentionsPrompt, normalize, splitThingName, thingClash, normalizeKey, normalizeRel, parseMentions, parseSort, partialPerson, personCandidates, resolve, THING_TYPES, thingName } from "./things.js";
import { askDecisionModel, triageRequest, triageVerdict } from "./decisions.js";
import { firstJob, handlerBrief, signalsMessage, POOL_DEFAULTS, poolSettings, resumeBrief, surveyBrief, taskBrief, taskThreadBrief } from "./pool.js";
import { chunk, extractionPrompt, MAX_CHARS, MAX_SECTIONS, parseExtraction, preview, sectionName } from "./documents.js";
import { danglingGrants, entityPredicate, grantedView, grantShows, isActive, resolveExpiry } from "./grants.js";
import { askerView, groupLinked, groupView, JOIN_MIN, LINK_MIN, MATCH_MAX, MATCH_MIN, needName, openUntil, ownersFor, ownerView, pickPositions } from "./needs.js";
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
  // where whole documents live (outside ArcadeDB; see docstore.js)
  DOC_STORE = "fs:/app/documents",
  // the model that extracts facts from documents (when an ingest asks for it); default: the grader's
  EXTRACT_MODEL = "",
  // the graph worker (finds the things statements are about); its model and instructions
  // normally come from the admin's Graph worker profile; these are fallbacks and limits
  WORKER_MODEL = "",
  // a Jev-style decision model for triage (TypeSafe's Jev through OpenRouter, or a compatible one); no key = no triage
  DECISION_URL = "https://openrouter.ai/api/alpha/decisions",
  DECISION_API_KEY = "",
  DECISION_MODEL = "~typesafe/jev-latest",
  WORKER_TIMEOUT_MS = "120000",
  WORKER_DAILY_CALLS = "300",
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
  // a thing: seen from the homes of the statements about it
  if (homes.size) conds.push(`(_kind = 'thing' AND _homes CONTAINSANY [${[...homes].map((h) => `'${esc(h)}'`).join(",")}])`);
  if (entities) conds.push(entities);
  return conds.length ? ` AND (${conds.join(" OR ")})` : " AND 1 = 0";
}

/** does the caller see this home by its own positions (not through a grant) */
const ownsHome = (scope, home) => scope.homes === null || scope.homes.has(effectiveHome(positionMap, home));

/** where a write lands: the caller's choice if it may write there, else its default */
function resolveWriteHome(scope, requested, { everyoneOk = true } = {}) {
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
function positionId(ref) {
  if (String(ref).trim().toLowerCase() === EVERYONE) return EVERYONE;
  if (positionMap && (ref === ROOT_NAME || ref === "Top of the organization")) return positionMap.root;
  if (positionMap?.positions[ref]) return ref;
  const hit = Object.entries(positionMap?.positions ?? {}).find(([, p]) => p.name === ref);
  if (!hit) throw new Error(`unknown position: ${ref}`);
  return hit[0];
}

const homeLabel = (home) => {
  if (!SCOPED || !positionMap) return undefined;
  const id = effectiveHome(positionMap, home);
  return { id, name: homeName(positionMap, id) };
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
const questionOf = (row) =>
  row?._kind === "need"
    ? { kind: "question", asked_by: row._asker, open_until: row._open_until ?? null }
    : row?._kind === "section"
      ? { kind: "section", document: row._doc_title, document_id: row._doc_id, section: Number(row._section) + 1 }
      : row?._kind === "document"
        ? { kind: "document", document_id: row._doc_id, status: row._doc_status }
        : {};

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

async function searchGraph({ query, facets, k = 8, temporal_filter, include_expired = false, assertions_only = false }, scope = { homes: null }, readHomes = [], { demand = true, ownEntry = null } = {}) {
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
  const kinds = assertions_only ? ASSERTIONS : include_expired ? " AND (_kind IS NULL OR _kind IN ['document', 'section'] OR (_kind = 'need' AND _status <> 'proposed'))" : openNeedsClause();
  const visible = homeFilter(scope) + (include_expired ? "" : liveClause()) + kinds;
  // neighbours may also be things (what the results are ABOUT), visible like any node
  const neighbours = homeFilter(scope) + (include_expired ? "" : liveClause()) + kinds.replace("_kind IN ['document', 'section']", "_kind IN ['document', 'section', 'thing']");
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
          ...(row._mentions_at ? { _mentioned: true } : {}),
          ...(row._reviewed_at ? { _reviewed: true } : {}),
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
        ? await adbQuery(`SELECT @rid AS rid, name, _home, _kind FROM [${ends.join(",")}] WHERE name IS NOT NULL${neighbours}`)
        : [];
      const nameOf = new Map(nodes.map((n) => [String(n.rid), n.name]));
      // reading a question gives no knowledge: it doesn't bound where later writes land
      for (const n of nodes) if (!n._kind || n._kind === "section") neighbourHomes.push(n._home);
      relationships = edges
        .filter((e) => nameOf.has(String(e.src)) && nameOf.has(String(e.dst)))
        .map((e) => ({ from: nameOf.get(String(e.src)), rel: e.rel, to: nameOf.get(String(e.dst)) }));
    } catch (e) {
      log.warn(`traversal failed: ${String(e).slice(0, 160)}`); // best-effort
    }
  }

  // what people look for gets linked first (the one-call linking only: a
  // search never starts a thread, and a worker's own searches aren't demand,
  // or one thread would queue threads for everything it looked at)
  if (demand) {
    for (const r of results.slice(0, k)) {
      if (r.kind === "question" || !RID_RE.test(String(r.rid)) || r._mentioned) continue;
      void enqueue("mentions", { rid: String(r.rid), no_thread: true }, { key: `mentions:${r.rid}`, priority: 5 }).catch(() => {});
    }
  }

  // what the caller has now seen (derived-data tracking; not returned). A
  // thing isn't content (it's seen wherever its statements are, though it's
  // stored at the root), and a thread's own task entry is its brief: neither
  // bounds where its writes land, or every search would hold them at the root.
  const shown = results.slice(0, k).filter((r) => r.kind !== "question");
  const rids = shown.map((r) => String(r.rid)).filter((x) => RID_RE.test(x));
  const skip = new Set(
    rids.length ? (await adbQuery(`SELECT @rid AS rid FROM [${rids.join(",")}] WHERE _kind = 'thing'`).catch(() => [])).map((r) => String(r.rid)) : [],
  );
  if (ownEntry) skip.add(String(ownEntry));
  readHomes.push(...shown.filter((r) => !skip.has(String(r.rid))).map((r) => r.home?.id), ...neighbourHomes.map((h) => (SCOPED && positionMap ? effectiveHome(positionMap, h) : h)));
  return {
    query,
    // exactly k results (the schema allows 1..32, default 8)
    results: results.slice(0, k).map(({ rid: _rid, _mentioned, _reviewed, ...r }) => r),
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
 * Would the floor hold this worker's write above where the entry lives? Then
 * not silently: the worker is told what it read, and either leaves the entry
 * or proposes the write (an admin decides who sees it). Null when it wouldn't.
 */
function workerLift(identity, home) {
  if (!SCOPED || !positionMap || home === undefined) return null;
  const at = effectiveHome(positionMap, home);
  const floor = derivedFloor(identity, at);
  if (!floor || floor === at || at === EVERYONE || !ancestors(positionMap, at).includes(floor)) return null;
  const cutoff = Date.now() - windowMs();
  const above = [...(readMarks.get(markKey(identity)) ?? new Map())]
    .filter(([h, t]) => t > cutoff && commonAncestor(positionMap, [at, h]) !== at)
    .map(([h]) => homeName(positionMap, h));
  return { floor, home: at, read: [...new Set(above)] };
}

const liftRefusal = (name, lift) =>
  `Not written: "${name}" lives at ${homeName(positionMap, lift.home)}, but in the last ${policy.derivedWindowHours} hours you read entries at ${lift.read.join(", ") || homeName(positionMap, lift.floor)} that people there can't see, so this write would be held at ${homeName(positionMap, lift.floor)} instead. Either leave the entry as it is, or write it again with propose: true and a reason that says what it rests on: an admin then decides whether it's written at ${homeName(positionMap, lift.home)}.`;

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
    note: `held at ${homeName(positionMap, floor)}: built from what its writer read there or below (${place.note})`,
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
  // written for everyone: graded from the top for its end date only (everyone isn't a position to describe)
  const verdicts = await gradeBatch(origin === EVERYONE ? positionMap.root : origin, entities, writtenAt);
  // the end date the grader judged; an unsure verdict means lasting, a failed one leaves it be
  const until = (v) => (v ? (v.confidence >= policy.gradingConfidence ? v.until : null) : undefined);
  if (origin === EVERYONE) {
    // written for everyone on purpose (the admin, or a survey for everyone): graded for its end date only
    return entities.map((_, i) => ({ ...applyFloor({ home: existing[i] ?? origin, note: "for everyone" }, origin, floor), until: until(verdicts[i]) }));
  }
  if (origin === positionMap.root) {
    // nothing above the root to restrict to: graded for its end date only
    return entities.map((_, i) => ({ ...applyFloor({ home: existing[i] ?? origin, note: "at the root" }, origin, floor), until: until(verdicts[i]) }));
  }
  return entities.map((_, i) => ({ ...applyFloor(decide(positionMap, origin, verdicts[i], existing[i], policy.gradingConfidence), origin, floor), until: until(verdicts[i]) }));
}

/** `home` is already resolved by the caller (resolveWriteHome); undefined = unscoped */
async function upsertEntities({ entities, home, floor, written_at, from_worker }) {
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
    // server-set fields (documents, sections); never from a caller (tool schemas drop them)
    const systemSql = Object.entries(e._system && typeof e._system === "object" ? e._system : {})
      .filter(([k, v]) => /^_[a-z][a-z0-9_]*$/.test(k) && ["string", "number"].includes(typeof v))
      .map(([k, v]) => `, n.\`${k}\` = ${typeof v === "string" ? `'${esc(v)}'` : Number(v)}`)
      .join("");
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
        `SET n.updated_at = datetime() ${propSql ? ", " + propSql : ""}${placeSql}${validSql}${systemSql} ${labelClause}`,
      "cypher",
    );
    merged++;
    for (const [facet, text] of Object.entries(e.facets ?? {})) {
      const f = sanitizeFacet(facet);
      if (typeof text !== "string" || !text.trim()) continue;
      await ensureIndex(f);
      // a section stores its preview but is embedded from its full text (+ context)
      const embed = typeof e._embed?.[facet] === "string" ? e._embed[facet] : text;
      jobs.push({ name: e.name, facet: f, text: text.slice(0, 4000), embed: embed.slice(0, 6000) });
    }
  }

  // one batched embeddings call for all facet texts
  let embedded = 0;
  if (jobs.length > 0) {
    const vecs = await embedBatch(jobs.map((j) => j.embed ?? j.text));
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
          .then(async (rows) => {
            if (!rows[0]) return;
            // the graph worker finds what it's about (in the background): the
            // one-call linking, or a thread; what a thread wrote only gets linked
            const rid = String(rows[0].rid);
            const kind = from_worker ? "mentions" : firstJob(worker.pool);
            // with a master: linked first (when there's a linking model), then into the next batch
            const toMaster = !from_worker && worker.pool.master && worker.pool.poolSize > 0;
            if (toMaster && !workerModel()) await enqueue("intake", { rid }, { key: `intake:${rid}` }).catch(() => {});
            else await enqueue(kind, { rid, ...(from_worker ? { from_worker: true } : {}), ...(toMaster ? { intake: true } : {}) }, { key: `${kind}:${rid}` }).catch(() => {});
            await meetAssertion(String(rows[0].rid), vec);
          })
          .catch((e) => log.warn(`meeting questions for ${jobs[i].name}: ${String(e).slice(0, 120)}`));
      }
    }
  }

  // grading's proposals go to a person: release lower, or review an unsure call
  const placed = [];
  if (placements) {
    for (const [i, e] of entities.entries()) {
      const p = placements[i];
      placed.push({ name: e.name, home: homeName(positionMap, p.home), note: p.note, ...(validities[i] !== undefined ? { valid_until: validities[i] } : {}) });
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
    // as parameters: an inlined vector or text can fail to parse (and one bad row stalled every sweep)
    await adbCommand(`UPDATE ${rids[i]} SET embed_identity = :v, text_identity = :t`, "sql", { v: vecs[i], t: texts[i] });
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

async function executeGraph({ command, language = "cypher", reason }, identity) {
  await assertNotWaiting(identity);
  if (!["cypher", "sql"].includes(language)) throw new Error("language must be cypher or sql");
  if (typeof command !== "string" || !command.trim()) throw new Error("command required");
  if (/^\s*(DROP DATABASE|DROP TYPE|TRUNCATE)/i.test(command)) {
    throw new Error("destructive schema/database operations are not permitted");
  }
  // a worker's raw writes are always proposals: they can do anything, and nothing undoes them
  if (identity.caps.write === "queued" || identity.role?.kind === "worker") {
    const q = await queueWrite({ kind: "command", command, language, user: identity.user, ...proposalFields(identity, reason) });
    return identity.role?.kind === "worker" ? { ...q, note: PROPOSED_NOTE } : q;
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
  if (rec.kind === "merge") return mergeThings(JSON.parse(rec.payload));
  if (rec.kind === "fold") return foldEntries(JSON.parse(rec.payload));
  if (rec.kind === "typed_update") return applyTypedUpdate(JSON.parse(rec.payload));
  if (rec.kind === "delete_entry") return deleteEntry(JSON.parse(rec.payload));
  // approved: runs in the background (minutes for a long document)
  if (rec.kind === "ingest") {
    const p = JSON.parse(rec.payload);
    void startIngest(p);
    return { ingesting: true, doc_id: p.doc_id, sections: p.sections };
  }
  const result = await adbCommand(rec.payload, rec.language ?? "sql");
  if (DELETE_RE.test(rec.payload)) await refreshGrants();
  return result;
}

/** move entities to another home: restricting applies, widening needs a person */
async function setHome({ entities, to, reason, propose }, identity, scope) {
  await assertNotWaiting(identity);
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
    // widening who sees something is always a person's call; a worker may also choose to ask
    if (kind === "restrict" && identity.caps.write === "direct" && !propose) {
      results.push({ name: ref.name, ...(await applyRehome(move)) });
      if (identity.role?.kind === "worker") await logChange(identity, { kind: "move", detail: `"${ref.name}" up to ${homeName(positionMap, target)}`, ...(reason ? { reason: String(reason).slice(0, 300) } : {}) });
    } else {
      // only people widen who sees what; queued writers queue restrictions too
      results.push({ name: ref.name, [kind === "widen" ? "widening" : "restricting"]: true, ...(await queueWrite({ kind: "rehome", payload: JSON.stringify(move), user: identity.user, home: current, ...proposalFields(identity, reason) })) });
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
  // seen from its new home: so are the things it's about
  const about = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`).catch(() => []);
  for (const a of about) if (RID_RE.test(String(a.dst))) await thingSeenFrom(String(a.dst), to).catch(() => {});
  log.info(`entity ${name} rehomed ${homeName(positionMap, from)} -> ${homeName(positionMap, to)}`);
  return { moved: true, from: homeName(positionMap, from), to: homeName(positionMap, to) };
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

const positionName = (id) => (positionMap && (id === EVERYONE || positionMap.positions[id]) ? homeName(positionMap, id) : id);

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
      positions: heldPositions(positionMap, entriesByUser.get(name)?.positions).map((id) => (id === positionMap.root ? "Top of the organization" : positionName(id))),
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
        `SELECT @rid AS rid, name, _home, _origin, _kind, _doc_id FROM ${ENTITY_LABEL} WHERE name = :name${homeFilter(scope, { own: true })}${ASSERTIONS}`,
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
      if (hits[0]._kind === "document") {
        // a document is shared with its sections (those the owner owns and the recipient doesn't see)
        const secs = await adbQuery(`SELECT @rid AS rid, name, _home, _origin FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :d${homeFilter(scope, { own: true })}`, { d: hits[0]._doc_id });
        for (const sec of secs) {
          const h = effectiveHome(positionMap, sec._home);
          if (!recipientSees(recipient, h)) targets.push({ kind: "entity", target: String(sec.rid), target_name: sec.name, target_origin: sec._origin ?? null, target_home: h });
        }
      }
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
const ASSERTIONS = " AND (_kind IS NULL OR _kind IN ['document', 'section'])";
/** in search: assertions, and questions only while open */
const openNeedsClause = (now = Date.now()) => ` AND (_kind IS NULL OR _kind IN ['document', 'section'] OR (_kind = 'need' AND _status = 'open' AND _open_until > '${new Date(now).toISOString()}'))`;

async function ensureNeedSchema() {
  for (const prop of ["_kind", "_qid", "_asker", "_asked_by", "_status", "_open_until", "_joined_into", "_questions", "_dismissed"]) {
    await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._asked IF NOT EXISTS INTEGER`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (_qid) NOTUNIQUE`).catch(() => {});
  await adbCommand("CREATE EDGE TYPE NEAR IF NOT EXISTS").catch(() => {});
  // ALSO: two people asking nearly the same thing (new question -> earlier one)
  await adbCommand("CREATE EDGE TYPE ALSO IF NOT EXISTS").catch(() => {});
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

/** is this person among the owners an entry's meeting goes to (not merely above it) */
const ownerOf = (person, home, asker) => ownersFor(positionMap, home, holdersMap(), asker).includes(person);

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
      await adbCommand(`UPDATE ${need.rid} SET _status = 'joined', _joined_into = :joined_into`, "sql", { joined_into: t.qid });
      log.info(`question ${need.qid} joined ${t.qid} (same asker, same question)`);
      return;
    }
    // other people asking nearly the same thing: linked, so owners answer them together
    const others = await adbQuery(
      `SELECT @rid AS rid, _qid, vectorCosineSimilarity(embed_identity, ${v}) AS score FROM ${ENTITY_LABEL} WHERE _kind = 'need' AND _status = 'open' AND _open_until > :now AND _asker <> :asker ORDER BY score DESC LIMIT 5`,
      { asker: need.asker, now: new Date(now).toISOString() },
    ).catch(() => []);
    for (const o of others) {
      if (!(Number(o.score) >= LINK_MIN) || !RID_RE.test(String(o.rid))) continue;
      await adbCommand(`CREATE EDGE ALSO FROM ${need.rid} TO ${String(o.rid)} SET score = :score, at = :at`, "sql", {
        score: Math.round(Number(o.score) * 1000) / 1000,
        at: new Date(now).toISOString(),
      });
      log.info(`question ${need.qid} linked to ${o._qid} (another person asked nearly the same)`);
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
  if (!row || (row._kind && row._kind !== "section") || isExpired(row._valid_until)) return;
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
  if (identity.agent) {
    return {
      proposed: true,
      requestId: qid,
      note: "Drafted only: nothing has been sent. Tell the person: \"I've drafted the question; nothing is sent until you press Ask on the card below.\"",
    };
  }
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
  return { ...askerView(need, await needEdges(need.rid)), also_asked: await alsoAsked(need) };
}

/** who else asked nearly the same, among questions the asker can see anyway */
async function alsoAsked(need) {
  const names = [];
  for (const rid of await linkedRids(need.rid)) {
    const row = (await adbQuery(`SELECT @rid AS rid, name, _home, _origin, _asker, _status FROM ${rid}`).catch(() => []))[0];
    if (row && row._asker !== need.asker && row._status === "open" && personSees(need.asker, row)) names.push(row._asker);
  }
  return [...new Set(names)];
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

/** questions linked to this one (other people asking the same thing) */
async function linkedRids(rid) {
  const rows = await adbQuery(`SELECT @out AS a, @in AS b FROM (SELECT expand(bothE('ALSO')) FROM ${rid})`).catch(() => []);
  return [...new Set(rows.flatMap((r) => [String(r.a), String(r.b)]))].filter((r) => r !== rid && RID_RE.test(r));
}

/** the open questions shown to this person with their meetings, grouped where linked */
async function shownGroups(person, scope) {
  const rows = await adbQuery(
    `SELECT FROM ${ENTITY_LABEL} WHERE _kind = 'need' AND _status = 'open' AND _open_until > :now AND _asker <> :me LIMIT 300`,
    { now: new Date().toISOString(), me: person },
  );
  const items = new Map(); // qid -> { need, edges, mine }
  for (const row of rows) {
    const need = needOf(row);
    // shown to me through a share of the question (not merely below me in the tree)
    if (!shownTo(need, person, scope) || need.dismissed.includes(person)) continue;
    const edges = await needEdges(need.rid);
    items.set(need.qid, { need, edges, mine: edges.filter((e) => e.state !== "visible" && ownerOf(person, e.home, need.asker)) });
  }
  const byRid = new Map([...items.values()].map((i) => [i.need.rid, i.need.qid]));
  const links = [];
  for (const { need } of items.values()) for (const r of await linkedRids(need.rid)) if (byRid.has(r)) links.push([need.qid, byRid.get(r)]);
  const asked = (i) => i.need.questions[0]?.at ?? "";
  return groupLinked([...items.keys()], links).map((g) => g.map((q) => items.get(q)).sort((a, b) => asked(a).localeCompare(asked(b))));
}

const groupOut = (group) => {
  const v = groupView(group.map((i) => ownerView(i.need, i.mine)));
  return { ...v, entries: v.entries.map((e) => ({ ...e, home: positionName(e.home) })) };
};

/** the owners' side: open questions shown to this person, one item per group of linked ones */
async function incomingRequests(identity) {
  const person = personOf(identity.user);
  const scope = personScope(person);
  if (!scope) return { requests: [] };
  const out = (await shownGroups(person, scope)).map(groupOut);
  return { requests: out.sort((a, b) => Number(b.status === "open") - Number(a.status === "open")) };
}

/** the group of linked questions shown to this person that holds `qid` */
async function groupOf(qid, person, scope) {
  return (await shownGroups(person, scope)).find((g) => g.some((i) => i.need.qid === qid)) ?? null;
}

/** the owner shares (some of) their entries with everyone in the group who asked */
async function answerRequest(qid, { entries, until }, identity, scope) {
  if (identity.agent) throw new Error("the person who owns the data answers a request");
  const person = personOf(identity.user);
  const group = await groupOf(qid, person, personScope(person) ?? scope);
  if (!group) throw new Error("this request is closed");
  // the owner's entries across the group, by record id
  const offered = new Map();
  for (const i of group) for (const e of i.mine) if (e.state === "open" && !offered.has(e.rid)) offered.set(e.rid, e);
  const keys = new Set(Array.isArray(entries) ? entries.map(String) : []);
  const chosen = [...offered.values()].filter((e) => keys.has(e.rid));
  if (chosen.length === 0) throw new Error(offered.size ? "pick at least one of the matching entries" : `no request ${qid} for you to answer`);
  const results = [];
  for (const { need, edges } of group) {
    for (const e of chosen) {
      const edge = edges.find((x) => x.rid === e.rid);
      if (edge?.state === "shared" || edge?.state === "visible") continue;
      let done = false;
      try {
        // an answer always ends: the organization's default unless the owner picked a date
        const end = until ?? `${policy.defaultShareDays}d`;
        const r = (await grantAccess({ entities: [{ name: e.name, home: e.home }], person: need.asker, reason: `Asked: ${need.question}`.slice(0, 500), until: end }, identity, scope)).results[0];
        results.push({ name: e.name, asker: need.asker, ...(r.granted ? { granted: true, expires_at: r.expires_at } : { proposed: true }) });
        done = true;
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        done = /already sees/.test(msg); // that asker got it some other way meanwhile
        results.push({ name: e.name, asker: need.asker, error: msg.slice(0, 200) });
      }
      if (!done) continue;
      // a linked question that didn't meet the entry itself gets the meeting now
      if (edge) await adbCommand(`UPDATE ${edge.erid} SET state = 'shared'`);
      else await meet(need, e.rid, e.score ?? 0, "shared");
    }
  }
  const view = (await incomingRequests(identity)).requests.find((r) => r.ids.includes(qid)) ?? null;
  return { request: view, results };
}

async function dismissRequest(qid, identity) {
  if (identity.agent) throw new Error("the person who owns the data answers a request");
  const person = personOf(identity.user);
  const scope = personScope(person);
  const group = scope && (await groupOf(qid, person, scope));
  if (!group) throw new Error(`no request ${qid} for you`);
  for (const { need, mine } of group) {
    for (const e of mine) if (e.state === "open") await adbCommand(`UPDATE ${e.erid} SET state = 'declined'`);
    await adbCommand(`UPDATE ${need.rid} SET _dismissed = :d`, "sql", { d: JSON.stringify([...new Set([...need.dismissed, person])]) });
  }
  return { dismissed: true, id: qid };
}

async function expireRequests() {
  await adbCommand(`UPDATE ${ENTITY_LABEL} SET _status = 'expired' WHERE _kind = 'need' AND _status IN ['proposed', 'open'] AND _open_until < :now`, "sql", {
    now: new Date().toISOString(),
  }).catch((e) => log.warn(`question expiry sweep: ${String(e).slice(0, 120)}`));
}

/** ---- documents (see documents.js and docstore.js) ---- */

const docStore = createDocStore(DOC_STORE);
let ingestQueue = Promise.resolve(); // one document at a time (grading and embedding are the cost)
const chunkCache = new Map(); // doc id -> chunks (deterministic from the stored text)

async function ensureDocumentSchema() {
  for (const prop of ["_doc_id", "_doc_title", "_doc_status"]) await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._section IF NOT EXISTS INTEGER`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (_doc_id) NOTUNIQUE`).catch(() => {});
  for (const t of ["PART_OF", "NEXT", "SOURCED_FROM"]) await adbCommand(`CREATE EDGE TYPE ${t} IF NOT EXISTS`).catch(() => {});
}

async function storedChunks(docId) {
  if (chunkCache.has(docId)) return chunkCache.get(docId);
  const { text } = await docStore.get(docId);
  const cs = chunk(text);
  if (chunkCache.size > 50) chunkCache.delete(chunkCache.keys().next().value);
  chunkCache.set(docId, cs);
  return cs;
}

async function edgeOnce(type, from, to) {
  const out = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('${type}')) FROM ${from})`).catch(() => []);
  if (out.some((e) => String(e.dst) === to)) return;
  await adbCommand(`CREATE EDGE ${type} FROM ${from} TO ${to}`);
}

/** one model call (the extraction model: EXTRACT_MODEL, else the grader's) */
async function chat(model, messages, timeoutMs = Number(GRADER_TIMEOUT_MS) * 2) {
  const res = await fetch(`${LITELLM_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LITELLM_API_KEY}` },
    body: JSON.stringify({ model, messages, temperature: 0 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${model} HTTP ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content ?? "";
}

/**
 * Ingest a stored document: its entry, its sections (graded, never below
 * the entry), their links, and, only when the ingest said so, extracted
 * facts. Re-ingesting the same title replaces the sections.
 */
async function ingestDocument(p) {
  const writtenAt = Date.parse(p.written_at) || Date.now();
  const { text } = await docStore.get(p.doc_id);
  const chunks = chunk(text);
  chunkCache.set(p.doc_id, chunks);
  const vu = p.valid_until; // ISO, "lasting", or undefined: as resolved when it was written
  const keyOf = (name, kind) => adbQuery(`SELECT @rid AS rid, _home, _doc_id FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin AND _kind = :kind LIMIT 1`, { name, origin: p.home, kind });
  const before = (await keyOf(p.title, "document"))[0];
  await upsertEntities({
    entities: [
      {
        name: p.title,
        facets: { identity: `${p.title}: ${p.description}` },
        properties: { description: p.description, sections: chunks.length, characters: text.length, extracted: Boolean(p.extract) },
        ...(vu ? { valid_until: vu } : {}),
        _system: { _kind: "document", _doc_id: p.doc_id, _doc_status: "ingesting" },
      },
    ],
    home: p.home,
    floor: p.floor,
    written_at: p.written_at,
  });
  const doc = (await keyOf(p.title, "document"))[0];
  if (!doc) throw new Error("the document entry wasn't written");
  // sections can be filed higher than the document (grading restricts), never lower
  const docHome = effectiveHome(positionMap, doc._home);
  for (let i = 0; i < chunks.length; i += 32) {
    await upsertEntities({
      entities: chunks.slice(i, i + 32).map((c) => ({
        name: sectionName(p.title, c.index, c.heading),
        facets: { identity: preview(c.text) },
        _embed: { identity: c.embedText },
        ...(c.heading ? { properties: { heading: c.heading } } : {}),
        ...(vu ? { valid_until: vu } : {}),
        _system: { _kind: "section", _doc_id: p.doc_id, _doc_title: p.title, _section: c.index },
      })),
      home: p.home,
      floor: docHome,
      written_at: p.written_at,
    });
  }
  const sections = await adbQuery(`SELECT @rid AS rid, _home, _section FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :d ORDER BY _section`, { d: p.doc_id });
  for (const [i, s] of sections.entries()) {
    await edgeOnce("PART_OF", String(s.rid), String(doc.rid));
    if (sections[i + 1]) await edgeOnce("NEXT", String(s.rid), String(sections[i + 1].rid));
  }
  // a re-ingest: sections past the new end, and the old text, go
  if (before?._doc_id && before._doc_id !== p.doc_id) {
    await adbCommand(`DELETE FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :old`, "sql", { old: before._doc_id }).catch(() => {});
    await docStore.remove(before._doc_id).catch(() => {});
    chunkCache.delete(before._doc_id);
  }
  let facts = 0;
  if (p.extract) facts = await extractFacts(p, chunks, sections, writtenAt);
  await adbCommand(`UPDATE ${String(doc.rid)} SET _doc_status = 'ready', facts = :facts`, "sql", { facts });
  log.info(`document "${p.title}" (${p.doc_id}): ${sections.length} sections${p.extract ? `, ${facts} extracted facts` : ", no extraction (as asked)"}`);
  return { doc_id: p.doc_id, sections: sections.length, facts };
}

/** extracted facts: ordinary entries, filed no lower than their section, linked to it */
async function extractFacts(p, chunks, sections, writtenAt) {
  const model = EXTRACT_MODEL || GRADER_MODEL;
  if (!model) {
    log.warn(`document "${p.title}": extraction asked for, but no EXTRACT_MODEL or GRADER_MODEL is set`);
    return 0;
  }
  const homeOf = new Map(sections.map((s) => [Number(s._section), { rid: String(s.rid), home: effectiveHome(positionMap, s._home) }]));
  const all = [];
  for (let i = 0; i < chunks.length; i += 4) {
    const group = chunks.slice(i, i + 4);
    try {
      all.push(...parseExtraction(await chat(model, extractionPrompt(p.title, group, writtenAt)), group, writtenAt));
    } catch (e) {
      log.warn(`document "${p.title}": extraction of sections ${i + 1}-${i + group.length} failed: ${String(e).slice(0, 120)}`);
    }
  }
  // one write per section home (grading runs per write), floored at that home
  const byHome = new Map();
  for (const f of all) {
    const s = homeOf.get(f.section);
    if (!s) continue;
    if (!byHome.has(s.home)) byHome.set(s.home, []);
    byHome.get(s.home).push({ ...f, sectionRid: s.rid });
  }
  let n = 0;
  for (const [home, list] of byHome) {
    for (let i = 0; i < list.length; i += 32) {
      const batch = list.slice(i, i + 32);
      await upsertEntities({
        entities: batch.map((f) => ({
          name: f.name,
          facets: { identity: f.statement },
          properties: { source: `${p.title} §${f.section + 1}` },
          ...(f.until ? { valid_until: f.until } : {}),
        })),
        home: p.home,
        floor: home,
        written_at: p.written_at,
      });
      for (const f of batch) {
        const row = (await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin AND _kind IS NULL LIMIT 1`, { name: f.name, origin: p.home }))[0];
        if (row) {
          await edgeOnce("SOURCED_FROM", String(row.rid), f.sectionRid);
          n++;
        }
      }
    }
  }
  return n;
}

/**
 * Stored texts nothing refers to any more (their entries were deleted some
 * other way): removed once a day old, so a deleted document doesn't linger.
 * A pending ingest still refers to its text.
 */
async function sweepOrphanDocuments(minAgeMs = 86_400_000) {
  if (!docStore?.list) return 0;
  const stored = await docStore.list();
  if (stored.length === 0) return 0;
  let rows;
  try {
    rows = await adbQuery(`SELECT _doc_id FROM ${ENTITY_LABEL} WHERE _kind IN ['document', 'section'] AND _doc_id IS NOT NULL LIMIT 100000`);
  } catch {
    return 0; // can't tell what's live: remove nothing
  }
  const live = new Set(rows.map((r) => r._doc_id));
  const pending = (await adbQuery("SELECT payload FROM PendingWrite WHERE kind = 'ingest' AND status IN ['pending', 'executing'] LIMIT 1000").catch(() => [])).map((r) => {
    try {
      return JSON.parse(r.payload).doc_id;
    } catch {
      return null;
    }
  });
  let n = 0;
  for (const d of stored) {
    if (live.has(d.id) || pending.includes(d.id) || Date.now() - d.at < minAgeMs) continue;
    await docStore.remove(d.id).catch(() => {});
    chunkCache.delete(d.id);
    n++;
  }
  if (n) log.info(`removed ${n} stored document${n === 1 ? "" : "s"} nothing refers to any more`);
  return n;
}

function startIngest(p) {
  ingestQueue = ingestQueue
    .then(() => ingestDocument(p))
    .catch(async (e) => {
      log.warn(`document "${p.title}" (${p.doc_id}) failed: ${String(e).slice(0, 200)}`);
      await adbCommand(`UPDATE ${ENTITY_LABEL} SET _doc_status = 'failed' WHERE _kind = 'document' AND _doc_id = :d`, "sql", { d: p.doc_id }).catch(() => {});
    });
  return ingestQueue;
}

/** an ingest from a tool call: stored now; ingested now, or after approval for queued writers */
async function requestIngest({ title, description, text, extract, home: requestedHome, valid_until }, identity, scope) {
  if (!docStore) throw new Error("no document store is configured (DOC_STORE)");
  if (typeof extract !== "boolean") throw new Error('say whether to extract facts: extract: true or false (ask the person if they haven\'t said)');
  const body = String(text ?? "");
  if (body.trim().length < 20) throw new Error("the document text is empty");
  if (body.length > MAX_CHARS) throw new Error(`documents are limited to ${MAX_CHARS} characters`);
  const chunks = chunk(body);
  if (chunks.length > MAX_SECTIONS) throw new Error(`documents are limited to ${MAX_SECTIONS} sections (this one has ${chunks.length})`);
  const home = resolveWriteHome(scope, requestedHome);
  const now = Date.now();
  const v = parseValidUntil(valid_until, now);
  const doc_id = randomUUID();
  const payload = {
    doc_id,
    title: String(title).trim().slice(0, 200),
    description: String(description).trim().slice(0, 500),
    extract,
    home,
    floor: derivedFloor(identity, home),
    written_at: new Date(now).toISOString(),
    ...(v ? { valid_until: v.valid_until ?? "lasting" } : {}),
    chars: body.length,
    sections: chunks.length,
  };
  await docStore.put(doc_id, body, { title: payload.title, by: identity.user, at: payload.written_at });
  if (identity.caps.write === "queued") {
    const q = await queueWrite({ kind: "ingest", payload: JSON.stringify(payload), user: identity.user, home });
    return { ...q, doc_id, sections: chunks.length, extract, note: "the document is stored; it's added to the knowledge graph once the ingest is approved" };
  }
  void startIngest(payload);
  return { ingesting: true, doc_id, sections: chunks.length, extract, note: "sections are being graded and embedded; search finds them in a minute or two" };
}

/** read a document's sections the caller can see (text from the document store) */
async function readDocument({ document, section, count = 3 }, identity, scope) {
  if (!docStore) throw new Error("no document store is configured");
  const ref = String(document ?? "").trim();
  const visible = homeFilter(scope) + liveClause();
  let docId = PENDING_ID_RE.test(ref) ? ref : null;
  let title = null;
  let status = null;
  if (!docId) {
    const d = (await adbQuery(`SELECT _doc_id, _doc_status FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND name = :name${visible} LIMIT 1`, { name: ref }))[0];
    const s = d ? null : (await adbQuery(`SELECT _doc_id FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_title = :name${visible} LIMIT 1`, { name: ref }))[0];
    docId = d?._doc_id ?? s?._doc_id ?? null;
    status = d?._doc_status ?? null;
  }
  if (!docId) throw new Error(`no document "${ref}" you can see`);
  const rows = await adbQuery(`SELECT _home, _section, _doc_title FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :d${visible} ORDER BY _section`, { d: docId });
  if (rows.length === 0) throw new Error(status === "ingesting" ? "this document is still being ingested" : `no document "${ref}" you can see`);
  title = rows[0]._doc_title;
  const chunks = await storedChunks(docId);
  const seen = new Set(rows.map((r) => Number(r._section)));
  const n = Math.max(1, Math.min(6, Number(count) || 3));
  const from = section ? Math.max(0, Number(section) - 1) : 0;
  const picked = chunks.filter((c) => c.index >= from && seen.has(c.index)).slice(0, n);
  recordReads(identity, rows.filter((r) => picked.some((c) => c.index === Number(r._section))).map((r) => effectiveHome(positionMap, r._home)));
  return {
    document: title,
    document_id: docId,
    // only the sections you can see are listed and returned
    contents: chunks.filter((c) => seen.has(c.index)).map((c) => ({ section: c.index + 1, heading: c.heading || undefined })),
    sections: picked.map((c) => ({ section: c.index + 1, heading: c.heading || undefined, text: c.text })),
  };
}

/** ---- the graph worker: a job queue and loop (things and their links; see things.js) ---- */

// the worker's settings come from the admin's "Graph worker" profile (PUT /api/worker)
let worker = { enabled: true, model: "", instructions: "", profile: null, pool: { ...POOL_DEFAULTS }, updated_by: null, updated_at: null };
// only a model someone chose: falling back to the grader's would spend its quota on every write
const workerModel = () => worker.model || WORKER_MODEL;
const workerUsage = { day: "", calls: 0 }; // model calls today (WORKER_DAILY_CALLS caps them)
let workerTicking = false;

async function ensureWorkerSchema() {
  await adbCommand("CREATE DOCUMENT TYPE Job IF NOT EXISTS").catch(() => {});
  for (const prop of ["id", "kind", "job_key", "payload", "status", "run_after", "created_at", "updated_at", "error"]) {
    await adbCommand(`CREATE PROPERTY Job.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
  for (const prop of ["attempts", "priority"]) await adbCommand(`CREATE PROPERTY Job.${prop} IF NOT EXISTS INTEGER`).catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON Job (job_key) NOTUNIQUE").catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON Job (status) NOTUNIQUE").catch(() => {});
  for (const prop of ["_thing_type", "_norm", "_mentions_at"]) await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS STRING`).catch(() => {});
  for (const prop of ["_homes", "_alias_norms", "_keys"]) await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS LIST`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (_norm) NOTUNIQUE`).catch(() => {});
  for (const prop of ["agent_id", "summary", "lease_until", "claimed_at", "changes"]) await adbCommand(`CREATE PROPERTY Job.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._reviewed_at IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand("CREATE DOCUMENT TYPE WorkerQuestion IF NOT EXISTS").catch(() => {});
  for (const prop of ["id", "job_id", "entry", "entry_name", "question", "options", "why", "asked_by", "status", "answer", "answered_by", "created_at", "answered_at"]) {
    await adbCommand(`CREATE PROPERTY WorkerQuestion.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
  await adbCommand("CREATE INDEX IF NOT EXISTS ON WorkerQuestion (job_id) NOTUNIQUE").catch(() => {});
  await adbCommand("CREATE EDGE TYPE ABOUT IF NOT EXISTS").catch(() => {});
  await adbCommand("CREATE EDGE TYPE RELATES IF NOT EXISTS").catch(() => {});
  for (const prop of ["rel", "evidence", "job", "at"]) await adbCommand(`CREATE PROPERTY RELATES.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._task_by IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand("CREATE PROPERTY ABOUT.role IF NOT EXISTS STRING").catch(() => {});
  // a crash mid-job leaves it running: it runs again (threads keep their lease: their workspace may still run them)
  await adbCommand("UPDATE Job SET status = 'pending' WHERE status = 'running' AND kind <> 'review'").catch(() => {});
  try {
    const row = (await adbQuery("SELECT FROM OrgPolicy WHERE scope = 'worker' LIMIT 1"))[0];
    if (row) {
      const saved = JSON.parse(row.json);
      worker = { ...worker, ...saved, pool: poolSettings(saved.pool ?? {}, POOL_DEFAULTS), updated_by: row.updated_by ?? null, updated_at: row.updated_at ?? null };
    }
  } catch {
    /* defaults */
  }
}

/** queue a job once: a pending one with the same key is reused (and raised in priority) */
async function enqueue(kind, payload, { key, priority = 0 } = {}) {
  const job_key = key ?? `${kind}:${JSON.stringify(payload)}`;
  const open = (await adbQuery("SELECT id, priority FROM Job WHERE job_key = :k AND status IN ['pending', 'running'] LIMIT 1", { k: job_key }).catch(() => []))[0];
  if (open) {
    if (priority > Number(open.priority ?? 0)) await adbCommand("UPDATE Job SET priority = :p WHERE id = :id AND status = 'pending'", "sql", { p: priority, id: open.id });
    return open.id;
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  await adbCommand(
    "INSERT INTO Job SET id = :id, kind = :kind, job_key = :k, payload = :payload, status = 'pending', attempts = 0, priority = :p, run_after = :now, created_at = :now, updated_at = :now",
    "sql",
    { id, kind, k: job_key, payload: JSON.stringify(payload), p: priority, now },
  );
  return id;
}

/** one model call for the worker, counted against the daily budget */
async function workerCall(messages) {
  const day = new Date().toISOString().slice(0, 10);
  if (workerUsage.day !== day) Object.assign(workerUsage, { day, calls: 0 });
  if (workerUsage.calls >= Number(WORKER_DAILY_CALLS)) throw Object.assign(new Error("the worker's daily budget is used up"), { later: true });
  workerUsage.calls++;
  return chat(workerModel(), messages, Number(WORKER_TIMEOUT_MS));
}

const THING_KINDS_READ = ["document", "section"]; // besides plain entries, what the worker reads for things

/** a thing's visibility follows the statements about it: add a home */
async function thingSeenFrom(rid, home) {
  const row = (await adbQuery(`SELECT _homes FROM ${rid}`))[0];
  const homes = Array.isArray(row?._homes) ? row._homes : [];
  if (!homes.includes(home)) await adbCommand(`UPDATE ${rid} SET _homes = :homes`, "sql", { homes: [...homes, home] });
}

async function aboutOnce(statementRid, thingRid, role) {
  const out = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${statementRid})`).catch(() => []);
  if (out.some((e) => String(e.dst) === thingRid)) return;
  await adbCommand(`CREATE EDGE ABOUT FROM ${statementRid} TO ${thingRid} SET role = :role`, "sql", { role });
}

/**
 * Resolve mentions to things and link a statement to them (see things.js):
 * exact or very close -> that thing; close but unsure -> a new thing plus a
 * merge question for a person (or, with `unsure: "skip"`, nothing: a worker
 * thread decides instead); otherwise a new thing. Returns what happened.
 */
async function linkMentions(rid, mentions, home, { unsure = "ask", create = true } = {}) {
  const vecs = mentions.length ? await embedBatch(mentions.map((m) => `${m.type}: ${m.name}`)) : [];
  const out = [];
  for (const [i, m] of mentions.entries()) {
    const n = normalize(m.name);
    // a record key finds its thing whatever it's called (and whatever type was guessed)
    const byKey = m.key
      ? await adbQuery(`SELECT @rid AS rid, label, _alias_norms, _thing_type, _keys FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS :k LIMIT 1`, { k: m.key }).catch(() => [])
      : [];
    const byName = byKey.length
      ? byKey
      : await adbQuery(
          `SELECT @rid AS rid, label, _alias_norms, _thing_type, _keys FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = :t AND (_norm = :n OR _alias_norms CONTAINS :n) LIMIT 5`,
          { t: m.type, n },
        ).catch(() => []);
    const near = byName.length
      ? []
      : await adbQuery(
          `SELECT @rid AS rid, label, _alias_norms, _thing_type, vectorCosineSimilarity(embed_thing, [${vecs[i].join(",")}]) AS score FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = :t AND embed_thing IS NOT NULL ORDER BY score DESC LIMIT 3`,
          { t: m.type },
        ).catch(() => []);
    const cands = [...byName, ...near].map((c) => ({
      rid: String(c.rid),
      name: c.label,
      aliases: c._alias_norms ?? [],
      // a keyed match counts as the mention's type: the key decides
      type: byKey.length ? m.type : c._thing_type,
      keys: c._keys ?? [],
      score: c.score === undefined ? undefined : Number(c.score),
    }));
    let r = resolve(m, cands);
    // a person written partially ("John F.") that would become a new thing: known people it could mean are candidates
    if (r.create && !r.maybe && m.type === "person" && !m.key && partialPerson(m.name)) {
      const part = partialPerson(m.name);
      const people = await adbQuery(`SELECT @rid AS rid, label FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = 'person' AND _norm LIKE :p LIMIT 40`, { p: `${part.first} %` }).catch(() => []);
      const found = personCandidates(part, people).slice(0, 6);
      if (found.length) r = { ambiguous: found.map((c) => String(c.rid)) };
    }
    if (r.create && !m.key) {
      // another entry's name ("ux-t06 bse certs") is a cross-reference, not a thing: no placeholder for it
      const entry = await adbQuery(`SELECT @rid FROM ${ENTITY_LABEL} WHERE name = :n AND ${ENTRY_KINDS} LIMIT 1`, { n: m.name }).catch(() => []);
      if (entry.length) {
        out.push({ name: m.name, type: m.type, role: m.role, skipped: "that's an entry, not a thing: mention it in the text instead" });
        continue;
      }
    }
    if (r.create && !create) {
      // what a worker wrote links only to things that exist (it makes new ones on purpose, with link_things)
      out.push({ name: m.name, type: m.type, role: m.role, skipped: "not an existing thing" });
      continue;
    }
    if (r.ambiguous) {
      // several things go by this name: nothing is linked; a thread (or the sorting step's escalation) picks
      const names = await adbQuery(`SELECT label, _keys FROM [${r.ambiguous.join(",")}]`).catch(() => []);
      out.push({ name: m.name, type: m.type, role: m.role, candidates: r.ambiguous, unsure: names.map((x) => `${x.label}${(x._keys ?? [])[0] ? ` [${x._keys[0]}]` : ""}`).join(" or ") });
      continue;
    }
    if (r.create && r.maybe && unsure === "skip") {
      const other = (await adbQuery(`SELECT label FROM ${r.maybe}`))[0]?.label;
      out.push({ name: m.name, type: m.type, role: m.role, candidates: [r.maybe], unsure: other ?? null });
      continue;
    }
    let thing = r.use;
    if (r.alias) {
      const cur = (await adbQuery(`SELECT _alias_norms FROM ${thing}`))[0]?._alias_norms ?? [];
      await adbCommand(`UPDATE ${thing} SET _alias_norms = :a`, "sql", { a: [...new Set([...cur, normalize(r.alias)])] }).catch(() => {});
    }
    if (r.create) {
      await adbCommand(
        `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, label = :label, _kind = 'thing', _thing_type = :t, _norm = :n, _alias_norms = :aliases, _keys = :keys, _homes = :homes, _home = :root, embed_thing = [${vecs[i].join(",")}], updated_at = :now`,
        "sql",
        { name: thingName(m.type, m.name), label: m.name, t: m.type, n, aliases: [], keys: m.key ? [m.key] : [], homes: [home], root: positionMap.root, now: new Date().toISOString() },
      );
      thing = String((await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = :t AND _norm = :n ORDER BY @rid DESC LIMIT 1`, { t: m.type, n }))[0]?.rid);
    } else if (m.key && RID_RE.test(String(thing))) {
      // a thing found by name learns its record key
      const cur = (await adbQuery(`SELECT _keys FROM ${thing}`))[0]?._keys ?? [];
      if (!cur.includes(m.key)) await adbCommand(`UPDATE ${thing} SET _keys = :k`, "sql", { k: [...cur, m.key].slice(-10) }).catch(() => {});
    }
    if (r.create) {
      if (r.maybe && RID_RE.test(thing)) {
        // unsure: a person decides whether they're the same (nothing merges on its own)
        const other = (await adbQuery(`SELECT label FROM ${r.maybe}`))[0]?.label;
        await queueWrite({ kind: "merge", payload: JSON.stringify({ keep: r.maybe, drop: thing, keep_name: other, drop_name: m.name, type: m.type }), user: "graph-rag worker", home: positionMap.root });
      }
    }
    if (!RID_RE.test(String(thing))) continue;
    await thingSeenFrom(thing, home);
    await aboutOnce(rid, thing, m.role);
    out.push({ name: m.name, type: m.type, role: m.role, [r.create ? "created" : "linked"]: true });
  }
  return out;
}

/**
 * The one-call job: find the things one statement is about and link them.
 * With a pool that sorts first, the same call decides whether a worker
 * thread should look (and an unsure match always sends it there instead of
 * to a person). Entries a worker wrote never go back to a thread.
 */
async function jobMentions({ rid, from_worker, no_thread, intake }) {
  if (!RID_RE.test(String(rid))) return;
  const row = (await adbQuery(`SELECT FROM ${rid}`))[0];
  if (!row?.name || (row._kind && !THING_KINDS_READ.includes(row._kind))) return; // gone, or a question/thing/document entry
  const facets = Object.fromEntries(Object.keys(FACETS).filter((f) => row[`text_${f}`]).map((f) => [f, row[`text_${f}`]]));
  if (Object.keys(facets).length === 0) return;
  const sort = worker.pool.poolSize > 0 && worker.pool.sortFirst && !worker.pool.master && !from_worker && !no_thread && !intake;
  const reply = await workerCall(mentionsPrompt({ name: row.name, facets }, worker.instructions, { sort }));
  const mentions = parseMentions(reply);
  const home = effectiveHome(positionMap, row._home);
  const linked = await linkMentions(rid, mentions, home, { unsure: sort ? "skip" : "ask", create: !from_worker });
  await adbCommand(`UPDATE ${rid} SET _mentions_at = :now`, "sql", { now: new Date().toISOString() });
  // with a master: into the next batch, with what linking couldn't settle
  if (intake) await intakeWithTriage(String(rid), row, linked, home);
  if (sort) {
    const verdict = parseSort(reply);
    const unsure = linked.filter((l) => l.unsure);
    if (verdict.review || unsure.length) {
      const why = [verdict.why, ...unsure.map((u) => `"${u.name}" may be the existing ${u.type} "${u.unsure}"`)].filter(Boolean).join("; ");
      await enqueue("review", { rid: String(rid), why }, { key: `review:${rid}` });
    }
  }
  return { things: mentions.length };
}

/** ---- the worker pool (see pool.js): one agent thread per queue entry, run by the admin's workspace ---- */

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);

/** threads started today (first starts and resumes) */
async function threadsToday() {
  const rows = await adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'review' AND claimed_at >= :day", { day: today() }).catch(() => []);
  return Number(rows[0]?.n ?? 0);
}

/** what a thread is told about its entry */
async function entryForBrief(rid) {
  const row = (await adbQuery(`SELECT FROM ${rid}`))[0];
  if (!row?.name) return null;
  const facets = Object.fromEntries(
    Object.keys(row)
      .filter((k) => k.startsWith("text_") && row[k])
      .map((k) => [k.slice(5), row[k]]),
  );
  const edges = await adbQuery(`SELECT @in AS dst, role FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`).catch(() => []);
  const dsts = edges.map((e) => String(e.dst)).filter((r) => RID_RE.test(r));
  const things = dsts.length ? await adbQuery(`SELECT @rid AS rid, label, _thing_type FROM [${dsts.join(",")}]`).catch(() => []) : [];
  const byRid = new Map(things.map((t) => [String(t.rid), t]));
  const links = edges.filter((e) => byRid.has(String(e.dst))).map((e) => ({ name: byRid.get(String(e.dst)).label, type: byRid.get(String(e.dst))._thing_type, role: e.role }));
  const home = effectiveHome(positionMap, row._home);
  return {
    entry: {
      name: row.name,
      home,
      home_name: homeName(positionMap, home),
      saved_at: row.updated_at ? String(row.updated_at) : undefined,
      valid_until: row._valid_until ?? undefined,
      facets,
    },
    links: links.map((l) => ({ name: l.name, type: l.type, role: l.role })),
    document: row._kind === "section" ? { title: row._doc_title, section: row._section } : null,
  };
}

/**
 * The admin's workspace claims up to `limit` threads to run: due review jobs,
 * highest priority first, within the day's budget. Each comes with its brief
 * (a first start) or its resume message (an answered question, a decided
 * proposal) and the thread's agent if it has one.
 */
async function claimThreads(limit) {
  const room = Math.max(0, Math.min(Number(limit) || 0, worker.pool.poolSize, worker.pool.dailyThreads - (await threadsToday())));
  if (!room) return { threads: [] };
  const now = new Date();
  const due = await adbQuery(`SELECT id, payload, agent_id, attempts FROM Job WHERE kind = 'review' AND status = 'pending' AND run_after <= :now ORDER BY priority DESC, created_at ASC LIMIT ${Math.floor(room)}`, {
    now: now.toISOString(),
  });
  const out = [];
  for (const job of due) {
    const minutes = Number(JSON.parse(job.payload || "{}").minutes) || worker.pool.threadMinutes;
    const lease = new Date(now.getTime() + (minutes + 5) * 60_000).toISOString();
    const claimed = await adbCommand("UPDATE Job SET status = 'running', claimed_at = :now, lease_until = :lease, updated_at = :now WHERE id = :id AND status = 'pending'", "sql", {
      now: now.toISOString(),
      lease,
      id: job.id,
    });
    if (Number(claimed?.[0]?.count ?? 0) !== 1) continue;
    const payload = JSON.parse(job.payload || "{}");
    const brief = RID_RE.test(String(payload.rid)) ? await entryForBrief(payload.rid) : null;
    if (!brief) {
      await adbCommand("UPDATE Job SET status = 'done', summary = 'the entry is gone', updated_at = :now WHERE id = :id", "sql", { now: now.toISOString(), id: job.id });
      continue;
    }
    out.push({
      job: job.id,
      entry: payload.rid,
      name: brief.entry.name,
      agent_id: job.agent_id ?? null,
      ...(payload.level ? { level: payload.level } : {}),
      minutes: Number(payload.minutes) || worker.pool.threadMinutes,
      message: payload.resume ? resumeBrief(payload.resume) : payload.task ? taskThreadBrief(payload.task) : taskBrief({ ...brief, why: payload.why }),
    });
  }
  return { threads: out };
}

/** a thread's agent (recorded when the workspace makes it) */
async function threadAgent(jobId, agentId) {
  if (!JOB_ID_RE.test(String(jobId)) || typeof agentId !== "string" || !/^[\w-]{1,80}$/.test(agentId)) throw Object.assign(new Error("invalid job or agent"), { status: 400 });
  await adbCommand("UPDATE Job SET agent_id = :a, updated_at = :now WHERE id = :id AND kind = 'review'", "sql", { a: agentId, now: new Date().toISOString(), id: jobId });
  return { ok: true };
}

/** the thread ended its turn: done, or waiting on its open questions */
async function finishThread(jobId, { status, summary }) {
  if (!JOB_ID_RE.test(String(jobId))) throw Object.assign(new Error("invalid job"), { status: 400 });
  const job = (await adbQuery("SELECT payload, attempts FROM Job WHERE id = :id AND kind = 'review'", { id: jobId }))[0];
  if (!job) throw Object.assign(new Error("no such thread"), { status: 404 });
  // open questions and undecided proposals: it waits for the admin
  const open =
    Number((await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: jobId }).catch(() => []))[0]?.n ?? 0) +
    Number((await adbQuery("SELECT count(*) AS n FROM PendingWrite WHERE job_id = :id AND status = 'pending'", { id: jobId }).catch(() => []))[0]?.n ?? 0);
  const now = new Date().toISOString();
  const failed = status === "failed";
  const attempts = Number(job.attempts ?? 0) + (failed ? 1 : 0);
  const payload = JSON.parse(job.payload || "{}");
  delete payload.resume;
  // answers or decisions that came while it ran: it goes again with the first
  const queued = !failed && Array.isArray(payload.next_resume) && payload.next_resume.length ? payload.next_resume.shift() : null;
  if (queued) payload.resume = queued;
  if (Array.isArray(payload.next_resume) && !payload.next_resume.length) delete payload.next_resume;
  const next = failed ? (attempts >= 3 ? "failed" : "pending") : queued ? "pending" : open ? "waiting" : "done";
  await adbCommand("UPDATE Job SET status = :s, attempts = :a, summary = :sum, payload = :p, run_after = :ra, updated_at = :now WHERE id = :id", "sql", {
    s: next,
    a: attempts,
    sum: String(summary ?? "").slice(0, 4000),
    p: JSON.stringify(payload),
    ra: new Date(Date.now() + (failed ? 120_000 * attempts : 0)).toISOString(),
    now,
    id: jobId,
  });
  if (next === "done" && RID_RE.test(String(payload.rid))) await adbCommand(`UPDATE ${payload.rid} SET _reviewed_at = :now`, "sql", { now }).catch(() => {});
  // the master hears how its worker ended: done, or stopped (waiting on a decision, or failed for good)
  if (payload.parent === MASTER && payload.entries?.length && (next === "done" || next === "waiting" || next === "failed")) {
    const meaningful = JSON.parse((await adbQuery("SELECT changes FROM Job WHERE id = :id", { id: jobId }))[0]?.changes || "[]").filter((c) => ["link", "merge", "relate", "unlink", "delete", "upsert", "move"].includes(c.kind)).length;
    await recordTriageOutcome(payload.entries, { job: jobId, status: next, changes: meaningful, stopped: next !== "done" });
  }
  if (payload.parent === MASTER && (next === "done" || next === "waiting" || next === "failed")) {
    const title = payload.task?.title ?? "a worker";
    if (next === "done") await emitSignal("done", { job_id: jobId, data: { title, summary: String(summary ?? "").slice(0, 2000) } });
    else await emitSignal("stopped", { job_id: jobId, data: { title, reason: next === "failed" ? "it failed three times" : "it's waiting on a decision", ...(next === "failed" ? { error: String(summary ?? "").slice(0, 600) } : { ...(await openItems(jobId)), summary: String(summary ?? "").slice(0, 1200) }) } });
  }
  // a task's report stays on its task entry (what the survey found, for the admin and later tasks)
  if (payload.task && RID_RE.test(String(payload.rid)) && summary) await adbCommand(`UPDATE ${payload.rid} SET text_state = :sum`, "sql", { sum: String(summary).slice(0, 6000) }).catch(() => {});
  return { status: next };
}

/** wake a thread that waited: it resumes with this message */
async function resumeThread(jobId, resume) {
  const job = (await adbQuery("SELECT payload, status FROM Job WHERE id = :id AND kind = 'review'", { id: jobId }))[0];
  if (!job) return;
  if (job.status === "running" || job.status === "pending") {
    // still working (or about to): it resumes with this once its turn ends
    const p = JSON.parse(job.payload || "{}");
    p.next_resume = [...(p.next_resume ?? []), resume].slice(-5);
    await adbCommand("UPDATE Job SET payload = :p WHERE id = :id", "sql", { p: JSON.stringify(p), id: jobId });
    return;
  }
  const payload = { ...JSON.parse(job.payload || "{}"), resume };
  await adbCommand("UPDATE Job SET status = 'pending', payload = :p, priority = 8, run_after = :now, updated_at = :now WHERE id = :id AND status IN ['waiting', 'done']", "sql", {
    p: JSON.stringify(payload),
    now: new Date().toISOString(),
    id: jobId,
  });
}

/** a thread asks: the liaison (or the admin) answers later; the thread ends its turn meanwhile */
async function raiseQuestion(identity, { question, options, why }) {
  await assertNotWaiting(identity);
  const job = identity.role.job;
  const open = await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: job });
  if (Number(open[0]?.n ?? 0) >= 3) throw new Error("this thread already has 3 open questions: end your turn and wait for answers");
  const entryName = (await adbQuery(`SELECT name FROM ${identity.role.entry}`).catch(() => []))[0]?.name ?? null;
  const id = randomUUID();
  await adbCommand(
    "INSERT INTO WorkerQuestion SET id = :id, job_id = :job, entry = :entry, entry_name = :ename, question = :q, options = :o, why = :w, asked_by = :u, status = 'open', created_at = :now",
    "sql",
    { id, job, entry: identity.role.entry, ename: entryName, q: question, o: JSON.stringify(options ?? []), w: why ?? "", u: identity.user, now: new Date().toISOString() },
  );
  return { asked: true, id, note: "Recorded. End your turn now with a short report; you'll be resumed with the answer." };
}

async function listQuestions(status = "open") {
  const rows = await adbQuery("SELECT id, job_id, entry_name, question, options, why, status, answer, answered_by, created_at, answered_at FROM WorkerQuestion WHERE status = :s ORDER BY created_at ASC LIMIT 200", { s: status }).catch(() => []);
  const agents = new Map();
  for (const r of rows) {
    if (!agents.has(r.job_id)) agents.set(r.job_id, (await adbQuery("SELECT agent_id FROM Job WHERE id = :id", { id: r.job_id }).catch(() => []))[0]?.agent_id ?? null);
  }
  return rows.map((r) => ({ ...r, options: JSON.parse(r.options || "[]"), agent_id: agents.get(r.job_id) }));
}

/** answer (or dismiss) questions; each one's thread resumes with the answer */
async function answerQuestions(ids, { answer, dismiss = false, quiet = false }, by) {
  const done = [];
  for (const id of ids) {
    if (!PENDING_ID_RE.test(String(id))) continue;
    const q = (await adbQuery("SELECT FROM WorkerQuestion WHERE id = :id AND status = 'open'", { id }))[0];
    if (!q) continue;
    const now = new Date().toISOString();
    await adbCommand("UPDATE WorkerQuestion SET status = :s, answer = :a, answered_by = :u, answered_at = :now WHERE id = :id", "sql", {
      s: dismiss ? "dismissed" : "answered",
      a: String(answer ?? "").slice(0, 2000),
      u: by,
      now,
      id,
    });
    const left = Number((await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: q.job_id }))[0]?.n ?? 0);
    if (dismiss) {
      // nothing to resume with: the thread is done once nothing else waits
      if (!left) await adbCommand("UPDATE Job SET status = 'done', updated_at = :now WHERE id = :id AND status = 'waiting'", "sql", { now, id: q.job_id });
    } else if (!quiet) {
      await resumeThread(q.job_id, { question: q.question, answer, answered_by: by });
    }
    done.push(id);
  }
  return { answered: done.length, ids: done };
}

/** workers' proposals: queued writes from a thread, with its reason */
async function listProposals() {
  const rows = await adbQuery("SELECT id, kind, payload, requested_by, created_at, note, job_id, home FROM PendingWrite WHERE status = 'pending' AND job_id IS NOT NULL ORDER BY created_at ASC LIMIT 100").catch(() => []);
  const out = [];
  for (const r of rows) {
    const job = (await adbQuery("SELECT agent_id, payload FROM Job WHERE id = :id", { id: r.job_id }).catch(() => []))[0];
    const rid = JSON.parse(job?.payload || "{}").rid;
    const entry = RID_RE.test(String(rid)) ? (await adbQuery(`SELECT name FROM ${rid}`).catch(() => []))[0]?.name : null;
    out.push({ id: r.id, kind: r.kind, change: String(r.payload).slice(0, 2000), reason: r.note ?? "", proposed_by: r.requested_by, created_at: r.created_at, entry, agent_id: job?.agent_id ?? null });
  }
  return out;
}

/**
 * A thread with a question or proposal waiting is stopped until the admin
 * decides: graph-rag refuses its further changes (the model may not stop by
 * itself). Reading still works; the turn should end.
 */
async function assertNotWaiting(identity) {
  const job = identity.role?.kind === "worker" ? identity.role.job : null;
  if (!job) return;
  const q = Number((await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: job }).catch(() => []))[0]?.n ?? 0);
  const p = Number((await adbQuery("SELECT count(*) AS n FROM PendingWrite WHERE job_id = :id AND status = 'pending'", { id: job }).catch(() => []))[0]?.n ?? 0);
  if (q || p) throw new Error(`You're waiting on the admin (${q ? "your question" : "your proposal"}): nothing more changes until they decide. End your turn now with a short report; you're resumed in this conversation with their answer.`);
}

/** what a proposal tells the thread: it stops here */
const PROPOSED_NOTE = "Proposed: nothing changes until the admin decides. End your turn now with a short report; you're resumed in this conversation with the decision.";

/** a worker's direct changes, kept on its thread (the audit view lists them) */
async function logChange(identity, change) {
  const job = identity.role?.job;
  if (!job) return;
  const row = (await adbQuery("SELECT changes FROM Job WHERE id = :id", { id: job }).catch(() => []))[0];
  const list = JSON.parse(row?.changes || "[]");
  list.push({ ...change, at: new Date().toISOString() });
  await adbCommand("UPDATE Job SET changes = :c WHERE id = :id", "sql", { c: JSON.stringify(list.slice(-100)), id: job }).catch(() => {});
}

/**
 * A worker thread's upsert. It applies directly (with the derived-data floor
 * like anyone's writes: what it read elsewhere holds them where both are
 * visible), unless the worker judges it a large change and sets propose:
 * then it's a proposal and the thread waits for the admin.
 */
async function workerUpsert(args, identity, scope) {
  await assertNotWaiting(identity);
  for (const e of args.entities) {
    const clash = await thingNamed(e.name);
    if (clash) throw new Error(thingClash(e.name, { ...clash, rid: String(clash.rid) }));
  }
  const own = (await adbQuery(`SELECT name, _origin FROM ${identity.role.entry}`).catch(() => []))[0];
  const now = Date.now();
  const entities = args.entities.map((e) => {
    const v = parseValidUntil(e.valid_until, now);
    return v === undefined ? e : { ...e, valid_until: v.valid_until ?? "lasting" };
  });
  // where each lands: the home asked for; else an existing entry's own home (it's updated where it
  // lives, never copied next to it); else the worker's own entry's
  const asked = args.home === undefined ? undefined : resolveWriteHome(scope, args.home, { everyoneOk: (await threadAudience(identity)) === EVERYONE });
  const byHome = new Map();
  for (const e of entities) {
    let home = asked;
    if (home === undefined) {
      const found = await adbQuery(`SELECT @rid AS rid, _origin FROM ${ENTITY_LABEL} WHERE name = :n AND ${ENTRY_KINDS} LIMIT 2`, { n: e.name }).catch(() => []);
      // two entries by this name: which one is meant isn't for a guess (update_entry takes the id)
      if (found.length > 1) await findEntry(e.name);
      home = found.length === 1 && found[0]._origin ? found[0]._origin : (own?._origin ?? positionMap.root);
    }
    if (!byHome.has(home)) byHome.set(home, []);
    byHome.get(home).push(e);
  }
  const results = [];
  for (const [home, list] of byHome) {
    const lift = workerLift(identity, home);
    if (lift && !args.propose) throw new Error(liftRefusal(list.map((e) => e.name).join(", "), lift));
    // proposed past the floor: an admin who approves it writes it where it lives
    const write = { entities: list, home, floor: lift ? lift.home : derivedFloor(identity, home), written_at: new Date(now).toISOString(), from_worker: true };
    if (args.propose) {
      results.push({ ...(await queueWrite({ kind: "upsert", payload: JSON.stringify(write), user: identity.user, home, ...proposalFields(identity, args.reason) })), note: PROPOSED_NOTE });
      continue;
    }
    results.push(await upsertEntities(write));
  }
  if (!args.propose) await logChange(identity, { kind: "upsert", entries: entities.map((e) => e.name), ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return results.length === 1 ? results[0] : { results };
}

/** who a task thread writes for: "everyone" when the admin started its survey for everyone */
async function threadAudience(identity) {
  const job = identity.role?.job;
  if (!job) return null;
  const row = (await adbQuery("SELECT payload FROM Job WHERE id = :id", { id: job }).catch(() => []))[0];
  return JSON.parse(row?.payload || "{}").audience ?? null;
}

/** a worker links its own entry to things (the same resolution as the one-call step; unsure matches come back to it) */
async function workerLink(args, identity) {
  await assertNotWaiting(identity);
  // its own entry by default; or another entry it names (a table's entry listing its records)
  const rid = args.entry ? String((await findEntry(args.entry)).rid) : identity.role.entry;
  const row = (await adbQuery(`SELECT _home FROM ${rid}`).catch(() => []))[0];
  if (!row) throw new Error("that entry is gone");
  const mentions = parseMentions(JSON.stringify({ things: args.things.map(bareThing) }), 25);
  const linked = await linkMentions(rid, mentions, effectiveHome(positionMap, row._home), { unsure: "skip" });
  await adbCommand(`UPDATE ${rid} SET _mentions_at = :now`, "sql", { now: new Date().toISOString() });
  const done = linked.filter((l) => !l.unsure && !l.skipped);
  if (done.length) {
    const created = done.filter((l) => l.created).length;
    await logChange(identity, {
      kind: "link",
      detail: `${args.entry ? `"${args.entry}": ` : ""}${done.length > 6 ? `${done.length} things (${created} new)` : done.map((l) => `${l.name} (${l.type}${l.created ? ", new" : ""})`).join(", ")}`,
    });
  }
  return {
    linked,
    ...(linked.some((l) => l.unsure)
      ? { note: "Unsure ones weren't linked: they may be an existing thing. Check with about_thing, then link the existing name, merge, or ask." }
      : {}),
  };
}

/** a worker removes links it judges wrong (from its entry by default, or the entry it names) */
async function workerUnlink(args, identity) {
  await assertNotWaiting(identity);
  const rid = args.entry ? String((await findEntry(args.entry)).rid) : identity.role.entry;
  const edges = await adbQuery(`SELECT @rid AS edge, @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`).catch(() => []);
  const out = [];
  for (const ref of args.things) {
    const t = await findThing(ref);
    if (!t) {
      out.push({ name: ref.name, skipped: "no single thing by that name, type or key" });
      continue;
    }
    const e = edges.filter((x) => String(x.dst) === String(t.rid));
    for (const x of e) if (RID_RE.test(String(x.edge))) await adbCommand(`DELETE FROM ${x.edge}`);
    out.push({ name: t.label, [e.length ? "unlinked" : "wasnt_linked"]: true });
  }
  const done = out.filter((o) => o.unlinked);
  if (done.length) await logChange(identity, { kind: "unlink", detail: `${args.entry ? `"${args.entry}": ` : ""}${done.map((o) => o.name).join(", ")}`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return { results: out };
}

/** a worker deletes a stray thing nothing refers to any more (anything still linked is merged or unlinked first) */
async function workerDeleteThing(args, identity) {
  await assertNotWaiting(identity);
  const t = await findThing(args);
  if (!t) throw new Error(`no single thing called "${args.name}"${args.type ? ` (${args.type})` : ""}: give its type or key`);
  const about = Number((await adbQuery(`SELECT count(*) AS n FROM (SELECT expand(inE('ABOUT')) FROM ${t.rid})`))[0]?.n ?? 0);
  const rel = Number((await adbQuery(`SELECT count(*) AS n FROM (SELECT expand(bothE('RELATES')) FROM ${t.rid})`))[0]?.n ?? 0);
  if (about || rel) throw new Error(`"${t.label}" is still linked from ${about} entr${about === 1 ? "y" : "ies"} and has ${rel} relationship(s): unlink or merge it first`);
  await adbCommand(`DELETE FROM ${t.rid}`);
  await logChange(identity, { kind: "delete", detail: `${t.label} (${t._thing_type})`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return { deleted: t.label };
}

/** a thing's full name ("Toro (customer)", as searches show it) is its name and type */
function bareThing(t) {
  const m = splitThingName(t?.name);
  return m ? { ...t, name: m.name, type: t.type ?? m.type } : t;
}

/**
 * An entry write naming a thing ("CNC 2 (machine)", or a bare "CNC 2" with
 * no entry of that name yet) would make a copy beside the thing: the thing it
 * clashes with, or null.
 */
async function thingNamed(name) {
  const full = splitThingName(name);
  const n = normalize(full ? full.name : name);
  const things = await adbQuery(
    `SELECT @rid AS rid, label, _thing_type FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (name = :full OR _norm = :n OR _alias_norms CONTAINS :n)${full ? " AND _thing_type = :t" : ""} LIMIT 1`,
    { full: name, n, t: full?.type },
  ).catch(() => []);
  if (!things.length) return null;
  if (full) return things[0];
  const entry = await adbQuery(`SELECT @rid FROM ${ENTITY_LABEL} WHERE name = :n AND ${ENTRY_KINDS} LIMIT 1`, { n: name }).catch(() => []);
  return entry.length ? null : things[0];
}

/** a worker corrects a thing's name (a work center stored as "cnc" that is "CNC 2"); the old name stays an alias */
async function workerRenameThing(args, identity) {
  await assertNotWaiting(identity);
  const t = await findThing(args.thing);
  if (!t) throw new Error(`no single thing called "${args.thing.name}"${args.thing.type ? ` (${args.thing.type})` : ""}: give its type or key`);
  const label = String(args.name).replace(/\s+/g, " ").trim();
  const n = normalize(label);
  if (n.length < 1) throw new Error("a name is needed");
  const row = (await adbQuery(`SELECT _norm, _alias_norms FROM ${t.rid}`))[0];
  if (row?._norm === n && t.label === label) return { already: true, name: thingName(t._thing_type, label) };
  const other = (await adbQuery(`SELECT @rid AS rid, label FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = :t AND (_norm = :n OR _alias_norms CONTAINS :n) LIMIT 2`, { t: t._thing_type, n }).catch(() => [])).find(
    (o) => String(o.rid) !== String(t.rid),
  );
  if (other) throw new Error(`another ${t._thing_type} is already called that (${other.label}, ${other.rid}): if they're the same, merge_things instead`);
  const [vec] = await embedBatch([`${t._thing_type}: ${label}`]);
  const aliases = [...new Set([...(row?._alias_norms ?? []), row?._norm].filter((a) => a && a !== n))];
  await adbCommand(`UPDATE ${t.rid} SET name = :name, label = :label, _norm = :n, _alias_norms = :a, embed_thing = [${vec.join(",")}], updated_at = :now`, "sql", {
    name: thingName(t._thing_type, label),
    label,
    n,
    a: aliases,
    now: new Date().toISOString(),
  });
  await logChange(identity, { kind: "rename", detail: `${t.label} -> ${label} (${t._thing_type})`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return { renamed: true, from: t.label, to: thingName(t._thing_type, label), aliases };
}

/** one thing by key, or by name/alias and type; null when there's none (or several) */
async function findThing(ref) {
  const t = bareThing(ref);
  const key = normalizeKey(t.key);
  if (key) {
    const k = (await adbQuery(`SELECT @rid AS rid, label, _thing_type, _homes FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _keys CONTAINS :k LIMIT 1`, { k: key }))[0];
    if (k) return k;
  }
  const n = normalize(t.name);
  const rows = await adbQuery(
    `SELECT @rid AS rid, label, _thing_type, _homes FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (_norm = :n OR _alias_norms CONTAINS :n)${t.type ? " AND _thing_type = :t" : ""} LIMIT 2`,
    { n, t: t.type },
  );
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Relationships between things (a job is for a customer, an employee works
 * in a work center), with the evidence. A relationship shows only to someone
 * who can see both things.
 */
async function workerRelate(args, identity) {
  await assertNotWaiting(identity);
  const out = [];
  for (const r of args.relations) {
    const rel = normalizeRel(r.rel);
    if (!rel) {
      out.push({ ...r, skipped: "no relationship verb" });
      continue;
    }
    const from = await findThing(r.from);
    const to = await findThing(r.to);
    if (!from || !to) {
      out.push({ from: r.from.name, rel, to: r.to.name, skipped: `no single thing called "${!from ? r.from.name : r.to.name}": link it to an entry first (link_things), or give its type or key` });
      continue;
    }
    if (String(from.rid) === String(to.rid)) {
      out.push({ from: from.label, rel, to: to.label, skipped: "a thing and itself" });
      continue;
    }
    const existing = await adbQuery(`SELECT @in AS dst, rel FROM (SELECT expand(outE('RELATES')) FROM ${from.rid})`).catch(() => []);
    if (existing.some((e) => String(e.dst) === String(to.rid) && e.rel === rel)) {
      out.push({ from: from.label, rel, to: to.label, already: true });
      continue;
    }
    await adbCommand(`CREATE EDGE RELATES FROM ${from.rid} TO ${to.rid} SET rel = :rel, evidence = :ev, job = :job, at = :now`, "sql", {
      rel,
      ev: String(r.evidence ?? "").slice(0, 400),
      job: identity.role.job,
      now: new Date().toISOString(),
    });
    out.push({ from: from.label, rel, to: to.label, related: true });
  }
  const made = out.filter((o) => o.related);
  if (made.length) await logChange(identity, { kind: "relate", detail: made.length > 6 ? `${made.length} relationships` : made.map((o) => `${o.from} ${o.rel} ${o.to}`).join("; ") });
  return { relations: out };
}

/**
 * A task thread: not one saved entry but a piece of work (a survey of a
 * connection, a follow-up a survey queued). Its "entry" is a task entry
 * (_kind 'task', at the root: only the admin sees it) that holds its brief
 * and, once done, what it found.
 */
async function createTask({ title, brief, minutes, parent, from, by, audience, entries, level }) {
  const name = String(title).replace(/\s+/g, " ").trim().slice(0, 120);
  if (name.length < 4) throw Object.assign(new Error("a task needs a title"), { status: 400 });
  const now = new Date().toISOString();
  await adbCommand(
    `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, _kind = 'task', _home = :root, _origin = :root, text_identity = :brief, _task_by = :taskby, updated_at = :now`,
    "sql",
    { name, root: positionMap.root, brief: String(brief).slice(0, 6000), taskby: by ?? "", now },
  );
  const rid = String((await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE name = :name AND _kind = 'task' ORDER BY @rid DESC LIMIT 1`, { name }))[0]?.rid);
  const job = await enqueue(
    "review",
    { rid, task: { title: name, brief: String(brief).slice(0, 6000) }, minutes: Math.max(5, Math.min(180, Number(minutes) || 60)), ...(parent ? { parent } : {}), ...(from ? { from } : {}), ...(audience === EVERYONE ? { audience } : {}), ...(entries?.length ? { entries } : {}), ...(level ? { level: Math.max(1, Math.min(3, Number(level))) } : {}) },
    { key: `task:${rid}`, priority: 3 },
  );
  return { task: name, job };
}

/** a worker queues follow-up work (a survey fanning out by topic); a few per thread */
async function workerFollowup(args, identity) {
  await assertNotWaiting(identity);
  const queued = Number((await adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'review' AND (payload LIKE :p OR payload LIKE :f)", { p: `%"parent":"${identity.role.job}"%`, f: `%"from":"${identity.role.job}"%` }))[0]?.n ?? 0);
  // a master's worker's follow-ups report to the master too
  const own = JSON.parse((await adbQuery("SELECT payload FROM Job WHERE id = :id", { id: identity.role.job }))[0]?.payload || "{}");
  if (queued >= 20) throw new Error("this thread already queued 20 follow-ups: finish with what's queued");
  // follow-ups write for whoever their survey wrote for
  const r = await createTask({
    title: args.title,
    brief: args.brief,
    minutes: args.minutes,
    parent: own.parent === MASTER ? MASTER : identity.role.job,
    from: identity.role.job,
    by: identity.user,
    audience: await threadAudience(identity),
    level: Number(args.level) || own.level,
  });
  await logChange(identity, { kind: "followup", detail: r.task });
  return { ...r, note: "Queued: another thread does it. Don't wait for it." };
}

/** a worker merges two things (by name): directly, or as a proposal when it judges it consequential */
async function workerMerge(args, identity, scope) {
  await assertNotWaiting(identity);
  const find = async (name, type) =>
    (
      await adbQuery(
        `SELECT @rid AS rid, label, _thing_type FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (_norm = :n OR _alias_norms CONTAINS :n)${type ? " AND _thing_type = :t" : ""}${homeFilter(scope)} LIMIT 2`,
        { n: normalize(name), t: type },
      )
    )[0];
  const keep = await find(args.keep, args.type);
  const drop = await find(args.drop, args.type);
  if (!keep || !drop) throw new Error(`no thing called "${!keep ? args.keep : args.drop}"${args.type ? ` (${args.type})` : ""}`);
  if (String(keep.rid) === String(drop.rid)) throw new Error("those are the same thing already");
  if (keep._thing_type !== drop._thing_type) throw new Error(`different types (${keep._thing_type}, ${drop._thing_type}): not merged`);
  const payload = { keep: String(keep.rid), drop: String(drop.rid), keep_name: keep.label, drop_name: drop.label, type: keep._thing_type };
  if (args.propose) {
    return { ...(await queueWrite({ kind: "merge", payload: JSON.stringify(payload), user: identity.user, home: positionMap.root, ...proposalFields(identity, args.reason) })), note: PROPOSED_NOTE };
  }
  const result = await mergeThings(payload);
  await logChange(identity, { kind: "merge", detail: `"${drop.label}" into "${keep.label}" (${keep._thing_type})`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return result;
}

const ENTRY_KINDS = "(_kind IS NULL OR _kind IN ['document', 'section', 'task'])";

/** an entry by its id ("#1:352258") or its name; when several share the name, the id is needed */
async function findEntry(ref) {
  const id = entryId(ref);
  if (id) {
    const row = (await adbQuery(`SELECT @rid AS rid, name, _home, _origin FROM ${id} WHERE name IS NOT NULL AND ${ENTRY_KINDS}`).catch(() => []))[0];
    if (!row) throw new Error(`no entry ${id}`);
    return row;
  }
  const rows = await adbQuery(`SELECT @rid AS rid, name, _home, _origin, updated_at FROM ${ENTITY_LABEL} WHERE name = :n AND ${ENTRY_KINDS} LIMIT 6`, { n: String(ref) });
  if (!rows.length) throw new Error(`no entry called "${ref}"`);
  if (rows.length > 1) {
    for (const r of rows) {
      r.home = homeName(positionMap, r._home);
      r.links = Number((await adbQuery(`SELECT count(*) AS n FROM (SELECT expand(outE('ABOUT')) FROM ${r.rid})`).catch(() => []))[0]?.n ?? 0);
    }
    throw new Error(duplicateEntries(String(ref), rows.map((r) => ({ ...r, rid: String(r.rid) }))));
  }
  return rows[0];
}

/**
 * A worker folds a duplicate entry into the one it duplicates: the drop's
 * links move to the keep, then the drop is deleted. Direct when both live at
 * the same home; otherwise a proposal (the drop's audience would lose it, the
 * keep's would gain its links).
 */
async function workerFoldEntries(args, identity) {
  await assertNotWaiting(identity);
  const keep = await findEntry(args.keep);
  const drop = await findEntry(args.drop);
  if (String(keep.rid) === String(drop.rid)) throw new Error("those are the same entry");
  if (String(drop.rid) === identity.role.entry) throw new Error("that's your own entry: fold the other into it instead");
  const payload = { keep: String(keep.rid), drop: String(drop.rid), keep_name: keep.name, drop_name: drop.name };
  const sameHome = effectiveHome(positionMap, keep._home) === effectiveHome(positionMap, drop._home);
  if (args.propose || !sameHome) {
    const why = sameHome ? args.reason : `${args.reason ? `${args.reason} ` : ""}(${homeName(positionMap, drop._home)} -> ${homeName(positionMap, keep._home)})`;
    return { ...(await queueWrite({ kind: "fold", payload: JSON.stringify(payload), user: identity.user, home: positionMap.root, ...proposalFields(identity, why) })), note: sameHome ? PROPOSED_NOTE : `The two live at different homes, so this is a proposal. ${PROPOSED_NOTE}` };
  }
  const result = await foldEntries(payload);
  await logChange(identity, { kind: "fold", detail: `${drop.rid} "${drop.name}" into ${keep.rid} "${keep.name}" (${result.moved} link${result.moved === 1 ? "" : "s"} moved)`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return result;
}

/** fold an entry into another: its ABOUT links move (the things seen from the keep's home), then it's deleted */
async function foldEntries({ keep, drop }) {
  if (!RID_RE.test(String(keep)) || !RID_RE.test(String(drop))) throw new Error("invalid fold");
  const k = (await adbQuery(`SELECT _home FROM ${keep} WHERE ${ENTRY_KINDS}`))[0];
  const d = (await adbQuery(`SELECT name FROM ${drop} WHERE ${ENTRY_KINDS}`))[0];
  if (!k || !d) throw new Error("one of the entries is gone");
  const edges = await adbQuery(`SELECT @in AS dst, role FROM (SELECT expand(outE('ABOUT')) FROM ${drop})`).catch(() => []);
  const home = effectiveHome(positionMap, k._home);
  let moved = 0;
  for (const e of edges) {
    const dst = String(e.dst);
    if (!RID_RE.test(dst)) continue;
    await aboutOnce(keep, dst, e.role ?? "mentions");
    await thingSeenFrom(dst, home);
    moved++;
  }
  await adbCommand(`DELETE FROM ${ENTITY_LABEL} WHERE @rid = ${drop}`);
  await refreshGrants();
  return { folded: true, kept: keep, deleted: drop, moved };
}

/**
 * A worker deletes an entry by id or name: directly when nothing links it
 * and it links nothing (a stray copy its own write made); otherwise a
 * proposal. Its text is kept in the thread's change log.
 */
async function workerDeleteEntry(args, identity) {
  await assertNotWaiting(identity);
  const row = await findEntry(args.entry);
  const rid = String(row.rid);
  if (rid === identity.role.entry) throw new Error("that's your own entry");
  const full = (await adbQuery(`SELECT * FROM ${rid}`))[0] ?? {};
  if (full._kind === "task") throw new Error("a task entry isn't deleted: it's the record of a thread's work");
  const edges = Number((await adbQuery(`SELECT count(*) AS n FROM (SELECT expand(bothE()) FROM ${rid})`))[0]?.n ?? 0);
  const text = Object.keys(full).filter((k) => k.startsWith("text_") && full[k]).map((k) => `${k.slice(5)}: ${full[k]}`).join(" | ").slice(0, 400);
  if (args.propose || edges > 0) {
    return {
      ...(await queueWrite({ kind: "delete_entry", payload: JSON.stringify({ rid, name: row.name, home: row._home ?? null, text }), user: identity.user, home: positionMap.root, ...proposalFields(identity, args.reason) })),
      note: edges > 0 ? `It has ${edges} link(s), so deleting it is a proposal (fold it into the copy it duplicates with merge_entries instead, if that's what it is). ${PROPOSED_NOTE}` : PROPOSED_NOTE,
    };
  }
  const result = await deleteEntry({ rid });
  await logChange(identity, { kind: "delete", detail: `entry ${rid} "${row.name}"${text ? ` (${text.slice(0, 200)})` : ""}`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return result;
}

/** delete an entry (approved, or a stray nothing links) */
async function deleteEntry({ rid }) {
  if (!RID_RE.test(String(rid))) throw new Error("invalid entry");
  const row = (await adbQuery(`SELECT name, _kind FROM ${rid} WHERE name IS NOT NULL AND ${ENTRY_KINDS}`))[0];
  if (!row) throw new Error("that entry is gone");
  if (row._kind === "task") throw new Error("a task entry isn't deleted");
  await adbCommand(`DELETE FROM ${ENTITY_LABEL} WHERE @rid = ${rid}`);
  await refreshGrants();
  return { deleted: rid, name: row.name };
}

/**
 * A typed record (a Database, a Host: another type than entries) is
 * corrected in place, not upserted (that would make an entry beside it).
 * Directly when what the worker read can be seen wherever the record is;
 * otherwise a proposal.
 */
async function typedUpdate(row, type, args, identity) {
  if (args.valid_until !== undefined) throw new Error(`"${row.name}" is a ${type} record: it has no end date; set properties or facets`);
  const change = typedChange(args);
  const home = effectiveHome(positionMap, row._home);
  const floor = derivedFloor(identity, home);
  const payload = { rid: String(row.rid), name: row.name, type, ...change };
  if (args.propose || (floor !== undefined && floor !== home)) {
    return {
      ...(await queueWrite({ kind: "typed_update", payload: JSON.stringify(payload), user: identity.user, home: positionMap.root, ...proposalFields(identity, args.reason) })),
      note: args.propose ? PROPOSED_NOTE : `What you read reaches fewer people than this record does, so the correction is a proposal. ${PROPOSED_NOTE}`,
    };
  }
  const result = await applyTypedUpdate(payload);
  await logChange(identity, { kind: "update", detail: `${row.rid} "${row.name}" (${type}): ${[...Object.keys(change.properties), ...Object.keys(change.facets).map((f) => `${f} facet`)].join(", ")}`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return result;
}

/** the fields a typed correction may set: plain names and values only */
function typedChange(args) {
  const properties = {};
  for (const [k, v] of Object.entries(args.properties ?? {})) {
    if (!PROP_RE.test(k) || k === "name") throw new Error(`can't set "${k}"`);
    if (["string", "number", "boolean"].includes(typeof v)) properties[k] = v;
  }
  const facets = {};
  for (const [f, text] of Object.entries(args.facets ?? {})) if (typeof text === "string" && text.trim()) facets[sanitizeFacet(f)] = text.slice(0, 4000);
  if (!Object.keys(properties).length && !Object.keys(facets).length) throw new Error("nothing to change");
  return { properties, facets };
}

/** apply a typed record's correction (direct, or approved) */
async function applyTypedUpdate({ rid, properties, facets }) {
  if (!RID_RE.test(String(rid))) throw new Error("invalid record");
  if (!(await adbQuery(`SELECT @rid FROM ${rid}`).catch(() => [])).length) throw new Error("that record is gone");
  const sets = [];
  const params = { now: new Date().toISOString() };
  for (const [i, [k, v]] of Object.entries(properties ?? {}).entries()) {
    if (!PROP_RE.test(k)) throw new Error(`can't set "${k}"`);
    sets.push(`${k} = :p${i}`);
    params[`p${i}`] = v;
  }
  const list = Object.entries(facets ?? {});
  const vecs = list.length ? await embedBatch(list.map(([, t]) => t)) : [];
  for (const [i, [f, text]] of list.entries()) {
    const facet = sanitizeFacet(f);
    sets.push(`text_${facet} = :f${i}`, `embed_${facet} = [${vecs[i].join(",")}]`);
    params[`f${i}`] = text;
  }
  await adbCommand(`UPDATE ${rid} SET ${[...sets, "updated_at = :now"].join(", ")}`, "sql", params);
  return { updated: rid, properties: Object.keys(properties ?? {}), facets: list.map(([f]) => f) };
}

/** a worker removes relationships it judges wrong (all of them between the two when no verb is given) */
async function workerUnrelate(args, identity) {
  await assertNotWaiting(identity);
  const out = [];
  for (const r of args.relations) {
    const rel = r.rel ? normalizeRel(r.rel) : null;
    const from = await findThing(r.from);
    const to = await findThing(r.to);
    if (!from || !to) {
      out.push({ from: r.from.name, rel, to: r.to.name, skipped: `no single thing called "${!from ? r.from.name : r.to.name}": give its type or key` });
      continue;
    }
    const edges = (await adbQuery(`SELECT @rid AS edge, @in AS dst, rel FROM (SELECT expand(outE('RELATES')) FROM ${from.rid})`).catch(() => [])).filter(
      (e) => String(e.dst) === String(to.rid) && (!rel || e.rel === rel),
    );
    for (const e of edges) if (RID_RE.test(String(e.edge))) await adbCommand(`DELETE FROM ${e.edge}`);
    out.push({ from: from.label, rel: rel ?? edges.map((e) => e.rel).join(", "), to: to.label, ...(edges.length ? { removed: edges.length } : { wasnt_related: true }) });
  }
  const done = out.filter((o) => o.removed);
  if (done.length) await logChange(identity, { kind: "unrelate", detail: done.map((o) => `${o.from} ${o.rel} ${o.to}`).join("; "), ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return { relations: out };
}

/**
 * A worker corrects an entry it names by id or name (a stale version, a wrong
 * field, a facet's text): the same write as an upsert, at that entry's own
 * origin, with the derived-data floor.
 */
async function workerUpdateEntry(args, identity) {
  await assertNotWaiting(identity);
  const row = await findEntry(args.entry);
  if (!args.properties && !args.facets && args.valid_until === undefined) throw new Error("nothing to change: give properties, facets or valid_until");
  const type = String((await adbQuery(`SELECT @type AS t FROM ${row.rid}`))[0]?.t ?? ENTITY_LABEL);
  if (type !== ENTITY_LABEL && !type.startsWith(`${ENTITY_LABEL}~`)) return typedUpdate(row, type, args, identity);
  const origin = row._origin ?? positionMap.root;
  const twins = Number((await adbQuery(`SELECT count(*) AS n FROM ${ENTITY_LABEL} WHERE name = :n AND _origin = :o`, { n: row.name, o: origin }))[0]?.n ?? 0);
  if (twins > 1) throw new Error(`${twins} entries are called "${row.name}" at the same home: fold the duplicate first (merge_entries), then update the one left`);
  const entity = { name: row.name, ...(args.properties ? { properties: args.properties } : {}), ...(args.facets ? { facets: args.facets } : {}), ...(args.valid_until !== undefined ? { valid_until: args.valid_until } : {}) };
  const now = Date.now();
  const v = parseValidUntil(entity.valid_until, now);
  if (v !== undefined) entity.valid_until = v.valid_until ?? "lasting";
  const lift = workerLift(identity, row._home ?? origin) ?? workerLift(identity, origin);
  if (lift && !args.propose) throw new Error(liftRefusal(row.name, lift));
  const write = { entities: [entity], home: origin, floor: lift ? origin : derivedFloor(identity, origin), written_at: new Date(now).toISOString(), from_worker: true };
  if (args.propose) return { ...(await queueWrite({ kind: "upsert", payload: JSON.stringify(write), user: identity.user, home: origin, ...proposalFields(identity, args.reason) })), note: PROPOSED_NOTE };
  const result = await upsertEntities(write);
  const changed = [...Object.keys(args.properties ?? {}), ...Object.keys(args.facets ?? {}).map((f) => `${f} facet`), ...(args.valid_until !== undefined ? ["valid_until"] : [])];
  await logChange(identity, { kind: "update", detail: `${row.rid} "${row.name}": ${changed.join(", ")}`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return result;
}

/** ---- triage (see decisions.js): what a saved entry needs, decided before the master sees it ---- */

const decisionConfig = () => ({ url: DECISION_URL, key: DECISION_API_KEY, model: DECISION_MODEL });

async function ensureTriageSchema() {
  await adbCommand("CREATE DOCUMENT TYPE Triage IF NOT EXISTS").catch(() => {});
  for (const prop of ["id", "rid", "name", "reason", "verdict", "outcome", "model", "created_at"]) await adbCommand(`CREATE PROPERTY Triage.${prop} IF NOT EXISTS STRING`).catch(() => {});
  for (const prop of ["level"]) await adbCommand(`CREATE PROPERTY Triage.${prop} IF NOT EXISTS INTEGER`).catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON Triage (name) NOTUNIQUE").catch(() => {});
}

/**
 * A linked entry joins the next batch, triaged first when a decision model
 * is configured: confident name choices are linked now; an entry that needs
 * nothing stays out of the batch (but for a small sample); the rest go with
 * their level and reason.
 */
async function intakeWithTriage(rid, row, linked, home) {
  const plain = linked.filter((l) => l.unsure).map((l) => `"${l.name}" (${l.type}) may be ${l.unsure}`);
  if (!DECISION_API_KEY) return void (await enqueue("intake", { rid, unsure: plain }, { key: `intake:${rid}` }));
  // the names linking couldn't settle, with what each candidate is
  const unsure = [];
  for (const u of linked.filter((l) => l.unsure && l.candidates?.length)) {
    const cands = await adbQuery(`SELECT @rid AS rid, label, _thing_type, _keys FROM [${u.candidates.filter((c) => RID_RE.test(String(c))).join(",")}]`).catch(() => []);
    const candidates = [];
    for (const c of cands) {
      const about = (await adbQuery(`SELECT name FROM (SELECT expand(in('ABOUT')) FROM ${c.rid}) WHERE name IS NOT NULL LIMIT 1`).catch(() => []))[0]?.name;
      candidates.push({ rid: String(c.rid), label: c.label, type: c._thing_type, detail: [(c._keys ?? [])[0], about ? `known from "${about}"` : ""].filter(Boolean).join("; ") });
    }
    if (candidates.length) unsure.push({ name: u.name, type: u.type, role: u.role, candidates });
  }
  // a few entries about the same things, to tell an update or a contradiction
  const dsts = (await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`).catch(() => [])).map((e) => String(e.dst)).filter((x) => RID_RE.test(x));
  const related = dsts.length
    ? (await adbQuery(`SELECT @rid AS rid, name, text_identity FROM (SELECT expand(in('ABOUT')) FROM [${dsts.slice(0, 6).join(",")}]) WHERE name IS NOT NULL AND text_identity IS NOT NULL LIMIT 8`).catch(() => []))
        .filter((r) => String(r.rid) !== rid)
        .slice(0, 3)
        .map((r) => ({ name: r.name, text: r.text_identity }))
    : [];
  const text = Object.keys(row).filter((k) => k.startsWith("text_") && row[k]).map((k) => row[k]).join(" ");
  let verdict = null;
  let model = null;
  try {
    const res = await askDecisionModel(decisionConfig(), triageRequest({ name: row.name, text }, unsure, related));
    if (res) {
      verdict = triageVerdict(res.answers, unsure);
      model = res.model;
    }
  } catch (e) {
    log.warn(`triage ${row.name}: ${String(e?.message ?? e).slice(0, 160)}`);
  }
  if (!verdict) return void (await enqueue("intake", { rid, unsure: plain }, { key: `intake:${rid}` }));
  // names it's confident about: linked now, the name kept as an alias
  for (const st of verdict.settled) {
    const u = unsure.find((x) => x.name === st.name);
    await thingSeenFrom(st.rid, home).catch(() => {});
    await aboutOnce(rid, st.rid, u?.role || "mentions").catch(() => {});
    const t = (await adbQuery(`SELECT _norm, _alias_norms FROM ${st.rid}`).catch(() => []))[0];
    const n = normalize(st.name);
    if (t && t._norm !== n && !(t._alias_norms ?? []).includes(n)) await adbCommand(`UPDATE ${st.rid} SET _alias_norms = :a`, "sql", { a: [...(t._alias_norms ?? []), n] }).catch(() => {});
  }
  await adbCommand("INSERT INTO Triage SET id = :id, rid = :rid, name = :name, level = :level, reason = :reason, verdict = :v, model = :m, created_at = :now", "sql", {
    id: randomUUID(),
    rid,
    name: row.name,
    level: verdict.level,
    reason: verdict.reason ?? "",
    v: JSON.stringify({ score: verdict.score, pNothing: verdict.pNothing, reasonP: verdict.reasonP, contradiction: verdict.contradiction, settled: verdict.settled.map((x) => ({ name: x.name, label: x.label, p: x.p })), open: verdict.open, sample: verdict.sample }),
    m: model ?? "",
    now: new Date().toISOString(),
  }).catch((e) => log.warn(`triage record: ${String(e).slice(0, 120)}`));
  if (!verdict.toMaster) return;
  await enqueue(
    "intake",
    {
      rid,
      unsure: verdict.open.map((o) => `"${o.name}" unsettled${o.pick ? ` (perhaps ${o.pick}, p ${o.p.toFixed(2)})` : ""}`),
      triage: { level: verdict.level, reason: verdict.reason, ...(verdict.sample ? { sample: true } : {}), ...(verdict.settled.length ? { settled: verdict.settled.map((x) => `"${x.name}" = ${x.label}`) } : {}) },
    },
    { key: `intake:${rid}` },
  );
}

/** what the worker then did with triaged entries: the labels triage is tuned on */
async function recordTriageOutcome(names, outcome) {
  for (const name of (names ?? []).slice(0, 25)) {
    const t = (await adbQuery("SELECT id FROM Triage WHERE name = :n ORDER BY created_at DESC LIMIT 1", { n: name }).catch(() => []))[0];
    if (t) await adbCommand("UPDATE Triage SET outcome = :o WHERE id = :id", "sql", { o: JSON.stringify(outcome), id: t.id }).catch(() => {});
  }
}

/** today's triage: entries by level, how many went to the master, names settled, and how its levels matched what workers did */
async function triageStats() {
  const day = new Date().toISOString().slice(0, 10);
  const rows = await adbQuery("SELECT level, verdict, outcome FROM Triage WHERE created_at >= :d LIMIT 5000", { d: day }).catch(() => []);
  const byLevel = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let settled = 0;
  let sampled = 0;
  const outcomes = { needed: 0, nothing_done: 0 };
  for (const r of rows) {
    byLevel[r.level] = (byLevel[r.level] ?? 0) + 1;
    const v = JSON.parse(r.verdict || "{}");
    settled += (v.settled ?? []).length;
    if (v.sample) sampled++;
    if (r.outcome) {
      const o = JSON.parse(r.outcome);
      if (o.changes > 0 || o.stopped) outcomes.needed++;
      else outcomes.nothing_done++;
    }
  }
  return { on: !!DECISION_API_KEY, model: DECISION_API_KEY ? DECISION_MODEL : null, today: rows.length, byLevel, settledNames: settled, sampled, outcomes };
}

/**
 * ---- the master (pool.master): a long-running thread plans batches of saved
 * entries and starts workers; graph-rag keeps its inbox (Signal), the batches
 * (Batch) and the handlers (Job kind "handler": one stopped worker each, which
 * the operator settles). Workers started by the master have parent MASTER.
 */
const MASTER = "master";

async function ensureMasterSchema() {
  // (BATCH is a reserved word in ArcadeDB SQL: the type is WorkBatch)
  for (const type of ["Signal", "WorkBatch"]) await adbCommand(`CREATE DOCUMENT TYPE ${type} IF NOT EXISTS`).catch(() => {});
  for (const prop of ["id", "kind", "job_id", "batch_id", "data", "status", "created_at"]) await adbCommand(`CREATE PROPERTY Signal.${prop} IF NOT EXISTS STRING`).catch(() => {});
  for (const prop of ["id", "entries", "status", "created_at"]) await adbCommand(`CREATE PROPERTY WorkBatch.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON Signal (status) NOTUNIQUE").catch(() => {});
}

async function emitSignal(kind, { job_id = null, batch_id = null, data = {} } = {}) {
  await adbCommand("INSERT INTO Signal SET id = :id, kind = :k, job_id = :j, batch_id = :b, data = :d, status = 'new', created_at = :now", "sql", {
    id: randomUUID(),
    k: kind,
    j: job_id,
    b: batch_id,
    d: JSON.stringify(data),
    now: new Date().toISOString(),
  });
}

/** a stopped worker's open questions and undecided proposals */
async function openItems(jobId) {
  const questions = await adbQuery("SELECT id, question, options FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: jobId }).catch(() => []);
  const proposals = await adbQuery("SELECT id, kind, note FROM PendingWrite WHERE job_id = :id AND status = 'pending'", { id: jobId }).catch(() => []);
  return {
    questions: questions.map((q) => ({ id: q.id, question: q.question, options: JSON.parse(q.options || "[]") })),
    proposals: proposals.map((p) => ({ id: p.id, kind: p.kind, reason: p.note ?? "" })),
  };
}

const openHandlers = async () => Number((await adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'handler' AND status IN ['pending', 'running', 'waiting']").catch(() => []))[0]?.n ?? 0);

/** the master's status: halted when too many stopped workers wait on the operator */
async function masterStatus() {
  const handlers = await openHandlers();
  const intake = Number((await adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'intake' AND status = 'pending'").catch(() => []))[0]?.n ?? 0);
  const signals = Number((await adbQuery("SELECT count(*) AS n FROM Signal WHERE status = 'new'").catch(() => []))[0]?.n ?? 0);
  return { on: !!worker.pool.master && worker.pool.poolSize > 0, handlers, maxHandlers: worker.pool.maxHandlers, halted: handlers >= worker.pool.maxHandlers, intake, signals };
}

/** a batch closes at batchSize entries or when its oldest has waited batchMinutes; not while halted */
async function batchTick() {
  const st = await masterStatus();
  if (!st.on || st.halted || !st.intake) return;
  const rows = await adbQuery("SELECT id, payload, created_at FROM Job WHERE kind = 'intake' AND status = 'pending' ORDER BY created_at ASC LIMIT " + Math.floor(worker.pool.batchSize));
  const oldest = Date.parse(rows[0]?.created_at ?? "");
  if (rows.length < worker.pool.batchSize && !(Date.now() - oldest >= worker.pool.batchMinutes * 60_000)) return;
  const batch = randomUUID();
  const entries = [];
  const taken = [];
  for (const r of rows) {
    const p = JSON.parse(r.payload || "{}");
    const row = RID_RE.test(String(p.rid)) ? (await adbQuery(`SELECT name, _home FROM ${p.rid}`).catch(() => []))[0] : null;
    taken.push(r.id);
    if (!row?.name) continue; // gone since it was saved
    const edges = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${p.rid})`).catch(() => []);
    const dsts = edges.map((e) => String(e.dst)).filter((x) => RID_RE.test(x));
    const things = dsts.length ? await adbQuery(`SELECT label, _thing_type FROM [${dsts.join(",")}]`).catch(() => []) : [];
    entries.push({ name: row.name, home: homeName(positionMap, row._home), links: things.map((t) => `${t.label} (${t._thing_type})`), unsure: p.unsure ?? [], ...(p.triage ? { triage: p.triage } : {}) });
  }
  // the batch and its signal first: entries leave the intake only once the master will hear of them
  if (entries.length) {
    await adbCommand("INSERT INTO WorkBatch SET id = :id, entries = :e, status = 'open', created_at = :now", "sql", { id: batch, e: JSON.stringify(entries.map((e) => e.name)), now: new Date().toISOString() });
    await emitSignal("batch", { batch_id: batch, data: { entries } });
  }
  for (const id of taken) await adbCommand("UPDATE Job SET status = 'done', summary = :b, updated_at = :now WHERE id = :id AND status = 'pending'", "sql", { b: `batch ${batch}`, now: new Date().toISOString(), id });
  if (!entries.length) return;
  log.info(`batch ${batch.slice(0, 8)}: ${entries.length} entries for the master`);
}

/** the master starts a worker: a task (a brief, the entries it's about), run by the pool */
async function masterStartWorker(args, identity) {
  const names = (args.entries ?? []).slice(0, 25);
  const brief = [String(args.brief), ...(names.length ? ["", `The entries this is about: ${names.map((n) => `"${n}"`).join(", ")} (read them in the graph).`] : [])].join("\n");
  // its level of work (which model runs it): the master's call, else the highest triage level among its entries, else an investigation
  let level = Number(args.level) || 0;
  if (!level && names.length) {
    for (const n of names) {
      const t = (await adbQuery("SELECT level FROM Triage WHERE name = :n ORDER BY created_at DESC LIMIT 1", { n }).catch(() => []))[0];
      level = Math.max(level, Number(t?.level ?? 0));
    }
  }
  const r = await createTask({ title: args.title, brief, minutes: args.minutes, parent: MASTER, by: identity.user, audience: args.audience === "everyone" ? EVERYONE : undefined, entries: names, level: level || 2 });
  return { ...r, note: "Started: you'll get a signal when it's done or stopped." };
}

/** one worker's situation, for the master or its handler */
async function workerSituation(jobId) {
  if (!JOB_ID_RE.test(String(jobId))) throw new Error("which worker (its job id)");
  const job = (await adbQuery("SELECT status, payload, summary, changes, agent_id, updated_at FROM Job WHERE id = :id AND kind = 'review'", { id: jobId }))[0];
  if (!job) throw new Error(`no worker ${jobId}`);
  const p = JSON.parse(job.payload || "{}");
  return {
    job: jobId,
    title: p.task?.title ?? null,
    status: job.status,
    brief: String(p.task?.brief ?? "").slice(0, 3000),
    report: String(job.summary ?? "").slice(0, 3000),
    changes: JSON.parse(job.changes || "[]").slice(-30),
    ...(await openItems(jobId)),
  };
}

/** the master (or a handler, on the operator's word) answers a stopped worker: it resumes with the message */
async function answerWorker(jobId, answer, by) {
  const items = await openItems(jobId);
  if (items.questions.length) await answerQuestions(items.questions.map((q) => q.id), { answer, quiet: true }, by);
  await resumeThread(jobId, { message: String(answer).slice(0, 3000), answered_by: by });
  return { resumed: true, answered: items.questions.length };
}

/** raw commands and widening who sees something are the operator's, whatever the master thinks */
async function needsOperator(id) {
  const rec = (await adbQuery("SELECT kind, payload FROM PendingWrite WHERE id = :id", { id }))[0];
  if (!rec) return null;
  if (rec.kind === "command") return "a raw command";
  if (rec.kind === "rehome") {
    const m = JSON.parse(rec.payload);
    if (moveKind(positionMap, m.from, m.to) === "widen") return "widening who sees something";
  }
  return null;
}

/** the master closes a worker it won't pursue: questions dismissed, proposals rejected, no resume */
async function closeWorker(jobId, summary, identity) {
  await adbCommand("UPDATE Job SET status = 'closed', summary = :s, updated_at = :now WHERE id = :id AND kind = 'review'", "sql", { s: String(summary ?? "closed by the master").slice(0, 2000), now: new Date().toISOString(), id: jobId });
  const items = await openItems(jobId);
  if (items.questions.length) await answerQuestions(items.questions.map((q) => q.id), { answer: "", dismiss: true }, identity.user);
  for (const p of items.proposals) await rejectPending(p.id, identity, "closed by the master").catch(() => {});
  return { closed: true };
}

/** the master hands a stop it can't decide to a handler, who settles it with the operator */
async function startHandler(jobId, description, identity) {
  const sit = await workerSituation(jobId);
  if (sit.status !== "waiting") throw new Error(`worker ${jobId} isn't waiting (${sit.status})`);
  const st = await masterStatus();
  if (st.halted) throw new Error(`${st.handlers} handlers already wait on the operator (at most ${st.maxHandlers}): settle what you can, the rest waits`);
  const id = randomUUID();
  const now = new Date().toISOString();
  await adbCommand(
    "INSERT INTO Job SET id = :id, kind = 'handler', job_key = :k, payload = :p, status = 'pending', attempts = 0, priority = 9, run_after = :now, created_at = :now, updated_at = :now",
    "sql",
    { id, k: `handler:${jobId}:${id.slice(0, 8)}`, p: JSON.stringify({ for_job: jobId, title: sit.title, description: String(description).slice(0, 3000), by: identity.user }), now },
  );
  return { handler: id, note: "Handed to the operator: you'll get a signal when it's resolved." };
}

/** the handler records the operator's decision: answers, applies or rejects proposals; the worker resumes; the master hears */
async function handlerDecide(args, identity) {
  const h = (await adbQuery("SELECT payload, status FROM Job WHERE id = :id AND kind = 'handler'", { id: identity.role.job }))[0];
  if (!h) throw new Error("no such handler");
  if (h.status === "done") throw new Error("already decided");
  const { for_job } = JSON.parse(h.payload || "{}");
  const items = await openItems(for_job);
  const mine = new Set(items.proposals.map((p) => p.id));
  const by = `${identity.user} (on the operator's word)`;
  const done = [];
  for (const id of args.approve ?? []) {
    if (!mine.has(id)) continue;
    await approvePending(id, { ...identity, user: by }, "", { quiet: true }).then(() => done.push(`applied ${id.slice(0, 8)}`), (e) => done.push(`couldn't apply ${id.slice(0, 8)}: ${String(e.message ?? e).slice(0, 120)}`));
  }
  for (const r of args.reject ?? []) {
    if (!mine.has(r.id)) continue;
    await rejectPending(r.id, { ...identity, user: by }, r.reason ?? "", { quiet: true }).then(() => done.push(`rejected ${r.id.slice(0, 8)}`));
  }
  if (items.questions.length && args.answer) await answerQuestions(items.questions.map((q) => q.id), { answer: args.answer, quiet: true }, by);
  const decision = [args.answer ? `The operator: ${args.answer}` : "", ...done].filter(Boolean).join("; ");
  await resumeThread(for_job, { message: decision || "The operator looked at it: carry on.", answered_by: by });
  await adbCommand("UPDATE Job SET status = 'done', summary = :s, updated_at = :now WHERE id = :id", "sql", { s: decision.slice(0, 2000), now: new Date().toISOString(), id: identity.role.job });
  await emitSignal("resolved", { job_id: for_job, data: { decision } });
  return { decided: true, worker_resumes: for_job, note: "Recorded: the worker resumes and the master knows. Tell the operator what you recorded." };
}

/** the admin's decision on a worker's proposal (through the liaison or Approvals); rejected = the thread decides again */
async function decideProposal(id, approve, reason, identity) {
  const rec = (await adbQuery("SELECT id FROM PendingWrite WHERE id = :id AND status = 'pending' AND job_id IS NOT NULL", { id }))[0];
  if (!rec) throw new Error(`no pending proposal ${id}`);
  // either way the waiting thread resumes with the decision (see approvePending, rejectPending)
  return approve ? approvePending(id, identity, reason) : rejectPending(id, identity, reason);
}

/** approved merge: the dropped thing's links move to the kept one */
async function mergeThings({ keep, drop, drop_name }) {
  if (!RID_RE.test(String(keep)) || !RID_RE.test(String(drop))) throw new Error("invalid merge");
  const k = (await adbQuery(`SELECT _homes, _alias_norms FROM ${keep}`))[0];
  const d = (await adbQuery(`SELECT _homes, _alias_norms, _norm FROM ${drop}`))[0];
  if (!k || !d) throw new Error("one of the things is gone");
  const edges = await adbQuery(`SELECT @out AS src, role FROM (SELECT expand(inE('ABOUT')) FROM ${drop})`).catch(() => []);
  for (const e of edges) await aboutOnce(String(e.src), keep, e.role ?? "mentions");
  await adbCommand(`UPDATE ${keep} SET _homes = :homes, _alias_norms = :aliases`, "sql", {
    homes: [...new Set([...(k._homes ?? []), ...(d._homes ?? [])])],
    aliases: [...new Set([...(k._alias_norms ?? []), ...(d._alias_norms ?? []), d._norm, normalize(drop_name)].filter(Boolean))],
  });
  await adbCommand(`DELETE FROM ${ENTITY_LABEL} WHERE @rid = ${drop} AND _kind = 'thing'`);
  return { merged: true };
}

// the jobs graph-rag runs itself (review jobs are threads: the admin's workspace runs them)
const JOBS = { mentions: jobMentions };

/** a thread whose workspace went quiet past its lease runs again (three times at most) */
async function expireLeases() {
  const now = new Date().toISOString();
  await adbCommand("UPDATE Job SET status = 'failed', error = 'the thread stopped reporting', updated_at = :now WHERE kind = 'review' AND status = 'running' AND lease_until < :now AND attempts >= 2", "sql", { now });
  await adbCommand("UPDATE Job SET status = 'pending', attempts = attempts + 1, error = 'the thread stopped reporting', updated_at = :now WHERE kind = 'review' AND status = 'running' AND lease_until < :now", "sql", { now });
}

/** a thread left waiting with nothing open (its proposals were handled some other way) carries on */
async function wakeIdleWaiting() {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const rows = await adbQuery("SELECT id FROM Job WHERE kind = 'review' AND status = 'waiting' AND updated_at < :c LIMIT 50", { c: cutoff });
  for (const r of rows) {
    const q = Number((await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: r.id }))[0]?.n ?? 0);
    const p = Number((await adbQuery("SELECT count(*) AS n FROM PendingWrite WHERE job_id = :id AND status = 'pending'", { id: r.id }))[0]?.n ?? 0);
    if (!q && !p) await resumeThread(r.id, { proposal: "your last proposal", decision: "handled", reason: "nothing of yours is waiting any more: check what's in place now and finish." });
  }
}

/** a few jobs per tick, highest priority first; failures back off and give up after a few tries */
async function workerTick() {
  if (workerTicking || !worker.enabled || !workerModel() || !SCOPED || !positionMap) return;
  workerTicking = true;
  try {
    const now = new Date().toISOString();
    const kinds = Object.keys(JOBS).map((k) => `'${k}'`).join(", ");
    const due = await adbQuery(`SELECT id, kind, payload, attempts FROM Job WHERE status = 'pending' AND kind IN [${kinds}] AND run_after <= :now ORDER BY priority DESC, created_at ASC LIMIT 3`, { now });
    for (const job of due) {
      const claimed = await adbCommand("UPDATE Job SET status = 'running', updated_at = :now WHERE id = :id AND status = 'pending'", "sql", { now, id: job.id });
      if (Number(claimed?.[0]?.count ?? 0) !== 1) continue;
      try {
        if (!JOBS[job.kind]) throw new Error(`unknown job kind ${job.kind}`);
        await JOBS[job.kind](JSON.parse(job.payload || "{}"));
        await adbCommand("UPDATE Job SET status = 'done', updated_at = :now WHERE id = :id", "sql", { now: new Date().toISOString(), id: job.id });
      } catch (e) {
        const attempts = Number(job.attempts ?? 0) + (e.later ? 0 : 1);
        const giveUp = attempts >= 5;
        const wait = e.later ? 3_600_000 : 30_000 * 4 ** attempts;
        await adbCommand("UPDATE Job SET status = :s, attempts = :a, run_after = :ra, error = :err, updated_at = :now WHERE id = :id", "sql", {
          s: giveUp ? "failed" : "pending",
          a: attempts,
          ra: new Date(Date.now() + wait).toISOString(),
          err: String(e?.message ?? e).slice(0, 300),
          now: new Date().toISOString(),
          id: job.id,
        });
        if (e.later) break; // out of budget: stop for this tick
      }
    }
  } finally {
    workerTicking = false;
  }
}

/** what we know about a thing: the statements about it the caller can see */
async function aboutThing({ name }, identity, scope) {
  const n = normalize(name);
  const visible = homeFilter(scope);
  const things = await adbQuery(
    `SELECT @rid AS rid, label, _thing_type, _alias_norms, _keys FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (_norm = :n OR _alias_norms CONTAINS :n OR _keys CONTAINS :raw)${visible} LIMIT 5`,
    { n, raw: String(name).trim() },
  );
  if (things.length === 0) return { things: [], note: `nothing called "${name}" that you can see is known yet` };
  const out = [];
  const read = [];
  for (const t of things) {
    const rows = await adbQuery(
      `SELECT name, _home, _kind, _doc_title, _doc_id, _section, text_identity, _valid_until FROM (SELECT expand(in('ABOUT')) FROM ${String(t.rid)}) WHERE name IS NOT NULL${visible}${liveClause()} LIMIT 40`,
    ).catch(() => []);
    read.push(...rows.map((r) => effectiveHome(positionMap, r._home)));
    // relationships to other things the caller can see
    const edges = [
      ...(await adbQuery(`SELECT @in AS other, rel FROM (SELECT expand(outE('RELATES')) FROM ${String(t.rid)}) LIMIT 60`).catch(() => [])).map((e) => ({ ...e, dir: "out" })),
      ...(await adbQuery(`SELECT @out AS other, rel FROM (SELECT expand(inE('RELATES')) FROM ${String(t.rid)}) LIMIT 60`).catch(() => [])).map((e) => ({ ...e, dir: "in" })),
    ].filter((e) => RID_RE.test(String(e.other)));
    const others = edges.length ? await adbQuery(`SELECT @rid AS rid, label, _thing_type FROM [${[...new Set(edges.map((e) => String(e.other)))].join(",")}] WHERE _kind = 'thing'${visible}`).catch(() => []) : [];
    const byRid = new Map(others.map((o) => [String(o.rid), o]));
    out.push({
      name: t.label,
      type: t._thing_type,
      also_called: t._alias_norms ?? [],
      ...(t._keys?.length ? { keys: t._keys } : {}),
      related: edges
        .filter((e) => byRid.has(String(e.other)))
        .map((e) => {
          const o = byRid.get(String(e.other));
          return e.dir === "out" ? { [e.rel]: `${o.label} (${o._thing_type})` } : { [`${e.rel} (from)`]: `${o.label} (${o._thing_type})` };
        }),
      statements: rows.map((r) => ({ name: r.name, ...questionOf(r), ...validityOf(r), text: String(r.text_identity ?? "").slice(0, 300) })),
    });
  }
  recordReads(identity, read);
  return { things: out };
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
      if (rec.properties?._kind === "document" && rec.properties._doc_id && docStore) await docStore.remove(rec.properties._doc_id).catch(() => {});
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
  return { ...prunePreviewDays(rows, policy.pruneAfterDays), sink: pruneSink ? { name: pruneSink.name, keeps: pruneSink.keeps } : { name: PRUNE_SINK, unknown: true } };
}

/** ---- pending-write queue (audited writes for low-capability identities) ---- */

async function ensurePendingSchema() {
  await adbCommand("CREATE DOCUMENT TYPE PendingWrite").catch(() => {});
  for (const prop of ["id", "kind", "payload", "language", "requested_by", "created_at", "status", "executed_at", "approved_by", "home", "note", "job_id"]) {
    await adbCommand(`CREATE PROPERTY PendingWrite.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
}

const RID_RE = /^#\d+:\d+$/;
const PENDING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** a worker thread's queued write is a proposal: its reason, and the thread to resume when it's decided */
const proposalFields = (identity, reason) =>
  identity.role?.kind === "worker" ? { note: String(reason ?? "").trim().slice(0, 600) || "(no reason given)", job: identity.role.job } : {};

async function queueWrite(entry) {
  const id = randomUUID();
  const created = new Date().toISOString();
  const payload = entry.payload ?? entry.command ?? "";
  const language = entry.language ?? "sql";
  // awaited: a write is only reported as queued once the record exists
  await adbCommand(
    "INSERT INTO PendingWrite SET id = :id, kind = :kind, payload = :payload, language = :lang, " +
      "requested_by = :user, created_at = :created, status = :status, home = :home, note = :note, job_id = :job",
    "sql",
    {
      id,
      kind: entry.kind,
      payload,
      lang: language,
      user: entry.user,
      created,
      home: entry.home ?? null,
      status: entry.status ?? "pending",
      // a worker thread's proposal: its reason, and the thread (resumed when it's decided)
      note: entry.note ?? null,
      job: entry.job ?? null,
    },
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

async function approvePending(id, identity, reason = "", { quiet = false } = {}) {
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
    // a worker's proposal that couldn't be applied: the waiting thread hears why
    if (rec.job_id && !quiet) await resumeThread(rec.job_id, { proposal: rec.note || rec.kind, decision: "failed", reason: String(err?.message ?? err).slice(0, 600), answered_by: approver }).catch(() => {});
    throw err;
  }
  await adbCommand("UPDATE PendingWrite SET status = 'approved', executed_at = :now WHERE id = :id", "sql", {
    now: new Date().toISOString(),
    id,
  });
  console.log(`[graph-rag] write ${id} approved by ${approver}`);
  // a worker thread's proposal: it waited for this, and carries on
  if (rec.job_id && !quiet) await resumeThread(rec.job_id, { proposal: rec.note || rec.kind, decision: "approved", reason, answered_by: approver }).catch(() => {});
  // shares that waited on this write can now point at its entities
  if (rec.kind === "upsert") await resolveWaitingShares(id).catch((e) => log.warn(`waiting shares for ${id}: ${String(e).slice(0, 160)}`));
  return { approved: true, result };
}
async function rejectPending(id, identity, reason = "", { quiet = false } = {}) {
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
  // a rejected ingest leaves nothing behind
  if (rows[0].kind === "ingest" && docStore) await docStore.remove(JSON.parse(rows[0].payload).doc_id).catch(() => {});
  // a worker thread's proposal: the thread decides again (wherever it was rejected)
  if (rows[0].job_id && !quiet) await resumeThread(rows[0].job_id, { proposal: rows[0].note || rows[0].kind, decision: "rejected", reason, answered_by: rejector }).catch(() => {});
  return { rejected: true };
}

function sanitizeFacet(name) {
  if (typeof name !== "string" || !FACET_RE.test(name)) throw new Error(`invalid facet name: ${String(name)}`);
  // a facet named as it's stored ("text_state") is that facet, not a second one ("text_text_state")
  return name.toLowerCase().replace(/^(?:text_|embed_)+/, "") || name.toLowerCase();
}

/** ---- MCP server (fresh instance per request: stateless) ---- */
const facetDoc = Object.entries(FACETS)
  .map(([f, d]) => `- ${f}: ${d}`)
  .join("\n");

function createServer(identity) {
  const caps = identity.caps;
  const scope = scopeOf(identity);
  // the graph worker's agents (see delegation.js): their own tools, not the sharing and review ones
  const role = identity.role?.kind;
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
      const result = await searchGraph(args, scope, read, { demand: !role, ownEntry: identity.role?.entry ?? null });
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
      ...(role === "worker" ? { reason: z.string().max(600).optional(), propose: z.boolean().optional() } : {}),
    },
    async (args) => {
      need("write");
      if (role === "worker") return { content: [{ type: "text", text: JSON.stringify(await workerUpsert(args, identity, scope)) }] };
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
    "Execute a WRITE command against the knowledge graph (openCypher or SQL): ONE statement per call (no ';'-separated statements). Depending on your identity capabilities this executes immediately or is queued for review.",
    {
      command: z.string().min(1),
      language: z.enum(["cypher", "sql"]).optional(),
      ...(role === "worker" ? { reason: z.string().max(600).optional(), propose: z.boolean().optional() } : {}),
    },
    async (args) => {
      need("write");
      need("raw");
      return { content: [{ type: "text", text: JSON.stringify(await executeGraph(args, identity)) }] };
    },
  );

  if (caps.write !== "deny" && !role) server.tool(
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
      ...(role === "worker" ? { reason: z.string().max(600).optional(), propose: z.boolean().optional() } : {}),
    },
    async (args) => {
      need("write");
      const r = await setHome(args, identity, scope);
      if (role === "worker" && r.results.some((x) => x.queued)) r.note = PROPOSED_NOTE;
      return { content: [{ type: "text", text: JSON.stringify(r) }] };
    },
  );

  if (SCOPED && caps.write !== "deny" && !role) server.tool(
    "ingest_document",
    `Add a long document (a manual, a meeting transcript, a report) to the knowledge graph. Give
its full text, a short title and a one-sentence description. The text is kept in the document
store; the graph gets the document's entry and one searchable section per page or so, each filed
where it belongs (a sensitive part may be filed higher than the rest).
extract is required, true or false: true also pulls focused facts (specifications, decisions,
action items with dates) out of the text into the graph, each linked to its section; false keeps
only the document and its sections. It's the person's decision: if they haven't said, ask them
("Should I also pull the individual facts out of it?") before calling this. valid_until works as
in upsert_entities. Re-ingesting the same title replaces the document.`,
    {
      title: z.string().min(3).max(200),
      description: z.string().min(3).max(500),
      text: z.string().min(20),
      extract: z.boolean(),
      ...(SCOPED ? { home: z.string().optional() } : {}),
      valid_until: z.string().optional(),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await requestIngest(args, identity, scope)) }] };
    },
  );

  if (SCOPED) server.tool(
    "about_thing",
    `Everything you can see about one thing: a person, customer, supplier, machine, part, order,
place, project or team, by name (aliases work: "Toro Co." finds Toro). The graph worker links
statements to the things they mention in the background, so newly saved entries appear here after
a minute or so. Use it for "what do we know about X" questions, and to find related entries after
a search.`,
    { name: z.string().min(2) },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await aboutThing(args, identity, scope)) }] };
    },
  );

  // ---- a graph worker thread's own tools (one queue entry: its entry) ----
  if (SCOPED && role === "worker") {
    server.tool(
      "link_things",
      `Link an entry (yours by default; or name one in entry by name or id, e.g. a table's entry) to
the things it's about: people, customers, suppliers, machines, parts, orders, places, projects, teams
(type one of: person, customer, supplier, machine, part, order, place, project, team, other). Up to 25
a call. Give a record's key when you know it ("mssql:dbo_Customer:TORO"): the same key is always the
same thing. Existing things are found by key, name or alias; new ones are created. A name that may be
an existing thing under another name isn't linked: it comes back as unsure for you to check. Another
entry is never a thing: cross-reference entries by name in the text, not with a link.`,
      {
        things: z.array(z.object({ name: z.string().min(2).max(120), type: z.string(), role: z.string().max(30).optional(), key: z.string().max(200).optional() })).min(1).max(25),
        entry: z.string().max(200).optional(),
      },
      async (args) => {
        need("read");
        return { content: [{ type: "text", text: JSON.stringify(await workerLink(args, identity)) }] };
      },
    );
    server.tool(
      "relate_things",
      `Record relationships between things: from, a verb (rel: works_in, supplies, orders, belongs_to,
runs_on, reports_to...), to, and the evidence (which table and columns, or the aggregate). Each thing
by name and type, or by key. Up to 25 a call. A relationship shows only to people who can see both.`,
      {
        relations: z
          .array(
            z.object({
              from: z.object({ name: z.string().min(2), type: z.string().optional(), key: z.string().optional() }),
              rel: z.string().min(2).max(40),
              to: z.object({ name: z.string().min(2), type: z.string().optional(), key: z.string().optional() }),
              evidence: z.string().max(400).optional(),
            }),
          )
          .min(1)
          .max(25),
      },
      async (args) => {
        need("write");
        return { content: [{ type: "text", text: JSON.stringify(await workerRelate(args, identity)) }] };
      },
    );
    server.tool(
      "queue_followup",
      `Queue a follow-up task for another thread: a title and a precise brief (which tables, what to seed,
which relationships). For a survey's topics that don't fit this conversation. A few per thread.`,
      { title: z.string().min(4).max(120), brief: z.string().min(20).max(6000), minutes: z.number().int().min(5).max(180).optional(), level: z.number().int().min(1).max(3).optional() },
      async (args) => {
        need("write");
        return { content: [{ type: "text", text: JSON.stringify(await workerFollowup(args, identity)) }] };
      },
    );
    server.tool(
      "unlink_things",
      `Remove links you judge wrong between an entry (yours by default, or one you name by name or id) and
things: e.g. a note linked to the wrong "John". Each thing by name and type, or key. Give a short reason.`,
      {
        things: z.array(z.object({ name: z.string().min(1), type: z.string().optional(), key: z.string().optional() })).min(1).max(25),
        entry: z.string().max(200).optional(),
        reason: z.string().max(300).optional(),
      },
      async (args) => {
        need("write");
        return { content: [{ type: "text", text: JSON.stringify(await workerUnlink(args, identity)) }] };
      },
    );
    server.tool(
      "delete_thing",
      `Delete a stray thing that nothing links to any more (a mis-typed duplicate, a placeholder). Anything
still linked or related must be unlinked or merged first. Give a short reason.`,
      { name: z.string().min(1), type: z.string().optional(), key: z.string().optional(), reason: z.string().max(300).optional() },
      async (args) => {
        need("write");
        return { content: [{ type: "text", text: JSON.stringify(await workerDeleteThing(args, identity)) }] };
      },
    );
    server.tool(
      "merge_things",
      `Merge two things that are the same (e.g. "Toro Co." and "Toro", both customers): keep one, fold the
other's links and names into it. Plain duplicates: merge directly. When it matters (things many entries
point at, or you're not certain), set propose: true with a reason: an admin decides and you wait.`,
      { keep: z.string().min(2), drop: z.string().min(2), type: z.string().optional(), reason: z.string().max(600).optional(), propose: z.boolean().optional() },
      async (args) => {
        need("write");
        return { content: [{ type: "text", text: JSON.stringify(await workerMerge(args, identity, scope)) }] };
      },
    );
    server.tool(
      "merge_entries",
      `Fold a duplicate entry into the one it duplicates (two copies of one note): the drop's links move to
the keep, then the drop is deleted. Name each by name, or by its id ("#1:352258") when several share a
name. Two copies at the same home fold directly; at different homes, or with propose: true, it's a
proposal and you wait. Give a short reason.`,
      { keep: z.string().min(2).max(200), drop: z.string().min(2).max(200), reason: z.string().max(600).optional(), propose: z.boolean().optional() },
      async (args) => {
        need("write");
        return { content: [{ type: "text", text: JSON.stringify(await workerFoldEntries(args, identity)) }] };
      },
    );
    server.tool(
      "unrelate_things",
      `Remove relationships you judge wrong or stale between things (a works_in the current data no longer
supports). Each by from, rel and to (each thing by name and type, or key); without rel, every
relationship from the one to the other goes. Give a short reason.`,
      {
        relations: z
          .array(
            z.object({
              from: z.object({ name: z.string().min(2), type: z.string().optional(), key: z.string().optional() }),
              rel: z.string().max(40).optional(),
              to: z.object({ name: z.string().min(2), type: z.string().optional(), key: z.string().optional() }),
            }),
          )
          .min(1)
          .max(25),
        reason: z.string().max(300).optional(),
      },
      async (args) => {
        need("write");
        return { content: [{ type: "text", text: JSON.stringify(await workerUnrelate(args, identity)) }] };
      },
    );
    server.tool(
      "delete_entry",
      `Delete an entry by name or id ("#971:0"): a stray copy a write made by mistake, a placeholder. With
nothing linking it and no links of its own it goes directly; otherwise it's a proposal (a duplicate of
another entry is folded with merge_entries instead). Use this, not raw commands. Give a short reason.`,
      { entry: z.string().min(2).max(200), reason: z.string().max(300).optional(), propose: z.boolean().optional() },
      async (args) => {
        need("write");
        return { content: [{ type: "text", text: JSON.stringify(await workerDeleteEntry(args, identity)) }] };
      },
    );
    server.tool(
      "rename_thing",
      `Correct a thing's name (a work center stored as "cnc" that the ERP calls "CNC 2"). The thing by name
and type, or key; the new name without its type. The old name stays as an alias, so searches still find
it. Don't write a thing's name as an entry: that makes a second copy beside it.`,
      {
        thing: z.object({ name: z.string().min(1), type: z.string().optional(), key: z.string().optional() }),
        name: z.string().min(1).max(120),
        reason: z.string().max(300).optional(),
      },
      async (args) => {
        need("write");
        return { content: [{ type: "text", text: JSON.stringify(await workerRenameThing(args, identity)) }] };
      },
    );
    server.tool(
      "update_entry",
      `Correct an entry you name by name or id: set properties (a stale version, a wrong field), rewrite a
facet's text, or set its valid_until. A typed record (a Database, a Host: give its id, "#13:0") is
corrected in place the same way, without an end date. It's updated where it lives, with the usual
floor. Use this, not raw commands, for corrections. Set propose: true with a reason when it matters.`,
      {
        entry: z.string().min(2).max(200),
        properties: z.record(z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
        facets: z.record(z.string().max(4000)).optional(),
        valid_until: z.string().max(40).optional(),
        reason: z.string().max(600).optional(),
        propose: z.boolean().optional(),
      },
      async (args) => {
        need("write");
        return { content: [{ type: "text", text: JSON.stringify(await workerUpdateEntry(args, identity)) }] };
      },
    );
    server.tool(
      "raise_question",
      `Ask the admin something you can't settle from the graph or your sources (which customer a name means,
whether a change is right). Give options when there are clear choices, and why you're asking. Then END
YOUR TURN with a short report: you're resumed with the answer later, in this same conversation.`,
      { question: z.string().min(8).max(600), options: z.array(z.string().max(200)).max(6).optional(), why: z.string().max(600).optional() },
      async (args) => {
        need("read");
        return { content: [{ type: "text", text: JSON.stringify(await raiseQuestion(identity, args)) }] };
      },
    );
  }

  // ---- the master's tools: start workers, settle stops, hand the rest to the operator ----
  if (SCOPED && role === "master") {
    server.tool(
      "start_worker",
      `Start a worker on a piece of work: a title, a precise brief (what to do, which entries, what a good
result is) and the entries it's about (by name: the worker reads them). Group entries that belong
together into one worker. audience "everyone" lets it write for Everyone (only for organization-wide
knowledge). level picks the model it runs on: 1 a quick check, 2 an investigation, 3 a broad or
structural matter (default: the highest triage level among its entries). You get a signal when it's
done or stopped.`,
      {
        title: z.string().min(4).max(120),
        brief: z.string().min(20).max(6000),
        entries: z.array(z.string().max(200)).max(25).optional(),
        minutes: z.number().int().min(5).max(180).optional(),
        audience: z.enum(["everyone", "default"]).optional(),
        level: z.number().int().min(1).max(3).optional(),
      },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await masterStartWorker(args, identity)) }] }),
    );
    server.tool(
      "worker_status",
      "A worker's situation: its status, brief, report, changes, and the questions and proposals it's waiting on.",
      { job: z.string() },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await workerSituation(args.job)) }] }),
    );
    server.tool(
      "answer_worker",
      `Settle a stopped worker yourself when you can: your answer to its questions, or what to do next. It
resumes in its own conversation.`,
      { job: z.string(), answer: z.string().min(2).max(3000) },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await answerWorker(args.job, args.answer, identity.user)) }] }),
    );
    server.tool(
      "decide_proposal",
      `Apply or reject a worker's proposal yourself (its worker resumes with your decision). Raw commands and
widening who sees something are the operator's: hand those to a handler.`,
      { id: z.string(), approve: z.boolean(), reason: z.string().max(1000).optional() },
      async (args) => {
        const why = await needsOperator(args.id);
        if (why) throw new Error(`${why} is the operator's decision: start a handler for this worker`);
        return { content: [{ type: "text", text: JSON.stringify(await decideProposal(args.id, args.approve, args.reason ?? "", identity)) }] };
      },
    );
    server.tool(
      "close_worker",
      "Close a worker you won't pursue (its questions dismissed, its proposals rejected). Say why.",
      { job: z.string(), summary: z.string().min(3).max(2000) },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await closeWorker(args.job, args.summary, identity)) }] }),
    );
    server.tool(
      "start_handler",
      `Hand a stopped worker you can't decide for to the operator: a handler thread explains it to them and
records their decision. Describe what's going on and what needs deciding, plainly.`,
      { job: z.string(), description: z.string().min(10).max(3000) },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await startHandler(args.job, args.description, identity)) }] }),
    );
    server.tool(
      "pool_status",
      "How the pool stands: workers by status, handlers waiting on the operator (and whether that halts new batches), entries waiting for the next batch.",
      {},
      async () => {
        const counts = await adbQuery("SELECT status, count(*) AS n FROM Job WHERE kind = 'review' GROUP BY status").catch(() => []);
        return { content: [{ type: "text", text: JSON.stringify({ workers: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])), ...(await masterStatus()) }) }] };
      },
    );
  }

  // ---- a handler's tools: one stopped worker, settled with the operator ----
  if (SCOPED && role === "handler") {
    server.tool(
      "worker_status",
      "The stopped worker you handle: its brief, report, changes, and the questions and proposals it waits on.",
      {},
      async () => {
        const h = (await adbQuery("SELECT payload FROM Job WHERE id = :id AND kind = 'handler'", { id: identity.role.job }))[0];
        return { content: [{ type: "text", text: JSON.stringify(await workerSituation(JSON.parse(h?.payload || "{}").for_job)) }] };
      },
    );
    server.tool(
      "decide_for_worker",
      `Record the operator's decision, only on their word: their answer to the worker's questions, which
proposals to apply, which to reject (with their reason). The worker resumes and the master is told.`,
      {
        answer: z.string().max(3000).optional(),
        approve: z.array(z.string()).max(20).optional(),
        reject: z.array(z.object({ id: z.string(), reason: z.string().max(600).optional() })).max(20).optional(),
      },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlerDecide(args, identity)) }] }),
    );
  }

  // ---- the liaison's tools: workers' questions and proposals, for the admin ----
  if (SCOPED && role === "liaison") {
    server.tool(
      "list_worker_questions",
      "The questions graph worker threads are waiting on, oldest first: which entry, the question, its options, and why the thread asks.",
      {},
      async () => ({ content: [{ type: "text", text: JSON.stringify({ questions: await listQuestions("open") }) }] }),
    );
    server.tool(
      "answer_worker_questions",
      `Record the admin's answer to one or more questions (several threads asking the same thing can share one
answer). Each thread resumes with it. Only answer with what the admin said: never decide for them.
dismiss: true closes the questions without an answer (the threads finish as they are).`,
      { ids: z.array(z.string()).min(1).max(100), answer: z.string().max(2000).optional(), dismiss: z.boolean().optional() },
      async (args) => {
        if (!args.dismiss && !args.answer?.trim()) throw new Error("an answer, or dismiss: true");
        return { content: [{ type: "text", text: JSON.stringify(await answerQuestions(args.ids, { answer: args.answer ?? "", dismiss: args.dismiss === true }, `${identity.user} (for the admin)`)) }] };
      },
    );
    server.tool(
      "list_worker_proposals",
      "Changes graph worker threads proposed (to entries that aren't theirs, merges, raw commands), with each thread's reason.",
      {},
      async () => ({ content: [{ type: "text", text: JSON.stringify({ proposals: await listProposals() }) }] }),
    );
    server.tool(
      "decide_worker_proposal",
      `Apply or reject a worker's proposal, as the admin decided. Only on the admin's say-so. A rejection (and
an approval with a reason) resumes the thread with the reason.`,
      { id: z.string(), approve: z.boolean(), reason: z.string().max(1000).optional() },
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await decideProposal(args.id, args.approve, args.reason ?? "", identity)) }] }),
    );
  }

  if (SCOPED) server.tool(
    "read_document",
    `Read a document from the knowledge graph. Search results with kind "section" are parts of a
document (document, document_id, section): pass document_id (or the document's title) and the
section to read it in full, with up to count sections from there (default 3, at most 6). Without
a section you get its contents (the sections you can see) and the first sections.`,
    { document: z.string().min(1), section: z.number().int().min(1).optional(), count: z.number().int().min(1).max(6).optional() },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await readDocument(args, identity, scope)) }] };
    },
  );

  if (SCOPED && !role) server.tool(
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

  if (SCOPED && caps.write !== "deny" && !role) server.tool(
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

  if (SCOPED && !role) server.tool(
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

  if (SCOPED && !role) server.tool(
    "list_grants",
    "List active grants on data you own (outgoing) and grants that show you data (incoming).",
    {},
    async () => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(listGrants(scope)) }] };
    },
  );

  if (SCOPED && caps.write !== "deny" && !role) server.tool(
    "revoke_grant",
    "Revoke a grant (takes effect at once). The person who granted it or any owner of the data may revoke.",
    { id: z.string().min(1) },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await revokeGrant(args, identity, scope)) }] };
    },
  );

  if (caps.approve === true && !role) server.tool(
    "list_pending_writes",
    "List queued graph writes awaiting approval (requires approve capability).",
    {},
    async () => {
      need("approve");
      return { content: [{ type: "text", text: JSON.stringify({ pending: await listPending(identity) }) }] };
    },
  );

  if (caps.approve === true && !role) server.tool(
    "approve_write",
    "Approve and execute a queued graph write.",
    { id: z.string().min(1) },
    async (args) => {
      need("approve");
      return { content: [{ type: "text", text: JSON.stringify(await approvePending(args.id, identity)) }] };
    },
  );

  if (caps.approve === true && !role) server.tool(
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
    .map(([id, p]) => ({ id, name: homeName(positionMap, id), parent: p.parent, ...(p.description ? { description: p.description } : {}) }));
  // the whole tree's names: grants may go to positions outside the caller's
  // reach (that is their point); this says nothing about anyone's data
  const tree = Object.entries(positionMap.positions).map(([id, p]) => ({ id, name: homeName(positionMap, id), parent: p.parent }));
  res.json({ scoped: true, root: positionMap.root, everyone: { id: EVERYONE, name: "Everyone" }, held, positions, tree, people: peopleView(personOf(identity.user)), canGrantStanding: reach === null && !identity.agent && policy.standingGrants === "root" });
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
/** the graph worker: settings (pushed from the admin's Graph worker profile) and its backlog; root only */
async function workerStatus() {
  const counts = await adbQuery("SELECT status, count(*) AS n FROM Job WHERE kind <> 'review' GROUP BY status").catch(() => []);
  const threads = await adbQuery("SELECT status, count(*) AS n FROM Job WHERE kind = 'review' GROUP BY status").catch(() => []);
  const questions = await adbQuery("SELECT count(*) AS n FROM WorkerQuestion WHERE status = 'open'").catch(() => []);
  const proposals = await adbQuery("SELECT count(*) AS n FROM PendingWrite WHERE status = 'pending' AND job_id IS NOT NULL").catch(() => []);
  const things = await adbQuery(`SELECT count(*) AS n FROM ${ENTITY_LABEL} WHERE _kind = 'thing'`).catch(() => []);
  const failed = await adbQuery("SELECT kind, error, updated_at FROM Job WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 5").catch(() => []);
  return {
    ...worker,
    model: workerModel() || null,
    threads: { ...Object.fromEntries(threads.map((c) => [c.status, Number(c.n)])), today: await threadsToday() },
    master: await masterStatus().catch(() => null),
    triage: await triageStats().catch(() => null),
    open_questions: Number(questions[0]?.n ?? 0),
    open_proposals: Number(proposals[0]?.n ?? 0),
    jobs: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    things: Number(things[0]?.n ?? 0),
    today: { calls: workerUsage.day === new Date().toISOString().slice(0, 10) ? workerUsage.calls : 0, budget: Number(WORKER_DAILY_CALLS) },
    recent_failures: failed,
  };
}
app.get("/api/worker", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sees the graph worker" });
  void workerStatus().then((r) => res.json(r), (e) => httpError(res, e));
});
app.put("/api/worker", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sets the graph worker" });
  const b = req.body ?? {};
  const next = {
    enabled: typeof b.enabled === "boolean" ? b.enabled : worker.enabled,
    model: typeof b.model === "string" ? b.model.slice(0, 300) : worker.model,
    instructions: typeof b.instructions === "string" ? b.instructions.slice(0, 4000) : worker.instructions,
    profile: typeof b.profile === "string" ? b.profile.slice(0, 120) : b.profile === null ? null : worker.profile,
    pool: worker.pool,
  };
  try {
    if (b.pool !== undefined) next.pool = poolSettings(b.pool, worker.pool);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const now = new Date().toISOString();
  void (async () => {
    const json = JSON.stringify(next);
    const done = await adbCommand("UPDATE OrgPolicy SET json = :json, updated_by = :u, updated_at = :now WHERE scope = 'worker'", "sql", { json, u: identity.user, now });
    if (Number(done?.[0]?.count ?? 0) === 0) await adbCommand("INSERT INTO OrgPolicy SET scope = 'worker', json = :json, updated_by = :u, updated_at = :now", "sql", { json, u: identity.user, now });
    worker = { ...next, updated_by: identity.user, updated_at: now };
    log.info(`graph worker set by ${identity.user}: ${next.enabled ? `on, ${workerModel() || "no model"}` : "off"}${next.profile ? ` (profile ${next.profile})` : ""}`);
    return workerStatus();
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
/** the models graph-rag reaches through litellm (what a Graph worker profile can pick) */
app.get("/api/worker/models", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sets the graph worker" });
  void fetch(`${LITELLM_BASE_URL.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${LITELLM_API_KEY}` }, signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json())
    .then((j) => res.json({ models: (j.data ?? []).map((m) => m.id).filter((id) => typeof id === "string" && !/embed/i.test(id)).sort() }))
    .catch((e) => httpError(res, e));
});
/** the worker pool's endpoints: the admin's workspace runs the threads; root only */
const rootOnly = (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return void res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return void res.status(403).json({ error: "only the organization's root runs graph worker threads" });
  return identity;
};
app.post("/api/worker/threads/claim", (req, res) => {
  if (!rootOnly(req, res)) return;
  void claimThreads(req.body?.limit).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/worker/threads/:id/agent", (req, res) => {
  if (!rootOnly(req, res)) return;
  void threadAgent(req.params.id, req.body?.agent_id).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/worker/threads/:id/finish", (req, res) => {
  if (!rootOnly(req, res)) return;
  void finishThread(req.params.id, req.body ?? {}).then((r) => res.json(r), (e) => httpError(res, e));
});
/** the master's inbox: new signals (the workspace delivers them to the master thread) */
app.get("/api/worker/signals", (req, res) => {
  if (!rootOnly(req, res)) return;
  void (async () => {
    const rows = await adbQuery("SELECT id, kind, job_id, batch_id, data, created_at FROM Signal WHERE status = 'new' ORDER BY created_at ASC LIMIT 50");
    const signals = rows.map((r) => ({ ...r, data: JSON.parse(r.data || "{}") }));
    const status = await masterStatus();
    return { signals, status, message: signals.length ? signalsMessage(signals, status) : "" };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/worker/signals/ack", (req, res) => {
  if (!rootOnly(req, res)) return;
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((i) => JOB_ID_RE.test(String(i))).slice(0, 100);
  void (async () => {
    for (const id of ids) await adbCommand("UPDATE Signal SET status = 'delivered' WHERE id = :id", "sql", { id });
    return { acked: ids.length };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
/** handlers to start (not limited by the pool: they wait on the operator) */
app.post("/api/worker/handlers/claim", (req, res) => {
  if (!rootOnly(req, res)) return;
  void (async () => {
    const rows = await adbQuery("SELECT id, payload FROM Job WHERE kind = 'handler' AND status = 'pending' ORDER BY created_at ASC LIMIT 10");
    const out = [];
    for (const r of rows) {
      const ok = await adbCommand("UPDATE Job SET status = 'running', updated_at = :now WHERE id = :id AND status = 'pending'", "sql", { now: new Date().toISOString(), id: r.id });
      if (Number(ok?.[0]?.count ?? 0) !== 1) continue;
      const p = JSON.parse(r.payload || "{}");
      out.push({ job: r.id, worker: p.for_job, title: p.title ?? "a stopped worker", message: handlerBrief({ worker: { job: p.for_job, title: p.title ?? "" }, description: p.description }) });
    }
    return { handlers: out };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
/** a handler's thread asked the operator: it waits (it stays in the rail) */
app.post("/api/worker/handlers/:id/waiting", (req, res) => {
  if (!rootOnly(req, res)) return;
  void adbCommand("UPDATE Job SET status = 'waiting', agent_id = :a, updated_at = :now WHERE id = :id AND kind = 'handler' AND status IN ['running', 'pending']", "sql", {
    a: typeof req.body?.agent_id === "string" ? req.body.agent_id.slice(0, 80) : null,
    now: new Date().toISOString(),
    id: req.params.id,
  }).then(() => res.json({ ok: true }), (e) => httpError(res, e));
});
app.get("/api/worker/handlers", (req, res) => {
  if (!rootOnly(req, res)) return;
  void (async () => {
    const rows = await adbQuery("SELECT id, payload, status, agent_id, summary, created_at, updated_at FROM Job WHERE kind = 'handler' ORDER BY created_at DESC LIMIT 100");
    return { handlers: rows.map((r) => ({ id: r.id, ...JSON.parse(r.payload || "{}"), status: r.status, agent_id: r.agent_id ?? null, decision: r.summary ?? "", created_at: r.created_at, updated_at: r.updated_at })) };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});

/** recent threads: which entry, how it went, its agent (for the audit view and clean-up) */
app.get("/api/worker/threads", (req, res) => {
  if (!rootOnly(req, res)) return;
  void (async () => {
    const rows = await adbQuery("SELECT id, payload, status, agent_id, summary, error, attempts, changes, created_at, updated_at, claimed_at FROM Job WHERE kind = 'review' ORDER BY updated_at DESC LIMIT 200");
    const out = [];
    for (const r of rows) {
      const p = JSON.parse(r.payload || "{}");
      const name = RID_RE.test(String(p.rid)) ? (await adbQuery(`SELECT name FROM ${p.rid}`).catch(() => []))[0]?.name : null;
      out.push({
        id: r.id,
        entry: name ?? null,
        why: p.why ?? "",
        ...(p.level ? { level: p.level } : {}),
        status: r.status,
        agent_id: r.agent_id ?? null,
        summary: r.summary ?? "",
        // what it changed without asking (the audit trail for the small things)
        changes: JSON.parse(r.changes || "[]"),
        error: r.error ?? null,
        attempts: Number(r.attempts ?? 0),
        created_at: r.created_at,
        updated_at: r.updated_at,
      });
    }
    return { threads: out };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
/** the admin starts a survey of a connection: a task thread maps it, seeds its records, relates them */
app.post("/api/worker/survey", (req, res) => {
  const identity = rootOnly(req, res);
  if (!identity) return;
  const connection = String(req.body?.connection ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(connection)) return res.status(400).json({ error: "which connection (its name)" });
  const focus = typeof req.body?.focus === "string" ? req.body.focus.slice(0, 1000) : "";
  // who sees what the survey builds: everyone (the default: it's the organization's map) or the admin only
  const audience = req.body?.audience === "admin" ? "admin" : EVERYONE;
  void createTask({ title: `Survey: ${connection}`, brief: surveyBrief(connection, focus, audience), minutes: Number(req.body?.minutes) || 60, by: identity.user, audience, level: 3 }).then(
    (r) => res.json(r),
    (e) => httpError(res, e),
  );
});
app.get("/api/worker/questions", (req, res) => {
  if (!rootOnly(req, res)) return;
  const status = ["open", "answered", "dismissed"].includes(String(req.query.status)) ? String(req.query.status) : "open";
  void listQuestions(status).then((questions) => res.json({ questions }), (e) => httpError(res, e));
});
app.post("/api/worker/questions/answer", (req, res) => {
  const identity = rootOnly(req, res);
  if (!identity) return;
  const b = req.body ?? {};
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 100) : [];
  if (!b.dismiss && !(typeof b.answer === "string" && b.answer.trim())) return res.status(400).json({ error: "an answer, or dismiss" });
  void answerQuestions(ids, { answer: b.answer ?? "", dismiss: b.dismiss === true }, identity.user).then((r) => res.json(r), (e) => httpError(res, e));
});
app.get("/api/worker/proposals", (req, res) => {
  if (!rootOnly(req, res)) return;
  void listProposals().then((proposals) => res.json({ proposals }), (e) => httpError(res, e));
});
app.post("/api/worker/proposals/:id", (req, res) => {
  const identity = rootOnly(req, res);
  if (!identity) return;
  void decideProposal(req.params.id, req.body?.approve === true, typeof req.body?.reason === "string" ? req.body.reason.slice(0, 1000) : "", identity).then((r) => res.json(r), (e) => httpError(res, e));
});

/** queue the entries saved before the worker existed (newest first; demand still goes first) */
app.post("/api/worker/backfill", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root runs a backfill" });
  void (async () => {
    const kind = firstJob(worker.pool);
    const rows = await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE ${kind === "mentions" ? "_mentions_at" : "_reviewed_at"} IS NULL AND embed_identity IS NOT NULL${ASSERTIONS}${liveClause()} ORDER BY updated_at DESC LIMIT 500`);
    for (const r of rows) await enqueue(kind, { rid: String(r.rid) }, { key: `${kind}:${r.rid}` });
    return { queued: rows.length };
  })().then((r) => res.json(r), (e) => httpError(res, e));
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
  const prune = () =>
    void pruneExpired()
      .then(() => sweepOrphanDocuments())
      .catch((e) => log.warn(`pruning failed: ${String(e).slice(0, 160)}`));
  setTimeout(prune, 60_000);
  setInterval(prune, 600_000);
  if (SCOPED) log.info(`semantic grading: ${GRADER_MODEL && policy.gradingEnabled ? `on (${GRADER_MODEL}, confidence ${policy.gradingConfidence})` : "off"}`);
  if (SCOPED) await ensureReadMarkSchema();
  if (SCOPED) {
    await ensureGrantSchema();
    await refreshGrants();
    await ensureNeedSchema();
    await ensureDocumentSchema();
    await ensureWorkerSchema();
    setInterval(() => void workerTick().catch((e) => log.warn(`worker: ${String(e).slice(0, 160)}`)), 5_000);
    setInterval(() => void expireLeases().then(wakeIdleWaiting).catch((e) => log.warn(`worker leases: ${String(e).slice(0, 160)}`)), 60_000);
    await ensureMasterSchema();
    await ensureTriageSchema();
    setInterval(() => void batchTick().catch((e) => log.warn(`batches: ${String(e).slice(0, 160)}`)), 30_000);
    log.info(`graph worker: ${worker.enabled && workerModel() ? `on (${workerModel()}${worker.profile ? `, from profile ${worker.profile}` : ""})` : "off"}`);
    if (!docStore) log.warn(`DOC_STORE=${DOC_STORE} isn't a known store: documents can't be ingested`);
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
