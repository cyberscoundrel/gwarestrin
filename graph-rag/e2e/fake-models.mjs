// A stand-in for litellm and the decision API, for the replay harness: the
// same routes, answers decided from the request (so a run is repeatable),
// and a control route that makes any model fail, the way an account out of
// credit or a provider outage does. Every answer is keyed on phrases in the
// text, so a scenario says what it wants by what it writes.
//
//   POST /v1/embeddings          deterministic vectors from the words
//   POST /v1/chat/completions    the grader (writer's position, sure; "[admins]" in a note = the top;
//                                an item marked [claimed] is a section with claims: the grader is not
//                                its judge, it stays at the writer's position and the call is counted),
//                                the condenser (a request whose model or system prompt says "condens":
//                                fake-condenser.mjs next to this file when present, else the built-in
//                                one: sections from the text, claims from [claim: kind|subject|class|attribute|value] tags)
//   POST /decisions              triage: "[L2]" in the entry = an investigation, else nothing to do;
//                                a closed question (any `choice`) answered from a [<question>: <key>] tag, else "none"
//                                (no built-in answers: the linker and triage are gone, R4, and a fake that resolved
//                                names would hand a test its answer)
//   POST /__fail {model, status} a model (or "decisions") answers with status
//   POST /__ok {model}           ... and recovers
//   POST /__slow {model, match, ms}  a request to it whose input contains match waits ms first
//                                ({} clears them): to order two writers' calls
//   POST /__condense {match, document}  the built-in condenser answers document (an object) when
//                                the conversation contains match ({} clears them)
//   POST /__reset                clears every override above (run.mjs calls it after each scenario)
//   GET  /__calls                calls per model, plus grader:claimed (claimed items the grader was asked about)
//   GET  /__decisions            every decision request: its question names and the reason question's criteria (kept across /__reset)
//   GET  /__graded               the name of every item the grader was asked about, in order (kept across /__reset)
//   GET  /__condenser            whether fake-condenser.mjs was loaded
// Imported by test/harness-fakes.test.js for its pure parts; listens only when run as a program.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIM = 384;

