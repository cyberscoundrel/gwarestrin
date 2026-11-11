// Reading a run's snapshot from an instance (docs/build/integrate.md, section 2): the filing log, workers'
// requests, the brief log, documents, sections, classes, instances and ABOUT edges, through `query(sql)` (the
// admin's raw query_graph). Every read is one SQL statement against the contract's schema (model/schema.js),
// so a scenario can run these against a real ArcadeDB and catch a drift before a real run does.
//
// Property names the contract doesn't fix yet are read tolerantly and listed here, to bind when the streams
// land: an instance's source key (`_record_key`, `record_key` or `key`), a section's text (the
// preview the record path stores) is `text_identity`, as write.js stores a facet.

const parse = (v, fallback = null) => {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
const rid = (v) => String(v?.["@rid"] ?? v ?? "");

export const QUERIES = {
  entries: "SELECT id, outcome, record, section, home, piece, class, instances, target, recorder, worker, reason, pending_id, question, request, account, verdict, refiled_from, at FROM FilingEntry ORDER BY at",
  requests: "SELECT id, kind, record, section, home, worker, question, suggestion, status, answer, answered_by, raised_by, at FROM WorkerRequest ORDER BY at",
  briefs: "SELECT id, record, audience, worker, brief, dropped, at FROM BriefLog ORDER BY at",
  documents: "SELECT @rid AS rid, name, _doc_id, _doc_title, _home, _recorded_by, _recorded_at, _record_position FROM Entity WHERE _kind = 'document'",
  sections: "SELECT @rid AS rid, name, _doc_id, _section, _home, text_identity FROM Entity WHERE _kind = 'section'",
  classes: "SELECT @rid AS rid, _class_key, _class_name, _description, _evidence, _rows_are_nodes, _record_table, _stages, _status, _home, out('SUBCLASS_OF')._class_key AS parents FROM Entity WHERE _kind = 'class'",
  instances: "SELECT @rid AS rid, name, _home, _homes, _keys, _record_key, record_key, key, out('INSTANCE_OF')._class_key AS classes FROM Entity WHERE out('INSTANCE_OF').size() > 0",
  about: "SELECT @rid AS rid, _doc_id, out('ABOUT') AS about FROM Entity WHERE _kind = 'section' AND out('ABOUT').size() > 0",
};

/** a stored FilingEntry row back to model/filing.js's shape (JSON columns parsed) */
export const entryOf = (r) => ({ ...r, instances: (Array.isArray(r.instances) ? r.instances : parse(r.instances, [])).map(rid), target: parse(r.target), account: parse(r.account), verdict: parse(r.verdict) });

/** a type that doesn't exist yet reads as no rows (the filing stream creates BriefLog's rows) */
async function rows(query, sql) {
  try {
    return await query(sql);
  } catch (e) {
    if (/not found|does not exist|unknown type|Type .* not/i.test(String(e?.message ?? e))) return [];
    throw e;
  }
}

/**
 * The graph and log side of a snapshot. `records`: the run's records as seeded ([{ note, person, document:
 * { title } }]), matched to documents by title and recorder, so the report can say which note an entry is about.
 */
export async function collectGraph(query, { records = [] } = {}) {
  const [entries, requests, briefs, documents, sections, classes, instances, about] = await Promise.all(Object.values(QUERIES).map((q) => rows(query, q)));
  const docByDocId = new Map(documents.map((d) => [d._doc_id, d]));
  const noteOf = {};
  const recordIds = {};
  for (const r of records) {
    const d = documents.find((x) => (x._doc_title === r.document.title || x.name === r.document.title) && (!x._recorded_by || x._recorded_by === r.person));
    if (d) {
      // the filing log names a record by its document id; sections and edges by the document's record id
      noteOf[rid(d.rid)] = r.note;
      if (d._doc_id) noteOf[d._doc_id] = r.note;
      recordIds[r.note] = rid(d.rid);
    }
  }
  const aboutBy = {};
  for (const a of about) {
    const doc = docByDocId.get(a._doc_id);
    const key = doc ? rid(doc.rid) : rid(a.rid);
    aboutBy[key] = [...(aboutBy[key] ?? []), ...(a.about ?? []).map(rid)];
  }
  return {
    entries: entries.map(entryOf),
    requests,
    briefs: briefs.map((b) => ({ id: b.id, record: b.record, audience: b.audience, worker: b.worker, text: b.brief, dropped: parse(b.dropped) })),
    documents,
    titles: documents.map((d) => ({ rid: rid(d.rid), record: rid(d.rid), home: d._home ?? null, title: d.name ?? d._doc_title ?? "" })),
    sections: sections.map((s) => ({ rid: rid(s.rid), record: rid(docByDocId.get(s._doc_id)?.rid) || null, home: s._home ?? null, text: s.text_identity ?? "" })),
    classes: classes.map((c) => ({ rid: rid(c.rid), key: c._class_key, name: c._class_name ?? c._class_key, parents: c.parents ?? [], home: c._home ?? null, description: c._description ?? null, evidence: parse(c._evidence, []), rows_are_nodes: Boolean(c._rows_are_nodes), record_table: c._record_table ?? null, stages: c._stages ?? [], status: c._status ?? "active" })),
    // an instance's source keys are in _keys (instances.js); the older single-key fields are read too
    instances: instances.map((i) => ({ rid: rid(i.rid), name: i.name, key: (Array.isArray(i._keys) && i._keys[0]) || i._record_key || i.record_key || i.key || null, keys: Array.isArray(i._keys) ? i._keys : [], classes: i.classes ?? [], homes: i._homes?.length ? i._homes : i._home ? [i._home] : [] })),
    about: aboutBy,
    noteOf,
    recordIds,
  };
}
