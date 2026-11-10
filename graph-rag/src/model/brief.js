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
  const recordOk = !record?.home || homeOk(positions, audience, record.home);
  return {
    brief: { audience, record: recordOk ? record ?? null : null, sections: s, classes: c, instances: i, sources },
    dropped: { sections: ds, classes: dc, instances: di, record: recordOk ? 0 : 1 },
  };
}

/** the check the brief's sender runs last: throws ShapeError when anything in it is above the audience */
export function assertBrief(brief, positions) {
  const { audience } = brief ?? {};
  if (!audience) throw new ShapeError("audience", "a brief needs its audience");
  if (brief.record?.home && !homeOk(positions, audience, brief.record.home)) throw new ShapeError("record", "the record's title is above the audience");
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
