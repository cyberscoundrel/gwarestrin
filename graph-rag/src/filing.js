/**
 * Filing a record, piece by piece (docs/ORGANIZATION-MODEL.md, "How workers file a record"): the filing log, the
 * worker's filing tools, Held questions to the recorder, requests of the orchestrator, the worker's account, and the
 * orchestrator's check of that account against the source.
 *
 *   A piece is whatever one filing-log entry covers; the worker decides the split, and nothing is stored to divide
 *   sections (R11). Each piece ends in one outcome on record (R2):
 *     Filed     source and record clear, the recorder has authority: written, the entry names the row
 *     Proposed  clear, but no authority, a class missing from the map, or a source that isn't writable
 *     Held      a source exists but it's unclear which record, the source disagrees, or it can't be reached: the
 *               worker asks whoever put it on record, and nothing is overwritten
 *     Kept      no system holds it: the document is the source, linked to instances
 *   Filed or Proposed is decided here from facts (the row as read, the class map, the recorder's standing), never
 *   taken from the model: the worker says what it would write, and the code says which outcome that is.
 *
 *   The log is append-only (NEEDS A RULING F2): a later outcome for a piece is a new entry pointing back at the old
 *   one with `refiled_from` (a re-filed Kept piece, R11; an approved Proposed one; an answered Held one). An entry
 *   gains only its account and the orchestrator's verdict after it is written. It lives outside the graph (R9;
 *   model/filing.js: a FilingEntry document, never a vertex or an edge).
 *
 * Everything a handler touches comes through `env` (the log's store, the database, the source reads, the class
 * reads, the position map, the people), so tests run it over fakes that hand it facts, never answers.
 * The filing stream owns this module.
 */
