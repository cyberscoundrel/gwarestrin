// Filing outcomes against the labels (docs/build/integrate.md, 2.1) and wrong placements of sections (2.5).
// The worker decides the split (R11), so entries are matched to labelled pieces, not counted one to one:
//   1. an entry naming a row matches the piece with that key, or a new-row piece on the same table;
//   2. the rest match the remaining pieces by outcome (exact, then accepted, then any), preferring entries
//      whose instances overlap the note's expected instances;
//   3. unmatched entries are extra (they count only if they write); unmatched pieces are missing.
// Pure: the caller resolves record ids to notes and instance rids to { key, name }.
import { accepted } from "./labels.mjs";

export const OUTCOME_ORDER = ["filed", "proposed", "held", "kept"];

const rowTarget = (p) => p.target.kind === "row" || p.target.kind === "new-row";
const fold = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** does a resolved instance stand for a label's expected key or name */
export function instanceIs(info, want) {
  if (!info) return false;
  if (/^\w+:[^:]+:.+$/.test(want)) return info.key === want;
  return fold(info.name).includes(fold(want));
}

function overlap(entry, note, info) {
  const want = note.resolves ?? [];
  return entry.instances.filter((rid) => want.some((w) => instanceIs(info.get(rid), w))).length;
}

/**
 * Match one note's entries to its pieces. Returns { pieces: [{ piece, entry, verdict, failure }], extra }.
 * verdict: exact | accepted | wrong | missing. failure (when wrong or missing): target | rule | missing.
 */
export function matchNote(note, entries, info = new Map()) {
  const left = [...entries];
  const take = (pred) => {
    const i = left.findIndex(pred);
    return i < 0 ? null : left.splice(i, 1)[0];
  };
  const pairs = note.pieces.map((piece) => ({ piece, entry: null }));
  // 1: by row
  for (const p of pairs) {
    if (!rowTarget(p.piece)) continue;
    const t = p.piece.target;
    // a write decided field by field (I-50) leaves a Filed entry and a Held one on the same row: the one writing the
    // labelled columns is the piece's
    const covers = (e) => (t.columns ?? []).some((c) => e.target?.fields && c in e.target.fields);
    p.entry =
      take((e) => e.target?.key && e.target.key === t.key && covers(e)) ??
      take((e) => e.target?.key && e.target.key === t.key) ??
      (t.kind === "new-row" ? take((e) => e.target?.table === t.table && covers(e)) ?? take((e) => e.target?.table === t.table) : null);
  }
  // 2: by outcome, then overlap
  const rank = (e) => -overlap(e, note, info);
  for (const tier of ["exact", "accepted", "any"]) {
    for (const p of pairs) {
      if (p.entry) continue;
      const ok = (e) => (tier === "exact" ? e.outcome === p.piece.outcome : tier === "accepted" ? accepted(p.piece).includes(e.outcome) : true);
      const cands = left.filter(ok).sort((a, b) => rank(a) - rank(b));
      if (cands.length) p.entry = take((e) => e === cands[0]);
    }
  }
  const pieces = pairs.map(({ piece, entry }) => {
    if (!entry) return { piece, entry: null, verdict: "missing", failure: "missing" };
    const verdict = entry.outcome === piece.outcome ? "exact" : accepted(piece).includes(entry.outcome) ? "accepted" : "wrong";
    let failure = null;
    if (verdict === "wrong") {
      const sameTarget = rowTarget(piece) ? Boolean(entry.target) && (entry.target.key === piece.target.key || (piece.target.kind === "new-row" && entry.target.table === piece.target.table)) : !entry.target || entry.outcome === "held";
      failure = sameTarget ? "rule" : "target";
    }
    return { piece, entry, verdict, failure };
  });
  return { pieces, extra: left };
}

/**
 * Every note. `entries`: normalized filing entries; `noteOf`: record id -> note id; `info`: rid -> { key, name }.
 * `changes`: the row diff (source.mjs), for the notes' "must not change/write" lines; `instances`: [{ rid, name }]
 * for "must not mint", judged only on the instances the note's own entries and sections are about (`about`:
 * record id -> [instance rid]), by whole words. Returns { notes, confusion, totals, mustNot, stated, unheld }.
 */
