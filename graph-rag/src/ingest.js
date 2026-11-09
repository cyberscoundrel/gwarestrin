/**
 * Documents (see documents.js and docstore.js): ingesting a stored text into an entry, sections and extracted
 * facts; reading it back. A condensed document (docs/ORGANIZATION-MODEL.md, "Inputs: on record, condensed,
 * per claim") takes the same path: its sections are given rather than chunked, the document entry carries the
 * on-record marker, and each claim becomes a CLAIMS edge from its section (model/schema.js) homed no lower
 * than the section.
 */
import { randomUUID } from "node:crypto";
import { commonAncestor, effectiveHome, homeName } from "./positions.js";
import { liveClause, parseValidUntil } from "./extent.js";
import { createDocStore } from "./docstore.js";
import { chunk, extractionPrompt, MAX_CHARS, MAX_SECTIONS, parseExtraction, parseRecordText, prepareRecord, preview, renderRecord, sectionChunks, sectionName } from "./documents.js";
import { authorityOf, claimHome } from "./model/authority.js";
import { statements, TYPES } from "./model/schema.js";
import { DOC_STORE, EXTRACT_MODEL, GRADER_MODEL, log } from "./context.js";
import { adbCommand, adbQuery, ensureIndex, ENTITY_LABEL, PENDING_ID_RE, RID_RE } from "./db.js";
import { chat, embedBatch } from "./models.js";
import { homeFilter, personOf, positionMap, resolveWriteHome, writerOf } from "./scope.js";
import { derivedFloor, recordReads } from "./floor.js";
import { queueWrite, upsertEntities } from "./write.js";
// the Authority stream's exports, once merged (docs/ORGANIZATION-MODEL.md; MAP.md): decideWrite in write.js
// decides a record's write by its claims' authority, placeByClaims in placement.js homes an entity by the
// claims it carries. Read through namespaces so this module runs on main as it is and takes them when present.
import * as writeRules from "./write.js";
import * as placementRules from "./placement.js";
import { policy } from "./org-policy.js";
import { findThing } from "./linker.js";
import { normalize, thingName } from "./things.js";

/** ---- documents (see documents.js and docstore.js) ---- */

export const docStore = createDocStore(DOC_STORE);
let ingestQueue = Promise.resolve(); // one document at a time (grading and embedding are the cost)
const chunkCache = new Map(); // doc id -> chunks (deterministic from the stored text)

export async function ensureDocumentSchema() {
  for (const prop of ["_doc_id", "_doc_title", "_doc_status"]) await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._section IF NOT EXISTS INTEGER`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (_doc_id) NOTUNIQUE`).catch(() => {});
  for (const t of ["PART_OF", "NEXT", "SOURCED_FROM"]) await adbCommand(`CREATE EDGE TYPE ${t} IF NOT EXISTS`).catch(() => {});
  // the organization model's shapes a record needs (idempotent DDL from the contract): the on-record marker
  // on a document, the CLAIMS edge, and the class type claims are checked against
  for (const sql of statements({ Entity: TYPES.Entity, CLAIMS: TYPES.CLAIMS, CommitmentClass: TYPES.CommitmentClass })) await adbCommand(sql).catch(() => {});
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

/**
 * Ingest a stored document: its entry, its sections (graded, never below
 * the entry), their links, and, only when the ingest said so, extracted
 * facts. Re-ingesting the same title replaces the sections.
 */