import { randomUUID } from "node:crypto";
import { adbCommand as realCommand, adbQuery as realQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { canSee, EVERYONE, visibleHomes } from "./positions.js";
import { classKey } from "./model/classes.js";
import { parseKey } from "./model/schema.js";
import { disagreeingColumns, FILED, FLOOR_REASON, GRAPH_RAG, HELD, KEPT, normalizeAccount, normalizeAnswer, normalizeEntry, normalizeRequest, normalizeVerdict, onDisagreement, OUTCOMES, PROPOSED, suggestVerdict } from "./model/filing.js";
import { enterData, findRows, getRow, sameValue } from "./data-entry.js";
import { sourceFor } from "./sources.js";
import { addDependency, relateInstance } from "./instances.js";

const realDb = { adbCommand: realCommand, adbQuery: realQuery };
const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const parse = (v) => {
  if (v === null || v === undefined || v === "") return null;
  try {
    return typeof v === "string" ? JSON.parse(v) : v;
  } catch {
    return null;
  }
};
const normName = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** ---- the log's store ---- */

const ENTRY_FIELDS = ["id", "outcome", "record", "section", "home", "piece", "class", "instances", "target", "recorder", "worker", "reason", "pending_id", "question", "request", "account", "verdict", "refiled_from", "at"];
const fromEntryRow = (r) => ({ ...Object.fromEntries(ENTRY_FIELDS.map((k) => [k, r[k] ?? null])), instances: Array.isArray(r.instances) ? r.instances : [], target: parse(r.target), account: parse(r.account), verdict: parse(r.verdict) });
const ATTEMPT_FIELDS = ["id", "system", "table", "key", "action", "fields", "before", "piece", "status", "detail", "at", "settled_at"];
// stored under names that are no SQL keyword in ArcadeDB: table -> source_table, key -> row_key, before -> row_before
const ATTEMPT_COLUMN = (k) => (k === "table" ? "source_table" : k === "key" ? "row_key" : k === "before" ? "row_before" : k);
const REQUEST_FIELDS = ["id", "kind", "record", "section", "home", "worker", "question", "suggestion", "status", "answer", "answered_by", "raised_by", "at"];

/**
 * The log and the requests in ArcadeDB (the FilingEntry and WorkerRequest documents the contract declares,
 * model/schema.js). Never a vertex or an edge, so no graph read returns them (R9).
 */
export function arcadeStore(db = realDb) {
  return {
    async insertEntry(e) {
      await db.adbCommand(`INSERT INTO FilingEntry SET ${ENTRY_FIELDS.map((k) => `${k} = :${k}`).join(", ")}`, "sql", { ...e, target: json(e.target), account: json(e.account), verdict: json(e.verdict) });
      return e;
    },
    /** an entry gains its account or verdict; nothing else about it changes */
    async annotateEntry(id, { account, verdict }) {
      const sets = [];
      const params = { id };
      if (account !== undefined) (sets.push("account = :account"), (params.account = json(account)));
      if (verdict !== undefined) (sets.push("verdict = :verdict"), (params.verdict = json(verdict)));
      if (sets.length) await db.adbCommand(`UPDATE FilingEntry SET ${sets.join(", ")} WHERE id = :id`, "sql", params);
    },
    async entries({ id, record, section, worker, outcome, refiled_from, pending_id, limit = 500 } = {}) {
      const where = [];
      const params = {};
      for (const [k, v] of Object.entries({ id, record, section, worker, outcome, refiled_from, pending_id })) if (v !== undefined) (where.push(`${k} = :${k}`), (params[k] = v));
      const rows = await db.adbQuery(`SELECT FROM FilingEntry${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at ASC LIMIT ${Math.max(1, Math.min(5000, Math.floor(limit)))}`, params);
      return rows.map(fromEntryRow);
    },
    async insertRequest(r) {
      await db.adbCommand(`INSERT INTO WorkerRequest SET ${REQUEST_FIELDS.map((k) => `${k} = :${k}`).join(", ")}`, "sql", r);
      return r;
    },
    async updateRequest(id, fields) {
      const keys = Object.keys(fields).filter((k) => REQUEST_FIELDS.includes(k) && k !== "id");
      if (keys.length) await db.adbCommand(`UPDATE WorkerRequest SET ${keys.map((k) => `${k} = :${k}`).join(", ")} WHERE id = :id`, "sql", { ...fields, id });
    },
    /** a source write's attempt (the sources stream's journal: begun before the write, settled after) */
    async insertAttempt(a) {
      await db.adbCommand(`INSERT INTO FilingAttempt SET ${ATTEMPT_FIELDS.map((k) => `${ATTEMPT_COLUMN(k)} = :${ATTEMPT_COLUMN(k)}`).join(", ")}`, "sql", { ...Object.fromEntries(ATTEMPT_FIELDS.map((k) => [ATTEMPT_COLUMN(k), a[k] ?? null])), fields: json(a.fields), row_before: json(a.before), piece: json(a.piece), detail: json(a.detail) });
      return a;
    },
    async updateAttempt(id, { status, detail }) {
      await db.adbCommand("UPDATE FilingAttempt SET status = :status, detail = :detail, settled_at = :at WHERE id = :id", "sql", { id, status, detail: json(detail), at: new Date().toISOString() });
    },
    async attempt(id) {
      const r = (await db.adbQuery("SELECT FROM FilingAttempt WHERE id = :id LIMIT 1", { id }))[0];
      return r ? { ...Object.fromEntries(ATTEMPT_FIELDS.map((k) => [k, r[ATTEMPT_COLUMN(k)] ?? null])), fields: parse(r.fields), before: parse(r.row_before), piece: parse(r.piece), detail: parse(r.detail) } : null;
    },
    async requests({ id, worker, status, record, section, raised_by } = {}) {
      const where = [];
      const params = {};
      for (const [k, v] of Object.entries({ id, worker, status, record, section, raised_by })) if (v !== undefined) (where.push(`${k} = :${k}`), (params[k] = v));
      const rows = await db.adbQuery(`SELECT FROM WorkerRequest${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at ASC LIMIT 500`, params);
      return rows.map((r) => Object.fromEntries(REQUEST_FIELDS.map((k) => [k, r[k] ?? null])));
    },
  };
}

/** ---- the live environment (tests pass their own) ---- */

const liveScope = async () => import("./scope.js");

/** a class by key as stored (an Entity with _kind 'class'; model/schema.js), with its parents; null when none */
export async function classByKey(key, db = realDb) {
  const k = classKey(key);
  if (!k) return null;
  const row = (await db.adbQuery(`SELECT @rid AS rid, _class_name, _class_key, _home, _rows_are_nodes, _record_table, _status FROM ${ENTITY_LABEL} WHERE _kind = 'class' AND _class_key = :k LIMIT 1`, { k }))[0];
  if (!row) return null;
  const parents = await db.adbQuery(`SELECT _class_key AS key FROM (SELECT expand(out('SUBCLASS_OF')) FROM ${row.rid})`).catch(() => []);
  return { rid: String(row.rid), key: row._class_key, name: row._class_name ?? row._class_key, home: row._home ?? null, rows_are_nodes: row._rows_are_nodes === true, record_table: row._record_table ?? null, status: row._status ?? "active", parents: parents.map((p) => p.key).filter(Boolean) };
}

/**
 * A row by its key, as a fact, read through the sources stream's read adapter (data-entry.js getRow):
 * { status: ok, row } | { status: not_found } | { status: unreachable, error } | { status: refused, error }.
 * `audience` (a worker's home) makes the adapter refuse a connection whose home the audience can't see (R11.6,
 * R11.9); the orchestrator reads with none.
 */
export async function readSourceRow(key, { db = realDb, fetch, audience, positions } = {}) {
  if (!parseKey(key)) return { status: "not_found", error: `not a record key: ${key}` };
  const r = await getRow(key, { db, fetch, ...(audience !== undefined ? { audience, positions } : {}) });
  if (r.status === "found") return { status: "ok", row: r.row };
  if (r.status === "none") return { status: "not_found" };
  if (r.status === "refused") return { status: "refused", error: r.why ?? "the source refused the read" };
  return { status: "unreachable", error: r.why ?? r.status };
}

/** rows whose column equals a name (at most five), through the read adapter's findRows, as the audience may see them */
export async function findSourceRows(system, table, column, value, { db = realDb, fetch, audience, positions } = {}) {
  const r = await findRows({ system, table, column, value, mode: "eq", first: 5 }, { db, fetch, ...(audience !== undefined ? { audience, positions } : {}) });
  if (["found", "ambiguous", "none"].includes(r.status)) return { status: "ok", rows: (r.rows ?? []).map((x) => x.row), more: Boolean(r.more) };
  if (r.status === "refused") return { status: "refused", error: r.why ?? "the source refused the read" };
  return { status: "unreachable", error: r.why ?? r.status };
}

/** the environment a handler runs in: the live one, with anything a caller passes over it */
export async function liveEnv(over = {}) {
  const scope = await liveScope();
  const db = over.db ?? realDb;
  const positions = over.positions ?? scope.positionMap;
  const env = {
    db,
    store: over.store ?? arcadeStore(db),
    positions,
    people: over.people ?? ((name) => scope.entriesByUser.get(name)),
    classes: over.classes ?? { get: (key) => classByKey(key, db) },
    readRow: over.readRow ?? ((key, o = {}) => readSourceRow(key, { db, fetch: over.fetch, positions, ...o })),
    findRows: over.findRows ?? ((system, table, column, value, o = {}) => findSourceRows(system, table, column, value, { db, fetch: over.fetch, positions, ...o })),
    laterClassOrSource: over.laterClassOrSource ?? ((at) => laterClassOrSource(at, db)),
    classesForTable: over.classesForTable ?? (async (table) => (await db.adbQuery(`SELECT _class_key AS key, _home AS home FROM ${ENTITY_LABEL} WHERE _kind = 'class' AND _record_table = :t AND (_status IS NULL OR _status <> 'retired')`, { t: table }).catch(() => [])).map((r) => ({ key: r.key, home: r.home ?? null }))),
    // the home of the connection that reads a system (its declaration's read.home; none, or no such system: the root)
    connectionHome: over.connectionHome ?? (async (system) => {
      const d = await sourceFor(system, db).catch(() => null);
      return d?.read?.home ?? positions?.root ?? null;
    }),
    // the write is begun and settled in this env's own log (its store), not the live one; the class index decides inheritance
    // instances and dependencies: the classes stream's one implementation (instances.js)
    instances: over.instances ?? { relate: relateInstance, depend: addDependency },
    enter: over.enter ?? ((args, opts = {}) => enterData(args, { db, fetch: over.fetch, positions, people: over.people, policy: over.policy, journal: makeJournal(env), index: over.index, ...opts })),
    signal: over.signal ?? (async (kind, payload) => (await import("./master-tools.js")).emitSignal(kind, payload)),
    resume: over.resume ?? (async (job, message) => (await import("./worker-pool.js")).resumeThread(job, message)),
    now: over.now ?? (() => new Date().toISOString()),
    rule: over.rule,
  };
  return env;
}

/** ---- a worker's job, as its tools see it ---- */

/**
 * What a filing worker works on, from its job (worker-pool.js claimThreads sets it up): the record, its sections at
 * one home, that home (the audience: R11), and the recorder as the record names them (R11: the recorder's authority
 * counts, never the agent's). Null when the job isn't a filing job.
 */
export async function jobContext(identity, db = realDb) {
  const job = identity?.role?.job;
  if (!job) return null;
  const row = (await db.adbQuery("SELECT payload FROM Job WHERE id = :id AND kind = 'review'", { id: job }).catch(() => []))[0];
  const p = parse(row?.payload) ?? {};
  if (!p.record || !Array.isArray(p.sections) || !p.home) return null;
  const doc = (await db.adbQuery(`SELECT @rid AS rid, _recorded_by, _record_position FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: p.record }).catch(() => []))[0];
  return { job, record: p.record, document: doc ? String(doc.rid) : null, sections: p.sections.map(String), home: p.home, recorder: doc?._recorded_by ? { person: doc._recorded_by, position: doc._record_position ?? null } : null, refile: Array.isArray(p.refile) ? p.refile : [] };
}

const refuse = (msg) => Object.assign(new Error(msg), { refused: true });

/** a section of this worker's own record and home, or a refusal (which section is the model's word) */
function ownSection(ctx, section) {
  const s = String(section ?? "").trim();
  if (!ctx.sections.includes(s)) throw refuse(`no section ${s || "(none given)"} in your brief: give a section id from your brief`);
  return s;
}

/** can this worker's audience see something homed at `home` (R7, R11: a worker sees only its audience) */
const audienceSees = (env, ctx, home) => !env.positions || canSee(env.positions, [ctx.home], home ?? env.positions.root);

/**
 * May this worker read a table of a source (R7, R11.6, R11.9)? Its audience must see the home of the connection
 * that reads it, and the home of every class whose table it is (a class from a table gets the connection's home,
 * so a class above the audience marks the table as above it). The connection's home is its declaration's read.home
 * (none, or no such system: the root); the read adapter checks it again on every read (data-entry.js getRow and
 * findRows, given the audience). Refused before anything is read, so no row and no value reaches the worker.
 * NEEDS A RULING (F22): a class above the audience pointing at a table refuses it, even when the connection's own
 * home is visible: the strictest wins.
 */
async function assertTableReadable(env, ctx, table) {
  const t = String(table ?? "").trim();
  const [system] = t.split(":");
  const conn = await env.connectionHome(system);
  if (conn !== undefined && !audienceSees(env, ctx, conn)) throw refuse(`${t} is read through a connection above your audience: hold the piece, or request it of the orchestrator`);
  const classes = await env.classesForTable(t);
  if (!classes.length && conn === undefined) throw refuse(`no class you can see records ${t}: request one (graph-rag_request, kind "class")`);
  if (classes.some((c) => !audienceSees(env, ctx, c.home))) throw refuse(`${t} is above your audience: hold the piece, or request it of the orchestrator`);
}

/** a worker's read of a row: only from a table its audience may read */
async function workerRead(env, ctx, key) {
  await assertTableReadable(env, ctx, tableOf(key));
  const read = await env.readRow(key, { audience: ctx.home });
  if (read.status === "refused") throw refuse(`${key}: ${read.error}`);
  return read;
}

/** a class this worker may file under: it exists, is in use, and its audience can see it. No worker makes or changes a class (R5, R7) */
async function visibleClass(env, ctx, name) {
  const cls = await env.classes.get(name);
  if (!cls || !audienceSees(env, ctx, cls.home)) throw refuse(`no class ${classKey(name)} you can file under: when no class fits, request one (graph-rag_request, kind "class"), and don't file the piece yourself`);
  if (cls.status === "retired") throw refuse(`${cls.key} is retired: request a class (graph-rag_request, kind "class")`);
  return cls;
}

/** the request a piece may rely on: this worker's own, answered, with that decision */
async function answeredRequest(env, ctx, id, decisions) {
  if (!id) return null;
  const r = (await env.store.requests({ id: String(id) }))[0];
  const ans = parse(r?.answer);
  if (!r || r.worker !== ctx.job || r.status !== "answered" || !decisions.includes(ans?.decision)) throw refuse(`request ${id} isn't an answered request of yours saying ${decisions.join(" or ")}`);
  return { ...r, answer: ans };
}

/** a Kept or Held entry this worker was given to re-file: it points back at it (R11) */
async function refiledFrom(env, ctx, id) {
  if (!id) return null;
  const e = (await env.store.entries({ id: String(id) }))[0];
  if (!e || e.record !== ctx.record || e.home !== ctx.home || ![KEPT, HELD, PROPOSED].includes(e.outcome)) throw refuse(`entry ${id} isn't a piece of this record at your home to re-file`);
  return e.id;
}

/** write one entry (normalized, append-only) */
async function appendEntry(env, raw) {
  const e = normalizeEntry({ id: randomUUID(), at: env.now(), ...raw });
  await env.store.insertEntry(e);
  return e;
}

/** a Held piece asks whoever put it on record (R2): a question addressed to them, not to the admin (NEEDS A RULING F3) */
async function askRecorder(env, ctx, entry) {
  const id = randomUUID();
  await env.db.adbCommand(
    "INSERT INTO WorkerQuestion SET id = :id, job_id = :job, entry = :entry, entry_name = :ename, question = :q, options = '[]', why = '', asked_by = :u, asked_of = :of, filing_entry = :fe, status = 'open', created_at = :now",
    "sql",
    { id, job: ctx.job, entry: entry.section, ename: null, q: entry.question, u: `worker:${ctx.job.slice(0, 8)}`, of: ctx.recorder?.person ?? null, fe: entry.id, now: env.now() },
  );
  return id;
}

async function holdEntry(env, ctx, { section, piece, cls, target, question, request = null, reason = null, refiled = null, instances = [], account = null }) {
  const entry = await appendEntry(env, { outcome: HELD, record: ctx.record, section, home: ctx.home, piece, class: cls ?? null, instances, target, recorder: ctx.recorder?.person ?? "unknown", worker: ctx.job, question, request, reason, refiled_from: refiled, account });
  await askRecorder(env, ctx, entry);
  return entry;
}

const tableOf = (key) => {
  const k = parseKey(key);
  return k ? `${k.system}:${k.table}` : null;
};

/**
 * File a piece to its source row (`key`, `fields`) under a class: Filed or Proposed by the class map over the
 * recorder as they stand now (data-entry.js, model/class-map.js), Held when the row can't be found or read (R3)
 * or the source disagrees (model/filing.js onDisagreement, F4), never overwritten.
 */
export async function fileToSource(args, identity, env) {
  const ctx = await jobContext(identity, env.db);
  if (!ctx) throw refuse("this thread has no record to file");
  if (!ctx.recorder) throw refuse("the record names nobody who put it on record, so nothing can be filed for them");
  const section = ownSection(ctx, args.section);
  const piece = String(args.piece ?? "").trim();
  if (!piece) throw refuse("piece: say what this piece of the record is, in a sentence");
  // R10: a worker resolving a piece to storage reports what it did; the account comes with the write it asks for
  const said = String(args.said ?? "").trim();
  if (!said) throw refuse("said: your account of what this piece writes, in a sentence (the orchestrator checks it against the source)");
  const account = { said, at: env.now() };
  const cls = await visibleClass(env, ctx, args.class);
  const key = parseKey(args.key);
  if (!key) throw refuse(`key: not system:table:row: ${args.key ?? "(none)"}`);
  const fields = args.fields && typeof args.fields === "object" && !Array.isArray(args.fields) ? args.fields : null;
  if (!fields || !Object.keys(fields).length) throw refuse("fields: the columns to write, with their values");
  const refiled = await refiledFrom(env, ctx, args.refiles);
  // the row must be in the class's own table: a key elsewhere would read a table the class doesn't vouch for (F-B1)
  if (!cls.record_table || tableOf(key.key).toLowerCase() !== String(cls.record_table).toLowerCase()) throw refuse(`${key.key} isn't a row of ${cls.key}'s table (${cls.record_table ?? "it has none"}): file it under the class whose table holds it`);
  const target = { table: tableOf(key.key), key: key.key, fields };
  const base = { section, piece, cls: cls.key, target, refiled, account };
  const read = await workerRead(env, ctx, key.key);
  if (read.status === "unreachable") {
    return { outcome: HELD, entry: (await holdEntry(env, ctx, { ...base, question: args.question || `${key.system} couldn't be reached to file this: "${piece}". It waits for you to confirm it once the source is back.`, reason: read.error })).id };
  }
  if (read.status === "not_found") {
    return { outcome: HELD, entry: (await holdEntry(env, ctx, { ...base, question: args.question || `No row ${key.key} was found for "${piece}". Which record did you mean?`, reason: read.error ?? null })).id };
  }
  const differing = disagreeingColumns(read.row, fields, sameValue);
  if (differing.length) {
    // the orchestrator's "update" answer to a conflict request: reachable only under the conservative rule, which raises
    // conflict requests; under R12 (in force) a disagreeing state is Held and asks the recorder, and no request is raised
    const confirmed = await answeredRequest(env, ctx, args.confirmed_update, ["update"]);
    const d = confirmed ? { file: true } : onDisagreement({ says_change: args.says_change === true }, env.rule);
    if (!d.file) {
      const says = differing.map((x) => `${x.column} is ${JSON.stringify(x.source)} in the source, the record says ${JSON.stringify(x.record)}`).join("; ");
      let request = null;
      if (d.request) request = (await openRequest(env, ctx, { kind: d.request, section, question: `${key.key}: ${says}. Is the record an update, or does it disagree with the source?` })).id;
      const entry = await holdEntry(env, ctx, { ...base, question: args.question || `For "${piece}": ${says}. Which is right?`, request, reason: "the source disagrees: nothing was overwritten" });
      return { outcome: HELD, entry: entry.id, ...(request ? { request } : {}), note: request ? "Held, and a conflict request went to the orchestrator: nothing was written. Carry on with the other pieces." : "Held: nothing was written, and the recorder is asked." };
    }
  }
  const r = await env.enter(
    { actsFor: ctx.recorder, by: identity.user, key: key.key, fields, cls: cls.key, reason: piece, identity, before: Object.fromEntries(Object.keys(fields).map((c) => [c, read.row[c] ?? null])), piece: { record: ctx.record, section, job: ctx.job, piece } },
    // a Proposed piece is an outcome, not a wait: the proposal names no thread (the person approves it as themselves)
    { proposal: (_identity, reason) => ({ note: String(reason ?? "").slice(0, 600) || "(no reason given)" }) },
  );
  if (r.outcome === "filed") {
    const before = r.status === "already" ? "the row already held it: nothing was written" : r.before && Object.keys(r.before).length ? `before: ${JSON.stringify(r.before)}` : null;
    const entry = await appendEntry(env, { outcome: FILED, record: ctx.record, section, home: ctx.home, piece, class: cls.key, target, recorder: ctx.recorder.person, worker: ctx.job, reason: before, refiled_from: refiled, account });
    return { outcome: FILED, entry: entry.id, note: "Filed: written to the source." };
  }
  if (r.outcome === "proposed") {
    const entry = await appendEntry(env, { outcome: PROPOSED, record: ctx.record, section, home: ctx.home, piece, class: cls.key, target, recorder: ctx.recorder.person, worker: ctx.job, reason: r.reason || "the recorder doesn't hold the authority", pending_id: r.pendingId ?? null, refiled_from: refiled, account });
    return { outcome: PROPOSED, entry: entry.id, note: `Proposed: ${entry.reason}. A person with authority approves it; carry on.` };
  }
  if (r.outcome === "refused") {
    // NEEDS A RULING (BUILD.md 12): the recorder has left or moved, so nothing stands behind the write: Held, asking them
    const entry = await holdEntry(env, ctx, { ...base, question: args.question || `"${piece}" couldn't be filed for you: ${r.reason}`, reason: r.reason });
    return { outcome: HELD, entry: entry.id };
  }
  if (r.outcome === "held") {
    // the sources stream's adapter: a write that didn't land (unreachable, moved, not_found, refused, unknown) is Held, asking the recorder
    const why = r.why ?? r.reason ?? r.status ?? "the write didn't land";
    const entry = await holdEntry(env, ctx, { ...base, question: args.question || `"${piece}" wasn't written (${why}). Can you confirm it?`, reason: `${r.status ?? "held"}: ${why}`.slice(0, 600) });
    return { outcome: HELD, entry: entry.id, note: "Held: nothing was written, and whoever put it on record is asked." };
  }
  if (r.unverified) {
    // NEEDS A RULING (F18): the connection broke mid-write and the row couldn't be read back. Held, so the orchestrator's check reads the row
    const entry = await holdEntry(env, ctx, { ...base, question: `"${piece}": the source couldn't confirm whether it was written. It's being checked.`, reason: r.error });
    return { outcome: HELD, entry: entry.id };
  }
  // the source refused the write (a wrong column, say): the piece hasn't ended, and the worker hears why
  throw refuse(`the source refused the write, nothing was filed: ${r.error}`);
}

/** hold a piece: unclear which record, or the source disagrees; the recorder is asked, nothing is written (R2) */
export async function holdPiece(args, identity, env) {
  const ctx = await jobContext(identity, env.db);
  if (!ctx) throw refuse("this thread has no record to file");
  const section = ownSection(ctx, args.section);
  const piece = String(args.piece ?? "").trim();
  const question = String(args.question ?? "").trim();
  if (!piece || !question) throw refuse("piece and question: what the piece is, and what you ask whoever put it on record");
  const cls = args.class ? (await visibleClass(env, ctx, args.class)).key : null;
  const table = args.key ? tableOf(args.key) : args.table ? String(args.table).trim() : cls ? (await env.classes.get(cls))?.record_table : null;
  if (!table) throw refuse("a Held piece goes to a source: name its table or key, or its class's table. If no system holds it, keep it (graph-rag_keep_piece)");
  const target = { table, key: args.key ? parseKey(args.key)?.key ?? null : null, fields: args.fields ?? null };
  const entry = await holdEntry(env, ctx, { section, piece, cls, target, question, refiled: await refiledFrom(env, ctx, args.refiles) });
  return { outcome: HELD, entry: entry.id, note: "Held: whoever put it on record is asked. Carry on with the other pieces." };
}

/** keep a piece no system holds: the document is the source, linked to the instances it is about (R2) */
export async function keepPiece(args, identity, env) {
  const ctx = await jobContext(identity, env.db);
  if (!ctx) throw refuse("this thread has no record to file");
  const section = ownSection(ctx, args.section);
  const piece = String(args.piece ?? "").trim();
  if (!piece) throw refuse("piece: say what this piece of the record is");
  const instances = [];
  for (const rid of args.instances ?? []) instances.push((await visibleInstance(env, ctx, rid)).rid);
  if (!instances.length) throw refuse("instances: a Kept piece is linked to the instances it is about (R2): relate it to one you see, or make the lasting individual first (graph-rag_create_instance)");
  for (const rid of instances) await relate(env, ctx, section, rid);
  const entry = await appendEntry(env, { outcome: KEPT, record: ctx.record, section, home: ctx.home, piece, class: null, instances, target: null, recorder: ctx.recorder?.person ?? "unknown", worker: ctx.job, refiled_from: await refiledFrom(env, ctx, args.refiles) });
  return { outcome: KEPT, entry: entry.id, note: "Kept: the document is the source. Nothing Kept is deleted; the orchestrator re-files it when a fitting class or source appears." };
}

/** ---- requests of the orchestrator (R10: few, and only for what isn't low stakes) ---- */

async function openRequest(env, ctx, { kind, section = null, question, suggestion = null }) {
  const r = normalizeRequest({ id: randomUUID(), kind, record: ctx.record, section, home: ctx.home, worker: ctx.job, question, suggestion, status: "open", at: env.now() });
  await env.store.insertRequest(r);
  // the orchestrator hears of it with its next signals: a request names the record and the home, the question as data
  await env.signal("request", { job_id: ctx.job, data: { request: r.id, kind: r.kind, record: r.record, home: r.home, question: r.question, ...(r.suggestion ? { suggestion: r.suggestion } : {}) } });
  return r;
}

/** a worker asks the orchestrator: a class no existing one fits, a conflict with a source, or something else not low stakes */
export async function requestOrchestrator(args, identity, env) {
  const ctx = await jobContext(identity, env.db);
  if (!ctx) throw refuse("this thread has no record to file");
  const section = args.section ? ownSection(ctx, args.section) : null;
  const open = (await env.store.requests({ worker: ctx.job, status: "open" })).length;
  // NEEDS A RULING (F20): R10 keeps requests "to a minimum" and names no number; three open at once is the cap
  if (open >= 3) throw refuse("you already have 3 open requests: file the other pieces, give your account, and end your turn");
  const r = await openRequest(env, ctx, { kind: args.kind, section, question: args.question, suggestion: args.suggestion ?? null });
  return { request: r.id, note: "Sent to the orchestrator. Don't file that piece yourself: carry on with the others, and you're resumed with the answer." };
}

/** every request in the order it was raised: the orchestrator names them by handle, r1, r2 ... */
export async function requestList(env) {
  return (await env.store.requests({})).sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
}
export const requestHandle = (i) => `r${i + 1}`;

/** the open requests, one line each with its handle, for a refusal */
export async function openRequestLines(env, filter = () => true) {
  const all = await requestList(env);
  const open = all.map((r, i) => ({ r, h: requestHandle(i) })).filter(({ r }) => r.status === "open" && filter(r));
  return open.length ? open.map(({ r, h }) => `${h} (${r.kind}${r.raised_by ? `, raised by ${r.raised_by}` : ""}, record ${r.record} at ${r.home}${r.section ? `, section ${r.section}` : ""}): ${String(r.question).slice(0, 80)}`).join("; ") : "none open";
}

/**
 * The request a model meant, as its id, or null: its handle (r3, 3) or id; with one request open, any other value
 * means that one. A value shaped like a handle or id that matches none is never taken as another.
 */
export async function resolveRequestRef(value, env) {
  const all = await requestList(env);
  const ids = all.map((r) => r.id);
  const s = String(value ?? "").trim();
  if (ids.includes(s)) return s;
  const n = /^r?(\d{1,5})$/i.exec(s);
  if (n) return Number(n[1]) >= 1 && Number(n[1]) <= ids.length ? ids[Number(n[1]) - 1] : null;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(s)) return null;
  const open = all.filter((r) => r.status === "open");
  return open.length === 1 ? open[0].id : null;
}

/** the orchestrator answers a request, structured (model/filing.js normalizeAnswer); the worker resumes with it */
export async function answerRequest(id, raw, by, env) {
  const rid = await resolveRequestRef(id, env);
  if (!rid) throw refuse(`request "${String(id ?? "").slice(0, 60)}" isn't one to answer: give its handle (r1, r2 …) or id, never its question. Open: ${await openRequestLines(env)}`);
  const r = (await env.store.requests({ id: rid }))[0];
  if (!r) throw refuse(`no request ${id}`);
  if (r.status !== "open") throw refuse(`request ${id} is ${r.status}`);
  const answer = normalizeAnswer(raw);
  // R15: a section graph-rag sent back for a worker that ended: no worker waits on this answer
  if (r.raised_by === GRAPH_RAG) return settleKickback(r, answer.decision, by, env);
  if (answer.class) {
    const cls = await env.classes.get(answer.class);
    // the worker sees only its audience (R11): a class above it can't be named to it
    if (!cls || cls.status === "retired" || (env.positions && !canSee(env.positions, [r.home], cls.home ?? env.positions.root))) throw refuse(`${answer.class} isn't a class the worker's audience can see: name one at or below ${r.home}, or answer keep or hold`);
  }
  await env.store.updateRequest(r.id, { status: "answered", answer: JSON.stringify(answer), answered_by: String(by).slice(0, 120) });
  await env.resume(r.worker, { request: r.id, decision: answer.decision, class: answer.class, answered_by: "the orchestrator" });
  return { answered: r.id, ...answer };
}

/** ---- R15: a worker that ends without filing ---- */

/** a section's text, home and record, as stored */
async function sectionRow(env, rid) {
  if (!RID_RE.test(String(rid))) return null;
  return (await env.db.adbQuery(`SELECT @rid AS rid, _doc_id, _home, text_identity FROM ${rid} WHERE _kind = 'section'`).catch(() => []))[0] ?? null;
}

/**
 * A worker job ended (answered, out of turns, failed or closed): for each of its sections with no filing-log entry,
 * graph-rag itself, not a model, sends the orchestrator a request of kind "other" on the worker's behalf, with the
 * section's text and the worker's last reply (R15). A section that already has an open one isn't sent twice.
 * Returns the requests raised.
 */
export async function kickBack(jobId, payload, lastReply, env) {
  if (!payload?.record) return [];
  const sections = [...new Set([payload.rid, ...(Array.isArray(payload.sections) ? payload.sections : [])].filter((r) => RID_RE.test(String(r))))];
  const out = [];
  for (const section of sections) {
    if ((await env.store.entries({ record: payload.record, section })).length) continue;
    if ((await env.store.requests({ section, status: "open", raised_by: GRAPH_RAG })).length) continue;
    const row = await sectionRow(env, section);
    const text = String(row?.text_identity ?? "").trim();
    const reply = String(lastReply ?? "").trim();
    const r = normalizeRequest({
      id: randomUUID(),
      kind: "other",
      record: payload.record,
      section,
      home: payload.home ?? row?._home ?? "unknown",
      worker: String(jobId),
      question: clip(`The worker ended without filing this section (raised by graph-rag, R15). Section: "${text.slice(0, 500)}". The worker's last reply: "${reply.slice(0, 300) || "(none)"}". Start a fresh worker for the section (start_worker with record and section), keep it (answer keep), or send it to a person (answer hold). Left open past your turn, it is Kept as it stands.`, 1000),
      status: "open",
      raised_by: GRAPH_RAG,
      at: env.now(),
    });
    await env.store.insertRequest(r);
    await env.signal("request", { job_id: String(jobId), data: { request: r.id, kind: r.kind, record: r.record, home: r.home, section, raised_by: GRAPH_RAG, question: r.question } });
    out.push(r);
  }
  return out;
}
const clip = (v, n) => String(v ?? "").slice(0, n);

/** the floor (R15): the whole section as one Kept piece, at its home, with the instances related to it; no source written */
async function fileFloor(r, reason, env) {
  if ((await env.store.entries({ record: r.record, section: r.section })).length) return null; // filed meanwhile
  const row = await sectionRow(env, r.section);
  const about = await env.db.adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${r.section})`).catch(() => []);
  const doc = (await env.db.adbQuery(`SELECT _recorded_by FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: r.record }).catch(() => []))[0];
  return appendEntry(env, {
    outcome: KEPT,
    record: r.record,
    section: r.section,
    home: r.home,
    piece: String(row?.text_identity ?? "").trim() || "(the section's text)",
    class: null,
    instances: [...new Set(about.map((e) => String(e.dst)).filter((x) => RID_RE.test(x)))],
    target: null,
    recorder: doc?._recorded_by ?? "unknown",
    worker: r.worker,
    reason,
  });
}

