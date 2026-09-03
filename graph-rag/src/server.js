/**
 * graph-rag MCP sidecar — facet-indexed vector retrieval over the neo4j graph.
 *
 * Each node facet (identity, location, state, temporal, relations, + any
 * custom name) gets its own vector index over `n.embed_<facet>`; facet texts
 * are authored by the calling model via upsert_entities. search_graph embeds
 * the query and fans out over facet indexes, merging best-score-per-node.
 * A periodic sweep backfills the deterministic identity facet for nodes that
 * were written via raw cypher (model-authored facets are never synthesized).
 */
import express from "express";
import neo4j from "neo4j-driver";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const {
  NEO4J_URI = "bolt://neo4j:7687",
  NEO4J_DATABASE = "neo4j",
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
const LABEL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** advertised facets — upsert may add custom ones (lazily indexed) */
const FACETS = {
  identity: "what the entity is — type, purpose, defining attributes",
  location: "where it is / where it lives / where it runs",
  state: "current status, condition, availability",
  temporal: "when things happened — ordered, arrived, installed, updated",
  relations: "how it connects to other entities",
};

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.none, { disableLosslessIntegers: true });
const session = () => driver.session({ database: NEO4J_DATABASE });

/** facets we know an index exists for (advertised at boot + lazily created) */
const knownIndexes = new Set();

function sanitizeFacet(name) {
  if (typeof name !== "string" || !FACET_RE.test(name)) throw new Error(`invalid facet name: ${String(name)}`);
  return name.toLowerCase();
}

async function ensureIndex(facet) {
  if (knownIndexes.has(facet)) return;
  await session().run(
    `CREATE VECTOR INDEX entity_${facet} IF NOT EXISTS
     FOR (n:${ENTITY_LABEL}) ON (n.embed_${facet})
     OPTIONS {indexConfig: {\`vector.dimensions\`: ${EMBED_DIM_N}, \`vector.similarity_function\`: 'cosine'}}`,
  );
  knownIndexes.add(facet);
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

/** strip vector props from node output (they would flood the LLM context) */
function publicProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k.startsWith("embed_")) continue;
    out[k] = v;
  }
  return out;
}

function nodeOut(node, extra = {}) {
  return {
    name: node.properties.name,
    labels: node.labels.filter((l) => l !== ENTITY_LABEL),
    properties: publicProps(node.properties),
    ...extra,
  };
}

/** deterministic identity text for the sweep/backfill */
function identityText(node) {
  const labels = node.labels.filter((l) => l !== ENTITY_LABEL).join(",");
  const props = Object.entries(publicProps(node.properties))
    .filter(([k]) => k !== "updated_at")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("; ");
  return `${labels ? `[${labels}] ` : ""}${node.properties.name}${props ? " — " + props : ""}`;
}

/** ---- tool implementations ---- */

