// One run's report, and the comparison across runs (docs/build/integrate.md, section 2). Pure: it takes a
// snapshot (collect.mjs reads one from an instance) and returns the measures, the two gates, and Markdown.
//
// snapshot: {
//   meta: { setup, run, seed, noteOf: { recordId: noteId }, markers: [{ word, record, recordId, floor, expect? }] },
//   positions, before, after,            // the test positions; the source dumps
//   entries, requests, briefs,           // the filing log, workers' requests, every brief as sent
//   classes, instances, sections, about, // the graph: classes; [{ rid, name, key, classes, homes }];
//                                        // [{ rid, record, home, text }]; { recordId: [instance rid] }
//   titles,                              // [{ rid, record, home, title }]: documents' titles
//   checks?: { a: [answer], b: [answer], aName, bName },
//   connectionHome?                      // who reads the test source (the test configuration: everyone)
// }
import { NOTES } from "./labels.mjs";
import { briefItems, classItems, entryItems, instanceItems, markerHomes, requestItems, scanLeaks, sectionItems, titleItems, writeItems } from "./leaks.mjs";
import { OUTCOME_ORDER, scoreLinks, scoreOutcomes } from "./outcomes.mjs";
import { accountResults, diffDumps, rowGate } from "./source.mjs";
import { duplicateCandidates, placementSample, renderTree, stability } from "./tree.mjs";
import { compareChecks } from "./check.mjs";
import { EVERYONE } from "./positions.mjs";
import { SYSTEM, rowKey } from "./s0.mjs";

const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? "n/a" : `${Math.round(x * 100)}%`);

export function buildReport(snap, { notes = NOTES } = {}) {
  const noteOf = (rid) => snap.meta.noteOf?.[rid] ?? null;
  const recordsOf = (id) => Object.entries(snap.meta.noteOf ?? {}).filter(([, n]) => n === id).map(([r]) => r);
  const info = new Map(snap.instances.map((i) => [i.rid, { key: i.key ?? null, name: i.name }]));
  const changes = diffDumps(snap.before, snap.after);
  const rows = rowGate(changes, snap.entries);
  const titles = snap.titles ?? [];
  // a marker's home comes from the labels (its recorder's position), stricter only where the system stored it so
  const homes = markerHomes(snap.meta.markers ?? [], [...snap.sections, ...titles.map((t) => ({ ...t, text: t.title }))], snap.positions);
  const items = [
    ...briefItems(snap.briefs ?? []),
    ...entryItems(snap.entries),
    ...requestItems(snap.requests ?? []),
    ...instanceItems(snap.instances, snap.positions),
    // a section is checked against the other sections: a marker copied into a wider section is a leak
    ...sectionItems(snap.sections),
    ...titleItems(titles),
    ...classItems(snap.classes),
    ...writeItems(changes, snap.connectionHome ?? EVERYONE),
  ];
  const leaks = scanLeaks(items, homes, snap.positions, { briefs: (snap.briefs ?? []).length });
  const about = new Map(Object.entries(snap.about ?? {}));
  const outcomes = scoreOutcomes(notes, snap.entries, { noteOf, info, changes, instances: snap.instances, about });
  const links = scoreLinks(notes, { recordsOf, about, info });
  const accounts = accountResults(changes, snap.entries, { before: snap.before });
  const counts = {};
  const instancesOf = new Map();
  for (const i of snap.instances)
    for (const k of i.classes) {
      counts[k] = (counts[k] ?? 0) + 1;
      if (!instancesOf.has(k)) instancesOf.set(k, []);
      instancesOf.get(k).push(i.rid);
    }
  const afterRows = new Map();
  for (const [table, t] of Object.entries(snap.after ?? {})) for (const r of t.rows) afterRows.set(rowKey(table, t.primaryKey, r).replace(/^[^:]+:/, `${SYSTEM}:`), r);
  const placements = placementSample(snap.instances, snap.classes, afterRows, { seed: snap.meta.seed ?? 1 });
  const duplicates = duplicateCandidates(snap.classes, instancesOf);
  const checks = snap.checks?.a?.length && snap.checks?.b?.length ? compareChecks(snap.checks.a, snap.checks.b) : null;
  const tree = renderTree(snap.classes, counts, { title: `Class tree: ${snap.meta.setup ?? "setup"}, run ${snap.meta.run ?? 1}` });
  const gates = { rows: rows.ok, leaks: leaks.ok, ok: rows.ok && leaks.ok };
  const report = { meta: snap.meta, gates, changes, rows, leaks: { ...leaks, markers: homes }, outcomes, links, accounts, placements, duplicates, checks, tree };
  report.markdown = markdown(report, snap);
  return report;
}

