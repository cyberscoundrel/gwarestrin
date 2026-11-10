// The restrict-only check (R4, R11.11): once per section, at write, independent of the agents that read the
// content. A typed decision model answers two closed questions with real probabilities, and code decides from
// them, so every placement can be shown as numbers:
//
//   category      which of the organization's restricted categories the text is about, or "none"
//                 (policy.restrictedTopics: the nine in code, admin-editable; R11.11)
//   visible_from  the lowest position that may see it, from the recorder's position and those above it
//
// Rules, all restrict-only (a section never goes below where it starts, R11.5):
//   - "none", sure                         -> stays at its origin
//   - a category, sure, visible_from sure  -> visible_from (never below the origin)
//   - anything unsure                      -> held one level higher and flagged for a person (R11.11)
//   - no answer (unconfigured, an error, an unusable answer)
//                                          -> admin-only (the root) until it is checked (R11.11)
//
// The pure parts (checkRequest, checkVerdict) are tested in test/check.test.js; checkEntities makes the calls.
import { ancestors } from "./positions.js";
import { askDecisionModel } from "./decisions.js";

export const CONFIDENCE_MIN = 0.6;

/** the note an entry carries while it waits for its check */
export const UNCHECKED = "admin-only until checked: the check gave no answer";

/** the root, as the check's "admin-only" (NEEDS A RULING: R11.11 says admin-only; the root position is read as that) */
export const adminOnly = (map) => map.root;

/** one level higher than `home` (the root stays the root) */
export const oneUp = (map, home) => map.positions[home]?.parent ?? home;

/** the stricter of two homes on one line through the origin (the one fewer people see) */
const stricter = (map, a, b) => (ancestors(map, a).includes(b) ? b : a);

/** the positions the check may choose from: the origin and every position above it, labelled P1 (the origin)… */
export function levels(map, origin) {
  return [origin, ...ancestors(map, origin)];
}

/** the category keys: c1… in list order, then "none" */
export const categoryKeys = (topics) => [...topics.map((_, i) => `c${i + 1}`), "none"];

/**
 * The decision request for one section. `entry` is the section's text (data, never instructions: a decision
 * model only scores the closed choices it is given). Returns { state, questions, byLabel, byCategory }.
 */
export function checkRequest(map, origin, entity, topics) {
  const up = levels(map, origin);
  const byLabel = new Map(up.map((id, i) => [`P${i + 1}`, id]));
  const describe = (id) => {
    const p = map.positions[id];
    // the root's own description reads as "everyone" to a model; in this tree only the top sees it
    const what = p.parent === null ? "the top of the organization only: its owners and leadership" : p.description;
    return `${p.name}${what ? ` (${what})` : ""}`;
  };
  const byCategory = new Map(topics.map((t, i) => [`c${i + 1}`, t]));
  const criteria = Object.fromEntries([...byCategory].map(([k, t]) => [k, `The text is about ${t}`]));
  criteria.none = "None of these: the writer's position's own work (orders, jobs, schedules, machines, parts, who covers whom), with no money figure, confidential term, personnel judgement or request to keep it quiet";
  const text = textOf(entity);
  return {
    state: {
      entry: text,
      positions: up.map((id, i) => `P${i + 1}: ${describe(id)}${i === 0 ? " (the writer's own position)" : ""}`).join("\n"),
    },
    questions: {
      category: { type: "choice", instructions: "Which restricted category is the text in `entry` about, if any?", criteria },
      visible_from: {
        type: "choice",
        instructions: "Who may see the text in `entry`? The position chosen and every position above it see it; the higher the position, the fewer people see it. Choose P1 unless the text is about a restricted category that people at P1 must not see.",
        criteria: Object.fromEntries(up.map((id, i) => [`P${i + 1}`, describe(id)])),
      },
    },
    byLabel,
    byCategory,
  };
}

/** a section's text as the check sees it: its whole text when given (a stored facet is a preview), else its facets, and a heading */
function textOf(e) {
  const body = typeof e._text === "string" ? e._text : Object.values(e.facets ?? {}).filter((v) => typeof v === "string").join("\n");
  const heading = typeof e.properties?.heading === "string" && e.properties.heading ? `${e.properties.heading}\n` : "";
  return `${heading}${body}`.slice(0, 8000);
}

/** a choice answer: { choice, p } when the choice is one of `keys` with a probability, else null */
function choiceOf(answer, keys) {
  if (!answer || typeof answer.choice !== "string" || !keys.includes(answer.choice)) return null;
  const p = Number(answer.probabilities?.[answer.choice]);
  return Number.isFinite(p) ? { choice: answer.choice, p: Math.max(0, Math.min(1, p)) } : null;
}

