/**
 * Where a document's title may be seen. The title and description are the document's own text, so they are seen
 * no lower than its most restricted section: a section raised for what it says usually names the same thing in
 * the title. The document entry is homed there, and a section below it carries a title that says nothing (its
 * own text is its own, its heading its own once the title is out of it). Whatever moves a section or a document's entry settles the document again.
 */
import { commonAncestor, effectiveHome } from "./positions.js";
import { adbCommand, adbQuery, ENTITY_LABEL } from "./db.js";
import { positionMap } from "./scope.js";
import { sectionName } from "./documents.js";

/** the title a section shows while it is seen by people the document's title isn't for */
export const untitled = (docId) => `Document ${String(docId).slice(0, 8)}`;

/** a heading that repeats the document's title, without it (a condenser's headings often start with the title) */
export function headingWithout(heading, title) {
  if (!heading) return heading;
  const base = String(title).replace(/ \([0-9a-f]{8}\)$/, "");
  const out = String(heading).replace(new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-–—]*\\s*`, "gi"), "").trim();
  return out || "Part";
}

/**
 * Homes the document entry at the common ancestor of its own home (`_doc_base`: its grade, or where a person put
 * it) and every section's, and gives each section the title it may show. Returns that home; idempotent.
 * `title` and `base` are for the first settling, before the entry exists.
 */
export async function settleDocument(docId, { title, base } = {}) {
  if (!positionMap || !docId) return null;
  const doc = (await adbQuery(`SELECT @rid AS rid, name, _home, _doc_base FROM ${ENTITY_LABEL} WHERE _kind = 'document' AND _doc_id = :d LIMIT 1`, { d: docId }))[0];
  const sections = await adbQuery(`SELECT @rid AS rid, name, _home, _section, heading, _heading_own, _doc_title FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :d`, { d: docId });
  const own = base ?? doc?._doc_base ?? doc?._home;
  const shown = title ?? doc?.name;
  if (own === undefined || own === null || !shown) return null;
  const home = commonAncestor(positionMap, [own, ...sections.map((s) => s._home)]);
  if (doc && effectiveHome(positionMap, doc._home) !== home) await adbCommand(`UPDATE ${String(doc.rid)} SET _home = :h`, "sql", { h: home });
  for (const s of sections) {
    const titled = effectiveHome(positionMap, s._home) === home;
    const docTitle = titled ? shown : untitled(docId);
    // the heading as written is kept beside the one it shows, for when the section can show the title again
    const written = s._heading_own ?? s.heading ?? "";
    const heading = titled ? written : headingWithout(written, shown);
    const name = sectionName(docTitle, Number(s._section), heading);
    if (name === s.name && docTitle === s._doc_title && heading === (s.heading ?? "")) continue;
    await adbCommand(`UPDATE ${String(s.rid)} SET name = :n, _doc_title = :t, heading = :h, _heading_own = :o`, "sql", { n: name, t: docTitle, h: heading || null, o: titled ? null : written || null });
  }
  return home;
}
