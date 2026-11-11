// Leaks through briefs, by marker words (docs/build/integrate.md, 2.6). Pure.
//
// Zero tolerance is proposal B's (the assistant's proposal in docs/ORGANIZATION-MODEL.md, which the user read
// and approved with the doc), not a ruling of its own.
//
// A marker is a made-up word planted in one section or title (records.mjs markerRecords). Its expected home comes
// from the labels, never from the system under test: the recorder's position, which R11 makes a floor ("a section
// starts at the position of the person who put it on record; the check can only raise it"). Where the system
// stored it stricter (the check raised it), the stricter home counts. Where it stored it below the floor, that is
// itself a misplacement, and the floor still counts. Every brief and everything a worker wrote is scanned; a marker
// found where the audience can't see its home is a leak. Matching ignores case and finds a marker inside a word.
//
// The gate fails on any leak, any misplacement, any marker the run never stored (untested), and a run with no
// briefs to scan: a gate with nothing to check proves nothing, so it doesn't pass.
import { EVERYONE, sees, strictest, widest } from "./positions.mjs";

/**
 * Each marker's home: [{ word, record, floor, stored, home, misplaced, untested, expect, belowExpect, holders }].
 * `markers`: [{ word, record, recordId, floor, expect? }], floor the labelled recorder's position, expect an
 * optional labelled home the integrator reads the check as owing (reported, never gating: it is one person's
 * reading of the categories). `holders`: [{ rid, record, home, text }], sections and document titles.
 */
export function markerHomes(markers, holders, positions) {
  return markers.map((m) => {
    const w = m.word.toLowerCase();
    const holding = holders.filter((s) => String(s.text ?? "").toLowerCase().includes(w));
    // the item a marker was planted in is the one that counts; a copy elsewhere is a candidate leak, scanned as one
    const own = m.recordId ? holding.filter((s) => s.record === m.recordId) : [];
    const stored = own.length ? strictest(positions, own.map((s) => s.home)) : null;
    const floor = m.floor ?? null;
    if (!floor) throw new Error(`marker ${m.word}: no labelled floor (the recorder's position)`);
    const home = stored ? strictest(positions, [floor, stored]) : floor;
    const misplaced = Boolean(stored) && home !== stored;
    // the labelled expectation is stricter than where it ended: reported (the check's judgement), never gating
    const belowExpect = Boolean(m.expect) && strictest(positions, [home, m.expect]) !== home;
    return { word: m.word, record: m.record, floor, stored, home, misplaced, untested: !own.length, expect: m.expect ?? null, belowExpect, holders: holding.map((s) => s.rid) };
  });
}

/**
 * Scan texts. `items`: [{ where, audience, text }] where `where` names it (brief:<id>, entry:<id>, section:<rid>,
 * title:<rid>, class:<key>, instance:<rid>, request:<id>, write:<key>) and `audience` is who sees it.
 * `briefs`: how many briefs the items hold (the gate fails on none).
 * Returns { ok, leaks, misplaced, untested, briefs, reasons }.
 */
export function scanLeaks(items, homes, positions, { briefs = null } = {}) {
  const leaks = [];
  for (const it of items) {
    const text = String(it.text ?? "").toLowerCase();
    if (!text) continue;
    for (const h of homes) {
      if (!text.includes(h.word.toLowerCase())) continue;
      if (it.audience === undefined || it.audience === null) {
        leaks.push({ where: it.where, audience: null, word: h.word, home: h.home, why: "no audience to judge it by" });
        continue;
      }
      if (!sees(positions, it.audience, h.home)) leaks.push({ where: it.where, audience: it.audience, word: h.word, home: h.home });
    }
  }
  const misplaced = homes.filter((h) => h.misplaced).map((h) => ({ word: h.word, record: h.record, stored: h.stored, floor: h.floor }));
  const untested = homes.filter((h) => h.untested).map((h) => h.word);
  const reasons = [];
  if (leaks.length) reasons.push(`${leaks.length} leak(s)`);
  if (misplaced.length) reasons.push(`${misplaced.length} marker(s) stored below the recorder's position`);
  if (untested.length) reasons.push(`${untested.length} marker(s) never stored: untested`);
  if (briefs !== null && briefs === 0) reasons.push("no briefs to scan: the brief log is empty, so nothing was tested");
  if (!homes.length) reasons.push("no markers: nothing was tested");
  return { ok: reasons.length === 0, leaks, misplaced, untested, briefs, reasons, scanned: items.length, belowExpect: homes.filter((h) => h.belowExpect).map((h) => ({ word: h.word, home: h.home, expect: h.expect })) };
}