export function vector(text) {
  const v = new Array(DIM).fill(0);
  for (const w of String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 2166136261;
    for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    v[h % DIM] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

const userText = (messages) => messages.find((m) => m.role === "user")?.content ?? "";
const systemText = (messages) => messages.find((m) => m.role === "system")?.content ?? "";

/** a section with claims is marked [claimed] by whoever sends it: not the grader's to judge */
export const CLAIMED_TAG = "[claimed]";

/**
 * The grader. `counts` (optional) gets `claimed` bumped for every item the
 * grader should never have been asked about; the item itself stays where it
 * was written, so a wrongly graded section is visible two ways.
 */
export function grade(messages, counts = null) {
  const user = userText(messages);
  const items = [...user.matchAll(/^#\d+ name: (.+)$([\s\S]*?)(?=^#\d+ name: |$(?![\s\S]))/gm)].map((m) => ({ name: m[1].trim(), text: m[2] }));
  // the top of the organization's label (`Pn: org (...)`), for notes tagged [admins]
  const top = /^(P\d+): org\b/m.exec(user)?.[1];
  // P1 is the writer's own position: routine for its writer's team
  return JSON.stringify({
    items: items.map(({ name, text }) => {
      if (counts) (counts.graded ??= []).push(name);
      if (text.includes(CLAIMED_TAG)) {
        if (counts) counts.claimed = (counts.claimed ?? 0) + 1;
        return { name, visible_from: "P1", topic: null, release_to: null, until: null, confidence: 0.9, reason: "has claims: their authority places them, not the grader" };
      }
      return text.includes("[admins]") && top
        ? { name, visible_from: top, topic: "personnel and health", release_to: null, until: null, confidence: 0.9, reason: "for admins only" }
        : // [no-topic]: a grader that would restrict but names no listed topic (it stays where it's written)
          text.includes("[no-topic]") && top
          ? { name, visible_from: top, topic: null, release_to: null, until: null, confidence: 0.9, reason: "500 pieces, job 3260410" }
          : { name, visible_from: "P1", release_to: null, until: null, confidence: 0.9, reason: "routine for its writer's team" };
    }),
  });
}

// ---- the decision model: the closed questions, answered from tags in the text ----

/**
 * One closed question: a `[<question>: <key>]` tag in the text picks that choice, sure; else "none" when that
 * is a choice, else the first choice, unsure. No built-in answers: the linker and triage are gone (R4), and a
 * fake that knew which employee "Diep" is would hand a test its answer.
 */
export function answerChoice(question, { criteria = {}, entry = "" }) {
  const keys = Object.keys(criteria);
  const sure = (choice) => ({ choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.9 : Number((0.1 / Math.max(1, keys.length - 1)).toFixed(3))])) });
  const tagged = new RegExp(`\\[${question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([^\\]]+)\\]`).exec(entry)?.[1]?.trim();
  if (tagged && criteria[tagged]) return sure(tagged);
  if (criteria.none) return sure("none");
  return { choice: keys[0], probabilities: Object.fromEntries(keys.map((k) => [k, Number((1 / Math.max(1, keys.length)).toFixed(3))])) };
}

export function decide(body) {
  const entry = String(body?.state?.entry ?? "");
  const investigate = entry.includes("[L2]");
  const answers = {
    level: investigate ? { score: 2, probabilities: { 0: 0.05, 1: 0.15, 2: 0.7, 3: 0.1 } } : { score: 0, probabilities: { 0: 0.9, 1: 0.1, 2: 0, 3: 0 } },
    reason: investigate ? { choice: "record_lookup", probabilities: { record_lookup: 0.8 } } : { choice: "plain_fact", probabilities: { plain_fact: 0.9 } },
  };
  for (const [q, spec] of Object.entries(body?.questions ?? {})) {
    if (q === "level" || q === "reason") continue;
    if (spec?.type === "choice") {
      answers[q] = answerChoice(q, { criteria: spec.criteria ?? {}, entry });
    } else if (spec?.type === "noul") answers[q] = { noul: entry.includes("[contradicts]") ? 0.9 : 0.05 };
    else if (spec?.type === "score") answers[q] = { score: 0, probabilities: { 0: 0.9, 1: 0.1 } };
  }
  return { model: "fake-decisions", answers, usage: { cost: 0 } };
}

// ---- the condenser: fake-condenser.mjs when present, else the built-in one ----

export const isCondenseRequest = (body) => /condens/i.test(String(body?.model ?? "")) || /condens/i.test(systemText(body?.messages ?? []));

/**
 * The Condenser stream's canned responses, when its file is next to this
 * one: `complete(body)` returning a chat-completions response (the stream's
 * stand-in), or `condense(messages, body)` returning the assistant's content
 * (a string, or an object to JSON-encode); optionally `matches(body)` to
 * claim a request the model name or system prompt would not. Returns null
 * when absent.
 */
export async function loadCondenser(dir = fileURLToPath(new URL("./", import.meta.url))) {
  const file = `${dir.replace(/\/?$/, "/")}fake-condenser.mjs`;
  if (!existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  const complete = mod.complete ?? mod.default?.complete ?? null;
  const own = mod.condense ?? mod.default?.condense ?? (typeof mod.default === "function" ? mod.default : null);
  const condense =
    typeof complete === "function"
      ? async (messages, body) => {
          const r = await complete({ ...body, messages });
          return r?.choices?.[0]?.message?.content ?? r;
        }
      : own;
  if (typeof condense !== "function") throw new Error(`${file}: must export complete(body) or condense(messages, body)`);
  return { file, condense, matches: mod.matches ?? mod.default?.matches ?? null };
}

const CLAIM_TAG_RE = /\[claim:\s*([^\]|]+)\|([^\]|]+)\|([^\]|]+)\|([^\]|]+)\|([^\]]+)\]/g;

/**
 * The built-in condenser: a document in the contract's shape
 * (src/model/claims.js) from the conversation text. `lookups` first: the
 * document whose `match` the text contains. Else: a title from a
 * `[title: ...]` tag (or the first line), recorded_by/position/reason from
 * `[on record: person|position|reason]` (or placeholders), one section per
 * blank-line block, each block's `[claim: kind|subject|class|attribute|value]`
 * tags its claims. The tags are stripped from the section text.
 */
