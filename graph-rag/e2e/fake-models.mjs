// A stand-in for litellm and the decision API, for the replay harness: the
// same routes, answers decided from the request (so a run is repeatable),
// and a control route that makes any model fail, the way an account out of
// credit or a provider outage does.
//
//   POST /v1/embeddings          deterministic vectors from the words
//   POST /v1/chat/completions    the grader (writer's position, sure; "[admins]" in a note = the top),
//                                the linker (mentions from the statement's
//                                [things: Name/type, ...] tag)
//   POST /decisions              triage: "[L2]" in the entry = an
//                                investigation, else nothing to do
//   POST /__fail {model, status} a model (or "decisions") answers with status
//   POST /__ok {model}           ... and recovers
//   POST /__slow {model, match, ms}  a request to it whose input contains match waits ms first
//                                ({} clears them): to order two writers' calls
//   GET  /__calls                calls per model
import { createServer } from "node:http";

const DIM = 384;
const failing = new Map(); // model -> status
let slow = []; // {model, match, ms}
const calls = {};

function vector(text) {
  const v = new Array(DIM).fill(0);
  for (const w of String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 2166136261;
    for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    v[h % DIM] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function grade(messages) {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const items = [...user.matchAll(/^#\d+ name: (.+)$([\s\S]*?)(?=^#\d+ name: |$(?![\s\S]))/gm)].map((m) => ({ name: m[1].trim(), text: m[2] }));
  // the top of the organization's label (`Pn: org (...)`), for notes tagged [admins]
  const top = /^(P\d+): org\b/m.exec(user)?.[1];
  // P1 is the writer's own position: routine for its writer's team
  return JSON.stringify({
    items: items.map(({ name, text }) =>
      text.includes("[admins]") && top
        ? { name, visible_from: top, release_to: null, until: null, confidence: 0.9, reason: "for admins only" }
        : { name, visible_from: "P1", release_to: null, until: null, confidence: 0.9, reason: "routine for its writer's team" },
    ),
  });
}

function mentions(messages) {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const tag = /\[things: ([^\]]*)\]/.exec(user);
  const things = tag
    ? tag[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const [name, type = "other"] = s.split("/");
          return { name: name.trim(), type: type.trim(), role: "mentions" };
        })
    : [];
  return JSON.stringify({ things, review: false, why: "" });
}

function decide(body) {
  const entry = String(body?.state?.entry ?? "");
  const investigate = entry.includes("[L2]");
  const answers = {
    level: investigate ? { score: 2, probabilities: { 0: 0.05, 1: 0.15, 2: 0.7, 3: 0.1 } } : { score: 0, probabilities: { 0: 0.9, 1: 0.1, 2: 0, 3: 0 } },
    reason: investigate ? { choice: "record_lookup", probabilities: { record_lookup: 0.8 } } : { choice: "plain_fact", probabilities: { plain_fact: 0.9 } },
  };
  return { model: "fake-decisions", answers, usage: { cost: 0 } };
}

const read = (req) =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s ? JSON.parse(s) : {}));
  });

createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const body = req.method === "POST" ? await read(req) : {};
  const path = req.url.replace(/^\/v1/, "");
  if (path === "/__fail") return failing.set(body.model, Number(body.status) || 402), send(200, { failing: Object.fromEntries(failing) });
  if (path === "/__ok") return failing.delete(body.model), send(200, { failing: Object.fromEntries(failing) });
  if (path === "/__calls") return send(200, calls);
  if (path === "/__slow") return (slow = body.model ? [...slow, body] : []), send(200, { slow });
  const model = path === "/decisions" ? "decisions" : body.model;
  calls[model] = (calls[model] ?? 0) + 1;
  const wait = slow.find((x) => x.model === model && JSON.stringify(body).includes(x.match));
  if (wait) await new Promise((r) => setTimeout(r, Number(wait.ms) || 0));
  if (failing.has(model)) return send(failing.get(model), { error: { message: `fake: ${model} answers ${failing.get(model)}`, code: failing.get(model) } });
  if (path === "/embeddings") return send(200, { data: (body.input ?? []).map((t, index) => ({ index, embedding: vector(t) })) });
  if (path === "/decisions") return send(200, decide(body));
  if (path === "/chat/completions") {
    const system = body.messages?.find((m) => m.role === "system")?.content ?? "";
    const content = system.includes("who in an organization may see") ? grade(body.messages) : system.includes("You find the things a statement") ? mentions(body.messages) : "{}";
    return send(200, { choices: [{ message: { role: "assistant", content } }] });
  }
  send(404, { error: `no route ${req.url}` });
}).listen(Number(process.env.PORT ?? 4000), () => console.log("fake models listening"));