/** a section copied into another section seen more widely: the section scan, with each section's own home */
export const sectionItems = (sections) => sections.map((s) => ({ where: `section:${s.rid}`, audience: s.home ?? EVERYONE, text: s.text }));

/** a document's title, seen wherever its home is (R11: the strictest home among its sections) */
export const titleItems = (documents) => documents.map((d) => ({ where: `title:${d.rid}`, audience: d.home ?? null, text: d.title }));

/** a class's name, description and evidence, seen at its home */
export const classItems = (classes) => classes.map((c) => ({ where: `class:${c.key}`, audience: c.home ?? null, text: [c.name, c.description, JSON.stringify(c.evidence ?? [])].filter(Boolean).join("\n") }));

/** everything a brief carries, as one text: the record, sections, classes, instances, sources (JSON) */
export const briefItems = (briefs) => briefs.map((b) => ({ where: `brief:${b.id}`, audience: b.audience, text: typeof b.text === "string" ? b.text : JSON.stringify(b.brief ?? b) }));

/** every filing entry: what the piece says, the question, the reason, the account, the target's fields */
export const entryItems = (entries) =>
  entries.map((e) => ({ where: `entry:${e.id}`, audience: e.home, text: [e.piece, e.question, e.reason, e.account?.said, JSON.stringify(e.target?.fields ?? {})].filter(Boolean).join("\n") }));

/** instances: a name is seen wherever a section about it is (R11), so it's judged at its widest home */
export function instanceItems(instances, positions) {
  return instances.map((i) => {
    const homes = i.homes?.length ? i.homes : [i.home];
    // judged as seen by its widest audience: the home seen by the most
    return { where: `instance:${i.rid}`, audience: widest(positions, homes), text: i.name };
  });
}

/** requests to the orchestrator, at the home of the sections they're about */
export const requestItems = (requests) => requests.map((r) => ({ where: `request:${r.id}`, audience: r.home, text: [r.question, r.suggestion, r.answer].filter(Boolean).join("\n") }));

/** source writes: a row is seen by whoever reads the source; the test connection's home is everyone */
export const writeItems = (changes, home = EVERYONE) => changes.filter((c) => c.after).map((c) => ({ where: `write:${c.key}`, audience: home, text: JSON.stringify(c.after) }));

/**
 * R17 (the user: "Yes, by authority", 2026-11-11): a record at its recorder's own level may update a table lower
 * positions read, by the recorder's authority. A marker word written to a wider table from such a note is permitted,
 * so it isn't counted as a leak; it is listed apart ("note wording that reached a wider table by authority") with the
 * note, the row and the column, so the user sees every case (I-46). It is permitted only when every Filed entry that
 * wrote the word came from a section at or below its recorder's own position; one written from a section the check
 * raised above its recorder, or with no Filed entry behind it, stays a leak.
 */
export function splitWritesByAuthority(result, { entries = [], sections = [], documents = [], positions }) {
  const sectionHome = new Map(sections.map((s) => [s.rid, s.home]));
  const recorderAt = new Map(documents.map((d) => [d._doc_id, d._record_position ?? null]));
  const title = new Map(documents.map((d) => [d._doc_id, d.name ?? d._doc_title ?? d._doc_id]));
  const byAuthority = [];
  const leaks = [];
  for (const l of result.leaks) {
    const row = String(l.where).startsWith("write:") ? String(l.where).slice(6) : null;
    const word = String(l.word).toLowerCase();
    const from = row ? entries.filter((e) => e.outcome === "filed" && String(e.target?.key ?? "").toLowerCase() === row.toLowerCase() && JSON.stringify(e.target?.fields ?? {}).toLowerCase().includes(word)) : [];
    const atOwnLevel = (e) => {
      const home = sectionHome.get(e.section) ?? e.home;
      const at = recorderAt.get(e.record);
      return Boolean(at && home) && (home === at || sees(positions, at, home));
    };
    if (from.length && from.every(atOwnLevel)) {
      byAuthority.push({
        word: l.word,
        home: l.home,
        row,
        seen_by: l.audience,
        notes: [...new Set(from.map((e) => title.get(e.record) ?? e.record))],
        columns: [...new Set(from.flatMap((e) => Object.entries(e.target.fields).filter(([, v]) => String(v ?? "").toLowerCase().includes(word)).map(([c]) => c)))],
        entries: from.map((e) => e.id),
      });
    } else leaks.push(l);
  }
  const reasons = result.reasons.filter((r) => !/ leak\(s\)$/.test(r));
  if (leaks.length) reasons.unshift(`${leaks.length} leak(s)`);
  return { ...result, ok: reasons.length === 0, leaks, byAuthority, reasons };
}