export function condense(messages, lookups = []) {
  const text = userText(messages);
  for (const l of lookups) if (l.match && text.includes(l.match)) return typeof l.document === "string" ? l.document : JSON.stringify(l.document);
  const title = /\[title:\s*([^\]]+)\]/.exec(text)?.[1]?.trim() ?? text.split("\n").find((l) => l.trim())?.trim().slice(0, 80) ?? "Condensed conversation";
  const rec = /\[on record:\s*([^|\]]+)\|([^|\]]+)\|([^\]]+)\]/.exec(text);
  const strip = (s) =>
    s
      .replace(CLAIM_TAG_RE, "")
      .replace(/\[(title|on record):[^\]]*\]/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  const sections = text
    .split(/\n\s*\n/)
    .map((block) => {
      const claims = [...block.matchAll(CLAIM_TAG_RE)].map((m) => ({ kind: m[1].trim(), subject: m[2].trim(), class: m[3].trim(), attribute: m[4].trim(), value: m[5].trim() }));
      return { text: strip(block), claims };
    })
    .filter((s) => s.text);
  return JSON.stringify({
    title,
    recorded_by: rec?.[1]?.trim() ?? "unknown",
    position: rec?.[2]?.trim() ?? "unknown",
    reason: rec?.[3]?.trim() ?? "on record",
    sections: sections.length ? sections : [{ text: strip(text) || "(empty)", claims: [] }],
  });
}

// ---- the server ----

const read = (req) =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s ? JSON.parse(s) : {}));
  });

/** the fake models as an http.Server (not yet listening); `condenser` from loadCondenser, or null */
export function createFakeModels({ condenser = null } = {}) {
  const failing = new Map(); // model -> status
  let slow = []; // {model, match, ms}
  let condenseLookups = []; // {match, document}
  const calls = {};
  const counts = {};
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const body = req.method === "POST" ? await read(req) : {};
    const path = req.url.replace(/^\/v1/, "");
    if (path === "/__fail") return failing.set(body.model, Number(body.status) || 402), send(200, { failing: Object.fromEntries(failing) });
    if (path === "/__ok") return failing.delete(body.model), send(200, { failing: Object.fromEntries(failing) });
    if (path === "/__calls") return send(200, { ...calls, "grader:claimed": counts.claimed ?? 0 });
    if (path === "/__graded") return send(200, { graded: counts.graded ?? [] });
    if (path === "/__decisions") return send(200, { decisions: counts.decisions ?? [] });
    if (path === "/__slow") return (slow = body.model ? [...slow, body] : []), send(200, { slow });
    if (path === "/__condense") return (condenseLookups = body.match ? [...condenseLookups, body] : []), send(200, { condense: condenseLookups.map((l) => l.match) });
    if (path === "/__reset") return failing.clear(), (slow = []), (condenseLookups = []), send(200, { reset: true });
    if (path === "/__condenser") return send(200, { loaded: Boolean(condenser), file: condenser?.file ?? null });
    if (path === "/decisions") (counts.decisions ??= []).push({ questions: Object.keys(body.questions ?? {}), reasons: Object.keys(body.questions?.reason?.criteria ?? {}) });
    const model = path === "/decisions" ? "decisions" : body.model;
    calls[model] = (calls[model] ?? 0) + 1;
    const wait = slow.find((x) => x.model === model && JSON.stringify(body).includes(x.match));
    if (wait) await new Promise((r) => setTimeout(r, Number(wait.ms) || 0));
    if (failing.has(model)) return send(failing.get(model), { error: { message: `fake: ${model} answers ${failing.get(model)}`, code: failing.get(model) } });
    if (path === "/embeddings") return send(200, { data: (body.input ?? []).map((t, index) => ({ index, embedding: vector(t) })) });
    if (path === "/decisions") return send(200, decide(body));
    if (path === "/chat/completions") {
      const messages = body.messages ?? [];
      const system = systemText(messages);
      let content;
      if (condenser && (condenser.matches ? condenser.matches(body) : isCondenseRequest(body))) {
        const out = await condenser.condense(messages, body);
        content = typeof out === "string" ? out : JSON.stringify(out);
      } else if (system.includes("who in an organization may see")) content = grade(messages, counts);
      else if (isCondenseRequest(body)) content = condense(messages, condenseLookups);
      else content = "{}";
      return send(200, { choices: [{ message: { role: "assistant", content } }] });
    }
    send(404, { error: `no route ${req.url}` });
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const condenser = await loadCondenser();
  if (condenser) console.log(`fake condenser: ${condenser.file}`);
  createFakeModels({ condenser }).listen(Number(process.env.PORT ?? 4000), () => console.log("fake models listening"));
}
