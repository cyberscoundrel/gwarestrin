// A worker's brief, scoped to an audience (R7: "Workers start with a brief: the record, the relevant class
// tree, connected instances, how each source is committed to. A brief contains only what the record
// audience can see, enforced in code."). A record whose sections have different homes is split by home,
// one worker per home, each seeing only its audience (R11). Pure.
//
//   { audience, record, sections, classes, instances, sources }
//
// `audience` is the home of the sections the brief is for: everyone who sees them holds that position or
// one above it, so the brief holds only what a holder of `audience` itself sees (positions.canSee).
import { canSee, EVERYONE } from "../positions.js";
import { ShapeError } from "./text.js";

const homeOk = (positions, audience, home) => canSee(positions, [audience], home ?? positions.root);
/** an instance is visible wherever a section about it is (R11): any one of its homes will do */
const instanceOk = (positions, audience, i) => (i.homes ?? []).some((h) => homeOk(positions, audience, h));

/** the sections of a record grouped by home: one brief, and one worker, per group (R11) */
export function splitByHome(sections) {
  const out = new Map();
  for (const s of sections) {
    if (!s?.home) throw new ShapeError("sections", "every section needs its home");
    if (!out.has(s.home)) out.set(s.home, []);
    out.get(s.home).push(s);
  }
  return [...out].map(([home, list]) => ({ audience: home, sections: list }));
}

/**
 * Build a brief for one audience from what the caller gathered, dropping whatever that audience can't see.
 * `dropped` counts what was left out, by kind, so a caller can tell a thin brief from a filtered one;
 * it never names what was dropped.
 */
export function scopeBrief({ audience, record, sections = [], classes = [], instances = [], sources = [] }, positions) {
  if (!audience || (audience !== EVERYONE && !positions.positions[audience])) throw new ShapeError("audience", `unknown position: ${audience}`);
  const keep = (list, ok) => {
    const kept = list.filter(ok);
    return [kept, list.length - kept.length];
  };
  const [s, ds] = keep(sections, (x) => homeOk(positions, audience, x.home));
  const [c, dc] = keep(classes, (x) => homeOk(positions, audience, x.home));
  const [i, di] = keep(instances, (x) => instanceOk(positions, audience, x));
  // the record is its title and description only, never its sections (they come one by one, above); its title is
  // homed by R11 (the strictest home among its sections), and a record with no home counts as the root
  const recordOk = Boolean(record) && homeOk(positions, audience, record.home);
  return {
    brief: { audience, record: recordOk ? briefRecord(record) : null, sections: s, classes: c, instances: i, sources },
    dropped: { sections: ds, classes: dc, instances: di, record: record && !recordOk ? 1 : 0 },
  };
}

/**
 * what a brief may say of a record: its id, title, description, the title's home, and the day it was put on record
 * (a date column may take that day: write-conditions.js, I-57); nothing else
 */
export const RECORD_FIELDS = ["id", "title", "description", "home", "recorded_at"];
const briefRecord = (r) => Object.fromEntries(RECORD_FIELDS.map((k) => [k, r[k] ?? null]));

/** the check the brief's sender runs last: throws ShapeError when anything in it is above the audience */
export function assertBrief(brief, positions) {
  const { audience } = brief ?? {};
  if (!audience) throw new ShapeError("audience", "a brief needs its audience");
  if (brief.record) {
    // a record carrying anything but its title and description could carry sections above the audience (R7)
    const extra = Object.keys(brief.record).filter((k) => !RECORD_FIELDS.includes(k));
    if (extra.length) throw new ShapeError(`record.${extra.includes("sections") ? "sections" : extra[0]}`, "a brief holds the record's title and description only, never its sections");
    // no home counts as the root, as for sections and classes
    if (!homeOk(positions, audience, brief.record.home)) throw new ShapeError("record", "the record's title is above the audience");
  }
  brief.sections.forEach((x, n) => {
    if (!homeOk(positions, audience, x.home)) throw new ShapeError(`sections[${n}]`, "above the audience");
  });
  brief.classes.forEach((x, n) => {
    if (!homeOk(positions, audience, x.home)) throw new ShapeError(`classes[${n}]`, "above the audience");
  });
  brief.instances.forEach((x, n) => {
    if (!instanceOk(positions, audience, x)) throw new ShapeError(`instances[${n}]`, "above the audience");
  });
  for (const [n, src] of (brief.sources ?? []).entries()) {
    if (src.read || src.commit?.url) throw new ShapeError(`sources[${n}]`, "a brief says how a source is committed to, never where it is (briefSource)");
  }
  return brief;
}

/**
 * A worker names a section by a short id, s1, s2 ..., its place in the job's own list of sections (the payload's
 * order, which the brief follows); the record id (#1:23) is shown beside it and also accepted.
 */
export const shortSectionId = (i) => `s${i + 1}`;

/**
 * What a model sent as `section`, as the record id it means, or null: the record id itself, the short id ("s2"),
 * a bare or § number ("2", "§2"), any of those after "Section ". With one section in the brief, a missing value or
 * plain text means that one (a model writing the piece's text into the field, say); a value that names some other
 * section (a record id, or a short id or number past the list) never does: a worker can't file another record's
 * section (R7, R9).
 */
export function resolveSectionRef(value, sections) {
  const list = (sections ?? []).map(String);
  const raw = String(value ?? "").trim();
  const v = raw.replace(/^section\s+/i, "").replace(/^§\s*/, "").trim();
  if (list.includes(v)) return v;
  const n = /^s?(\d{1,3})$/i.exec(v);
  if (n && Number(n[1]) >= 1 && Number(n[1]) <= list.length) return list[Number(n[1]) - 1];
  const rid = /^(#\d+:\d+)/.exec(v);
  if (rid && list.includes(rid[1])) return rid[1];
  // names a section, just not one of these: refused, whatever the list
  if (rid || n) return null;
  if (list.length === 1) return list[0];
  return null;
}

/**
 * An entry a worker names in its account, as its id, or null: its handle (e3, 3) or id among `ids` (its own, in the
 * order it wrote them); with one entry, any other value means it. Another id, or a handle past the list, never does.
 */
export function resolveEntryRef(value, ids) {
  const list = (ids ?? []).map(String);
  const s = String(value ?? "").trim();
  if (list.includes(s)) return s;
  const n = /^e?(\d{1,4})$/i.exec(s);
  if (n) return Number(n[1]) >= 1 && Number(n[1]) <= list.length ? list[Number(n[1]) - 1] : null;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(s)) return null;
  return list.length === 1 ? list[0] : null;
}
