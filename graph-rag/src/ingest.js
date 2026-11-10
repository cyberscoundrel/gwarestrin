/**
 * Documents (see documents.js and docstore.js): ingesting a stored text into an entry and its sections; reading
 * it back. A condensed document (R2: the condensed document and its sections are the record) takes the same
 * path: its sections are given rather than chunked, and the document entry carries the on-record marker.
 */
import { randomUUID } from "node:crypto";
import { effectiveHome, homeName } from "./positions.js";
import { liveClause, parseValidUntil } from "./extent.js";
import { createDocStore } from "./docstore.js";
import { chunk, MAX_CHARS, MAX_SECTIONS, parseRecordText, prepareRecord, preview, recordId, renderRecord, sectionChunks, sectionName } from "./documents.js";
import { DOC_STORE, log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, PENDING_ID_RE } from "./db.js";
import { homeFilter, personOf, positionMap, resolveWriteHome, writerOf } from "./scope.js";
import { derivedFloor, placeEntities, recordReads } from "./floor.js";
import { decideWrite, queueWrite, upsertEntities } from "./write.js";
import { settleDocument, untitled } from "./document-home.js";

/** ---- documents (see documents.js and docstore.js) ---- */

export const docStore = createDocStore(DOC_STORE);
let ingestQueue = Promise.resolve(); // one document at a time (grading and embedding are the cost)
const chunkCache = new Map(); // doc id -> chunks (deterministic from the stored text)

export async function ensureDocumentSchema() {
  for (const prop of ["_doc_id", "_doc_title", "_doc_status", "_doc_base", "_heading_own"]) await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._section IF NOT EXISTS INTEGER`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (_doc_id) NOTUNIQUE`).catch(() => {});
  for (const t of ["PART_OF", "NEXT"]) await adbCommand(`CREATE EDGE TYPE ${t} IF NOT EXISTS`).catch(() => {});
}

async function storedChunks(docId) {
  if (chunkCache.has(docId)) return chunkCache.get(docId);
  const { text, meta } = await docStore.get(docId);
  // a condensed document's sections are the spans its ingest stored; a manual's are chunked from its text
  const cs = Array.isArray(meta?.sections) ? sectionChunks(text, meta.sections) : chunk(text);
  if (chunkCache.size > 50) chunkCache.delete(chunkCache.keys().next().value);
  chunkCache.set(docId, cs);
  return cs;
}