/**
 * The orchestrator settles a kick-back with answer_request: keep (Kept now, as the floor files it) or hold (a
 * person decides: a question to whoever put the record on record). A fresh worker is start_worker's (orchestrator.js).
 * NEEDS A RULING (I-27): "send it to a person" is read as a question to the recorder, since a Held entry needs a
 * source table that a section nobody filed doesn't have.
 */
export async function settleKickback(r, decision, by, env) {
  if (decision === "keep") {
    const e = await fileFloor(r, `${FLOOR_REASON}; kept by the orchestrator`, env);
    await env.store.updateRequest(r.id, { status: "answered", answer: JSON.stringify({ decision: "keep", entry: e?.id ?? null }), answered_by: String(by).slice(0, 120) });
    return { answered: r.id, decision: "keep", entry: e?.id ?? null };
  }
  if (decision === "hold") {
    const doc = (await env.db.adbQuery(`SELECT _recorded_by FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: r.record }).catch(() => []))[0];
    const person = doc?._recorded_by ?? null;
    const q = randomUUID();
    await env.db.adbCommand(
      "INSERT INTO WorkerQuestion SET id = :id, job_id = :job, entry = :entry, entry_name = :ename, question = :q, options = '[]', why = '', asked_by = :u, asked_of = :of, filing_entry = :fe, status = 'open', created_at = :now",
      "sql",
      { id: q, job: r.worker, entry: r.section, ename: null, q: "A worker couldn't file this section of your record. What should become of it?", u: GRAPH_RAG, of: person, fe: null, now: env.now() },
    );
    await env.store.updateRequest(r.id, { status: "answered", answer: JSON.stringify({ decision: "hold", question: q, asked_of: person }), answered_by: String(by).slice(0, 120) });
    return { answered: r.id, decision: "hold", question: q, asked_of: person };
  }
  throw refuse("graph-rag sent this section back because its worker ended without filing it: start a fresh worker for it (start_worker with record and section), answer keep, or answer hold");
}

/** the end of the orchestrator's turn that saw these requests: any graph-rag one still open is Kept as it stands (R15) */
export async function floorUnsettled(requestIds, env) {
  const out = [];
  for (const id of requestIds) {
    const r = (await env.store.requests({ id: String(id) }))[0];
    if (!r || r.raised_by !== GRAPH_RAG || r.status !== "open") continue;
    const e = await fileFloor(r, FLOOR_REASON, env);
    await env.store.updateRequest(r.id, { status: "answered", answer: JSON.stringify({ decision: "floor", entry: e?.id ?? null }), answered_by: GRAPH_RAG });
    out.push({ request: r.id, entry: e?.id ?? null });
  }
  return out;
}

/** ---- instances, sections and dependency (R1, R3, R7) ---- */

async function visibleInstance(env, ctx, rid) {
  const r = String(rid ?? "").trim();
  if (!RID_RE.test(r)) throw refuse(`"${r.slice(0, 60)}" isn't an instance id: give the id (like #12:3) that graph-rag_resolve_name or graph-rag_create_instance gave you, never a name`);
  const row = (await env.db.adbQuery(`SELECT @rid AS rid, label, _homes, _keys FROM ${r} WHERE _kind = 'thing'`).catch(() => []))[0];
  const homes = Array.isArray(row?._homes) ? row._homes : [];
  // an instance is visible wherever a section about it is (R11): one of its homes the audience sees will do
  if (!row || !(homes.includes(EVERYONE) || homes.some((h) => audienceSees(env, ctx, h)))) throw refuse(`no instance ${r} you can see: take its id from graph-rag_resolve_name, or make it with graph-rag_create_instance`);
  return { rid: String(row.rid), label: row.label, keys: Array.isArray(row._keys) ? row._keys : [] };
}

/** a section relates to an instance (ABOUT), and the instance is seen from the section's home (R2, R11) */
async function relate(env, ctx, section, rid, role = "about") {
  const out = await env.db.adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${section})`).catch(() => []);
  if (!out.some((e) => String(e.dst) === rid)) await env.db.adbCommand(`CREATE EDGE ABOUT FROM ${section} TO ${rid} SET role = :role`, "sql", { role });
  const row = (await env.db.adbQuery(`SELECT _homes FROM ${rid}`))[0];
  const homes = Array.isArray(row?._homes) ? row._homes : [];
  if (!homes.includes(ctx.home)) await env.db.adbCommand(`UPDATE ${rid} SET _homes = :homes`, "sql", { homes: [...homes, ctx.home] });
}

/** the worker's audience as a reader scope (classes.js seesHome): the homes visible from its job's home */
const workerScope = (env, ctx) => ({ homes: env.positions ? visibleHomes(env.positions, [ctx.home]) : null, granted: null });
/** the actor the classes stream's instance functions write as: the worker, with its identity for the write floor (R11.13) */
const workerActor = (identity) => ({ user: identity.user, agent: true, run: null, identity });

/** a key's row is read before a node is made for it (R3), through the audience gate (F-B1) */
async function rowExists(env, ctx, key) {
  const read = await workerRead(env, ctx, key);
  if (read.status !== "ok") throw refuse(read.status === "unreachable" ? `${key}: the source can't be reached to check the row: hold the piece instead` : `${key}: the source has no such row`);
}

/**
 * A lasting individual under an existing class (R3, R7), made or related by the classes stream's `relateInstance`
 * (instances.js: the one implementation, review C-B7). It checks the class against the audience, keeps one node per
 * key (refusing one held where the worker can't see), dedupes names under the class among what the worker sees, homes
 * a new node at the section's home under the write floor (R11.8, R11.13), and refuses a transactional row's node
 * (R3). Filing reads the row first and relates the section to the instance after.
 * NEEDS A RULING (F5): creating an instance isn't in R11's list of low or high stakes; R7 lets workers do it.
 */
export async function createInstance(args, identity, env) {
  const ctx = await jobContext(identity, env.db);
  if (!ctx) throw refuse("this thread has no record to file");
  const section = ownSection(ctx, args.section);
  const label = String(args.name ?? "").trim();
  if (!label) throw refuse("name: the individual's name");
  const key = args.key ? parseKey(args.key)?.key : null;
  if (args.key && !key) throw refuse(`key: not system:table:row: ${args.key}`);
  if (key) await rowExists(env, ctx, key);
  const r = await env.instances.relate({ class: args.class, ...(key ? { key } : {}), name: label }, workerScope(env, ctx), workerActor(identity), { home: ctx.home });
  await relate(env, ctx, section, r.instance);
  return { instance: r.instance, created: r.created, class: r.class, note: r.created ? "Made, and the section relates to it." : "An instance already held this; the section now relates to it." };
}

/** relate a section to an instance its audience sees (low stakes: R11) */
export async function relateSection(args, identity, env) {
  const ctx = await jobContext(identity, env.db);
  if (!ctx) throw refuse("this thread has no record to file");
  const section = ownSection(ctx, args.section);
  const inst = await visibleInstance(env, ctx, args.instance);
  await relate(env, ctx, section, inst.rid, args.role ? String(args.role).slice(0, 40) : "about");
  return { section, instance: inst.rid, related: true };
}

/** a transactional row's key stays on the section, with no node (R3: "a section stores the key") */
export async function sectionKey(args, identity, env) {
  const ctx = await jobContext(identity, env.db);
  if (!ctx) throw refuse("this thread has no record to file");
  const section = ownSection(ctx, args.section);
  const key = parseKey(args.key)?.key;
  if (!key) throw refuse(`key: not system:table:row: ${args.key ?? "(none)"}`);
  const read = await workerRead(env, ctx, key);
  if (read.status !== "ok") throw refuse(read.status === "unreachable" ? `${key}: the source can't be reached to check the row` : `${key}: the source has no such row`);
  const row = (await env.db.adbQuery(`SELECT _keys FROM ${section}`))[0];
  const keys = Array.isArray(row?._keys) ? row._keys : [];
  if (!keys.includes(key)) await env.db.adbCommand(`UPDATE ${section} SET _keys = :keys`, "sql", { keys: [...keys, key] });
  return { section, key, stored: true };
}

/**
 * A dependency between instances, stated by the record or by the agent (R1), written by the classes stream's
 * `addDependency` (instances.js, review C-B7): each end an instance the audience sees, or a row's key whose node it
 * makes (R3: a dependency the source can't hold), and refused when the edge would be seen lower than the write floor
 * (R11.13). Filing reads a key's row first and relates the section to both ends after.
 */
export async function stateDependency(args, identity, env) {
  const ctx = await jobContext(identity, env.db);
  if (!ctx) throw refuse("this thread has no record to file");
  const section = ownSection(ctx, args.section);
  const statedAs = args.stated_as === "agent" ? "agent" : "record";
  for (const end of [args.from, args.to]) {
    const s = String(end ?? "").trim();
    if (RID_RE.test(s)) continue;
    const key = parseKey(s)?.key;
    if (!key) throw refuse(`${s}: an instance id, or a row's key`);
    await rowExists(env, ctx, key);
  }
  const r = await env.instances.depend(
    { from: String(args.from).trim(), to: String(args.to).trim(), stated_as: statedAs, stated_by: statedAs === "record" ? ctx.record : identity.user, source: section, note: args.note, valid_from: args.valid_from, valid_until: args.valid_until, stated_at: env.now() },
    workerScope(env, ctx),
    workerActor(identity),
    { home: ctx.home },
  );
  for (const rid of [r.dependency.from, r.dependency.to]) await relate(env, ctx, section, rid);
  return { from: r.dependency.from, to: r.dependency.to, stated_as: r.dependency.stated_as, note: "Stated. It is seen only by someone who sees both ends (R11)." };
}

/** look a name up: instances this audience sees, and rows of a table whose column holds it (read-only; R3) */
export async function resolveName(args, identity, env) {
  const ctx = await jobContext(identity, env.db);
  if (!ctx) throw refuse("this thread has no record to file");
  const n = normName(args.name);
  if (!n) throw refuse("name: what to look up");
  const rows = await env.db.adbQuery(`SELECT @rid AS rid, label, _keys, _homes FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (_norm = :n OR _alias_norms CONTAINS :n) LIMIT 10`, { n }).catch(() => []);
  const instances = rows.filter((r) => (r._homes ?? []).some((h) => h === EVERYONE || audienceSees(env, ctx, h))).map((r) => ({ instance: String(r.rid), label: r.label, keys: r._keys ?? [] }));
  let source = null;
  if (args.table && args.column) {
    const t = String(args.table).split(":");
    if (t.length !== 2) throw refuse("table: system:table");
    await assertTableReadable(env, ctx, String(args.table).trim());
    source = await env.findRows(t[0], t[1], String(args.column), String(args.name), { audience: ctx.home });
    if (source.status === "refused") throw refuse(`${args.table}: ${source.error}`);
  }
  return { instances, ...(source ? { source } : {}), note: source?.status === "unreachable" ? "The source can't be reached: a piece that needs it is Held." : undefined };
}

/** ---- the worker's account, and the orchestrator's check (R10, R11) ---- */

/** the worker says what it did, piece by piece; every entry it wrote needs one before the thread is done */
export async function giveAccount(args, identity, env) {
  const ctx = await jobContext(identity, env.db);
  if (!ctx) throw refuse("this thread has no record to file");
  const mine = await env.store.entries({ worker: ctx.job });
  const byId = new Map(mine.map((e) => [e.id, e]));
  for (const p of args.pieces ?? []) {
    const e = byId.get(String(p.entry ?? "").trim());
    if (!e) throw refuse(`entry ${p.entry} isn't one of yours`);
    const account = normalizeAccount({ said: p.said, at: env.now() });
    await env.store.annotateEntry(e.id, { account });
    e.account = account;
  }
  const missing = mine.filter((e) => !e.account).map((e) => e.id);
  if (!missing.length) await markAccounted(env.db, ctx.job, args.summary);
  return { accounted: mine.length - missing.length, missing, note: missing.length ? "Each entry you wrote needs your account: give the missing ones." : "Your account is in. End your turn with a short report." };
}

async function markAccounted(db, job, summary) {
  const row = (await db.adbQuery("SELECT payload FROM Job WHERE id = :id", { id: job }))[0];
  const p = parse(row?.payload) ?? {};
  p.accounted = true;
  if (summary) p.account_summary = String(summary).slice(0, 2000);
  await db.adbCommand("UPDATE Job SET payload = :p WHERE id = :id", "sql", { p: JSON.stringify(p), id: job });
}

/** has a filing thread given its account: every entry it wrote has one, and it said so (a thread that filed nothing says so too) */
export async function accountGiven(job, payload, env) {
  if (!payload?.record) return true;
  const mine = await env.store.entries({ worker: job });
  return payload.accounted === true && mine.every((e) => e.account);
}

/**
 * What the orchestrator checks a worker's account against: each entry, what the worker said, the row as read from
 * the source now, and a suggested verdict (model/filing.js suggestVerdict). The orchestrator records its own.
 */
export async function accountEvidence(job, env) {
  const mine = await env.store.entries({ worker: String(job) });
  const out = [];
  for (const e of mine) {
    const later = (await env.store.entries({ refiled_from: e.id })).length > 0;
    const read = e.target?.key && !later ? await env.readRow(e.target.key) : null;
    const suggested = later ? { result: "unverifiable", checked: "a later entry supersedes this one" } : suggestVerdict(e, read, sameValue);
    // the record itself (R12: the orchestrator checks the entry afterwards): the section's text, which the orchestrator
    // sees whatever its home; and the row before the write, where the entry recorded it
    const sec = RID_RE.test(String(e.section ?? "")) ? (await env.db.adbQuery(`SELECT text_identity FROM ${e.section} WHERE _kind = 'section'`).catch(() => []))[0] : null;
    const before = /^before: /.test(String(e.reason ?? "")) ? (() => { try { return JSON.parse(String(e.reason).slice(8)); } catch { return null; } })() : /already held it/.test(String(e.reason ?? "")) ? e.target?.fields ?? null : null;
    out.push({ entry: e.id, outcome: e.outcome, section_text: sec?.text_identity ?? null, piece: e.piece, class: e.class, target: e.target, account: e.account?.said ?? null, row_before: before, source_now: read?.status === "ok" && e.target?.fields ? Object.fromEntries(Object.keys(e.target.fields).map((c) => [c, read.row[c] ?? null])) : (read?.status ?? null), suggested, verdict: e.verdict });
  }
  return { job: String(job), entries: out };
}

/** the orchestrator's verdict on one entry's account (R10). NEEDS A RULING (F8): a "differs" flags the entry for a person; nothing is undone */
export async function recordVerdict(entryId, { result, note }, by, env) {
  const e = (await env.store.entries({ id: String(entryId) }))[0];
  if (!e) throw refuse(`no entry ${entryId}`);
  if (!e.account) throw refuse(`entry ${entryId} has no account yet to check`);
  const read = e.target?.key ? await env.readRow(e.target.key) : null;
  const verdict = normalizeVerdict({ result, note, by, checked: suggestVerdict(e, read, sameValue).checked, at: env.now() });
  await env.store.annotateEntry(e.id, { verdict });
  return { entry: e.id, verdict };
}

/** ---- after the fact: approvals, Held answers ---- */

/** the Filed entry an approval appends, pointing back at the Proposed one (NEEDS A RULING F6); once only */
async function fileApproved(e, approver, env) {
  if ((await env.store.entries({ refiled_from: e.id })).length) return false;
  // the account is the worker's for the write it proposed; the approval is the reason (the worker didn't write it)
  const account = e.account ?? { said: `proposed: ${e.piece}`, at: env.now() };
  await appendEntry(env, { outcome: FILED, record: e.record, section: e.section, home: e.home, piece: e.piece, class: e.class, instances: e.instances, target: e.target, recorder: e.recorder, worker: e.worker, reason: `approved by ${approver ?? "a person"}`, refiled_from: e.id, account });
  return true;
}

/**
 * The journal the sources stream's write adapter writes through (data-entry.js loads `sourceJournal`): every source
 * write is begun here before it happens and settled after, so no row changes without the filing log knowing (R9).
 * `attempt`: { system, table, key, action, fields, before, piece }; settle's status: written, refused, unreachable,
 * unknown. A write an approval made (piece.pending_id) that settles written appends the Filed entry superseding the
 * Proposed one: the seam the review named (BUILD.md: filing writes the Filed entry on approval).
 */
export function makeJournal(envOrPromise) {
  const envOf = async () => (typeof envOrPromise === "function" ? envOrPromise() : envOrPromise);
  return {
    async begin(attempt) {
      const env = await envOf();
      const a = { id: randomUUID(), system: attempt?.system ?? null, table: attempt?.table ?? null, key: attempt?.key ?? null, action: attempt?.action ?? null, fields: attempt?.fields ?? null, before: attempt?.before ?? null, piece: attempt?.piece ?? null, status: "begun", detail: null, at: env.now(), settled_at: null };
      if (!a.system || !a.table || !["update", "create"].includes(a.action)) throw new Error("a write's attempt names its system, table and action");
      await env.store.insertAttempt(a);
      return a.id;
    },
    async settle(id, status, detail = null) {
      const env = await envOf();
      if (!["written", "refused", "unreachable", "unknown"].includes(status)) throw new Error(`not a write's status: ${status}`);
      await env.store.updateAttempt(String(id), { status, detail });
      const a = await env.store.attempt(String(id));
      const pending = a?.piece?.pending_id;
      if (status !== "written" || !pending) return;
      const proposed = (await env.store.entries({ pending_id: String(pending) })).find((e) => e.outcome === PROPOSED);
      if (proposed) await fileApproved(proposed, a.piece.approved_by, env);
    },
  };
}

/** the live journal (data-entry.js reads this export) */
export const sourceJournal = makeJournal(() => liveEnv());

/**
 * A Proposed piece a person approved becomes Filed: a new entry pointing back at it (NEEDS A RULING F6). Rejected
 * ones stay Proposed. Idempotent: runs on the worker loop, for an approval that wrote without the journal.
 */
export async function settleProposals(env) {
  const proposed = await env.store.entries({ outcome: PROPOSED });
  let filed = 0;
  for (const e of proposed) {
    if (!e.pending_id) continue;
    const pw = (await env.db.adbQuery("SELECT status, approved_by FROM PendingWrite WHERE id = :id", { id: e.pending_id }).catch(() => []))[0];
    if (pw?.status !== "approved") continue;
    if (await fileApproved(e, pw.approved_by, env)) filed++;
  }
  return { filed };
}

/** the Held questions put to this person (only theirs: R2 asks whoever put it on record) */
export async function heldQuestionsFor(person, db = realDb) {
  const rows = await db.adbQuery("SELECT id, job_id, question, filing_entry, status, answer, created_at FROM WorkerQuestion WHERE asked_of = :p AND status = 'open' ORDER BY created_at ASC LIMIT 200", { p: String(person) }).catch(() => []);
  return rows.map((r) => ({ id: r.id, question: r.question, entry: r.filing_entry, asked_at: r.created_at }));
}

/** the recorder answers a Held question: the worker is resumed to file the piece again (a new entry pointing back) */
export async function answerHeld(id, answer, person, env) {
  const q = (await env.db.adbQuery("SELECT FROM WorkerQuestion WHERE id = :id AND status = 'open'", { id: String(id) }))[0];
  if (!q || q.asked_of !== person) throw refuse(`no open question ${id} for you`);
  const text = String(answer ?? "").trim().slice(0, 2000);
  if (!text) throw refuse("an answer");
  await env.db.adbCommand("UPDATE WorkerQuestion SET status = 'answered', answer = :a, answered_by = :u, answered_at = :now WHERE id = :id", "sql", { a: text, u: person, now: env.now(), id: q.id });
  await env.resume(q.job_id, { held: q.filing_entry, question: q.question, answer: text, answered_by: person });
  return { answered: q.id };
}

/** the log, for the admin and the orchestrator (NEEDS A RULING F16: who else sees it) */
export async function filingLog({ record, outcome, worker, limit = 200 } = {}, env) {
  if (outcome && !OUTCOMES.includes(outcome)) throw refuse(`outcome: one of ${OUTCOMES.join(", ")}`);
  return { entries: await env.store.entries({ record, outcome, worker, limit }) };
}

/** R14: the most times one piece is re-filed (the assistant's number; it can change) */
export const REFILE_LIMIT = 3;

/**
 * R14: whether something that could give a Kept piece a home appeared after `at`: a class created, or a source table
 * declared (a class given its table by update_class, or the stored source declarations changed). Classes made before
 * classes carried a creation time count as older.
 */
export async function laterClassOrSource(at, db = realDb) {
  const cls = await db.adbQuery(`SELECT count(*) AS n FROM ${ENTITY_LABEL} WHERE _kind = 'class' AND (_created_at > :at OR _table_at > :at)`, { at }).catch(() => []);
  if (Number(cls[0]?.n ?? 0) > 0) return true;
  const src = (await db.adbQuery("SELECT updated_at FROM OrgPolicy WHERE scope = 'sources' LIMIT 1").catch(() => []))[0];
  return Boolean(src?.updated_at && String(src.updated_at) > String(at));
}

/**
 * How many times one piece was re-filed: every entry in its refile tree (from the first entry, following
 * refiled_from back, then every entry re-filed from any entry of the tree) but that first one, so sibling re-filings
 * of the same entry count as much as a chain of them.
 */
async function refileCount(env, e) {
  let root = e;
  const back = new Set([e.id]);
  while (root.refiled_from && !back.has(root.refiled_from)) {
    back.add(root.refiled_from);
    const up = (await env.store.entries({ id: root.refiled_from }))[0];
    if (!up) break;
    root = up;
  }
  const seen = new Set([root.id]);
  for (let frontier = [root.id]; frontier.length; ) {
    const next = [];
    for (const id of frontier) for (const c of await env.store.entries({ refiled_from: id })) if (!seen.has(c.id)) (seen.add(c.id), next.push(c.id));
    frontier = next;
  }
  return seen.size - 1;
}

/**
 * Why a Kept entry may not be re-filed now (R14), or null when it may: it was re-filed already (a re-filing goes from
 * the entry it left), its piece was re-filed REFILE_LIMIT times already over the whole refile tree, or no class was
 * created and no source table declared since it was Kept. Enforced here, not only asked of the orchestrator:
 * kept_pieces doesn't offer such a piece and refile refuses it.
 */
export async function refileRefusal(env, e) {
  if (!e || e.outcome !== KEPT) return "it isn't a Kept piece";
  const from = await env.store.entries({ refiled_from: e.id });
  if (from.length) return `this entry was re-filed already (entry ${from[0].id}): re-file what that left, if anything (R14)`;
  const n = await refileCount(env, e);
  if (n >= REFILE_LIMIT) return `this piece was re-filed ${n} times already, the most allowed (R14)`;
  const later = env.laterClassOrSource ?? ((at) => laterClassOrSource(at, env.db));
  if (!(await later(e.at))) return "no class was created and no source table declared since this piece was Kept, so nothing new could give it a home (R14)";
  return null;
}

/**
 * Kept pieces nothing has re-filed yet (R11: nothing Kept is deleted; the orchestrator re-files them), offered only
 * when R14 allows a re-filing: something new since, and fewer than REFILE_LIMIT re-filings behind it.
 */
export async function keptPieces(env) {
  const kept = await env.store.entries({ outcome: KEPT });
  const out = [];
  for (const e of kept) {
    if (await refileRefusal(env, e)) continue;
    out.push({ entry: e.id, record: e.record, home: e.home, piece: e.piece, instances: e.instances, at: e.at });
  }
  return out;
}

/** the filing routes (the integrator wires them: routes.js calls registerFilingRoutes(app)) */
export function registerFilingRoutes(app, { resolveIdentity, personOf, isRoot }) {
  const who = (req) => resolveIdentity(req.headers.authorization);
  app.get("/api/filing/held", async (req, res) => {
    const identity = who(req);
    if (!identity || identity.role) return res.status(401).json({ error: "a person asks for their own questions" });
    res.json({ questions: await heldQuestionsFor(personOf(identity.user)) });
  });
  app.post("/api/filing/held/:id/answer", async (req, res) => {
    const identity = who(req);
    if (!identity || identity.role || identity.agent) return res.status(401).json({ error: "the person who put it on record answers" });
    try {
      res.json(await answerHeld(req.params.id, req.body?.answer, personOf(identity.user), await liveEnv()));
    } catch (e) {
      res.status(e.refused ? 400 : 500).json({ error: String(e.message ?? e) });
    }
  });
  app.get("/api/filing/log", async (req, res) => {
    const identity = who(req);
    if (!identity || !isRoot(identity)) return res.status(403).json({ error: "the filing log is the admin's" });
    try {
      res.json(await filingLog({ record: req.query.record || undefined, outcome: req.query.outcome || undefined, worker: req.query.worker || undefined }, await liveEnv()));
    } catch (e) {
      res.status(e.refused ? 400 : 500).json({ error: String(e.message ?? e) });
    }
  });
}

/** WorkerQuestion carries who a Held question is for and which entry it holds (the filing stream's type, not the contract's) */
export async function ensureFilingSchema(db = realDb) {
  for (const prop of ["asked_of", "filing_entry"]) await db.adbCommand(`CREATE PROPERTY WorkerQuestion.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await db.adbCommand("CREATE INDEX IF NOT EXISTS ON WorkerQuestion (asked_of) NOTUNIQUE").catch(() => {});
  await db.adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._keys IF NOT EXISTS LIST`).catch(() => {});
  // a source write's attempt (makeJournal): a document, never a vertex or an edge (R9). Requested of the integrator as a TYPES entry
  await db.adbCommand("CREATE DOCUMENT TYPE FilingAttempt IF NOT EXISTS").catch(() => {});
  for (const prop of ATTEMPT_FIELDS.map(ATTEMPT_COLUMN)) await db.adbCommand(`CREATE PROPERTY FilingAttempt.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await db.adbCommand("CREATE INDEX IF NOT EXISTS ON FilingAttempt (id) UNIQUE").catch(() => {});
}
