// Documents: a manual, a meeting transcript, a long email thread. One
// embedding blurs a long text, so a document becomes a small structure:
//
//   document entry (_kind "document"): title + description, embedded
//   section entries (_kind "section"): one per chunk, embedded from the
//     chunk's full text but storing only a preview; PART_OF the document,
//     NEXT to the following section
//
// The full text lives in the document store (outside ArcadeDB); reading a
// section fetches it from there, for sections the reader can see.
// Pure functions: chunking and names.

/** chunk sizes in characters: aim for about a page, never more than MAX */
export const TARGET = 1800;
export const MIN = 400;
export const MAX = 3200;
/** context carried into each chunk's embedding from the one before */
export const OVERLAP = 200;
/** limits on one document */
export const MAX_CHARS = 1_500_000;
export const MAX_SECTIONS = 600;
/** stored in the graph per section (the rest is in the document store) */
export const PREVIEW = 400;

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
// a transcript turn: "Ken:", "[10:02] Maria:", "MARIA (QA):"
const SPEAKER_RE = /^(\[[\d:.\s]+\]\s*)?[A-Z][\w .'()-]{0,40}:\s/;

/**
 * Split text into blocks with their offsets: headings, speaker turns and
 * paragraphs (blank-line separated).
 */
function blocks(text) {
  const out = [];
  const lines = text.split("\n");
  let pos = 0;
  let cur = null;
  const flush = () => {
    if (cur && cur.text.trim()) out.push(cur);
    cur = null;
  };
  for (const line of lines) {
    const start = pos;
    pos += line.length + 1;
    const h = HEADING_RE.exec(line.trim());
    if (h) {
      flush();
      out.push({ kind: "heading", level: h[1].length, heading: h[2].trim(), start, end: pos - 1, text: line });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (SPEAKER_RE.test(line)) flush();
    if (!cur) cur = { kind: "text", start, end: pos - 1, text: line };
    else {
      cur.text += `\n${line}`;
      cur.end = pos - 1;
    }
  }
  flush();
  return out;
}

/** cut an oversized block at sentence ends (or hard, as a last resort) */
function splitLong(b) {
  const parts = [];
  let s = b.start;
  while (b.end - s > MAX) {
    const window = b.text.slice(s - b.start, s - b.start + MAX);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
    const len = cut > MIN ? cut + 1 : MAX;
    parts.push({ ...b, start: s, end: s + len, text: b.text.slice(s - b.start, s - b.start + len) });
    s += len;
  }
  parts.push({ ...b, start: s, end: b.end, text: b.text.slice(s - b.start) });
  return parts;
}

/**
 * Chunks of a document: [{ index, heading, start, end, text, embedText }].
 * Spans don't overlap (reading returns each part once); embedText adds the
 * heading and the tail of the previous chunk, so a chunk is found by its
 * context too.
 */
export function chunk(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const chunks = [];
  let heading = "";
  let cur = null;
  const close = () => {
    if (!cur) return;
    chunks.push(cur);
    cur = null;
  };
  for (const b of blocks(src).flatMap((x) => (x.kind === "text" && x.end - x.start > MAX ? splitLong(x) : [x]))) {
    if (b.kind === "heading") {
      // a heading starts a new section once the current one has some substance
      if (cur && cur.end - cur.start >= MIN) close();
      heading = b.heading;
      if (!cur) cur = { heading, start: b.start, end: b.end, body: false };
      else {
        cur.end = b.end;
        // nothing under the earlier heading yet: the newer one names the section better
        if (!cur.body) cur.heading = heading;
      }
      continue;
    }
    if (cur && b.end - cur.start > TARGET && cur.end - cur.start >= MIN) close();
    if (!cur) cur = { heading, start: b.start, end: b.end, body: true };
    else {
      cur.end = b.end;
      cur.body = true;
    }
  }
  close();
  return chunks.map((c, index) => {
    const body = src.slice(c.start, c.end);
    const prev = index > 0 ? src.slice(Math.max(chunks[index - 1].start, chunks[index - 1].end - OVERLAP), chunks[index - 1].end) : "";
    return {
      index,
      heading: c.heading,
      start: c.start,
      end: c.end,
      text: body,
      embedText: `${c.heading ? `${c.heading}\n` : ""}${prev ? `…${prev}\n` : ""}${body}`.slice(0, 6000),
    };
  });
}

/** a section's entity name: readable in search and traversal, unique within the document */
export const sectionName = (title, index, heading) =>
  `${String(title).slice(0, 80)} §${index + 1}${heading ? `: ${String(heading).slice(0, 60)}` : ""}`;

export const preview = (text, n = PREVIEW) => {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---- condensed documents (R2: the condensed document and its sections are the record) ----
//
// A condensed document arrives in the contract's shape (model/record.js
// normalizeDocument) and is stored like a manual, except that its sections
// are given, not chunked: renderRecord lays them out as one text with a span
// per section, and sectionChunks turns the spans back into the chunk shape
// everything else reads (readDocument, embeddings).
import { createHash } from "node:crypto";
import { normalizeDocument, RecordError, validateDocument } from "./model/record.js";

/** what a condensed document's text looks like in the store: a heading line per section, a blank line between */
export function renderRecord(doc) {
  let text = "";
  const spans = [];
  for (const s of doc.sections) {
    if (text) text += "\n\n";
    // the heading line is in the document's text for a reader, but outside the
    // section's span: a stored section's text is the section text alone, its
    // heading in the heading property (a manual's chunks are shaped the same)
    if (s.heading) text += `## ${s.heading}\n\n`;
    const start = text.length;
    text += s.text;
    spans.push({ index: s.index, heading: s.heading ?? "", start, end: text.length });
  }
  return { text: `${text}\n`, spans };
}

/** the chunks of a stored condensed document: one per section, from the spans the ingest stored */
export function sectionChunks(text, spans) {
  const src = String(text ?? "");
  return spans.map((sp, i) => {
    const body = src.slice(sp.start, sp.end);
    const prev = i > 0 ? src.slice(Math.max(spans[i - 1].start, spans[i - 1].end - OVERLAP), spans[i - 1].end) : "";
    return {
      index: Number.isInteger(sp.index) ? sp.index : i,
      heading: sp.heading ?? "",
      start: sp.start,
      end: sp.end,
      // the section text alone; the heading leads the embedding, as a manual's does
      text: body,
      embedText: `${sp.heading ? `${sp.heading}\n` : ""}${prev ? `…${prev}\n` : ""}${body}`.slice(0, 6000),
    };
  });
}

/** a condensed document, as the ingest tool receives it: `text` is the document as JSON, or it isn't one (a manual) */
export function parseRecordText(text) {
  const s = String(text ?? "").trim();
  if (!s.startsWith("{")) return null;
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.sections) ? parsed : null;
}

/** the same JSON however its keys were ordered: what "the same document" means, whichever turn sent it */
export const canonical = (v) =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v ?? null);

/** a uuid derived from what it names: the same parts always give the same id */
export function stableUuid(...parts) {
  const h = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * A condensed document's identity: who sent which text under which title to which home. A re-send
 * (a timeout, a failed ingest) is the same document and takes the same id; the recording fields the server stamps
 * don't count, so two sends of one document are the same however they differ there.
 */
export function recordId(raw, { person, home, title }) {
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).map((s) => ({
    heading: s?.heading ?? null,
    text: String(s?.text ?? "").replace(/\s+/g, " ").trim(),
  }));
  return stableUuid("record", person ?? "", home ?? "", title ?? "", canonical(sections));
}

/** what the server says about who recorded this, over whatever the document says */
function stamped(raw, stamp) {
  return {
    ...raw,
    recorded_by: stamp.recorded_by,
    position: stamp.position,
    recorded_at: stamp.recorded_at,
  };
}

/**
 * A condensed document made ready for the ingest: what the tool call gave
 * (title, description) fills what the document left out, the recording
 * person and position come from the identity when the condenser gave none
 * (an agent's record counts as the person it acts for), and the whole is
 * validated with the contract's normalizeDocument. With `stamp`
 * ({ recorded_by, recorded_at, position }, from the server's identity) those
 * three are the server's, whatever the document says.
 * Throws an Error listing every problem by field, so a condenser can fix
 * them all at once.
 */
export function prepareRecord(raw, { title, description, recorded_by, position, now = Date.now(), stamp } = {}) {
  const src = stamp ? stamped(raw, stamp) : raw;
  const doc = {
    ...src,
    title: typeof src.title === "string" && src.title.trim() ? src.title : title,
    description: typeof src.description === "string" && src.description.trim() ? src.description : description,
    recorded_by: typeof src.recorded_by === "string" && src.recorded_by.trim() ? src.recorded_by : recorded_by,
    position: typeof src.position === "string" && src.position.trim() ? src.position : position,
  };
  const { document, errors } = validateDocument(doc, { now });
  if (!document) {
    const list = errors.map((e) => `${e.field}: ${e.message}`);
    const err = new Error(`the condensed document isn't in the contract's shape (${list.length} problem${list.length === 1 ? "" : "s"}): ${list.join("; ")}`);
    err.errors = errors;
    throw err;
  }
  return document;
}

export { normalizeDocument, RecordError };