function markdown(r, snap) {
  const o = r.outcomes;
  const L = [];
  L.push(`# Filing run: ${r.meta.setup ?? "setup"}, run ${r.meta.run ?? 1}`, "");
  L.push(`**Gates** (zero tolerance, as proposal B proposes it; the user approved the doc). Rows changed only with a Filed entry: ${r.gates.rows ? "PASS" : "FAIL"}. Leaks through briefs: ${r.gates.leaks ? "PASS" : "FAIL"}${r.leaks.reasons.length ? ` (${r.leaks.reasons.join("; ")})` : ""}; ${r.leaks.briefs ?? 0} briefs scanned.`, "");
  if (!r.gates.rows) for (const v of r.rows.violations) L.push(`- row ${v.key} (${v.kind}): ${v.why}`);
  if (!r.gates.leaks) for (const l of r.leaks.leaks) L.push(`- leak: "${l.word}" (home ${l.home}) in ${l.where}, seen by ${l.audience ?? "unknown"}${l.why ? `: ${l.why}` : ""}`);
  for (const m of r.leaks.misplaced) L.push(`- misplaced: "${m.word}" (${m.record}) stored at ${m.stored}, below its recorder's position ${m.floor}`);
  if (r.leaks.untested.length) L.push(`- markers never stored, so untested: ${r.leaks.untested.join(", ")}`);
  for (const b of r.leaks.belowExpect) L.push(`- (reported, not gating) "${b.word}" ended at ${b.home}; the integrator's label reads the check as owing ${b.expect}`);
  L.push("", "## Filing outcomes against the labels", "");
  L.push(`${o.totals.pieces} labelled pieces: ${o.totals.exact} exact, ${o.totals.accepted} accepted, ${o.totals.wrong} wrong (${o.totals.wrongTarget} wrong target, ${o.totals.wrongRule} wrong outcome on the right target), ${o.totals.missing} missing. ${o.totals.extra} extra entries, ${o.totals.extraWrites} of them writes.`, "");
  L.push(`| label \\ logged | ${[...OUTCOME_ORDER, "missing"].join(" | ")} |`, `|---|${[...OUTCOME_ORDER, "missing"].map(() => "--:").join("|")}|`);
  for (const lab of OUTCOME_ORDER) L.push(`| ${lab} | ${[...OUTCOME_ORDER, "missing"].map((x) => o.confusion[lab][x]).join(" | ")} |`);
  if (o.mustNot.length) {
    L.push("", "Named wrong actions:", "");
    for (const m of o.mustNot) L.push(`- ${m.note}: ${m.rule}`);
  }
  L.push("", "Stated changes and stated states (R12): a change is written given authority, a state the source disagrees with is Held:", "");
  for (const f of o.stated) L.push(`- ${f.note} (${f.stated}): ${f.about}: labelled ${f.label}, logged ${f.got}`);
  L.push("", "Item 5 (someone or something the source doesn't hold), which this run chose:", "");
  const chose = (g) => o.unheld.filter((u) => u.got === g).length;
  L.push(`- Kept with an instance: ${chose("kept")}; Held question: ${chose("held")}; other or missing: ${o.unheld.length - chose("kept") - chose("held")}`);
  const wrongs = o.notes.flatMap((n) => n.pieces.filter((p) => p.verdict === "wrong" || p.verdict === "missing").map((p) => `- ${n.note}: ${p.about}: labelled ${p.label}, logged ${p.got ?? "nothing"} (${p.failure})`));
  if (wrongs.length) L.push("", "Wrong or missing pieces:", "", ...wrongs);
  L.push("", "## Sections and instances", "");
  L.push(`Expected instances linked: ${r.links.found} of ${r.links.expected}; links to the wrong row of an expected table: ${r.links.wrong}.`);
  for (const n of r.links.notes) L.push(`- ${n.note}: missing ${n.missing.join(", ") || "none"}${n.wrong.length ? `; wrong ${n.wrong.join(", ")}` : ""}`);
  L.push("", `Instances sampled against the source: ${r.placements.sample.length}, flagged by the mechanical checks: ${r.placements.flagged}.`);
  for (const s of r.placements.sample.filter((x) => x.problems.length)) L.push(`- ${s.name} (${s.classes.join(", ")}): ${s.problems.join("; ")}`);
  L.push("", "## Workers' accounts", "");
  const a = r.accounts.totals;
  L.push(`${a.accounts} accounts of a write: ${a.true} true, ${a.falseClaim} false claims, ${a.wrongValues} wrong values, ${a.unverifiableFields} naming no fields; ${a.omitted} writes no account mentions; ${a.silent} accounts whose words don't name the row (read them: the words are prose). The orchestrator's check: ${a.caught} caught, ${a.missed} missed, ${a.falseAlarm} false alarms, ${a.unverifiable} unverifiable, ${a.unchecked} unchecked.`);
  L.push("", "## Duplicate class candidates (for a person to confirm)", "");
  if (!r.duplicates.length) L.push("None suggested.");
  for (const d of r.duplicates) L.push(`- [ ] ${d.a} / ${d.b}: ${d.why.join("; ")}`);
  if (r.checks) {
    const c = r.checks;
    L.push("", "## The typed check", "");
    L.push(`${snap.checks.aName ?? "A"} against ${snap.checks.bName ?? "B"} on ${c.compared} sections: agreement ${pct(c.agreement)}, kappa ${c.kappa === null ? "n/a" : c.kappa.toFixed(2)}.`);
    L.push(`- ${snap.checks.aName ?? "A"}: unsure ${pct(c.a.unsureRate)}, stable ${pct(c.a.stability)}, unanswered ${c.a.unanswered}`);
    L.push(`- ${snap.checks.bName ?? "B"}: unsure ${pct(c.b.unsureRate)}, stable ${pct(c.b.stability)}, unanswered ${c.b.unanswered}`);
  }
  L.push("", "## Source changes", "");
  if (!r.changes.length) L.push("No row changed.");
  for (const c of r.changes) L.push(`- ${c.kind} ${c.key}: ${c.columns.join(", ")}`);
  L.push("");
  return L.join("\n");
}

