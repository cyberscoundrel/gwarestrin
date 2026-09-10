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
} = process.env;

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
    if (k.startsWith("embed_")) continue;
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

async function searchGraph({ query, facets, k = 8, temporal_filter }) {
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

  let where = "";
  if (temporal_filter) {
    const p = temporal_filter.property;
    if (!PROP_RE.test(p)) throw new Error(`invalid temporal property: ${p}`);
    const conds = [`${p} IS NOT NULL`];
    if (temporal_filter.after) conds.push(`${p} >= '${esc(temporal_filter.after)}'`);
    if (temporal_filter.before) conds.push(`${p} <= '${esc(temporal_filter.before)}'`);
    where = " WHERE " + conds.join(" AND ");
  }

  const byName = new Map();
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
        if (!name) continue;
        const entry =
          byName.get(name) ??
          {
            name,
            labels: row["@type"] ? [row["@type"]] : [],
            properties: publicProps(row),
            score: -2,
            facets: [],
          };
        if (score > entry.score) entry.score = score;
        if (!entry.facets.includes(facet)) entry.facets.push(facet);
        byName.set(name, entry);
      }
    }
  }

  let results = [...byName.values()].sort((a, b) => b.score - a.score);

  // lexical fallback when embeddings are unavailable or the index is empty —
  // never when a temporal_filter is set (lexical matching can't honor it)
  if (!vectorWorked && !temporal_filter) {
    const terms = query.split(/\s+/).filter((t) => t.length > 2).slice(0, 6);
    if (terms.length > 0) {
      const conds = terms.map((t) => `(name CONTAINS '${esc(t)}' OR text_identity CONTAINS '${esc(t)}')`);
      const rows = await adbQuery(
        `SELECT FROM ${ENTITY_LABEL} WHERE (${conds.join(" OR ")}) LIMIT ${k}`,
      );
      results = rows.map((row) => ({ name: row.name, properties: publicProps(row), score: null, facets: ["lexical"] }));
    }
  }

  // 1-hop relationships for the top results
  let relationships = [];
  if (results.length > 0) {
    const names = results.slice(0, 12).map((r) => `'${esc(r.name)}'`).join(",");
    try {
      const rows = await adbQueryLang(
        `MATCH (n:${ENTITY_LABEL})-[r]-(m) WHERE n.name IN [${names}] ` +
          `RETURN n.name AS src, type(r) AS rel, m.name AS dst LIMIT 50`,
        "cypher",
      );
      relationships = rows.map((r) => ({ from: r.src, rel: r.rel, to: r.dst }));
    } catch {
      /* traversal is best-effort */
    }
  }

  return {
    query,
    results: results.slice(0, 12),
    relationships,
    ...(embedFailed ? { note: "embedding backend unavailable; lexical fallback used" } : {}),
  };
}

