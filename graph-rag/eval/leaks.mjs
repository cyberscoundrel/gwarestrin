// Leaks through briefs, by marker words (docs/build/integrate.md, 2.6): zero tolerance. Pure.
//
// A marker is a made-up word planted in one section (records.mjs markerRecords). Its home is read from the
// graph after the run: the home of the section that holds it, the strictest when it was stored more than once.
// Every brief and everything a worker wrote is scanned; a marker found where the audience can't see its home is
// a leak. Matching ignores case and also finds a marker inside a longer word.
import { EVERYONE, sees, strictest } from "./positions.mjs";

/**
 * The home of each marker, from the sections stored: [{ word, home, sections }]. A marker found in no section
 * is reported with home null (the record never landed): it is not a leak, but the run didn't test it.
 * `sections`: [{ rid, record, home, text }].
 */
export function markerHomes(markers, sections, positions) {
  return markers.map((m) => {
    const w = m.word.toLowerCase();
    const holding = sections.filter((s) => String(s.text ?? "").toLowerCase().includes(w));
    // the section a marker was planted in is the one that counts; a copy elsewhere is itself a candidate leak
    const own = holding.filter((s) => !m.recordId || s.record === m.recordId);
    const homes = (own.length ? own : holding).map((s) => s.home);
    return { word: m.word, record: m.record, home: homes.length ? strictest(positions, homes) : null, sections: holding.map((s) => s.rid) };
  });
}

/**
 * Scan texts. `items`: [{ where, audience, text }] where `where` names it (brief:<id>, entry:<id>, section:<rid>,
 * instance:<rid>, request:<id>, write:<key>) and `audience` is who sees it (a brief's audience, an entry's or a
 * section's home). Returns { ok, leaks: [{ where, audience, word, home }], scanned, untested }.
 */
export function scanLeaks(items, homes, positions) {
  const leaks = [];
  const live = homes.filter((h) => h.home);
  for (const it of items) {
    const text = String(it.text ?? "").toLowerCase();
    if (!text) continue;
    for (const h of live) {
      if (!text.includes(h.word.toLowerCase())) continue;
      if (it.audience === undefined || it.audience === null) {
        leaks.push({ where: it.where, audience: null, word: h.word, home: h.home, why: "no audience to judge it by" });
        continue;
      }
      if (!sees(positions, it.audience, h.home)) leaks.push({ where: it.where, audience: it.audience, word: h.word, home: h.home });
    }
  }
  return { ok: leaks.length === 0, leaks, scanned: items.length, untested: homes.filter((h) => !h.home).map((h) => h.word) };
}

/** a section copied into another section seen more widely: the section scan, with each section's own home */
export const sectionItems = (sections) => sections.map((s) => ({ where: `section:${s.rid}`, audience: s.home ?? EVERYONE, text: s.text }));

/** everything a brief carries, as one text: the record, sections, classes, instances, sources (JSON) */
export const briefItems = (briefs) => briefs.map((b) => ({ where: `brief:${b.id}`, audience: b.audience, text: typeof b.text === "string" ? b.text : JSON.stringify(b.brief ?? b) }));

/** every filing entry: what the piece says, the question, the reason, the account, the target's fields */
export const entryItems = (entries) =>
  entries.map((e) => ({ where: `entry:${e.id}`, audience: e.home, text: [e.piece, e.question, e.reason, e.account?.said, JSON.stringify(e.target?.fields ?? {})].filter(Boolean).join("\n") }));

/** instances: a name is seen wherever a section about it is (R11), so it's judged at its widest home */
export function instanceItems(instances, positions) {
  return instances.map((i) => {
    const homes = i.homes?.length ? i.homes : [i.home];
    // the widest home: the one fewest levels deep
    const widest = homes.reduce((w, h) => (w === null || h === EVERYONE || (w !== EVERYONE && depth(positions, h) < depth(positions, w)) ? h : w), null);
    return { where: `instance:${i.rid}`, audience: widest, text: i.name };
  });
}
const depth = (positions, h) => {
  let n = 0;
  let at = h;
  while (positions.positions[at]?.parent) {
    at = positions.positions[at].parent;
    n++;
  }
  return n;
};

/** requests to the orchestrator, at the home of the sections they're about */
export const requestItems = (requests) => requests.map((r) => ({ where: `request:${r.id}`, audience: r.home, text: [r.question, r.suggestion, r.answer].filter(Boolean).join("\n") }));

/** source writes: a row is seen by whoever reads the source; the test connection's home is everyone */
export const writeItems = (changes, home = EVERYONE) => changes.filter((c) => c.after).map((c) => ({ where: `write:${c.key}`, audience: home, text: JSON.stringify(c.after) }));
