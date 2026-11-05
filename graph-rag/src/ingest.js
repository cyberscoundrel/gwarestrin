/**
 * Documents (see documents.js and docstore.js): ingesting a stored text into an entry, sections and extracted
 * facts; reading it back.
 */
import { randomUUID } from "node:crypto";
import { effectiveHome } from "./positions.js";
import { liveClause, parseValidUntil } from "./extent.js";
import { createDocStore } from "./docstore.js";
import { chunk, extractionPrompt, MAX_CHARS, MAX_SECTIONS, parseExtraction, preview, sectionName } from "./documents.js";
import { DOC_STORE, EXTRACT_MODEL, GRADER_MODEL, log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, PENDING_ID_RE } from "./db.js";
import { chat } from "./models.js";
import { homeFilter, positionMap, resolveWriteHome, writerOf } from "./scope.js";
import { derivedFloor, recordReads } from "./floor.js";
import { queueWrite, upsertEntities } from "./write.js";

/** ---- documents (see documents.js and docstore.js) ---- */

export const docStore = createDocStore(DOC_STORE);
let ingestQueue = Promise.resolve(); // one document at a time (grading and embedding are the cost)
const chunkCache = new Map(); // doc id -> chunks (deterministic from the stored text)

export async function ensureDocumentSchema() {
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
    written_by: p.written_by,
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
      written_by: p.written_by,
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
        written_by: p.written_by,
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
export async function sweepOrphanDocuments(minAgeMs = 86_400_000) {
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

export function startIngest(p) {
  ingestQueue = ingestQueue
    .then(() => ingestDocument(p))
    .catch(async (e) => {
      log.warn(`document "${p.title}" (${p.doc_id}) failed: ${String(e).slice(0, 200)}`);
      await adbCommand(`UPDATE ${ENTITY_LABEL} SET _doc_status = 'failed' WHERE _kind = 'document' AND _doc_id = :d`, "sql", { d: p.doc_id }).catch(() => {});
    });
  return ingestQueue;
}

/** an ingest from a tool call: stored now; ingested now, or after approval for queued writers */
export async function requestIngest({ title, description, text, extract, home: requestedHome, valid_until }, identity, scope) {
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
    ...writerOf(identity),
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
export async function readDocument({ document, section, count = 3 }, identity, scope) {
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