/**
 * The verdict from a decision model's answers, or null when they are unusable (no answer: admin-only).
 * Returns { home, sure, category, confidence, reason }. Pure.
 *
 * NEEDS A RULING (record 1, 2): R4 and R11.11 give closed categories and "uncertain holds one level higher",
 * not how high a sure category raises nor what "uncertain" is in numbers. Built: visible_from says how high,
 * a category restricts only when it is sure, and "sure" is a probability at or above the threshold
 * (policy.gradingConfidence). Unsure holds at the stricter of one level up and an above-origin visible_from.
 */
export function checkVerdict(answers, { map, origin, byLabel, byCategory, threshold = CONFIDENCE_MIN }) {
  const cat = choiceOf(answers?.category, [...byCategory.keys(), "none"]);
  if (!cat) return null;
  const vf = choiceOf(answers?.visible_from, [...byLabel.keys()]);
  const chosen = vf ? byLabel.get(vf.choice) : null;
  const topic = cat.choice === "none" ? null : byCategory.get(cat.choice);
  const held = (why, conf) => {
    const up = oneUp(map, origin);
    return { home: topic && chosen && chosen !== origin ? stricter(map, up, chosen) : up, sure: false, category: topic, confidence: conf, reason: why };
  };
  if (cat.p < threshold) return held(`unsure of the category (${topic ?? "none"} at ${cat.p.toFixed(2)})`, cat.p);
  if (!topic) return { home: origin, sure: true, category: null, confidence: cat.p, reason: "no restricted category" };
  if (!vf || vf.p < threshold) return held(`${topic}, unsure who may see it${vf ? ` (${vf.choice} at ${vf.p.toFixed(2)})` : ""}`, Math.min(cat.p, vf?.p ?? 0));
  return { home: chosen, sure: true, category: topic, confidence: Math.min(cat.p, vf.p), reason: chosen === origin ? `${topic}, but its writer's position may see it` : topic };
}

/** the decision model's settings, as context.js holds them */
export const decisionConfig = (ctx) => ({ url: ctx.DECISION_URL, key: ctx.DECISION_API_KEY, model: ctx.DECISION_MODEL });

/**
 * One check call per entity (R4: once per section). Per entity: a verdict, or undefined when there is no
 * answer (the decision model is not configured, fails, times out, or answers unusably). `ask(request)` is
 * the call (askDecisionModel by default); a null from it means not configured.
 */
export async function checkEntities(map, origin, entities, { topics, threshold, ask, onError = () => {} }) {
  const out = [];
  for (const e of entities) {
    const req = checkRequest(map, origin, e, topics);
    let res = null;
    try {
      res = await ask({ state: req.state, questions: req.questions });
    } catch (err) {
      onError(err, e);
      res = null;
    }
    const v = res ? checkVerdict(res.answers, { map, origin, byLabel: req.byLabel, byCategory: req.byCategory, threshold }) : null;
    out.push(v ?? undefined);
  }
  return out;
}

/** the default call: the configured decision model */
export const askWith = (config) => (request) => askDecisionModel(config, request);

/**
 * Where an entity goes from its check. `verdict` undefined = no answer: admin-only, marked unchecked so the
 * recheck places it once the model answers. `existing`: its home on an update (never widened; an update can
 * only restrict it further). Returns { home, note, unchecked?, review?: { to, reason }, restricted? }.
 */
export function placeChecked(map, { origin, verdict, existing }) {
  if (existing !== undefined) {
    if (verdict?.sure && verdict.home !== existing && ancestors(map, existing).includes(verdict.home)) {
      return { home: verdict.home, note: `restricted by the check: ${verdict.reason}`, restricted: { from: existing, reason: verdict.reason } };
    }
    return { home: existing, note: verdict ? "kept" : "kept (no answer from the check)" };
  }
  if (!verdict) return { home: adminOnly(map), note: UNCHECKED, unchecked: true };
  if (!verdict.sure) {
    return {
      home: verdict.home,
      ...(verdict.home !== origin ? { review: { to: origin, reason: `the check was unsure (${verdict.confidence.toFixed(2)}): ${verdict.reason}` } } : {}),
      note: `held one level higher: the check was unsure (${verdict.reason})`,
    };
  }
  return { home: verdict.home, note: verdict.home === origin ? `checked: ${verdict.reason}` : `restricted by the check: ${verdict.reason}` };
}
