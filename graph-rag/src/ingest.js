/**
 * The record (R2: "The condensed document and its sections are the record"): a document a person put on record,
 * stored whole in the document store, with an entry and one entry per section in the graph; reading it back.
 *
 * Two ways in, one path:
 *  - a condensed document (recordDocument): the chat agent, which was in the conversation, condenses its
 *    on-record sections into text sections (model/record.js). No claims, no class names (R2, R5).
 *  - a file (recordFile): a file uploaded on record is a record (R11.12). Its text is stored as it is and
 *    chunked into sections; nothing condenses it.
 *
 * Every section starts at the position of the person who put it on record (R11.5), is held no lower than what
 * the writing agent read, the person's own notes aside (R11.13), and is checked once by the restrict-only typed
 * check (R4; check.js through floor.js placeEntities): uncertain holds one level higher, no answer is admin-only
 * until checked (R11.11). The document's title and description take the strictest home among its sections
 * (R11.13; document-home.js). Once written, each section is queued for a worker the way every write is
 * (write.js; the filing stream splits by home, R11.6).
 */
import { createHash } from "node:crypto";
import { effectiveHome, homeName } from "./positions.js";
import { liveClause, parseValidUntil } from "./extent.js";
import { createDocStore } from "./docstore.js";
import { chunk, MAX_CHARS, MAX_SECTIONS, normalizeDocument, parseRecordText, prepareRecord, preview, recordId, renderRecord, sectionChunks, sectionName, stableUuid } from "./documents.js";
import { DOC_STORE, log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, PENDING_ID_RE } from "./db.js";
import { homeFilter, personOf, positionMap, resolveWriteHome, writerOf } from "./scope.js";
import { derivedFloor, recordReads } from "./floor.js";
import { decideWrite, queueWrite, upsertEntities } from "./write.js";
import { settleDocument, untitled } from "./document-home.js";
import { threadPosition } from "./record-state.js";

/** ---- documents (see documents.js and docstore.js) ---- */

export const docStore = createDocStore(DOC_STORE);
let ingestQueue = Promise.resolve(); // one document at a time (the check and embedding are the cost)
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
  // a record's sections are the spans its ingest stored (older texts without spans are chunked as they read)
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
 * name or one of the section names it would use. A reused title is usually a different record: it is written
 * beside the earlier one, never over it.
 */
async function recordTitle(base, docId, origin, spans) {
  const names = [base, ...spans.map((sp) => sectionName(base, sp.index, sp.heading))];
  const taken = await adbQuery(`SELECT _doc_id FROM ${ENTITY_LABEL} WHERE name IN :names AND _origin = :origin AND (_doc_id IS NULL OR _doc_id <> :doc) LIMIT 1`, { names, origin, doc: docId });
  return taken.length ? distinctTitle(base, docId) : base;
}

/**
 * Ingest a stored record: its sections (each checked once, starting at its recorder's position and no lower
 * than what its writer read), then its entry at the strictest home among them (settleDocument), and their
 * links. A record is never replaced: running one again (a retry, a failed ingest) finishes what is missing
 * and adds nothing.
 */
