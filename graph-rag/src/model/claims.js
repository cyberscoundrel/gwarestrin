// What a condenser emits, validated and normalized: a document with
// context, its sections, and the claims extracted from each section
// (docs/ORGANIZATION-MODEL.md, "Inputs: on record, condensed, per claim").
//
//   document: { title, description?, recorded_by, position, reason,
//               recorded_at?, sections: [section] }
//   section:  { heading?, text, claims: [claim] }
//   claim:    { kind, subject, class, attribute, value,
//               valid_from?, valid_until?, at?, recorded_at? }
//   subject:  { key?, name?, class?, actor?, scope? } or a string
//             an instance: `class` (a confirmed class; defaults to the
//             claim's) and a `key` (system:table:row) or a `name`; an actor:
//             `actor` (person, position, customer, supplier, agent) and a
//             name or key; a class itself (an aggregate observation, a need
//             on a process): `scope: "class"` with `class` and an optional
//             qualifying `name`. A string is a key when it parses as one,
//             else a name, with the claim's class.
//
// Every error names the field it is about (`sections[1].claims[0].value`).
// Dates are ISO, or relative to the claim's recording: `recorded_at`,
// `recorded_at+14d` (d, w, m, y). The interval rule is decision 3: a claim
// with no dates is valid from recorded_at, open-ended, and closed by the next
// claim on the same attribute of the same subject (`closeIntervals`). An
// event is a point in time (`at`) unless the text gives it an end (a two-day
// closure); events neither close nor are closed.
// Nothing here stores anything; pure functions over plain objects.
import { ACTOR_TYPES, CLAIM_KINDS, parseKey, STAGE_ATTRIBUTE } from "./schema.js";

/** an error that names the field (a path into the document) it is about */
export class ClaimError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = "ClaimError";
    this.field = field;
    this.reason = message;
  }
}

