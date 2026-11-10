// The typed check, hosted against locally served (docs/build/integrate.md, 2.7; R4). Pure. Not graded against
// the labels: agreement between the two, how often each is unsure, repeat stability, and sections left
// admin-only because no answer came (R11).
//
// An answer: { section, model, run, level, probs: { level: p }, unsure, answered }. `level` is the position the
// check chose (or null when it didn't answer).

const modal = (xs) => {
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] ?? null;
};

/** per model: sections, unsure rate, unanswered, stability (same level every run), spread of the top probability */
export function modelSummary(answers) {
  const bySection = new Map();
  for (const a of answers) {
    if (!bySection.has(a.section)) bySection.set(a.section, []);
    bySection.get(a.section).push(a);
  }
  let stable = 0;
  let spread = 0;
  for (const list of bySection.values()) {
    if (new Set(list.map((a) => a.level ?? "none")).size === 1) stable++;
    const tops = list.map((a) => Math.max(0, ...Object.values(a.probs ?? {}).map(Number)));
    spread += Math.max(...tops) - Math.min(...tops);
  }
  const n = bySection.size || 1;
  return {
    sections: bySection.size,
    answers: answers.length,
    unsureRate: answers.length ? answers.filter((a) => a.unsure).length / answers.length : 0,
    unanswered: answers.filter((a) => !a.answered).length,
    stability: stable / n,
    meanTopSpread: spread / n,
    modal: new Map([...bySection].map(([s, list]) => [s, modal(list.map((a) => a.level ?? "none"))])),
  };
}

/** Cohen's kappa over two labelings of the same items */
export function kappa(pairs) {
  if (!pairs.length) return null;
  const cats = [...new Set(pairs.flat())];
  const n = pairs.length;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pe = cats.reduce((s, c) => s + (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

/** the two models compared on the sections both answered for: exact agreement and kappa on the modal level */
export function compareChecks(answersA, answersB) {
  const a = modelSummary(answersA);
  const b = modelSummary(answersB);
  const pairs = [...a.modal].filter(([s]) => b.modal.has(s)).map(([s, l]) => [l, b.modal.get(s)]);
  const strip = ({ modal: _m, ...rest }) => rest;
  return {
    a: strip(a),
    b: strip(b),
    compared: pairs.length,
    agreement: pairs.length ? pairs.filter(([x, y]) => x === y).length / pairs.length : null,
    kappa: kappa(pairs),
    disagreements: [...a.modal].filter(([s, l]) => b.modal.has(s) && b.modal.get(s) !== l).map(([s, l]) => ({ section: s, a: l, b: b.modal.get(s) })),
  };
}