async function ingestDocument(p) {
  const { text, meta } = await docStore.get(p.doc_id);
  const chunks = Array.isArray(meta?.sections) ? sectionChunks(text, meta.sections) : chunk(text);
  chunkCache.set(p.doc_id, chunks);
  const vu = p.valid_until; // ISO, "lasting", or undefined: as resolved when it was written
  const keyOf = (name, kind) => adbQuery(`SELECT @rid AS rid, _home, _doc_id, _on_record FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin AND _kind = :kind LIMIT 1`, { name, origin: p.home, kind });
  const title = await recordTitle(p.title, p.doc_id, p.home, chunks);
  p = { ...p, title };
  // a section keeps the name it has (a re-run); a new one has no title until settled
  const held = await adbQuery(`SELECT name, _section FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :d`, { d: p.doc_id });
  const nameOf = (c) => held.find((r) => Number(r._section) === c.index)?.name ?? sectionName(untitled(p.doc_id), c.index, c.heading);
  for (let i = 0; i < chunks.length; i += 32) {
    await upsertEntities({
      entities: chunks.slice(i, i + 32).map((c) => ({
        name: nameOf(c),
        facets: { identity: preview(c.text) },
        _embed: { identity: c.embedText },
        // the check reads the whole section (the facet is a preview), and so does its recheck
        _text: c.text,
        ...(c.heading ? { properties: { heading: c.heading } } : {}),
        ...(vu ? { valid_until: vu } : {}),
        _system: { _kind: "section", _doc_id: p.doc_id, _doc_title: untitled(p.doc_id), _section: c.index },
      })),
      // R11.5: a section starts at the position of the person who put it on record
      home: p.home,
      written_by: p.written_by,
      // R11.13: an agent cannot write lower than what it read (the person's own notes don't count)
      floor: p.floor ?? p.home,
      regrade_floor: p.floor,
      written_at: p.written_at,
    });
  }
  // R11.13: the title takes the strictest home among its sections; its own floor is what its writer read
  const base = p.floor ?? p.home;
  const titleHome = (await settleDocument(p.doc_id, { title: p.title, base })) ?? base;
  const description = p.description ?? `${p.title}, put on record by ${p.record?.recorded_by ?? "a person"}`;
  await upsertEntities({
    entities: [
      {
        name: p.title,
        facets: { identity: `${p.title}: ${description}` },
        properties: { description, sections: chunks.length, characters: text.length, on_record: true, ...(p.file ? { file: p.file } : {}) },
        ...(vu ? { valid_until: vu } : {}),
        _system: {
          _kind: "document",
          _doc_id: p.doc_id,
          _doc_status: "ingesting",
          _doc_base: base,
          // the on-record marker (model/schema.js): who put it on record, under which position, why
          ...(p.record ? { _recorded_by: p.record.recorded_by, _recorded_at: p.record.recorded_at, _record_position: p.record.position, _record_reason: p.record.reason } : {}),
        },
      },
    ],
    home: p.home,
    written_by: p.written_by,
    floor: p.floor,
    written_at: p.written_at,
    // not checked on its own: it goes where its most restricted section is (R11.13)
    decided: [{ home: titleHome, note: `with its most restricted section (${homeName(positionMap, titleHome)})`, graded: true }],
  });
  const doc = (await keyOf(p.title, "document"))[0];
  if (!doc) throw new Error("the document entry wasn't written");
  // a boolean can't ride in _system (strings and numbers only): set the marker itself here
  await adbCommand(`UPDATE ${String(doc.rid)} SET _on_record = true`);
  const sections = await adbQuery(`SELECT @rid AS rid, _home, _section FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :d ORDER BY _section`, { d: p.doc_id });
  for (const [i, s] of sections.entries()) {
    await edgeOnce("PART_OF", String(s.rid), String(doc.rid));
    if (sections[i + 1]) await edgeOnce("NEXT", String(s.rid), String(sections[i + 1].rid));
  }
  // a section's check can have finished after the first settling (a recheck): settle once more
  await settleDocument(p.doc_id);
  await adbCommand(`UPDATE ${String(doc.rid)} SET _doc_status = 'ready'`);
  log.info(`record "${p.title}" (${p.doc_id}): ${sections.length} sections, on record by ${p.record?.recorded_by ?? p.written_by ?? "?"}${p.file ? ` from the file ${p.file}` : ""}`);
  return { doc_id: p.doc_id, sections: sections.length, on_record: true };
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
      log.warn(`record "${p.title}" (${p.doc_id}) failed: ${String(e).slice(0, 600)}`);
      await adbCommand(`UPDATE ${ENTITY_LABEL} SET _doc_status = 'failed' WHERE _kind = 'document' AND _doc_id = :d`, "sql", { d: p.doc_id }).catch(() => {});
    });
  return ingestQueue;
}