async function upsertEntities({ entities }) {
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
    await adbCommand(
      `MERGE (n:${ENTITY_LABEL} {name: '${esc(e.name)}'}) ` +
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
      await adbCommand(
        `UPDATE (SELECT FROM ${ENTITY_LABEL} WHERE name = '${esc(name)}') ` +
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
  for (const n of nodes) {
    const props = publicProps(n);
    const labels = Object.keys(n).filter((k) => k.startsWith(ENTITY_LABEL) === false && k.startsWith("@") === false && k === k.toLowerCase() === false);
    // ArcadeDB rows expose the type via @type; keep labels implicit
    void labels;
    texts.push(identityText(n.name, n["@type"] ? [n["@type"]] : [], props));
    names.push(n.name);
  }
  const vecs = await embedBatch(texts);
  for (let i = 0; i < names.length; i++) {
    await adbCommand(
      `UPDATE (SELECT FROM ${ENTITY_LABEL} WHERE name = '${esc(names[i])}') ` +
        `SET embed_identity = [${vecs[i].join(",")}], text_identity = '${esc(texts[i])}'`,
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

async function executeGraph({ command, language = "cypher" }) {
  if (!["cypher", "sql"].includes(language)) throw new Error("language must be cypher or sql");
  if (typeof command !== "string" || !command.trim()) throw new Error("command required");
  if (/^\s*(DROP DATABASE|DROP TYPE|TRUNCATE)/i.test(command)) {
    throw new Error("destructive schema/database operations are not permitted");
  }
  const result = await adbCommand(command, language);
  return { result };
}

async function schemaGraph() {
  const types = await adbQuery("SELECT FROM schema:types").catch(() => []);
  if (types.length > 0) return { types };
  const indexes = await adbQuery("SELECT FROM schema:indexes").catch(() => []);
  return { types: [], indexes };
}

function sanitizeFacet(name) {
  if (typeof name !== "string" || !FACET_RE.test(name)) throw new Error(`invalid facet name: ${String(name)}`);
  return name.toLowerCase();
}

/** ---- MCP server (fresh instance per request: stateless) ---- */
const facetDoc = Object.entries(FACETS)
  .map(([f, d]) => `- ${f}: ${d}`)
  .join("\n");

function createServer() {
  const server = new McpServer({ name: "graph-rag", version: "0.2.0" });

  server.tool(
    "search_graph",
    `Semantic (embedding) search over the knowledge graph. The query is embedded and matched
against per-facet vector indexes. Advertised facets:
${facetDoc}
Custom facets created via upsert_entities are also searchable. Use facets to narrow the
kind of question: e.g. "what tools were ordered recently" -> facets ["temporal","state"];
"where is the hammer" -> ["location"]. temporal_filter narrows by a datetime property on
the node (after/before are ISO datetimes, property compared as string dates). Falls back
to lexical matching if the embedding backend is unavailable.`,
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
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchGraph(args)) }] }),
  );

  server.tool(
    "upsert_entities",
    `Create or update graph entities with per-facet semantic indexes. For each entity provide
facet texts — a concise natural-language sentence per facet capturing that aspect of the
entity (facet list below). Provide only facets you have information for; each becomes
searchable via search_graph. Unknown facet names are allowed and indexed lazily (e.g.
"procurement", "compliance"). Include datetime facts BOTH as properties (e.g. ordered_at:
"2026-01-15") so temporal_filter can use them, and inside facet texts.
${facetDoc}`,
    {
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
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await upsertEntities(args)) }] }),
  );

  server.tool(
    "embed_backfill",
    "Embed the identity facet for graph nodes written via raw queries without embeddings (deterministic labels+name+properties text). Run after bulk writes.",
    { limit: z.number().int().min(1).max(256).optional() },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await backfillIdentity(args?.limit ?? 64)) }] }),
  );

  server.tool(
    "query_graph",
    "Run a READ-ONLY query against the knowledge graph (openCypher or SQL). Use for exact identifiers, structure, and schema exploration (schema_graph for the type list). Returns JSON rows.",
    {
      query: z.string().min(1),
      language: z.enum(["cypher", "sql"]).optional(),
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await queryGraph(args)) }] }),
  );

  server.tool(
    "execute_graph",
    "Execute a WRITE command against the knowledge graph (openCypher or SQL): create/update vertices and edges, set properties. Destructive schema operations are rejected.",
    {
      command: z.string().min(1),
      language: z.enum(["cypher", "sql"]).optional(),
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await executeGraph(args)) }] }),
  );

  server.tool(
    "schema_graph",
    "List the knowledge-graph types and indexes (vertex/edge types, properties, vector and full-text indexes).",
    {},
    async () => ({ content: [{ type: "text", text: JSON.stringify(await schemaGraph()) }] }),
  );

  return server;
}

/** ---- http ---- */
const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: each POST is self-contained
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  try {
    await createServer().connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null });
    }
  }
});

app.get("/mcp", (_req, res) => res.status(405).json({ error: "POST only (stateless)" }));
app.get("/health", (_req, res) => res.json({ ok: true, facets_indexed: [...knownIndexes] }));

/** boot: ensure advertised indexes + periodic identity sweep */
async function boot() {
  for (const facet of Object.keys(FACETS)) await ensureIndex(facet);
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