async function ingestDocument(p) {
  const writtenAt = Date.parse(p.written_at) || Date.now();
  const { text, meta } = await docStore.get(p.doc_id);
  const chunks = p.record ? sectionChunks(text, meta?.sections ?? []) : chunk(text);
  chunkCache.set(p.doc_id, chunks);
  const vu = p.valid_until; // ISO, "lasting", or undefined: as resolved when it was written
  const keyOf = (name, kind) => adbQuery(`SELECT @rid AS rid, _home, _doc_id FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin AND _kind = :kind LIMIT 1`, { name, origin: p.home, kind });
  const before = (await keyOf(p.title, "document"))[0];
  await upsertEntities({
    entities: [
      {
        name: p.title,
        facets: { identity: `${p.title}: ${p.description}` },
        properties: { description: p.description, sections: chunks.length, characters: text.length, extracted: Boolean(p.extract), ...(p.record ? { on_record: true } : {}) },
        ...(vu ? { valid_until: vu } : {}),
        _system: {
          _kind: "document",
          _doc_id: p.doc_id,
          _doc_status: "ingesting",
          // the on-record marker (model/schema.js): who put it on record, under which position, why
          ...(p.record ? { _recorded_by: p.record.recorded_by, _recorded_at: p.record.recorded_at, _record_position: p.record.position, _record_reason: p.record.reason } : {}),
        },
      },
    ],
    home: p.home,
    written_by: p.written_by,
    floor: p.floor,
    written_at: p.written_at,
  });
  const doc = (await keyOf(p.title, "document"))[0];
  if (!doc) throw new Error("the document entry wasn't written");
  // a boolean can't ride in _system (strings and numbers only): set the marker itself here
  if (p.record) await adbCommand(`UPDATE ${String(doc.rid)} SET _on_record = true`);
  // sections can be filed higher than the document (grading restricts), never lower
  const docHome = effectiveHome(positionMap, doc._home);
  // a condensed document's sections with claims are not the grader's to judge (the grader runs only on
  // text that maps to no class): they are written where their claims put them; the rest go the usual way
  const claimsOfSection = new Map(p.record ? p.record.sections.filter((sec) => (sec.claims ?? []).length > 0).map((sec) => [sec.index, sec.claims]) : []);
  // with the Authority stream's placement, an entity carrying `claims` is homed by them inside upsertEntities
  // (never graded, _claim_classes and _authority stored); until then this module writes them itself
  const byClaims = typeof placementRules.placeByClaims === "function";
  if (!byClaims) for (const c of chunks) if (claimsOfSection.has(c.index)) await writeClaimedSection(p, c, docHome, vu);
  const graded = byClaims ? chunks : chunks.filter((c) => !claimsOfSection.has(c.index));
  for (let i = 0; i < graded.length; i += 32) {
    await upsertEntities({
      entities: graded.slice(i, i + 32).map((c) => ({
        name: sectionName(p.title, c.index, c.heading),
        facets: { identity: preview(c.text) },
        _embed: { identity: c.embedText },
        ...(c.heading ? { properties: { heading: c.heading } } : {}),
        ...(vu ? { valid_until: vu } : {}),
        ...(byClaims && claimsOfSection.has(c.index) ? { claims: claimsOfSection.get(c.index) } : {}),
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
  // a condensed document's claims, extracted once by the condenser: a CLAIMS edge from each section
  const claims = p.record ? await recordClaims(p, sections) : 0;
  await adbCommand(`UPDATE ${String(doc.rid)} SET _doc_status = 'ready', facts = :facts${p.record ? ", claims = :claims" : ""}`, "sql", { facts, claims });
  log.info(
    `document "${p.title}" (${p.doc_id}): ${sections.length} sections${p.record ? `, on record by ${p.record.recorded_by}, ${claims} claims` : p.extract ? `, ${facts} extracted facts` : ", no extraction (as asked)"}`,
  );
  return { doc_id: p.doc_id, sections: sections.length, facts, ...(p.record ? { claims, on_record: true } : {}) };
}

/**
 * A section with claims, written as upsertEntities writes a section but without grading and without the
 * linker's queue (its subjects are its claims'): homed where the document is, and raised to a claim's
 * authority position by recordClaims once the policy names one. Re-ingesting the same title updates it
 * in place, like any section ((name, origin) is the key).
 */
async function writeClaimedSection(p, c, home, vu) {
  const name = sectionName(p.title, c.index, c.heading);
  await ensureIndex("identity");
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.heading IF NOT EXISTS STRING`).catch(() => {});
  const [vec] = await embedBatch([c.embedText.slice(0, 6000)]);
  const validUntil = vu && vu !== "lasting" ? vu : null;
  // (name, origin) is the key, as upsertEntities writes it: update in place, else a new vertex
  const existing = (await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE name = :s_name AND _origin = :s_origin LIMIT 1`, { s_name: name, s_origin: p.home }))[0];
  const set = `updated_at = :s_now, _home = :s_home, _grade = :s_grade, _ungraded = null, _kind = 'section', _doc_id = :s_doc, _doc_title = :s_title, _section = :s_index${p.written_by ? ", _written_by = :s_writer" : ""}${c.heading ? ", heading = :s_heading" : ""}${validUntil ? ", _valid_until = :s_until, _valid_by = 'writer'" : ""}, text_identity = :s_text, embed_identity = [${vec.join(",")}]`;
  const params = {
    s_now: new Date().toISOString(),
    s_home: home,
    s_grade: "a section with claims: homed by them, no lower than the document (not graded)",
    s_doc: p.doc_id,
    s_title: p.title,
    s_index: c.index,
    s_writer: p.written_by,
    s_heading: c.heading,
    s_until: validUntil,
    s_text: preview(c.text).slice(0, 4000),
    s_name: name,
    s_origin: p.home,
  };
  if (existing) await adbCommand(`UPDATE ${String(existing.rid)} SET ${set}`, "sql", params);
  else await adbCommand(`CREATE VERTEX ${ENTITY_LABEL} SET name = :s_name, _origin = :s_origin, ${set}`, "sql", params);
}

/** the policy's authority map (classes and attributes to positions; policy.authorityMap once the Authority stream stores one); null until then */
const authorityPolicy = () => {
  const m = policy?.authorityMap ?? (policy && (policy.classes || policy.attributes || policy.default) ? { classes: policy.classes ?? {}, attributes: policy.attributes ?? {}, default: policy.default } : null);
  return m && (Object.keys(m.classes ?? {}).length || Object.keys(m.attributes ?? {}).length || m.default) ? m : null;
};

/** an actor's thing type, or "other" for an instance (its class says what it is) */
const subjectType = (subject) => (subject.actor && ["person", "customer", "supplier"].includes(subject.actor) ? subject.actor : "other");

/**
 * The thing a claim is about: found by its record key, else by name (a thing of any type when exactly one
 * goes by it); made when there is none. A subject earns its node (admission rule 1: an identity that
 * outlives any one document) and is minted here by a person's record, with its class and key, so the
 * worker finds it by key when it reconciles. A class subject (scope "class") is the class's own thing.
 */
async function subjectThing(subject, home, cache) {
  const id = subject.key ? `key|${subject.key}` : `${subject.scope === "class" ? "class" : subject.class ?? subject.actor}|${normalize(subject.name ?? subject.class)}`;
  if (cache.has(id)) return cache.get(id);
  const name = subject.scope === "class" ? subject.name ? `${subject.class} (${subject.name})` : subject.class : subject.name ?? subject.key;
  const type = subjectType(subject);
  let found = await findThing({ ...(subject.key ? { key: subject.key } : {}), name, type }).catch(() => null);
  if (!found && subject.key) found = await findThing({ key: subject.key, name }).catch(() => null);
  if (!found) found = await findThing({ name }).catch(() => null);
  let rid = found ? String(found.rid) : null;
  if (rid && subject.key) {
    const cur = (await adbQuery(`SELECT _keys, _class FROM ${rid}`))[0] ?? {};
    const keys = cur._keys ?? [];
    if (!keys.includes(subject.key)) await adbCommand(`UPDATE ${rid} SET _keys = :t_keys`, "sql", { t_keys: [...keys, subject.key].slice(-10) }).catch(() => {});
    if (!cur._class && subject.class) await adbCommand(`UPDATE ${rid} SET _class = :t_class`, "sql", { t_class: subject.class }).catch(() => {});
  }
  if (!rid) {
    const n = normalize(name);
    const vec = (await embedBatch([`${type}: ${name}`]).catch(() => [null]))[0];
    await adbCommand(
      `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, label = :label, _kind = 'thing', _thing_type = :t, _norm = :n, _alias_norms = :aliases, _keys = :keys, _homes = :homes, _home = :root${subject.class ? ", _class = :cls" : ""}${vec ? `, embed_thing = [${vec.join(",")}]` : ""}, updated_at = :now`,
      "sql",
      { name: thingName(type, name), label: name, t: type, n, aliases: [], keys: subject.key ? [subject.key] : [], homes: [home], root: positionMap?.root ?? home, cls: subject.class, now: new Date().toISOString() },
    );
    rid = String((await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = :t AND _norm = :n ORDER BY @rid DESC LIMIT 1`, { t: type, n }))[0]?.rid);
  } else {
    // seen from this record's home too
    const homes = (await adbQuery(`SELECT _homes FROM ${rid}`))[0]?._homes ?? [];
    if (!homes.includes(home)) await adbCommand(`UPDATE ${rid} SET _homes = :t_homes`, "sql", { t_homes: [...homes, home] }).catch(() => {});
  }
  if (!RID_RE.test(rid)) throw new Error(`no thing for the subject ${name}`);
  cache.set(id, rid);
  return rid;
}

/**
 * The claims of a condensed document: one CLAIMS edge from the section each was extracted from to its
 * subject, carrying the primitive, class, attribute, value and interval, homed where the section is (a claim
 * is seen by whoever sees its section, decision 5) and raised to its class's authority position once the
 * policy names one, in which case the section is raised with it (no lower than its most restricted claim).
 * A new claim closes the open interval of the previous claim on the same attribute of the same subject
 * (decision 3); events are points and close nothing.
 */
async function recordClaims(p, sections) {
  const byIndex = new Map(sections.map((s) => [Number(s._section), { rid: String(s.rid), home: effectiveHome(positionMap, s._home) }]));
  const things = new Map();
  const authority = authorityPolicy();
  let n = 0;
  for (const section of p.record.sections) {
    const s = byIndex.get(section.index);
    if (!s) continue;
    for (const c of section.claims ?? []) {
      let home = s.home;
      if (authority && positionMap) {
        // the stricter of the section's home and the claim's authority home
        const raised = commonAncestor(positionMap, [s.home, claimHome(positionMap, s.home, authorityOf(authority, c.class, c.attribute))]);
        if (raised !== s.home) {
          home = raised;
          await adbCommand(`UPDATE ${s.rid} SET _home = :h, _grade = :g`, "sql", { h: raised, g: `raised to ${homeName(positionMap, raised)}: a claim on ${c.class}/${c.attribute}` }).catch(() => {});
          s.home = raised;
        }
      }
      const thing = await subjectThing(c.subject, p.home, things);
      const id = c.id ?? randomUUID();
      await adbCommand(
        `CREATE EDGE CLAIMS FROM ${s.rid} TO ${thing} SET id = :c_id, kind = :c_kind, class = :c_class, attribute = :c_attribute, value = :c_value${c.value_num === null || c.value_num === undefined ? "" : ", value_num = :c_num"}, valid_from = :c_from${c.valid_until ? ", valid_until = :c_until" : ""}, recorded_at = :c_at, recorded_by = :c_by, _home = :c_home`,
        "sql",
        { c_id: id, c_kind: c.kind, c_class: c.class, c_attribute: c.attribute, c_value: c.value, c_num: c.value_num, c_from: c.valid_from, c_until: c.valid_until, c_at: c.recorded_at, c_by: c.recorded_by, c_home: home },
      );
      if (c.kind !== "event") {
        // the previous open claim on this attribute of this subject ends where this one starts
        await adbCommand(
          `UPDATE CLAIMS SET valid_until = :c_from, closed_by = :c_id WHERE @in = ${thing} AND class = :c_class AND attribute = :c_attribute AND kind <> 'event' AND valid_until IS NULL AND valid_from < :c_from AND id <> :c_id`,
          "sql",
          { c_from: c.valid_from, c_id: id, c_class: c.class, c_attribute: c.attribute },
        ).catch((e) => log.warn(`closing earlier claims on ${c.class}/${c.attribute}: ${String(e).slice(0, 120)}`));
      }
      n++;
    }
  }
  return n;
}

/** the confirmed classes claims are checked against; none yet means no claim can name one (decision 2: the section is stored, with no claim) */
async function confirmedClasses() {
  const rows = await adbQuery("SELECT name, stages, record_table FROM CommitmentClass WHERE status = 'confirmed' LIMIT 500").catch(() => []);
  return rows.map((r) => ({ name: r.name, stages: Array.isArray(r.stages) ? r.stages : [], record_table: r.record_table ?? null }));
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
      log.warn(`document "${p.title}" (${p.doc_id}) failed: ${String(e).slice(0, 600)}`);
      await adbCommand(`UPDATE ${ENTITY_LABEL} SET _doc_status = 'failed' WHERE _kind = 'document' AND _doc_id = :d`, "sql", { d: p.doc_id }).catch(() => {});
    });
  return ingestQueue;
}

/**
 * A condensed document put on record (docs/ORGANIZATION-MODEL.md, "Inputs"): the contract's document shape
 * (model/claims.js), validated here before anything is stored, with its claims. The tool call's title and
 * description fill what the document left out; the recording person and position default to the identity's.
 * Stored and ingested like a manual (after approval for queued writers), with the on-record marker and a
 * CLAIMS edge per claim. Reachable today through ingest_document with the document as JSON in `text`
 * (the tool table in server.js isn't this module's); a dedicated tool can call this directly.
 */
export async function recordDocument(raw, identity, scope, { title, description, home: requestedHome, valid_until } = {}) {
  if (!docStore) throw new Error("no document store is configured (DOC_STORE)");
  const home = resolveWriteHome(scope, requestedHome);
  const now = Date.now();
  const classes = await confirmedClasses();
  // the record is under the authority of the token's person: an agent's record counts as the person it
  // acts for (model/schema.js), whatever the document says; in open mode the condenser's word stands
  const recordedBy = identity.open ? null : personOf(identity.user);
  const document = prepareRecord(recordedBy ? { ...raw, recorded_by: recordedBy } : raw, {
    title,
    description,
    recorded_by: recordedBy ?? undefined,
    position: identity.positions?.[0] ?? home ?? "unscoped",
    classes,
    now,
  });
  const { text, spans } = renderRecord(document);
  if (text.length > MAX_CHARS) throw new Error(`documents are limited to ${MAX_CHARS} characters`);
  if (spans.length > MAX_SECTIONS) throw new Error(`documents are limited to ${MAX_SECTIONS} sections (this one has ${spans.length})`);
  const v = parseValidUntil(valid_until, now);
  const doc_id = randomUUID();
  const allClaims = document.sections.flatMap((s) => s.claims);
  const claims = allClaims.length;
  // the write-or-propose decision: the Authority stream's one rule over the claims' classes when it is
  // merged (a record whose claims lie with a higher authority is proposed there), today's site rule until then
  const decision = typeof writeRules.decideWrite === "function" ? writeRules.decideWrite(identity, { kind: "ingest", claims: allClaims }, { origin: home }) : null;
  const queued = decision ? decision.action !== "direct" : identity.caps.write === "queued";
  // the document's floor is the writer's derived floor alone, as a manual's is: the decision's floor spans every
  // claim in the record (the common ancestor of their authorities), and applying it to the document would lift
  // every section to the most restricted claim's home. Each section is homed by its own claims inside
  // upsertEntities (model/README.md: no lower than its most restricted claim and no lower than its document),
  // the free-text sections by the grader; the decision's home is where the proposal is reviewed.
  const payload = {
    doc_id,
    title: document.title,
    description: (document.description ?? `${document.title}, put on record by ${document.recorded_by}`).slice(0, 500),
    extract: false,
    home,
    floor: derivedFloor(identity, home),
    written_at: document.recorded_at,
    ...(v ? { valid_until: v.valid_until ?? "lasting" } : {}),
    chars: text.length,
    sections: spans.length,
    // the record itself: who, under which position, why, and the claims per section (the approval runs this payload)
    record: { recorded_by: document.recorded_by, recorded_at: document.recorded_at, position: document.position, reason: document.reason, sections: document.sections.map((s) => ({ index: s.index, claims: s.claims })) },
    ...writerOf(identity),
  };
  await docStore.put(doc_id, text, { title: payload.title, by: identity.user, at: payload.written_at, on_record: true, sections: spans });
  const checked = classes ? { classes: `checked against ${classes.length} confirmed class${classes.length === 1 ? "" : "es"}` } : { classes: "no confirmed classes in the graph yet: class names unchecked" };
  if (queued) {
    const q = await queueWrite({ kind: "ingest", payload: JSON.stringify(payload), user: identity.user, home: decision?.home ?? home });
    return {
      ...q,
      doc_id,
      on_record: true,
      sections: spans.length,
      claims,
      ...checked,
      ...(decision?.reason ? { reason: decision.reason } : {}),
      note: "the record is stored; it's added to the knowledge graph once the ingest is approved",
    };
  }
  void startIngest(payload);
  return { ingesting: true, doc_id, on_record: true, sections: spans.length, claims, ...checked, note: "sections are being graded and embedded and the claims written; search finds them in a minute or two" };
}

/** an ingest from a tool call: stored now; ingested now, or after approval for queued writers */
export async function requestIngest({ title, description, text, extract, home: requestedHome, valid_until }, identity, scope) {
  if (!docStore) throw new Error("no document store is configured (DOC_STORE)");
  // a condensed document rides in text as JSON: the record path, not the chunker
  const record = parseRecordText(text);
  if (record) return recordDocument(record, identity, scope, { title, description, home: requestedHome, valid_until });
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
  // the one write-or-propose rule (write.js decideWrite, MAP.md): a manual carries no claims, so the identity's
  // queuing and the derived floor decide
  const decision = writeRules.decideWrite(identity, { kind: "ingest", claims: [] }, { origin: home });
  const payload = {
    doc_id,
    title: String(title).trim().slice(0, 200),
    description: String(description).trim().slice(0, 500),
    extract,
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
