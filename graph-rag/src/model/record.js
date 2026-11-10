// The record: a condensed document and its sections (R2: "The condensed document and its sections are
// the record"). No claims, and no class vocabulary (R5): a section is text. Pure.
//
//   document: { title, description?, recorded_by, position, reason, recorded_at?, sections: [section] }
//   section:  { heading?, text }
//
// `position` is where the record starts: a section starts at the position of the person who put it on
// record, and the check can only raise it (R11). Every error names its field (`sections[1].text`).
import { clip, isoDate, nonEmpty, ShapeError } from "./text.js";

export { ShapeError as RecordError };

/** a whole document, normalized; throws the first RecordError (ShapeError). `now`: recorded_at when none is given */
export function normalizeDocument(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ShapeError("document", "must be an object");
  if (!nonEmpty(raw.title)) throw new ShapeError("title", "needs a title");
  if (!nonEmpty(raw.recorded_by)) throw new ShapeError("recorded_by", "needs the person who put it on record");
  if (!nonEmpty(raw.position)) throw new ShapeError("position", "needs the position it was recorded under");
  if (!nonEmpty(raw.reason)) throw new ShapeError("reason", "needs why it is on record");
  const recordedAt = isoDate(raw.recorded_at ?? now);
  if (!recordedAt) throw new ShapeError("recorded_at", `not a date: ${raw.recorded_at}`);
  if (!Array.isArray(raw.sections) || raw.sections.length === 0) throw new ShapeError("sections", "needs at least one section");
  const sections = raw.sections.map((s, i) => {
    const f = `sections[${i}]`;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new ShapeError(f, "must be an object");
    if (!nonEmpty(s.text)) throw new ShapeError(`${f}.text`, "needs text");
    if (s.claims !== undefined) throw new ShapeError(`${f}.claims`, "a section is text: claims are gone (R2)");
    return {
      index: i,
      heading: nonEmpty(s.heading) ? clip(s.heading, 120) : null,
      text: String(s.text).replace(/\r\n?/g, "\n").trim(),
    };
  });
  return {
    title: clip(raw.title, 200),
    description: nonEmpty(raw.description) ? clip(raw.description, 1000) : null,
    on_record: true,
    recorded_by: String(raw.recorded_by).trim(),
    recorded_at: recordedAt,
    position: String(raw.position).trim(),
    reason: clip(raw.reason, 300),
    sections,
  };
}

/** every problem as data instead of a throw: { document | null, errors: [{ field, message }] } */
export function validateDocument(raw, opts = {}) {
  try {
    return { document: normalizeDocument(raw, opts), errors: [] };
  } catch (e) {
    if (!(e instanceof ShapeError)) throw e;
    return { document: null, errors: [{ field: e.field, message: e.reason }] };
  }
}