/**
 * Across the runs of one setup, and across setups: tree stability and the headline numbers. The plan of at least two
 * setups, three runs each, is proposal B's (the assistant's, approved by the user with the doc), not a ruling;
 * this takes whatever runs it is given.
 */
export function compareRuns(runs) {
  const bySetup = new Map();
  for (const r of runs) {
    const s = r.report.meta.setup ?? "setup";
    if (!bySetup.has(s)) bySetup.set(s, []);
    bySetup.get(s).push(r);
  }
  const L = ["# Runs compared", "", "| Setup | Runs | Gates | Exact or accepted | Wrong | Missing | Writes | Classes in every run | Edges in every run |", "|---|--:|---|--:|--:|--:|--:|--:|--:|"];
  const setups = [];
  for (const [setup, list] of bySetup) {
    const st = stability(list.map((r) => r.classes));
    const t = list.map((r) => r.report.outcomes.totals);
    const avg = (k) => (t.reduce((s, x) => s + x[k], 0) / t.length).toFixed(1);
    const ok = list.every((r) => r.report.gates.ok);
    const good = (t.reduce((s, x) => s + x.exact + x.accepted, 0) / t.length).toFixed(1);
    const writes = (list.reduce((s, r) => s + r.report.changes.length, 0) / list.length).toFixed(1);
    L.push(`| ${setup} | ${list.length} | ${ok ? "pass" : "FAIL"} | ${good} / ${t[0]?.pieces ?? 0} | ${avg("wrong")} | ${avg("missing")} | ${writes} | ${pct(st.shareInAll)} of ${st.classes} | ${pct(st.shareEdgesInAll)} of ${st.edges} |`);
    setups.push({ setup, runs: list.length, gates: ok, stability: st });
  }
  return { setups, markdown: `${L.join("\n")}\n` };
}