async function searchGraph({ query, facets, k = 8, temporal_filter }) {
  const facetList = (facets?.length ? facets : Object.keys(FACETS)).map(sanitizeFacet);
  for (const f of facetList) {
    // advertised facets get their index ensured on demand; custom facets are
    // only searchable if an upsert already created one
    if (!knownIndexes.has(f) && FACETS[f]) await ensureIndex(f);
  }

  const tprop = temporal_filter?.property ?? null;
  const tafter = temporal_filter?.after ?? null;
  const tbefore = temporal_filter?.before ?? null;

  const byNode = new Map();
  let vectorWorked = false;
  let embedFailed = false;

  let embedding = null;
  try {
    embedding = (await embedBatch([query]))[0];
  } catch {
    embedFailed = true;
  }

  if (embedding) {
    const s = session();
    try {
      for (const facet of facetList) {
        try {
          const res = await s.run(
            `CALL db.index.vector.queryNodes($index, $k, $vec)
             YIELD node, score
             WHERE $tprop IS NULL OR (
               node[$tprop] IS NOT NULL
               AND ($tafter IS NULL OR datetime(toString(node[$tprop])) >= datetime($tafter))
               AND ($tbefore IS NULL OR datetime(toString(node[$tprop])) <= datetime($tbefore))
             )
             RETURN node, score ORDER BY score DESC LIMIT $k`,
            { index: `entity_${facet}`, k, vec: embedding, tprop, tafter, tbefore },
          );
          vectorWorked = vectorWorked || res.records.length > 0;
          for (const rec of res.records) {
            const node = rec.get("node");
            const score = rec.get("score");
            const key = node.properties.name;
            const entry = byNode.get(key) ?? nodeOut(node, { score: -1, facets: [] });
            if (score > entry.score) entry.score = score;
            if (!entry.facets.includes(facet)) entry.facets.push(facet);
            byNode.set(key, entry);
          }
        } catch {
          /* no index for this facet yet — nothing embedded under it */
        }
      }
    } finally {
      s.close();
    }
  }

  let results = [...byNode.values()].sort((a, b) => b.score - a.score);

  // lexical fallback when embeddings are unavailable or the index is empty
  if (!vectorWorked) {
    const terms = query.split(/\s+/).filter((t) => t.length > 2).slice(0, 6);
    if (terms.length > 0) {
      const s = session();
      try {
        const res = await s.run(
          `MATCH (n:${ENTITY_LABEL})
           WHERE any(t IN $terms WHERE n.name CONTAINS t OR (
             n.text_identity IS NOT NULL AND n.text_identity CONTAINS t))
           RETURN n LIMIT $k`,
          { terms, k },
        );
        results = res.records.map((rec) => nodeOut(rec.get("n"), { score: null, facets: ["lexical"] }));
      } finally {
        s.close();
      }
    }
  }

  // 1-hop relationships for the top results
  let relationships = [];
  if (results.length > 0) {
    const s = session();
    try {
      const names = results.slice(0, 12).map((r) => r.name);
      const res = await s.run(
        `MATCH (n:${ENTITY_LABEL})-[r]-(m)
         WHERE n.name IN $names
         RETURN n.name AS src, type(r) AS rel,
                (CASE WHEN startNode(r) = n THEN '->' ELSE '<-' END) AS dir,
                coalesce(m.name, '') AS dst,
                [l IN labels(m) WHERE l <> $entityLabel] AS dstLabels
         LIMIT 100`,
        { names, entityLabel: ENTITY_LABEL },
      );
      relationships = res.records.map((rec) => ({
        from: rec.get("src"),
        rel: rec.get("rel"),
        dir: rec.get("dir"),
        to: rec.get("dst"),
        toLabels: rec.get("dstLabels"),
      }));
    } finally {
      s.close();
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
  const s = session();
  try {
    for (const e of entities) {
      if (!e?.name || typeof e.name !== "string") throw new Error("entity.name required");
      const labels = (e.labels ?? []).map(String).filter((l) => LABEL_RE.test(l) && l !== ENTITY_LABEL);
      const props = {};
      for (const [k, v] of Object.entries(e.properties ?? {})) {
        if (!/^[a-z][a-z0-9_]*$/i.test(k)) throw new Error(`invalid property name: ${k}`);
        if (["string", "number", "boolean"].includes(typeof v)) props[k] = v;
      }
      const labelClause = labels.map((l) => `SET n:\`${l}\``).join(" ");
      await s.run(
        `MERGE (n:${ENTITY_LABEL} {name: $name})
         SET n += $props, n.updated_at = datetime() ${labelClause}`,
        { name: e.name, props },
      );
      merged++;
      for (const [facet, text] of Object.entries(e.facets ?? {})) {
        const f = sanitizeFacet(facet);
        if (typeof text !== "string" || !text.trim()) continue;
        await ensureIndex(f);
        jobs.push({ name: e.name, facet: f, text: text.slice(0, 4000) });
      }
    }
  } finally {
    s.close();
  }

  // one batched embeddings call for all facet texts
  let embedded = 0;
  if (jobs.length > 0) {
    const vecs = await embedBatch(jobs.map((j) => j.text));
    const s2 = session();
    try {
      for (let i = 0; i < jobs.length; i++) {
        const { name, facet, text } = jobs[i];
        await s2.run(
          `MERGE (n:${ENTITY_LABEL} {name: $name})
           SET n.embed_${facet} = $vec, n.text_${facet} = $text`,
          { name, vec: vecs[i], text },
        );
        embedded++;
      }
    } finally {
      s2.close();
    }
  }

  return { merged, embedded, facets_indexed: [...knownIndexes] };
}

async function backfillIdentity(limit = 64) {
  const s = session();
  let nodes;
  try {
    const res = await s.run(
      `MATCH (n:${ENTITY_LABEL}) WHERE n.embed_identity IS NULL
       RETURN n LIMIT $limit`,
      { limit },
    );
    nodes = res.records.map((rec) => rec.get("n"));
  } finally {
    s.close();
  }
  if (nodes.length === 0) return { backfilled: 0 };

  const texts = nodes.map((n) => identityText(n));
  const vecs = await embedBatch(texts);
  const s2 = session();
  try {
    for (let i = 0; i < nodes.length; i++) {
      await s2.run(
        `MATCH (n:${ENTITY_LABEL} {name: $name})
         SET n.embed_identity = $vec, n.text_identity = $text`,
        { name: nodes[i].properties.name, vec: vecs[i], text: texts[i] },
      );
    }
  } finally {
    s2.close();
  }
  return { backfilled: nodes.length, ...(nodes.length === limit ? { note: "more may remain; run again" } : {}) };
}

/** ---- MCP server (fresh instance per request: stateless) ---- */
const facetDoc = Object.entries(FACETS)
  .map(([f, d]) => `- ${f}: ${d}`)
  .join("\n");

function createServer() {
  const server = new McpServer({ name: "graph-rag", version: "0.1.0" });

  server.tool(
    "search_graph",
    `Semantic (embedding) search over the knowledge graph. The query is embedded and matched
against per-facet vector indexes. Advertised facets:
${facetDoc}
Custom facets created via upsert_entities are also searchable. Use facets to narrow the
kind of question: e.g. "what tools were ordered recently" -> facets ["temporal","state"];
"where is the hammer" -> ["location"]. temporal_filter narrows by a datetime property on
the node (after/before are ISO datetimes). Falls back to lexical matching if the
embedding backend is unavailable.`,
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
    "Embed the identity facet for graph nodes written via raw cypher without embeddings (deterministic labels+name+properties text). Run after bulk writes.",
    { limit: z.number().int().min(1).max(256).optional() },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await backfillIdentity(args?.limit ?? 64)) }] }),
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