/** "Credit limit" / "creditLimit" / "credit-limit" -> "credit_limit" (like things.js normalizeRel) */
export const normalizeAttribute = (a) =>
  String(a ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

/** a name for matching: case and punctuation dropped (things.js normalize) */
export const normalizeName = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** a date as the condenser writes it (ISO, or YYYY-MM-DD) -> ISO, or null when unusable */
export function isoDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "number") return Number.isFinite(v) ? new Date(v).toISOString() : null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null;
  // no zone given: UTC (a condenser's local time is unknown; a date alone is its start)
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00.000Z` : withZone.replace(" ", "T"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const REL_RE = /^recorded_at(?:\s*\+\s*(\d{1,4})\s*([dwmy]))?$/i;

/**
 * A date as the condenser writes it, resolved against the claim's
 * recording: ISO, or `recorded_at`, or `recorded_at+14d` (d days, w weeks,
 * m calendar months, y years). Null when unusable.
 */
export function resolveDate(v, recordedAt) {
  const m = typeof v === "string" ? REL_RE.exec(v.trim()) : null;
  if (!m) return isoDate(v);
  const base = isoDate(recordedAt);
  if (!base) return null;
  if (!m[1]) return base;
  const d = new Date(base);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "d") d.setUTCDate(d.getUTCDate() + n);
  else if (unit === "w") d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (unit === "m") d.setUTCMonth(d.getUTCMonth() + n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString();
}

/** the classes a document is validated against: a list (the fixture) or a map, by name */
export function classIndex(classes) {
  const list = Array.isArray(classes) ? classes : classes?.classes ? classes.classes : Object.values(classes ?? {});
  const out = new Map();
  for (const c of list) if (c && typeof c.name === "string") out.set(c.name, c);
  return out;
}

const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;
const text = (v, max) => String(v).replace(/\s+/g, " ").trim().slice(0, max);

/** what identifies a subject across claims: its key, else its class/actor and normalized name */
export function subjectId(subject) {
  if (subject.scope === "class") return `class|${subject.class}|${normalizeName(subject.name)}`;
  if (subject.key) return `key|${subject.key}`;
  return `${subject.class ?? subject.actor}|${normalizeName(subject.name)}`;
}

/**
 * One subject, normalized; throws ClaimError. `claimClass` is the claim's
 * own class, which an instance subject takes when it names none. A string
 * is a key when it parses as one, else a name.
 */
export function normalizeSubject(raw, field, classes, claimClass = null) {
  if (typeof raw === "string") raw = parseKey(raw.trim()) ? { key: raw.trim() } : { name: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ClaimError(field, "must be a key, a name, or an object with one");
  const key = raw.key === undefined || raw.key === null || raw.key === "" ? null : String(raw.key).trim();
  if (key !== null && !parseKey(key)) throw new ClaimError(`${field}.key`, `not a record key (system:table:row): ${key}`);
  const name = nonEmpty(raw.name) ? text(raw.name, 120) : null;
  const hasActor = nonEmpty(raw.actor);
  const scope = raw.scope === undefined || raw.scope === null ? null : String(raw.scope).trim().toLowerCase();
  if (scope !== null && scope !== "class") throw new ClaimError(`${field}.scope`, 'must be "class" when given: the subject is the class itself');
  if (hasActor) {
    if (scope) throw new ClaimError(`${field}.scope`, "an actor is not a class");
    if (!key && !name) throw new ClaimError(field, "needs a key or a name");
    const actor = String(raw.actor).trim().toLowerCase();
    if (!ACTOR_TYPES.includes(actor)) throw new ClaimError(`${field}.actor`, `must be one of ${ACTOR_TYPES.join(", ")}`);
    return { key, name, class: null, actor, scope: null };
  }
  const cls = nonEmpty(raw.class) ? String(raw.class).trim() : claimClass;
  if (!cls) throw new ClaimError(`${field}.class`, "an instance needs its class (or the claim one), an actor its actor");
  if (classes && !classes.has(cls)) throw new ClaimError(`${field}.class`, `not a confirmed class: ${cls}`);
  if (scope === "class") {
    if (key) throw new ClaimError(`${field}.key`, "a class subject has no row; give a key for an instance");
    return { key: null, name, class: cls, actor: null, scope: "class" };
  }
  if (!key && !name) throw new ClaimError(field, "needs a key or a name (or scope \"class\" for the class itself)");
  return { key, name, class: cls, actor: null, scope: null };
}

/**
 * One claim, normalized; throws ClaimError. `recordedAt` and `recordedBy`
 * come from the document unless the claim gives its own recorded_at.
 * The interval: an event is a point (`at`, else recorded_at); anything else
 * runs from valid_from (else recorded_at) to valid_until (else open).
 */
export function normalizeClaim(raw, field, { classes, recordedAt, recordedBy, section } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ClaimError(field, "must be an object");
  const kind = String(raw.kind ?? "").trim().toLowerCase();
  if (!CLAIM_KINDS.includes(kind)) throw new ClaimError(`${field}.kind`, `must be one of ${CLAIM_KINDS.join(", ")}`);
  const own = nonEmpty(raw.class) ? String(raw.class).trim() : null;
  const subject = normalizeSubject(raw.subject, `${field}.subject`, classes, own);
  const clsName = own ?? subject.class;
  if (!clsName) throw new ClaimError(`${field}.class`, "a claim about an actor must name the commitment class it bears on");
  if (classes && !classes.has(clsName)) throw new ClaimError(`${field}.class`, `not a confirmed class: ${clsName}`);
  if (subject.class && subject.class !== clsName) throw new ClaimError(`${field}.class`, `differs from the subject's class (${subject.class})`);
  const attribute = normalizeAttribute(raw.attribute);
  if (!attribute) throw new ClaimError(`${field}.attribute`, "needs an attribute");
  if (raw.value === undefined || raw.value === null || raw.value === "") throw new ClaimError(`${field}.value`, "needs a value");
  let value;
  let valueNum = null;
  if (typeof raw.value === "number") {
    if (!Number.isFinite(raw.value)) throw new ClaimError(`${field}.value`, "must be finite");
    value = JSON.stringify(raw.value);
    valueNum = raw.value;
  } else if (typeof raw.value === "boolean") value = JSON.stringify(raw.value);
  else if (typeof raw.value === "string") {
    value = text(raw.value, 600);
    if (!value) throw new ClaimError(`${field}.value`, "needs a value");
    if (/^-?\d+(\.\d+)?$/.test(value)) valueNum = Number(value);
  } else throw new ClaimError(`${field}.value`, "must be a string, number or boolean");
  if (attribute === STAGE_ATTRIBUTE && classes) {
    const stages = classes.get(clsName)?.stages ?? [];
    if (!stages.includes(value)) throw new ClaimError(`${field}.value`, `not a stage of ${clsName}: ${value} (stages: ${stages.join(", ")})`);
  }
  const recorded = isoDate(raw.recorded_at ?? recordedAt);
  if (!recorded) throw new ClaimError(`${field}.recorded_at`, "needs a date (ISO)");
  const by = nonEmpty(raw.recorded_by) ? String(raw.recorded_by).trim() : recordedBy;
  if (!nonEmpty(by)) throw new ClaimError(`${field}.recorded_by`, "needs the person");
  const date = (k) => {
    if (raw[k] === undefined || raw[k] === null || raw[k] === "") return null;
    const d = resolveDate(raw[k], recorded);
    if (!d) throw new ClaimError(`${field}.${k}`, `not a date (ISO, recorded_at, recorded_at+14d): ${raw[k]}`);
    return d;
  };
  let validFrom;
  let validUntil;
  if (kind === "event") {
    // a point in time unless the text gives it an end (a two-day closure)
    validFrom = date("at") ?? date("valid_from") ?? recorded;
    validUntil = date("valid_until") ?? validFrom;
  } else {
    validFrom = date("valid_from") ?? recorded;
    validUntil = date("valid_until");
  }
  if (validUntil && validUntil < validFrom) throw new ClaimError(`${field}.valid_until`, `ends (${validUntil}) before it starts (${validFrom})`);
  return {
    ...(nonEmpty(raw.id) ? { id: String(raw.id).trim() } : {}),
    kind,
    subject,
    class: clsName,
    attribute,
    value,
    value_num: valueNum,
    valid_from: validFrom,
    valid_until: validUntil,
    recorded_at: recorded,
    recorded_by: by,
    ...(section !== undefined ? { section } : {}),
  };
}