/**
 * Where a record by this identity starts (R11.5): the position the person chose when they put the thread on
 * record, when it is one they hold; else their own position (the identity's default write home).
 *
 * NEEDS A RULING (record 9): the tool's `home` argument is gone, so an agent can't start a record anywhere
 * else; a person moves a section afterwards with set_home, as before.
 */
export function recordHome(identity, scope) {
  const chosen = threadPosition(identity);
  if (chosen && Array.isArray(scope.held) && scope.held.includes(chosen)) return chosen;
  return resolveWriteHome(scope, undefined);
}

/** who recorded it and under which position: the server's, from the token (an agent's record is its person's); open mode takes the document's word */
function recorderOf(identity, home) {
  const person = identity.open ? null : personOf(identity.user);
  return { person, position: home ?? "unscoped" };
}

/**
 * Store a prepared record and start (or queue) its ingest. Shared by condensed documents and files. A re-send
 * is the same record (`doc_id` derives from what it says): finished once it is not ingested again.
 */
async function putOnRecord({ doc_id, title, description, text, spans, document, file }, identity, home, valid_until) {
  const existing = (await adbQuery(`SELECT name, _doc_status, sections FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: doc_id }))[0];
  if (existing?._doc_status === "ready") {
    return { already_on_record: true, doc_id, title: existing.name, sections: Number(existing.sections) || spans.length, note: "this is already on record; nothing was added" };
  }
  if (text.length > MAX_CHARS) throw new Error(`a record is limited to ${MAX_CHARS} characters`);
  if (spans.length > MAX_SECTIONS) throw new Error(`a record is limited to ${MAX_SECTIONS} sections (this one has ${spans.length})`);
  const now = Date.parse(document.recorded_at) || Date.now();
  const v = parseValidUntil(valid_until, now);
  // the write-or-propose decision: the identity's queuing and the derived floor (write.js decideWrite)
  // NEEDS A RULING (record 5): a queued writer's record still waits for approval before it is checked and filed
  const decision = decideWrite(identity, { kind: "ingest" }, { origin: home });
  const queued = decision.action !== "direct";
  const recordName = await recordTitle(title, doc_id, home, spans);
  const payload = {
    doc_id,
    title: recordName,
    description: String(description ?? `${title}, put on record by ${document.recorded_by}`).slice(0, 500),
    home,
    floor: derivedFloor(identity, home),
    written_at: document.recorded_at,
    ...(v ? { valid_until: v.valid_until ?? "lasting" } : {}),
    chars: text.length,
    sections: spans.length,
    ...(file ? { file } : {}),
    // the record itself: who, under which position, why (the approval runs this payload)
    record: { recorded_by: document.recorded_by, recorded_at: document.recorded_at, position: document.position, reason: document.reason },
    ...writerOf(identity),
  };
  await docStore.put(doc_id, text, { title: payload.title, by: identity.user, at: payload.written_at, on_record: true, sections: spans, ...(file ? { file } : {}) });
  const said = { doc_id, title: recordName, on_record: true, sections: spans.length, position: homeName(positionMap, home) };
  if (queued) {
    // a re-send while the first waits for approval is that same proposal
    const waiting = (await adbQuery("SELECT id FROM PendingWrite WHERE kind = 'ingest' AND status = 'pending' AND payload LIKE :p LIMIT 1", { p: `%"doc_id":"${doc_id}"%` }))[0];
    const q = waiting ? { queued: true, pendingId: waiting.id } : await queueWrite({ kind: "ingest", payload: JSON.stringify(payload), user: identity.user, home: decision.home ?? home });
    return { ...q, ...said, ...(decision.reason ? { reason: decision.reason } : {}), note: "the record is stored; it's checked and filed once the ingest is approved" };
  }
  void startIngest(payload);
  return { ingesting: true, ...said, note: "each section is being checked and embedded, then a worker files it; search finds it in a minute or two" };
}

/**
 * A condensed document put on record: the contract's shape (model/record.js), validated before anything is
 * stored. The tool call's title and description fill what the document left out; the recording person,
 * position and time are the server's. Also reachable through ingest_document with the document as JSON.
 */
export async function recordDocument(raw, identity, scope, { title, description, valid_until } = {}) {
  if (!docStore) throw new Error("no document store is configured (DOC_STORE)");
  const home = recordHome(identity, scope);
  const { person, position } = recorderOf(identity, home);
  const at = new Date().toISOString();
  const prepare = (when) => prepareRecord(raw, { title, description, recorded_by: person ?? undefined, position, now: Date.parse(when), stamp: person ? { recorded_by: person, position, recorded_at: when } : undefined });
  let document = prepare(at);
  const doc_id = recordId(raw, { person: document.recorded_by, home, title: document.title });
  // a failed run continues from its first recording
  const first = (await adbQuery(`SELECT _recorded_at FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: doc_id }))[0]?._recorded_at;
  if (first) document = prepare(first);
  const { text, spans } = renderRecord(document);
  return putOnRecord({ doc_id, title: document.title, description: document.description, text, spans, document }, identity, home, valid_until);
}

