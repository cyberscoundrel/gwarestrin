// The filing log, worker accounts, the orchestrator's verdicts, and requests (docs/ORGANIZATION-MODEL.md,
// "How workers file a record" and "The orchestrator, workers and briefs"). Pure shapes.
//
//   entry:   one filing outcome. A piece is whatever one entry covers; the worker decides the split while
//            filing, and nothing is stored to divide sections (R11). Each piece ends in one outcome (R2).
//   account: what the worker says it did, in any medium (R10)
//   verdict: the orchestrator's evaluation of that account, checked against the source itself (R10, R11)
//   request: a worker asking the orchestrator instead of resolving something that isn't low stakes (R10)
//
// One filing log outside the knowledge graph holds every outcome, including source writes; there are no
// audit nodes (R9). NEEDS A RULING (where the log lives): smallest choice, a FilingEntry document type in
// the same ArcadeDB database (schema.js): no vertex, no edge, and no graph read returns it.
import { clip, isoDate, nonEmpty, ShapeError } from "./text.js";
import { parseKey, parseTable } from "./schema.js";
import { classKey } from "./classes.js";

export const FILED = "filed";
export const PROPOSED = "proposed";
export const HELD = "held";
export const KEPT = "kept";
/** R2: Filed, Proposed, Held, Kept */
export const OUTCOMES = [FILED, PROPOSED, HELD, KEPT];

/**
 * What an orchestrator's check of an account found. NEEDS A RULING (verdict values): smallest choice,
 * matches (the source shows what the account says), differs (it doesn't), unverifiable (nothing to check
 * it against, or the source couldn't be read).
 */
export const VERDICTS = ["matches", "differs", "unverifiable"];

/**
 * What a worker asks the orchestrator. R11: high stakes is new classes or subclasses, and conflicts with a
 * source. NEEDS A RULING (conflicts): R2 has a disagreeing source Held with a question to the recorder,
 * R11 calls a conflict with a source high stakes. Smallest choice: such a piece is Held and the worker
 * also raises a "conflict" request; "other" covers anything else a worker won't resolve on its own.
 */
export const REQUEST_KINDS = ["class", "conflict", "other"];
export const REQUEST_STATUSES = ["open", "answered", "withdrawn"];

/**
 * R15: a worker that ends without filing. graph-rag itself raises a request for each section left without an entry
 * (raised_by GRAPH_RAG), and a section nobody settles is filed as one Kept piece with this reason: the whole section,
 * at its home, with whatever instances the worker related (none, possibly: the document itself is the source).
 */
export const GRAPH_RAG = "graph-rag";
export const FLOOR_REASON = "worker ended without filing";

const date = (v, field, fallback = null) => {
  if (v === undefined || v === null || v === "") {
    if (fallback !== null) return fallback;
    throw new ShapeError(field, "needs a date");
  }
  const d = isoDate(v);
  if (!d) throw new ShapeError(field, `not a date: ${v}`);
  return d;
};
const str = (v, max) => (nonEmpty(v) ? clip(v, max) : null);

/** a worker's account of what it did: { said, at } (R10) */
export function normalizeAccount(raw, field = "account") {
  if (typeof raw === "string") raw = { said: raw };
  if (!raw || typeof raw !== "object") throw new ShapeError(field, "must be what the worker says it did");
  if (!nonEmpty(raw.said)) throw new ShapeError(`${field}.said`, "needs what the worker says it did");
  return { said: clip(raw.said, 2000), at: date(raw.at, `${field}.at`, new Date().toISOString()) };
}

/** the orchestrator's verdict on an account: { result, checked, note, by, at } */
export function normalizeVerdict(raw, field = "verdict") {
  if (!raw || typeof raw !== "object") throw new ShapeError(field, "must be an object");
  if (!VERDICTS.includes(raw.result)) throw new ShapeError(`${field}.result`, `must be one of ${VERDICTS.join(", ")}`);
  if (!nonEmpty(raw.by)) throw new ShapeError(`${field}.by`, "needs who checked it");
  return { result: raw.result, checked: str(raw.checked, 300), note: str(raw.note, 1000), by: clip(raw.by, 120), at: date(raw.at, `${field}.at`, new Date().toISOString()) };
}

/**
 * Where a piece went: a row in a source ({ source, table, key }) for Filed, Proposed and Held, or the
 * record itself for Kept (no system holds it: the document is the source, linked to instances).
 */