async function edgeOnce(type, from, to) {
  const out = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('${type}')) FROM ${from})`).catch(() => []);
  if (out.some((e) => String(e.dst) === to)) return;
  await adbCommand(`CREATE EDGE ${type} FROM ${from} TO ${to}`);
}

/** a name of its own for a document whose title is taken: short enough that sectionName keeps the id, so its sections are distinct too */
const distinctTitle = (base, docId) => `${String(base).slice(0, 68)} (${docId.slice(0, 8)})`;

/**
 * The name a record goes under at this origin: its title, unless another document or entry already holds that
 * name or one of the section names it would use. A model picks titles by topic, so a reused title is usually a
 * different record: it is written beside the earlier one, never over it (only a manual is replaced by a new text
 * under its title).
 */
async function recordTitle(base, docId, origin, spans) {
  const names = [base, ...spans.map((sp) => sectionName(base, sp.index, sp.heading))];
  const taken = await adbQuery(`SELECT _doc_id FROM ${ENTITY_LABEL} WHERE name IN :names AND _origin = :origin AND (_doc_id IS NULL OR _doc_id <> :doc) LIMIT 1`, { names, origin, doc: docId });
  return taken.length ? distinctTitle(base, docId) : base;
}

/**
 * Ingest a stored document: its sections (graded, never below the entry's
 * grade, named for no one until they are placed), then its entry (no lower
 * than its most restricted section: settleDocument) and their links. Re-ingesting a
 * manual's title replaces the manual's sections; a record is never replaced, and
 * running one again (a retry, a failed ingest) finishes what is missing and adds nothing.
 */
async function ingestDocument(p) {
  const writtenAt = Date.parse(p.written_at) || Date.now();
  const { text, meta } = await docStore.get(p.doc_id);
  const chunks = p.record ? sectionChunks(text, meta?.sections ?? []) : chunk(text);
  chunkCache.set(p.doc_id, chunks);
  const vu = p.valid_until; // ISO, "lasting", or undefined: as resolved when it was written
  const keyOf = (name, kind) => adbQuery(`SELECT @rid AS rid, _home, _doc_id, _on_record FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin AND _kind = :kind LIMIT 1`, { name, origin: p.home, kind });
  let title = p.record ? await recordTitle(p.title, p.doc_id, p.home, meta?.sections ?? []) : p.title;
  let before = (await keyOf(title, "document"))[0];
  // a manual never replaces a record: it goes beside it, under a name of its own
  if (!p.record && before?._on_record === true && before._doc_id !== p.doc_id) {
    title = distinctTitle(p.title, p.doc_id);
    before = (await keyOf(title, "document"))[0];
  }
  p = { ...p, title };
  const docEntry = {
    name: p.title,
    facets: { identity: `${p.title}: ${p.description}` },
    properties: { description: p.description, sections: chunks.length, characters: text.length, ...(p.record ? { on_record: true } : {}) },
    ...(vu ? { valid_until: vu } : {}),
  };
  // the entry's title is graded now and written once its sections are placed: until then no reader below a section that turns out restricted can find it
  const [docPlaced] = await placeEntities([docEntry], p.home, p.floor ?? p.home, writtenAt);
  // sections can be filed higher than the document (grading restricts), never lower
  const docHome = effectiveHome(positionMap, docPlaced.home);
  // a section keeps the name it has (a re-run, or a manual replaced in place by its title); a new one has no title until settled
  const held = await adbQuery(`SELECT name, _section, _doc_id FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id IN :ids`, { ids: [p.doc_id, before?._doc_id].filter(Boolean) });
  const heldName = (c) => {
    const rows = held.filter((r) => Number(r._section) === c.index);
    const same = rows.find((r) => r._doc_id === p.doc_id);
    if (same) return same.name;
    return rows.find((r) => [sectionName(p.title, c.index, c.heading), sectionName(untitled(r._doc_id), c.index, c.heading)].includes(r.name))?.name;
  };
  const nameOf = (c) => heldName(c) ?? sectionName(untitled(p.doc_id), c.index, c.heading);
  for (let i = 0; i < chunks.length; i += 32) {
    await upsertEntities({
      entities: chunks.slice(i, i + 32).map((c) => ({
        name: nameOf(c),
        facets: { identity: preview(c.text) },
        _embed: { identity: c.embedText },
        ...(c.heading ? { properties: { heading: c.heading } } : {}),
        ...(vu ? { valid_until: vu } : {}),
        _system: { _kind: "section", _doc_id: p.doc_id, _doc_title: untitled(p.doc_id), _section: c.index },
      })),
      home: p.home,
      written_by: p.written_by,
      // the entry's grade floors its sections; a home held through a grader outage isn't a grade, or a section could never come down from it
      floor: docPlaced.ungraded ? (p.floor ?? p.home) : docHome,
      // a regrade takes what its writer read, and the document as it then stands
      regrade_floor: p.floor,
      written_at: p.written_at,
    });
  }
  // now the title has a home: the entry goes there (no lower than its most restricted section), and each section shows what it may
  const titleHome = await settleDocument(p.doc_id, { title: p.title, base: docHome });
  await upsertEntities({
    entities: [
      {
        ...docEntry,
        _system: {
          _kind: "document",
          _doc_id: p.doc_id,
          _doc_status: "ingesting",
          _doc_base: docHome,
          // the on-record marker (model/schema.js): who put it on record, under which position, why
          ...(p.record ? { _recorded_by: p.record.recorded_by, _recorded_at: p.record.recorded_at, _record_position: p.record.position, _record_reason: p.record.reason } : {}),
        },
      },
    ],
    home: p.home,
    written_by: p.written_by,
    floor: p.floor,
    written_at: p.written_at,
    decided: [titleHome === docHome ? docPlaced : { ...docPlaced, home: titleHome, note: `${docPlaced.note}; raised to ${homeName(positionMap, titleHome)} with its most restricted section` }],
  });
  const doc = (await keyOf(p.title, "document"))[0];
  if (!doc) throw new Error("the document entry wasn't written");
  // a boolean can't ride in _system (strings and numbers only): set the marker itself here
  if (p.record) await adbCommand(`UPDATE ${String(doc.rid)} SET _on_record = true`);
  const sections = await adbQuery(`SELECT @rid AS rid, _home, _section, _doc_title FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :d ORDER BY _section`, { d: p.doc_id });
  for (const [i, s] of sections.entries()) {
    await edgeOnce("PART_OF", String(s.rid), String(doc.rid));
    if (sections[i + 1]) await edgeOnce("NEXT", String(s.rid), String(sections[i + 1].rid));
  }
  // a manual re-ingested under its title: sections past the new end, and the old text, go (a record's name is its own)
  if (before?._doc_id && before._doc_id !== p.doc_id) {
    await adbCommand(`DELETE FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :old`, "sql", { old: before._doc_id }).catch(() => {});
    await docStore.remove(before._doc_id).catch(() => {});
    chunkCache.delete(before._doc_id);
  }
  await adbCommand(`UPDATE ${String(doc.rid)} SET _doc_status = 'ready'`);
  log.info(`document "${p.title}" (${p.doc_id}): ${sections.length} sections${p.record ? `, on record by ${p.record.recorded_by}` : ""}`);
  return { doc_id: p.doc_id, sections: sections.length, ...(p.record ? { on_record: true } : {}) };
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
      log.warn(`document "${p.title}" (${p.doc_id}) failed: ${String(e).slice(0, 600)}`);
      await adbCommand(`UPDATE ${ENTITY_LABEL} SET _doc_status = 'failed' WHERE _kind = 'document' AND _doc_id = :d`, "sql", { d: p.doc_id }).catch(() => {});
    });
  return ingestQueue;
}

/**
 * A condensed document put on record: the contract's document shape (model/record.js), validated here before
 * anything is stored. The tool call's title and description fill what the document left out; the recording
 * person, position and time are the server's. Stored and ingested like a manual (after approval for queued
 * writers), with the on-record marker. Also reachable through ingest_document with the document as JSON in `text`.
 */
export async function recordDocument(raw, identity, scope, { title, description, home: requestedHome, valid_until } = {}) {
  if (!docStore) throw new Error("no document store is configured (DOC_STORE)");
  const home = resolveWriteHome(scope, requestedHome);
  let now = Date.now();
  // who recorded it, under which position and when are the server's: an agent's record counts as the person it
  // acts for, at the position its token holds, now, whatever the document says.
  // Only in open mode (no identities, standalone development) does the condenser's word stand.
  const person = identity.open ? null : personOf(identity.user);
  const position = identity.positions?.includes(home) ? home : (identity.positions?.[0] ?? home ?? "unscoped");
  const prepare = (at) => prepareRecord(raw, { title, description, recorded_by: person ?? undefined, position, now: at, stamp: person ? { recorded_by: person, position, recorded_at: new Date(at).toISOString() } : undefined });
  let document = prepare(now);
  // a re-send is the same document: finished once it is not ingested again, and a failed run continues from its
  // first recording
  const doc_id = recordId(raw, { person: document.recorded_by, home, title: document.title });
  const existing = (await adbQuery(`SELECT name, _doc_status, _recorded_at, sections FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: doc_id }))[0];
  if (existing?._doc_status === "ready") {
    return { already_on_record: true, doc_id, title: existing.name, sections: Number(existing.sections) || document.sections.length, note: "this document is already on record; nothing was added" };
  }
  if (existing?._recorded_at) {
    now = Date.parse(existing._recorded_at) || now;
    document = prepare(now);
  }
  const { text, spans } = renderRecord(document);
  if (text.length > MAX_CHARS) throw new Error(`documents are limited to ${MAX_CHARS} characters`);
  if (spans.length > MAX_SECTIONS) throw new Error(`documents are limited to ${MAX_SECTIONS} sections (this one has ${spans.length})`);
  const v = parseValidUntil(valid_until, now);
  // the write-or-propose decision: queuing and the derived floor (write.js decideWrite)
  const decision = decideWrite(identity, { kind: "ingest" }, { origin: home });
  const queued = decision.action !== "direct";
  // the name it goes under (checked again when the ingest runs: an earlier record keeps its title)
  const recordName = await recordTitle(document.title, doc_id, home, spans);
  const payload = {
    doc_id,
    title: recordName,
    description: (document.description ?? `${document.title}, put on record by ${document.recorded_by}`).slice(0, 500),
    home,
    floor: derivedFloor(identity, home),
    written_at: document.recorded_at,
    ...(v ? { valid_until: v.valid_until ?? "lasting" } : {}),
    chars: text.length,
    sections: spans.length,
    // the record itself: who, under which position, why (the approval runs this payload)
    record: { recorded_by: document.recorded_by, recorded_at: document.recorded_at, position: document.position, reason: document.reason },
    ...writerOf(identity),
  };
  await docStore.put(doc_id, text, { title: payload.title, by: identity.user, at: payload.written_at, on_record: true, sections: spans });
  if (queued) {
    // a re-send while the first waits for approval is that same proposal
    const waiting = (await adbQuery("SELECT id FROM PendingWrite WHERE kind = 'ingest' AND status = 'pending' AND payload LIKE :p LIMIT 1", { p: `%"doc_id":"${doc_id}"%` }))[0];
    const q = waiting ? { queued: true, pendingId: waiting.id } : await queueWrite({ kind: "ingest", payload: JSON.stringify(payload), user: identity.user, home: decision.home ?? home });
    return {
      ...q,
      doc_id,
      title: recordName,
      on_record: true,
      sections: spans.length,
      ...(decision.reason ? { reason: decision.reason } : {}),
      note: "the record is stored; it's added to the knowledge graph once the ingest is approved",
    };
  }
  void startIngest(payload);
  return { ingesting: true, doc_id, title: recordName, on_record: true, sections: spans.length, note: "sections are being graded and embedded; search finds them in a minute or two" };
}