/** the reason a file is on record when the person gave none */
const fileReason = (file) => `the file ${file} was uploaded on record`;

/**
 * A file uploaded on record (R11.12: a file uploaded on record is a record and gets a worker): its text is the
 * record, stored as it is and chunked into sections. Nothing condenses it. Title: the one given, else the file
 * name. The same file sent again by the same person is the same record.
 *
 * NEEDS A RULING (record 4): only text is taken (a PDF or an office file must be turned into text first), and a
 * file is not condensed.
 */
export async function recordFile({ file, text, title, description, reason, valid_until }, identity, scope) {
  if (!docStore) throw new Error("no document store is configured (DOC_STORE)");
  const name = String(file ?? "").trim().replace(/^.*[\\/]/, "").slice(0, 200);
  const body = String(text ?? "").replace(/\r\n?/g, "\n");
  if (body.trim().length < 20) throw new Error("the file's text is empty (only text files can be put on record)");
  if (body.includes("\u0000")) throw new Error("this file isn't text: only text files can be put on record");
  if (body.length > MAX_CHARS) throw new Error(`a record is limited to ${MAX_CHARS} characters`);
  const chunks = chunk(body);
  if (chunks.length === 0) throw new Error("the file's text is empty");
  if (chunks.length > MAX_SECTIONS) throw new Error(`a record is limited to ${MAX_SECTIONS} sections (this one has ${chunks.length})`);
  const home = recordHome(identity, scope);
  const { person, position } = recorderOf(identity, home);
  const shown = String(title ?? "").trim() || name || "Uploaded file";
  const hash = createHash("sha256").update(body).digest("hex");
  const doc_id = stableUuid("file", person ?? identity.user ?? "", home ?? "", shown, hash);
  const first = (await adbQuery(`SELECT _recorded_at FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: doc_id }))[0]?._recorded_at;
  // the contract's shape for the record's marker (model/record.js): every section text, recorded by the person
  const document = normalizeDocument(
    {
      title: shown,
      description: description ?? null,
      recorded_by: person ?? identity.user ?? "unknown",
      position,
      reason: String(reason ?? "").trim() || fileReason(name || shown),
      recorded_at: first ?? new Date().toISOString(),
      sections: chunks.map((c) => ({ heading: c.heading || null, text: c.text })),
    },
    {},
  );
  const spans = chunks.map((c) => ({ index: c.index, heading: c.heading ?? "", start: c.start, end: c.end }));
  return putOnRecord({ doc_id, title: shown, description: document.description, text: body, spans, document, file: name || undefined }, identity, home, valid_until);
}

/**
 * ingest_document: everything a person or their agent ingests is a record (R2, R11.12). A condensed document
 * rides in `text` as JSON; any other text is a file's, stored as it is and chunked.
 */
export async function requestIngest({ title, description, text, valid_until, file, reason }, identity, scope) {
  if (!docStore) throw new Error("no document store is configured (DOC_STORE)");
  const record = parseRecordText(text);
  if (record) return recordDocument(record, identity, scope, { title, description, valid_until });
  return recordFile({ file, text, title, description, reason, valid_until }, identity, scope);
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