function normalizeTarget(raw, outcome) {
  if (outcome === KEPT) return null;
  if (!raw || typeof raw !== "object") throw new ShapeError("target", "needs the source and table the piece goes to");
  const table = nonEmpty(raw.table) ? String(raw.table).trim() : null;
  if (!table || !parseTable(table)) throw new ShapeError("target.table", "needs system:table");
  const key = nonEmpty(raw.key) ? String(raw.key).trim() : null;
  if (key && !parseKey(key)) throw new ShapeError("target.key", `not system:table:row: ${key}`);
  if (outcome === FILED && !key) throw new ShapeError("target.key", "a Filed piece names the row it wrote");
  const fields = raw.fields === undefined || raw.fields === null ? null : raw.fields;
  if (fields !== null && (typeof fields !== "object" || Array.isArray(fields))) throw new ShapeError("target.fields", "must map columns to values");
  return { table, key, fields };
}

/**
 * One filing-log entry, normalized; throws ShapeError naming the field.
 *   { id, outcome, record, section, home, piece, class, instances, target, recorder, worker,
 *     pending_id, question, request, account, verdict, refiled_from, at }
 * `home` is the section's home: the entry carries the piece's words, so it is seen no wider than its section.
 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ShapeError("entry", "must be an object");
  if (!nonEmpty(raw.id)) throw new ShapeError("id", "needs an id");
  if (!OUTCOMES.includes(raw.outcome)) throw new ShapeError("outcome", `must be one of ${OUTCOMES.join(", ")}`);
  for (const k of ["record", "section", "home", "recorder", "worker"]) if (!nonEmpty(raw[k])) throw new ShapeError(k, "is needed");
  if (!nonEmpty(raw.piece)) throw new ShapeError("piece", "needs what the piece says");
  const instances = raw.instances === undefined || raw.instances === null ? [] : raw.instances;
  if (!Array.isArray(instances) || instances.some((r) => !nonEmpty(r))) throw new ShapeError("instances", "must be a list of record ids");
  if (raw.outcome === HELD && !nonEmpty(raw.question)) throw new ShapeError("question", "a Held piece asks whoever put it on record");
  if (raw.outcome === PROPOSED && !nonEmpty(raw.reason)) throw new ShapeError("reason", "a Proposed piece says why it isn't Filed");
  // R11: a class missing from the map means Proposed, so a Filed piece passed the map under a class
  if (raw.outcome === FILED && !nonEmpty(raw.class)) throw new ShapeError("class", "a Filed piece names the class the map passed it under");
  // R10: a worker that resolves a piece to storage reports what it did
  if (raw.outcome === FILED && (raw.account === undefined || raw.account === null)) throw new ShapeError("account", "a Filed piece carries the account of what was written");
  // R2: Kept is "linked to instances"
  // R15: the floor's Kept piece carries whatever instances the worker related, which may be none
  if (raw.outcome === KEPT && !instances.length && !String(raw.reason ?? "").startsWith(FLOOR_REASON)) throw new ShapeError("instances", "a Kept piece is linked to the instances it is about");
  return {
    id: String(raw.id).trim(),
    outcome: raw.outcome,
    record: String(raw.record).trim(),
    section: String(raw.section).trim(),
    home: String(raw.home).trim(),
    piece: clip(raw.piece, 1000),
    class: nonEmpty(raw.class) ? classKey(raw.class) : null,
    instances: instances.map((r) => String(r).trim()),
    target: normalizeTarget(raw.target, raw.outcome),
    recorder: String(raw.recorder).trim(),
    worker: String(raw.worker).trim(),
    reason: str(raw.reason, 600),
    pending_id: str(raw.pending_id, 80),
    question: str(raw.question, 1000),
    request: str(raw.request, 80),
    account: raw.account === undefined || raw.account === null ? null : normalizeAccount(raw.account),
    verdict: raw.verdict === undefined || raw.verdict === null ? null : normalizeVerdict(raw.verdict),
    // R11: when a fitting class or source appears, the orchestrator re-files matching Kept pieces in a later batch
    refiled_from: str(raw.refiled_from, 80),
    at: date(raw.at, "at", new Date().toISOString()),
  };
}

/** does an entry's account still wait for the orchestrator's check */
export const awaitingVerdict = (e) => Boolean(e.account) && !e.verdict;

/** one request from a worker to the orchestrator, normalized */
export function normalizeRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ShapeError("request", "must be an object");
  if (!nonEmpty(raw.id)) throw new ShapeError("id", "needs an id");
  if (!REQUEST_KINDS.includes(raw.kind)) throw new ShapeError("kind", `must be one of ${REQUEST_KINDS.join(", ")}`);
  for (const k of ["record", "worker", "home"]) if (!nonEmpty(raw[k])) throw new ShapeError(k, "is needed");
  if (!nonEmpty(raw.question)) throw new ShapeError("question", "needs what the worker asks");
  const status = raw.status ?? "open";
  if (!REQUEST_STATUSES.includes(status)) throw new ShapeError("status", `must be one of ${REQUEST_STATUSES.join(", ")}`);
  if (status === "answered" && (!nonEmpty(raw.answer) || !nonEmpty(raw.answered_by))) throw new ShapeError("answer", "an answered request has the answer and who gave it");
  return {
    id: String(raw.id).trim(),
    kind: raw.kind,
    record: String(raw.record).trim(),
    section: str(raw.section, 80),
    home: String(raw.home).trim(),
    worker: String(raw.worker).trim(),
    question: clip(raw.question, 1000),
    // a class request names what the worker found no class for, and the parents it would suggest
    suggestion: str(raw.suggestion, 600),
    status,
    answer: str(raw.answer, 2000),
    answered_by: str(raw.answered_by, 120),
    // who raised it: the worker (null), or graph-rag itself for a worker that ended without filing (R15)
    raised_by: str(raw.raised_by, 40),
    at: date(raw.at, "at", new Date().toISOString()),
  };
}

