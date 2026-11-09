/**
 * Reads: semantic search over the facet indexes, the raw read pass-through, the schema, and what is known
 * about a thing.
 */
import { effectiveHome } from "./positions.js";
import { isExpired, liveClause } from "./extent.js";
import { normalize } from "./things.js";
import { log } from "./context.js";
import { adbQuery, adbQueryLang, ensureIndex, ENTITY_LABEL, esc, FACET_RE, FACETS, knownIndexes, likeTerm, PROP_RE, RID_RE } from "./db.js";
import { embedBatch } from "./models.js";
import { homeFilter, homeLabel, positionMap, SCOPED, viaOf } from "./scope.js";
import { recordReads } from "./floor.js";
import { ASSERTIONS, openNeedsClause } from "./requests.js";
import { enqueue } from "./worker-pool.js";
import { asOfDate, claimsOfThing, claimView, inForceAt, stateAt, stateView } from "./state.js";

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
export function publicProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k.startsWith("embed_") || k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

/** deterministic identity text for the sweep/backfill */
export function identityText(name, labels, props) {
  const l = labels.filter((x) => x !== ENTITY_LABEL).join(",");
  const kv = Object.entries(props)
    .filter(([k]) => k !== "updated_at")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("; ");
  return `${l ? `[${l}] ` : ""}${name}${kv ? " — " + kv : ""}`;
}

/** ---- tool implementations ---- */

export async function searchGraph({ query, facets, k = 8, temporal_filter, as_of, include_expired = false, assertions_only = false }, scope = { homes: null }, readHomes = [], { demand = true, ownEntry = null } = {}) {
  console.log(`[graph-rag] search_graph: ${JSON.stringify({ query: query.slice(0, 80), facets, temporal_filter, ...(as_of ? { as_of } : {}) })}`);
  // as_of: hits that bear claims are kept only while one of their claims was in force at that date
  const asOf = as_of === undefined || as_of === null || as_of === "" ? null : asOfDate(as_of);
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
    // a filter applied after ranking (temporal, as_of) needs more candidates than it will keep
    const innerK = temporal_filter || asOf ? Math.min(k * 3, 96) : k;
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
    const top = [...best].sort((a, b) => b[1].score - a[1].score).slice(0, asOf ? innerK : k);
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
          ...viaOf(scope, row),
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
        ...viaOf(scope, row),
        ...validityOf(row),
        ...questionOf(row),
        score: null,
        facets: ["lexical"],
        rid: row["@rid"],
      }));
    }
  }

  // as_of: a hit that bears claims says something about a date only while one of its claims was in
  // force then (decision 3 closes an open claim at the next one on the same attribute, so the
  // siblings on the same subjects are read too); a hit bearing none passes as it is
  if (asOf && results.length) results = await coveringAsOf(results, asOf, scope);

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

/**
 * The results that bear claims, filtered to those with a claim in force at `asOf` (each then carries
 * `claims`: what it said that held then); results bearing no claim pass unchanged. Claims are the
 * ones the caller sees (claimsOfThing, the per-claim rule): a claim it can't see neither shows here
 * nor ends a claim it can, and a hit whose claims it can't see at all passes as one bearing none.
 */
async function coveringAsOf(results, asOf, scope) {
  const rids = results.map((r) => String(r.rid)).filter((x) => RID_RE.test(x));
  if (!rids.length) return results;
  const edges = await adbQuery(`SELECT @rid AS rid, @out AS src, @in AS dst FROM (SELECT expand(outE('CLAIMS')) FROM [${rids.join(",")}]) LIMIT 500`).catch(() => []);
  if (!edges.length) return results;
  // every claim on the subjects these hits bear on, so a later claim elsewhere closes an open one here
  const subjects = [...new Set(edges.map((e) => String(e.dst)).filter((x) => RID_RE.test(x)))].slice(0, 24);
  const labels = new Map((await adbQuery(`SELECT @rid AS rid, label, _keys FROM [${subjects.join(",")}]`).catch(() => [])).map((t) => [String(t.rid), t]));
  const claims = [];
  for (const s of subjects) {
    const t = labels.get(s);
    const thing = { rid: s, name: t?.label ?? s, keys: Array.isArray(t?._keys) ? t._keys : [], class: null };
    claims.push(...(await claimsOfThing(thing, { scope })).claims);
  }
  // closed over the caller's claims of the subject, then what held at the date, by the hit it came from
  const bearing = new Set(claims.map((c) => c.source));
  const held = Map.groupBy(inForceAt(claims, asOf), (c) => c.source);
  const out = [];
  for (const r of results) {
    const rid = String(r.rid);
    if (!bearing.has(rid)) {
      out.push(r);
      continue;
    }
    const mine = held.get(rid);
    if (!mine) continue;
    // (the hit is the section: no need to name it again on each claim)
    out.push({ ...r, claims: mine.map(({ section: _section, ...c }) => ({ subject: c.subject.name, ...claimView(c) })) });
  }
  return out;
}

/** ---- pass-through: raw graph access for agents (credentials stay here) ---- */

export async function queryGraph({ query, language = "cypher" }) {
  if (!["cypher", "sql"].includes(language)) throw new Error("language must be cypher or sql");
  if (typeof query !== "string" || !query.trim()) throw new Error("query required");
  // defense in depth: ArcadeDB's /query endpoint already rejects writes
  if (/^\s*(CREATE|MERGE|DELETE|SET|DROP|REMOVE|DETACH|INSERT|UPDATE)\b/i.test(query)) {
    throw new Error("query_graph is read-only; use execute_graph for writes");
  }
  const rows = await adbQueryLang(query, language);
  return { rows };
}

export async function schemaGraph() {
  const types = await adbQuery("SELECT FROM schema:types").catch(() => []);
  if (types.length > 0) return { types };
  const indexes = await adbQuery("SELECT FROM schema:indexes").catch(() => []);
  return { types: [], indexes };
}

/** what we know about a thing: the statements about it the caller can see, and its current state (the latest claim per attribute) */
export async function aboutThing({ name }, identity, scope) {
  const n = normalize(name);
  const visible = homeFilter(scope);
  const things = await adbQuery(
    `SELECT @rid AS rid, label, _thing_type, _alias_norms, _keys, _class FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (_norm = :n OR _alias_norms CONTAINS :n OR _keys CONTAINS :raw)${visible} LIMIT 5`,
    { n, raw: String(name).trim() },
  );
  if (things.length === 0) return { things: [], note: `nothing called "${name}" that you can see is known yet` };
  const out = [];
  const read = [];
  const now = new Date().toISOString();
  for (const t of things) {
    // the claims about it the caller sees (state.js): the sections they rest on count as read too
    const { claims, read: claimRead } = await claimsOfThing({ rid: String(t.rid), name: t.label, type: t._thing_type, keys: t._keys ?? [], class: t._class ?? null }, { scope });
    read.push(...claimRead);
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
      ...(t._class ? { class: t._class } : {}),
      // what holds now, from the claims the caller sees; stateAsOf (tools-queries.js) gives another date
      state: stateView(stateAt(claims, now)),
      claims: claims.length,
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