/** an ingest from a tool call: stored now; ingested now, or after approval for queued writers */
export async function requestIngest({ title, description, text, home: requestedHome, valid_until }, identity, scope) {
  if (!docStore) throw new Error("no document store is configured (DOC_STORE)");
  // a condensed document rides in text as JSON: the record path, not the chunker
  const record = parseRecordText(text);
  if (record) return recordDocument(record, identity, scope, { title, description, home: requestedHome, valid_until });
  const body = String(text ?? "");
  if (body.trim().length < 20) throw new Error("the document text is empty");
  if (body.length > MAX_CHARS) throw new Error(`documents are limited to ${MAX_CHARS} characters`);
  const chunks = chunk(body);
  if (chunks.length > MAX_SECTIONS) throw new Error(`documents are limited to ${MAX_SECTIONS} sections (this one has ${chunks.length})`);
  const home = resolveWriteHome(scope, requestedHome);
  const now = Date.now();
  const v = parseValidUntil(valid_until, now);
  const doc_id = randomUUID();
  // the one write-or-propose rule (write.js decideWrite): the identity's queuing and the derived floor
  const decision = decideWrite(identity, { kind: "ingest" }, { origin: home });
  const payload = {
    doc_id,
    title: String(title).trim().slice(0, 200),
    description: String(description).trim().slice(0, 500),
    home,
    floor: decision.floor ?? derivedFloor(identity, home),
    written_at: new Date(now).toISOString(),
    ...(v ? { valid_until: v.valid_until ?? "lasting" } : {}),
    chars: body.length,
    sections: chunks.length,
    ...writerOf(identity),
  };
  await docStore.put(doc_id, body, { title: payload.title, by: identity.user, at: payload.written_at });
  if (decision.action !== "direct") {
    const q = await queueWrite({ kind: "ingest", payload: JSON.stringify(payload), user: identity.user, home: decision.home ?? home });
    return { ...q, doc_id, sections: chunks.length, note: "the document is stored; it's added to the knowledge graph once the ingest is approved" };
  }
  void startIngest(payload);
  return { ingesting: true, doc_id, sections: chunks.length, note: "sections are being graded and embedded; search finds them in a minute or two" };
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
  const rows = await adbQuery(`SELECT _home, _section, _doc_title, heading, _written_by FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :d${visible} ORDER BY _section`, { d: docId });
  if (rows.length === 0) throw new Error(status === "ingesting" ? "this document is still being ingested" : `no document "${ref}" you can see`);
  // the document's title when its entry is visible to the reader, else what the section shows
  const entry = (await adbQuery(`SELECT name FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d${visible} LIMIT 1`, { d: docId }))[0];
  title = entry?.name ?? rows[0]._doc_title;
  const chunks = await storedChunks(docId);
  const seen = new Set(rows.map((r) => Number(r._section)));
  // the heading as the section shows it (document-home.js): the stored text's may repeat a title this reader can't see
  const shownHeading = new Map(rows.map((r) => [Number(r._section), r.heading]));
  const n = Math.max(1, Math.min(6, Number(count) || 3));
  const from = section ? Math.max(0, Number(section) - 1) : 0;
  const picked = chunks.filter((c) => c.index >= from && seen.has(c.index)).slice(0, n);
  recordReads(identity, rows.filter((r) => r._written_by !== scope.person && picked.some((c) => c.index === Number(r._section))).map((r) => effectiveHome(positionMap, r._home)));
  return {
    document: title,
    document_id: docId,
    // only the sections you can see are listed and returned
    contents: chunks.filter((c) => seen.has(c.index)).map((c) => ({ section: c.index + 1, heading: shownHeading.get(c.index) || undefined })),
    sections: picked.map((c) => ({ section: c.index + 1, heading: shownHeading.get(c.index) || undefined, text: c.text })),
  };
}