/**
 * R16 (the user, 2026-11-11) replaced R12's state-versus-change test and the disagreement rule that applied it
 * (onDisagreement: update_when_changed, hold_and_request): whether a source write lands is decided in code by four
 * conditions (filing.js fileToSource, model/write-conditions.js), and nothing a worker says about the piece counts.
 */

/**
 * The columns of `fields` the row already holds a different, non-empty value in (`same`: a value comparison,
 * data-entry.js sameValue). An empty column taking a value is no disagreement: nothing is overwritten.
 * NEEDS A RULING (F21): R2's "never overwrites" read as "never replaces a value"; an empty column is filled without asking.
 */
export function disagreeingColumns(row, fields, same = (a, b) => a === b) {
  if (!row || !fields) return [];
  const empty = (v) => v === null || v === undefined || (typeof v === "string" && !v.trim());
  return Object.entries(fields)
    .filter(([c, v]) => c in row && !empty(row[c]) && !same(row[c], v))
    .map(([c, v]) => ({ column: c, source: row[c], record: v }));
}

/**
 * What a worker's request is answered with: structured, never free text, so nothing above the worker's
 * audience can ride along (NEEDS A RULING F7). `class` names a class for use_class / class_created; the caller
 * checks the worker's audience can see it.
 *   use_class      file the piece under this existing class
 *   class_created  the orchestrator made this class: file the piece under it
 *   keep           no class fits: keep the piece (the document is its source)
 *   hold           leave the piece Held with its question to the recorder
 *   update         (a conflict) the record states a change: file it as an update, given authority
 */
export const ANSWERS = ["use_class", "class_created", "keep", "hold", "update"];

export function normalizeAnswer(raw) {
  if (!raw || typeof raw !== "object") throw new ShapeError("answer", "must be { decision, class? }");
  if (!ANSWERS.includes(raw.decision)) throw new ShapeError("answer.decision", `must be one of ${ANSWERS.join(", ")}`);
  const needsClass = raw.decision === "use_class" || raw.decision === "class_created";
  if (needsClass && !nonEmpty(raw.class)) throw new ShapeError("answer.class", `${raw.decision} names the class`);
  if (!needsClass && nonEmpty(raw.class)) throw new ShapeError("answer.class", `${raw.decision} names no class`);
  return { decision: raw.decision, class: needsClass ? classKey(raw.class) : null };
}

/** the suggested verdict on one entry, from the source as read now (the orchestrator records its own: R10, R11) */
export function suggestVerdict(entry, read, same = (a, b) => a === b) {
  if (entry.outcome === KEPT) return { result: "unverifiable", checked: "a Kept piece has no source to check" };
  const fields = entry.target?.fields ?? null;
  if (!entry.target?.key || !fields) return { result: "unverifiable", checked: "the entry names no row and fields" };
  if (!read || read.status === "unreachable") return { result: "unverifiable", checked: "the source couldn't be read" };
  // R12 "the orchestrator checks it afterwards": whether an entry says what its section says is the orchestrator's
  // judgement, from the section's text (accountEvidence gives it). This hands over a verdict only where there is
  // nothing to judge (a Kept piece, a source that can't be read, a Filed write that isn't in the row); otherwise only
  // the facts about the row, as `checked`, and no result
  if (read.status === "not_found") return entry.outcome === FILED ? { result: "differs", checked: `no row ${entry.target.key}: the write is not in the source` } : { checked: `no row ${entry.target.key}: nothing was written` };
  const holds = Object.entries(fields).every(([c, v]) => c in read.row && same(read.row[c], v));
  if (entry.outcome === FILED) return holds ? { checked: `the row holds what was filed` } : { result: "differs", checked: `${entry.target.key} doesn't hold what was filed: the write didn't land, or was changed since` };
  // Proposed and Held write nothing: a row holding the piece's values is either an approval since, or a write that shouldn't have happened
  return holds ? { checked: `the row holds the piece's values though it was ${entry.outcome}: an approval since, or a write that shouldn't have happened` } : { checked: `the row is unchanged by this piece` };
}