export function scoreOutcomes(notes, entries, { noteOf, info = new Map(), changes = [], instances = [], about = new Map() } = {}) {
  const byNote = new Map(notes.map((n) => [n.id, []]));
  const unknown = [];
  for (const e of entries) {
    const id = noteOf(e.record);
    if (byNote.has(id)) byNote.get(id).push(e);
    else unknown.push(e);
  }
  const confusion = Object.fromEntries(OUTCOME_ORDER.map((o) => [o, Object.fromEntries([...OUTCOME_ORDER, "missing"].map((x) => [x, 0]))]));
  const totals = { pieces: 0, exact: 0, accepted: 0, wrong: 0, missing: 0, wrongTarget: 0, wrongRule: 0, extra: 0, extraWrites: 0 };
  const out = [];
  const mustNot = [];
  const stated = [];
  const unheld = [];
  for (const n of notes) {
    const mine = byNote.get(n.id);
    const m = matchNote(n, mine, info);
    for (const p of m.pieces) {
      totals.pieces++;
      totals[p.verdict]++;
      if (p.failure === "target") totals.wrongTarget++;
      if (p.failure === "rule") totals.wrongRule++;
      confusion[p.piece.outcome][p.entry ? p.entry.outcome : "missing"]++;
      if (p.piece.stated) stated.push({ note: n.id, about: p.piece.about, stated: p.piece.stated, label: p.piece.outcome, got: p.entry?.outcome ?? "missing" });
      if (p.piece.unheld) unheld.push({ note: n.id, about: p.piece.about, got: p.entry?.outcome ?? "missing" });
    }
    totals.extra += m.extra.length;
    totals.extraWrites += m.extra.filter((e) => e.outcome === "filed").length;
    const recordIds = new Set(mine.map((e) => e.record));
    for (const rule of n.mustNot ?? []) {
      // a change counts against this note when its own Filed entry made it, or when no Filed entry accounts for it
      // (another note's legitimate write to the same row, ux-z01's to 3260356, say, is not this note's)
      // a Filed entry wrote the row only when it changed it: one saying "the row already held it" wrote nothing
      if (rule.change && changes.some((c) => c.key === rule.change)) {
        const wrote = (e) => e.outcome === "filed" && e.target?.key === rule.change && !/already held it/i.test(String(e.reason ?? ""));
        const mineWrote = mine.some(wrote);
        const someoneWrote = entries.some(wrote);
        if (mineWrote || !someoneWrote) mustNot.push({ note: n.id, rule: `changed ${rule.change}${mineWrote ? "" : " (no Filed entry accounts for it)"}` });
      }
      if (rule.write && mine.some((e) => e.outcome === "filed" && e.target?.table === rule.write)) mustNot.push({ note: n.id, rule: `wrote to ${rule.write}` });
      if (rule.link && mine.some((e) => e.instances.some((rid) => info.get(rid)?.key === rule.link))) mustNot.push({ note: n.id, rule: `linked ${rule.link}` });
      if (rule.mint) {
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])${rule.mint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu");
        const own = new Set([...recordIds, ...[...about.keys()].filter((r) => noteOf(r) === n.id)]);
        const linked = new Set([...mine.flatMap((e) => e.instances), ...[...own].flatMap((r) => about.get(r) ?? [])]);
        for (const i of instances) if (linked.has(i.rid) && re.test(i.name ?? "")) mustNot.push({ note: n.id, rule: `minted "${i.name}"` });
      }
    }
    out.push({ note: n.id, records: [...recordIds], pieces: m.pieces.map((p) => ({ about: p.piece.about, label: p.piece.outcome, got: p.entry?.outcome ?? null, entry: p.entry?.id ?? null, verdict: p.verdict, failure: p.failure })), extra: m.extra.map((e) => ({ id: e.id, outcome: e.outcome, piece: e.piece })) });
  }
  return { notes: out, confusion, totals, mustNot, stated, unheld, unknown: unknown.map((e) => e.id) };
}

/**
 * Sections linked to the wrong instance (2.5): for each note, the expected instances it should be about,
 * against the instances its entries and its sections' ABOUT edges name. `about`: record id -> [rid].
 * Reports, per note, expected instances found, expected ones missing, and links to rows of the same table
 * as an expected key but another row (Diep to NGDT, say).
 */
export function scoreLinks(notes, { recordsOf, about, info = new Map() }) {
  const out = [];
  let expected = 0;
  let found = 0;
  let wrong = 0;
  for (const n of notes) {
    const rids = new Set((recordsOf(n.id) ?? []).flatMap((r) => about.get(r) ?? []));
    const linked = [...rids].map((r) => info.get(r)).filter(Boolean);
    const want = n.resolves ?? [];
    const hit = want.filter((w) => linked.some((i) => instanceIs(i, w)));
    const tableOf = (k) => k.split(":").slice(0, 2).join(":");
    const bad = linked.filter((i) => i.key && want.some((w) => /^\w+:[^:]+:.+$/.test(w) && tableOf(w) === tableOf(i.key) && w !== i.key) && !want.includes(i.key));
    expected += want.length;
    found += hit.length;
    wrong += bad.length;
    if (hit.length < want.length || bad.length) out.push({ note: n.id, missing: want.filter((w) => !hit.includes(w)), wrong: bad.map((i) => i.key) });
  }
  return { expected, found, wrong, notes: out };
}