/**
 * A whole document; throws the first ClaimError. `classes`: the confirmed
 * set (a list, the fixture object, or a map); omitted = any class name
 * passes (a stream that has not loaded them yet). `now`: recorded_at when
 * the document gives none.
 */
export function normalizeDocument(raw, { classes, now = Date.now() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ClaimError("document", "must be an object");
  const idx = classes === undefined ? undefined : classIndex(classes);
  if (!nonEmpty(raw.title)) throw new ClaimError("title", "needs a title");
  if (!nonEmpty(raw.recorded_by)) throw new ClaimError("recorded_by", "needs the person who put it on record");
  if (!nonEmpty(raw.position)) throw new ClaimError("position", "needs the position it was recorded under");
  if (!nonEmpty(raw.reason)) throw new ClaimError("reason", "needs why it is on record");
  const recordedAt = isoDate(raw.recorded_at ?? now);
  if (!recordedAt) throw new ClaimError("recorded_at", `not a date: ${raw.recorded_at}`);
  if (!Array.isArray(raw.sections) || raw.sections.length === 0) throw new ClaimError("sections", "needs at least one section");
  const recordedBy = String(raw.recorded_by).trim();
  const sections = raw.sections.map((s, i) => {
    const f = `sections[${i}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new ClaimError(f, "must be an object");
    if (!nonEmpty(s.text)) throw new ClaimError(`${f}.text`, "needs text");
    const claims = s.claims === undefined || s.claims === null ? [] : s.claims;
    if (!Array.isArray(claims)) throw new ClaimError(`${f}.claims`, "must be a list");
    return {
      index: i,
      heading: nonEmpty(s.heading) ? text(s.heading, 120) : null,
      text: String(s.text).replace(/\r\n?/g, "\n").trim(),
      claims: claims.map((c, j) => normalizeClaim(c, `${f}.claims[${j}]`, { classes: idx, recordedAt, recordedBy, section: i })),
    };
  });
  return {
    title: text(raw.title, 200),
    description: nonEmpty(raw.description) ? text(raw.description, 1000) : null,
    on_record: true,
    recorded_by: recordedBy,
    recorded_at: recordedAt,
    position: String(raw.position).trim(),
    reason: text(raw.reason, 300),
    sections,
  };
}

/**
 * Every problem at once: { document | null, errors: [{ field, message }] }.
 * Document-level errors stop at the first; claims are checked one by one so
 * a condenser sees all of its mistakes.
 */
export function validateDocument(raw, opts = {}) {
  const errors = [];
  let document = null;
  try {
    document = normalizeDocument(raw, opts);
  } catch (e) {
    if (!(e instanceof ClaimError)) throw e;
    errors.push({ field: e.field, message: e.reason });
    // keep going through the claims when the document itself is sound
    if (e.field.startsWith("sections[") && /\.claims\[\d+\]/.test(e.field) && Array.isArray(raw?.sections)) {
      const idx = opts.classes === undefined ? undefined : classIndex(opts.classes);
      const recordedAt = isoDate(raw.recorded_at ?? opts.now ?? Date.now());
      const recordedBy = typeof raw.recorded_by === "string" ? raw.recorded_by.trim() : "";
      raw.sections.forEach((s, i) => {
        if (!Array.isArray(s?.claims)) return;
        s.claims.forEach((c, j) => {
          const f = `sections[${i}].claims[${j}]`;
          if (f === e.field || e.field.startsWith(`${f}.`)) return;
          try {
            normalizeClaim(c, f, { classes: idx, recordedAt, recordedBy, section: i });
          } catch (e2) {
            if (!(e2 instanceof ClaimError)) throw e2;
            errors.push({ field: e2.field, message: e2.reason });
          }
        });
      });
    }
  }
  return { document, errors };
}

/** every claim of a normalized document, in order, each knowing its section */
export function claimsOf(document) {
  return document.sections.flatMap((s) => s.claims.map((c) => ({ ...c, section: s.index })));
}

/**
 * Decision 3, as a pure function over claims (normalized, from any number of
 * documents): the next claim on the same attribute of the same subject
 * closes an open interval at its own valid_from. Two claims starting at the
 * same instant are not a succession: both stay open (overlaps() names them
 * when their values differ) until a later one closes them. Events are
 * points: they neither close nor are closed. A claim already closed keeps
 * its end. Returns new claim objects (closed ones carry `closed_by` = the
 * closer's id, or its index in `claims` when it has none); order is preserved.
 */
export function closeIntervals(claims) {
  const out = claims.map((c) => ({ ...c }));
  const groups = new Map();
  out.forEach((c, i) => {
    if (c.kind === "event") return;
    const k = `${subjectId(c.subject)}|${c.attribute}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  for (const idxs of groups.values()) {
    idxs.sort((a, b) => out[a].valid_from.localeCompare(out[b].valid_from) || out[a].recorded_at.localeCompare(out[b].recorded_at) || a - b);
    for (let n = 0; n < idxs.length; n++) {
      const cur = out[idxs[n]];
      if (cur.valid_until !== null) continue;
      const later = idxs.slice(n + 1).find((i) => out[i].valid_from > cur.valid_from);
      if (later === undefined) continue;
      cur.valid_until = out[later].valid_from;
      cur.closed_by = out[later].id ?? later;
    }
  }
  return out;
}

/** the claims in force at `asOf` (ISO): started by then, not ended (an open end counts as in force) */
export function inForce(claims, asOf) {
  const t = isoDate(asOf);
  // an event is in force through its end (a point is in force at its instant); a state ends when the next one starts
  return claims.filter((c) => c.valid_from <= t && (c.valid_until === null || (c.kind === "event" ? c.valid_until >= t : c.valid_until > t)));
}

/**
 * The current state of one subject at `asOf`: attribute -> the claim in
 * force, the latest valid_from (then latest recorded_at) winning when two
 * overlap. Events are left out: state is what holds, not what happened.
 */
export function stateOf(claims, subject, asOf) {
  const id = subjectId(subject);
  const out = {};
  for (const c of inForce(claims, asOf)) {
    if (c.kind === "event" || subjectId(c.subject) !== id) continue;
    const prev = out[c.attribute];
    if (!prev || c.valid_from > prev.valid_from || (c.valid_from === prev.valid_from && c.recorded_at > prev.recorded_at)) out[c.attribute] = c;
  }
  return out;
}

/**
 * Contradictions: two non-event claims on one attribute of one subject
 * whose intervals overlap and whose values differ. Run after
 * closeIntervals, so what one claim supersedes is not a contradiction; what
 * remains is for a person or the worker. Returns pairs [a, b].
 */
export function overlaps(claims) {
  const pairs = [];
  const groups = new Map();
  for (const c of claims) {
    if (c.kind === "event") continue;
    const k = `${subjectId(c.subject)}|${c.attribute}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.value === b.value) continue;
        const aEnd = a.valid_until ?? "9999";
        const bEnd = b.valid_until ?? "9999";
        if (a.valid_from < bEnd && b.valid_from < aEnd) pairs.push([a, b]);
      }
  }
  return pairs;
}
