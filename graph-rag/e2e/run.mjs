// The replay harness's scenarios: each one a failure the live batches found,
// replayed against a real ArcadeDB and graph-rag with fake models (see
// fake-models.mjs and e2e.sh). Run by e2e.sh inside the harness network.
//
// After its own scenarios it runs every stream's: each `scenarios-<stream>.mjs`
// in this directory exporting an array of { name, run } (the contract is
// SCENARIOS.md; the loader is scenarios.mjs). One suite, one summary line.
// ONLY=term[,term] runs the scenarios whose name, file or stream matches.
import { discoverScenarioFiles, loadScenarioFiles, selected, skipReason, summaryLine } from "./scenarios.mjs";
const GRAPH = process.env.GRAPH_URL ?? "http://graph-rag:8000";
const MODELS = process.env.MODELS_URL ?? "http://models:4000";
// the fake test source (fake-source.mjs): read endpoint, write endpoint, and its control routes on the read port
const SOURCE = { read: "http://source:5000/mcp", write: "http://source:5001/mcp", control: "http://source:5000" };
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// carol: a second person at Operations who never writes, for negative checks (a search records what it shows as reads,
// and a writer's own notes graded above them show via "writer", so alice searching would raise her derived floor for hours)
const TOKENS = { admin: "e2e-admin", alice: "e2e-alice", bob: "e2e-bob", carol: "e2e-carol" };
// a graph worker thread's token, as the admin's workspace signs it (graph-rag/src/delegation.js)
const delegated = (claims) => {
  const body = Buffer.from(JSON.stringify({ u: "admin", a: randomUUID(), iat: Math.floor(Date.now() / 1000), ...claims })).toString("base64url");
  return `gwa1.${body}.${createHmac("sha256", "e2e-delegation-key-0123456789abcdef").update(`gwa1.${body}`).digest("base64url")}`;
};
const workerToken = (entry, job = randomUUID()) => delegated({ r: "worker", j: job, e: entry });
// the handler the master starts for a stopped worker (its Job row says which)
const handlerToken = (job) => delegated({ r: "handler", j: job });

let id = 1;
async function tool(who, name, args) {
  const r = await fetch(`${GRAPH}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKENS[who] ?? who}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
  });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  const msg = JSON.parse(line ? line.slice(5) : t);
  const text = msg.result?.content?.[0]?.text ?? msg.error?.message ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
const sql = async (query) => (await tool("admin", "query_graph", { query, language: "sql" })).rows ?? [];
const api = async (path, opts = {}) => (await fetch(`${GRAPH}${path}`, { ...opts, headers: { authorization: `Bearer ${TOKENS.admin}`, "content-type": "application/json" } })).json();
const models = (path, body) => fetch(`${MODELS}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const entry = async (name) => (await sql(`SELECT @rid AS rid, name, _home, _grade, _ungraded FROM Entity WHERE name = '${name}'`))[0];
const thing = async (label) => (await sql(`SELECT @rid AS rid, name FROM Entity WHERE _kind = 'thing' AND label = '${label}'`))[0];
const job = async (rid, kind = "review") => (await sql(`SELECT status, attempts, error, payload FROM Job WHERE kind = '${kind}' AND payload LIKE '%"${rid}"%' ORDER BY created_at DESC LIMIT 1`))[0];

async function until(label, fn, timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = `threw: ${e}`;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out: ${label} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
}

const results = [];
const OWN = { file: "run.mjs", stream: "harness" };
async function scenario(name, fn, meta = OWN) {
  if (!selected({ name, ...meta })) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, s: Math.round((Date.now() - t0) / 1000) });
    console.log(`PASS ${name} (${Math.round((Date.now() - t0) / 1000)}s)`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e) });
    console.log(`FAIL ${name}: ${String(e?.message ?? e).slice(0, 500)}`);
  } finally {
    // a failed scenario never leaves a model failing, slowed or primed for the next one
    for (const model of ["grader", "ds-flash", "embed", "decisions"]) await models("/__ok", { model });
    await models("/__reset", {}).catch(() => {});
    // ... and every scenario starts from S0 in the fake source
    await fetch(`${SOURCE.control}/__reset`, { method: "POST" }).catch(() => {});
  }
}
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const save = (who, name, text) => tool(who, "upsert_entities", { entities: [{ name, facets: { identity: text } }] });
const POS = { org: "org", ops: "ops", floor: "floor" };

await until("graph-rag up", async () => (await api("/api/worker")).enabled !== undefined, 120_000);

await scenario("a graded note lands at its writer's position", async () => {
  await save("alice", "e2e-a1 fridge", "The break room fridge gets cleaned Fridays.");
  const e = await entry("e2e-a1 fridge");
  check(e?._home === POS.ops, `home ${e?._home}`);
  check(!e._ungraded, "not awaiting grading");
});

await scenario("the grader out: held one level up, no proposal, graded on its own when it's back", async () => {
  await models("/__fail", { model: "grader", status: 402 });
  await save("bob", "e2e-a2 belt", "Maintenance replaced the compressor belt.");
  const e = await entry("e2e-a2 belt");
  check(e?._home === POS.ops, `held one level up (ops), got ${e?._home}`);
  check(e._ungraded, "marked awaiting grading");
  const queue = (await api("/api/queue")).pending ?? [];
  check(!queue.some((p) => String(p.payload).includes("e2e-a2")), "no move-back proposal for a person");
  const st = await api("/api/worker");
  check(st.dependencies?.["model:grader"]?.ok === false, `grader shown out: ${JSON.stringify(st.dependencies)}`);
  check(st.awaiting_grading >= 1, "counted as awaiting grading");
  await models("/__ok", { model: "grader" });
  const back = await until("regraded", async () => {
    const x = await entry("e2e-a2 belt");
    return x && !x._ungraded && x._home === POS.floor ? x : false;
  });
  check(/graded/.test(back._grade), `grade note: ${back._grade}`);
});

await scenario("the sweep embeds rows whose text the old inline SQL couldn't parse", async () => {
  await tool("admin", "execute_graph", { language: "sql", command: "INSERT INTO Entity SET name = 'e2e-raw \\\\ and \\' quote', _home = 'org', _origin = 'org'" });
  await until("backfilled", async () => {
    const r = (await sql("SELECT count(*) AS n FROM Entity WHERE name LIKE 'e2e-raw%' AND embed_identity IS NULL"))[0];
    return Number(r?.n) === 0 ? true : false;
  }, 90_000);
});

await scenario("the sweep never writes over the text a save stored while it ran", async () => {
  // the save embeds its text slower than the sweep comes round, so the sweep reads the row
  // bare; the sweep's own embedding is slower still, so its write lands after the save's
  await models("/__slow", { model: "embed", match: "a slow save stores", ms: 8000 });
  await models("/__slow", { model: "embed", match: "e2e-race lost update", ms: 12000 });
  try {
    await save("alice", "e2e-race lost update", "The body a slow save stores.");
    await new Promise((r) => setTimeout(r, 15000));
    const row = (await sql("SELECT text_identity FROM Entity WHERE name = 'e2e-race lost update'"))[0];
    check(row?.text_identity === "The body a slow save stores.", `text ${JSON.stringify(row?.text_identity)?.slice(0, 120)}`);
  } finally {
    await models("/__slow", {});
  }
});

await scenario("a worker restricts an entry on its own, but asks before moving one a person placed", async () => {
  await save("alice", "e2e-p1 unplaced", "The loading dock door sticks in the cold.");
  await save("alice", "e2e-p2 placed", "Second shift starts at 3 pm from Monday.");
  // a person releases e2e-p2 to the floor (a widening: queued, then approved)
  const asked = await tool("admin", "set_home", { entities: [{ name: "e2e-p2 placed" }], to: "Production floor" });
  const id = asked.results?.[0]?.id ?? asked.results?.[0]?.pendingId;
  check(id, `the release is queued: ${JSON.stringify(asked).slice(0, 300)}`);
  const ok = await api(`/api/queue/${id}/approve`, { method: "POST", body: "{}" });
  check(ok.result?.approved, `approved: ${JSON.stringify(ok).slice(0, 300)}`);
  check((await entry("e2e-p2 placed"))?._home === POS.floor, "released to the floor");
  // a worker moving the unplaced one up: applied
  const p1 = await entry("e2e-p1 unplaced");
  const w1 = await tool(workerToken(String(p1.rid)), "set_home", { entities: [{ name: "e2e-p1 unplaced" }], to: "org", reason: "e2e" });
  check((await entry("e2e-p1 unplaced"))?._home === POS.org, `an unplaced entry is restricted directly: ${JSON.stringify(w1).slice(0, 300)}`);
  // a worker moving the placed one back up: proposed, and it stays where the person put it
  const p2 = await entry("e2e-p2 placed");
  const w2 = await tool(workerToken(String(p2.rid)), "set_home", { entities: [{ name: "e2e-p2 placed" }], to: "Operations", reason: "it's an Operations note" });
  check(w2.results?.[0]?.placed_by_person, `proposed, not applied: ${JSON.stringify(w2).slice(0, 300)}`);
  check((await entry("e2e-p2 placed"))?._home === POS.floor, "still where the person put it");
});

await scenario("a worker writes no entry text, wherever grading put the entry", async () => {
  await save("bob", "e2e-l1 bonus note", "The weekend shift bonus is 40 a week. [admins]");
  const e = await entry("e2e-l1 bonus note");
  check(e?._home === POS.org, `graded to the top, got ${e?._home}`);
  const w = workerToken(String(e.rid));
  await tool(w, "search_graph", { query: "weekend shift bonus 40 a week" });
  const up = await tool(w, "upsert_entities", { entities: [{ name: "e2e-l1 bonus note", facets: { state: "Paid weekly from November." } }] });
  check(/writes no entries/.test(up.error ?? ""), `upsert refused: ${JSON.stringify(up).slice(0, 300)}`);
  check(!(await sql("SELECT text_state FROM Entity WHERE name = 'e2e-l1 bonus note'"))[0]?.text_state, "nothing was written to the entry");
  check((await entry("e2e-l1 bonus note"))?._home === POS.org, "the entry is still at the top");
});

await scenario("a worker (or a master's task) searches and reads instances as its entries' audience sees them, and beyond: true shows nothing more", async () => {
  await save("alice", "e2e-s1 zephyrine budget", "The zephyrine fixture budget is 9,000. [admins]");
  check((await entry("e2e-s1 zephyrine budget"))?._home === POS.org, "the budget note is at the top");
  await save("bob", "e2e-s2 zephyrine fixture", "The zephyrine fixture is on the bench.");
  const e = await entry("e2e-s2 zephyrine fixture");
  const w = workerToken(String(e.rid));
  const names = (r) => (r.results ?? []).map((x) => x.name);
  const mine = await tool(w, "search_graph", { query: "zephyrine fixture budget" });
  check(!names(mine).includes("e2e-s1 zephyrine budget"), `not found by default: ${names(mine).join(", ")}`);
  // an instance both notes are about, seen from both homes (R11: visible wherever a section about it is)
  await tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = 'zephyrine fixture (instance)', label = 'zephyrine fixture', _kind = 'thing', _norm = 'zephyrine fixture', _alias_norms = [], _homes = ['${POS.floor}', '${POS.org}'], _home = '${POS.org}'` });
  const inst = (await sql("SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND _norm = 'zephyrine fixture'"))[0];
  const top = await entry("e2e-s1 zephyrine budget");
  for (const from of [top.rid, e.rid]) await tool("admin", "execute_graph", { language: "sql", command: `CREATE EDGE ABOUT FROM ${from} TO ${inst.rid} SET role = 'mentions'` });
  const said = (r) => (r.things ?? []).flatMap((t) => (t.statements ?? []).map((x) => x.name));
  const about = await tool(w, "about_thing", { name: "zephyrine fixture" });
  check(said(about).includes("e2e-s2 zephyrine fixture") && !said(about).includes("e2e-s1 zephyrine budget"), `about_thing shows the floor's view: ${JSON.stringify(about).slice(0, 300)}`);
  // R11: each worker sees only its audience; the old way past it reads nothing more
  const aboutAll = await tool(w, "about_thing", { name: "zephyrine fixture", beyond: true });
  check(!said(aboutAll).includes("e2e-s1 zephyrine budget"), `beyond shows nothing more: ${JSON.stringify(aboutAll).slice(0, 300)}`);
  const all = await tool(w, "search_graph", { query: "zephyrine fixture budget", beyond: true });
  check(!names(all).includes("e2e-s1 zephyrine budget"), `not found with beyond either: ${names(all).join(", ")}`);
  // a master's task (a record at the top) about the floor's entry: its worker sees what the floor sees
  await tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = 'e2e-s3 zephyrine task', _kind = 'task', _home = '${POS.org}', _origin = '${POS.org}'` });
  const task = (await sql("SELECT @rid AS rid FROM Entity WHERE name = 'e2e-s3 zephyrine task' AND _kind = 'task'"))[0];
  const tj = randomUUID();
  await tool("admin", "execute_graph", { language: "sql", command: `INSERT INTO Job SET id = '${tj}', kind = 'thread', status = 'waiting', payload = '${JSON.stringify({ rid: String(task.rid), entries: ["e2e-s2 zephyrine fixture"] })}'` });
  const tw = workerToken(String(task.rid), tj);
  const taskAbout = await tool(tw, "about_thing", { name: "zephyrine fixture" });
  check(said(taskAbout).includes("e2e-s2 zephyrine fixture") && !said(taskAbout).includes("e2e-s1 zephyrine budget"), `a task's worker sees its entries' view: ${JSON.stringify(taskAbout).slice(0, 300)}`);
});

await scenario("a worker reads documents as its entry's people do, beyond: true reads nothing more, and a worker writes no entry text", async () => {
  const doc = await tool("alice", "ingest_document", { title: "e2e-d1 quillon contract", description: "The quillon supply contract.", text: "The quillon supply contract pays 12,000 a year. [admins]" });
  check(doc.doc_id, `ingested: ${JSON.stringify(doc).slice(0, 300)}`);
  await until("the section is placed", async () => (await sql(`SELECT _home FROM Entity WHERE _kind = 'section' AND _doc_id = '${doc.doc_id}'`))[0]?._home === POS.org);
  await save("bob", "e2e-d2 quillon bench", "The quillon jig is on bench 2.");
  const e = await entry("e2e-d2 quillon bench");
  const w = workerToken(String(e.rid));
  const hidden = await tool(w, "read_document", { document: doc.doc_id, section: 1 });
  check(!(hidden.sections ?? []).length, `the floor's view has no section: ${JSON.stringify(hidden).slice(0, 300)}`);
  const all = await tool(w, "read_document", { document: doc.doc_id, section: 1, beyond: true });
  check(!(all.sections ?? []).length && !JSON.stringify(all).includes("12,000"), `beyond reads nothing more: ${JSON.stringify(all).slice(0, 300)}`);
  const viaUpsert = await tool(w, "upsert_entities", { entities: [{ name: "e2e-d2 quillon bench", facets: { state: "On bench 2; under contract." } }] });
  check(/writes no entries/.test(viaUpsert.error ?? ""), `upsert_entities is refused: ${JSON.stringify(viaUpsert).slice(0, 300)}`);
});

await scenario("a worker cannot read above its audience by any tool it is offered or over HTTP, set_home neither finds nor moves what it can't see, and one whose entry can't be resolved reads nothing", async () => {
  const listTools = async (who) => {
    const r = await fetch(`${GRAPH}/mcp`, { method: "POST", headers: { authorization: `Bearer ${who}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/list", params: {} }) });
    const t = await r.text();
    const line = t.split("\n").find((l) => l.startsWith("data:"));
    return (JSON.parse(line ? line.slice(5) : t).result?.tools ?? []).map((x) => x.name);
  };
  const secret = "e2e-a1 vellichor payroll";
  await save("alice", secret, "The vellichor crew's raises are 4 percent from March. [admins]");
  check((await entry(secret))?._home === POS.org, "the secret is at the top");
  const doc = await tool("alice", "ingest_document", { title: "e2e-a2 vellichor raises", description: "The vellichor raises.", text: "Vellichor raises: 4 percent from March. [admins]" });
  check(doc.doc_id, `ingested: ${JSON.stringify(doc).slice(0, 200)}`);
  await until("the section is placed", async () => (await sql(`SELECT _home FROM Entity WHERE _kind = 'section' AND _doc_id = '${doc.doc_id}'`))[0]?._home === POS.org);
  await tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = 'vellichor crew (instance)', label = 'vellichor crew', _kind = 'thing', _norm = 'vellichor crew', _alias_norms = [], _homes = ['${POS.org}'], _home = '${POS.org}'` });
  await save("bob", "e2e-a3 vellichor bench", "The vellichor crew is on bench 4 this week.");
  const floorEntry = await entry("e2e-a3 vellichor bench");
  check(floorEntry?._home === POS.floor, "the worker's entry is on the floor");
  const w = workerToken(String(floorEntry.rid));
  // the secret's content, never a name this scenario passes in (a reply may echo what it was asked)
  const leaked = (r) => /4 percent/i.test(JSON.stringify(r));
  // every tool a worker is offered, sorted: reads, and writes that find their target by name (both checked here),
  // and writes that find nothing. A new tool fails this until it's sorted and, if it reads or finds, checked.
  const offered = await listTools(w);
  // list_classes and read_dependencies: the classes stream's (routes-classes.js), read through this audience
  const READS = ["search_graph", "about_thing", "read_document", "schema_graph", "list_classes", "read_dependencies"];
  const FINDS = ["set_home"];
  // execute_graph: a worker's raw command is always a proposal for an admin (write.js), never run for it;
  // upsert_entities: refused for a worker (it writes no entries); raise_question: asks, reads nothing back
  const NEITHER = ["upsert_entities", "raise_question", "execute_graph"];
  const unknown = offered.filter((t) => ![...READS, ...FINDS, ...NEITHER].includes(t));
  check(!unknown.length, `a worker tool this scenario doesn't sort into reads or not: ${unknown.join(", ")}`);
  check(!offered.includes("query_graph"), `no raw reads for a worker: ${offered.join(", ")}`);
  const raw = "SELECT text_identity FROM Entity WHERE text_identity LIKE '%percent%'";
  const q = await tool(w, "query_graph", { query: raw, language: "sql" });
  check(!leaked(q) && !(q.rows ?? []).length && q.error, `query_graph refused: ${JSON.stringify(q).slice(0, 200)}`);
  const x = await tool(w, "execute_graph", { command: raw, language: "sql", reason: "e2e: a read dressed as a command" });
  check(!leaked(x) && !(x.rows ?? []).length && (x.pendingId || x.error), `execute_graph only proposes, and shows nothing: ${JSON.stringify(x).slice(0, 200)}`);
  if (x.pendingId) await api(`/api/worker/proposals/${x.pendingId}`, { method: "POST", body: JSON.stringify({ approve: false, reason: "e2e" }) });
  for (const beyond of [undefined, true]) {
    const extra = beyond ? { beyond } : {};
    const s = await tool(w, "search_graph", { query: "vellichor crew raises 4 percent", ...extra });
    check(Array.isArray(s.results) && !leaked(s.results), `search_graph${beyond ? " beyond" : ""}: ${JSON.stringify(s).slice(0, 300)}`);
    const a = await tool(w, "about_thing", { name: "vellichor crew", ...extra });
    check(!leaked(a), `about_thing${beyond ? " beyond" : ""}: ${JSON.stringify(a).slice(0, 300)}`);
    for (const args of [{ document: doc.doc_id }, { document: doc.doc_id, section: 1 }, { document: "e2e-a2 vellichor raises" }]) {
      const d = await tool(w, "read_document", { ...args, ...extra });
      check(!leaked(d), `read_document ${JSON.stringify(args)}${beyond ? " beyond" : ""}: ${JSON.stringify(d).slice(0, 300)}`);
    }
  }
  check(!leaked(await tool(w, "schema_graph", {})), "schema_graph names no entry");
  // a class homed at the top, and a dependency whose far end only the top sees
  await tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = 'vellichor raise class', _kind = 'class', _class_key = 'vellichor_raise_class', _class_name = 'Vellichor raise class', _description = 'raises of 4 percent', _home = '${POS.org}', _status = 'active'` });
  await tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = 'vellichor bench (instance)', label = 'vellichor bench', _kind = 'thing', _norm = 'vellichor bench', _alias_norms = [], _homes = ['${POS.floor}'], _home = '${POS.floor}'` });
  const bench = (await sql("SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND _norm = 'vellichor bench'"))[0];
  const crew = (await sql("SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND _norm = 'vellichor crew'"))[0];
  await tool("admin", "execute_graph", { language: "sql", command: `CREATE EDGE DEPENDS_ON FROM ${bench.rid} TO ${crew.rid} SET stated_as = 'person', stated_by = 'admin', stated_at = '${new Date().toISOString()}'` });
  const classes = await tool(w, "list_classes", {});
  check(!classes.error && !leaked(classes) && !/vellichor raise/i.test(JSON.stringify(classes)), `list_classes shows no class above the audience: ${JSON.stringify(classes).slice(0, 300)}`);
  // (control) both are there to be shown: the class, and the edge from the floor's instance
  check((await sql("SELECT count(*) AS n FROM Entity WHERE _kind = 'class' AND _class_key = 'vellichor_raise_class'"))[0]?.n === 1, "the class exists");
  check((await sql(`SELECT out('DEPENDS_ON').size() AS n FROM ${bench.rid}`))[0]?.n === 1, "the dependency exists");
  const deps = await tool(w, "read_dependencies", { instance: String(bench.rid) });
  check(!JSON.stringify(deps).includes(String(crew.rid)) && !/vellichor crew/i.test(JSON.stringify(deps)), `read_dependencies hides an end the audience can't see: ${JSON.stringify(deps).slice(0, 300)}`);
  // set_home: an entry above the audience answers as one that doesn't exist (no existence oracle), and doesn't move
  await save("alice", "e2e-a4 vellichor ops plan", "The vellichor crew moves to second shift in April.");
  check((await entry("e2e-a4 vellichor ops plan"))?._home === POS.ops, "an Operations entry");
  const missing = await tool(w, "set_home", { entities: [{ name: "e2e-a9 no such entry" }], to: "Top of the organization", reason: "e2e" });
  for (const name of [secret, "e2e-a4 vellichor ops plan"]) {
    const r = await tool(w, "set_home", { entities: [{ name }], to: "Top of the organization", reason: "e2e" });
    check(r.error && r.error.replace(name, "X") === missing.error.replace("e2e-a9 no such entry", "X"), `set_home on ${name} answers as for no entry: ${JSON.stringify(r).slice(0, 200)} vs ${JSON.stringify(missing).slice(0, 200)}`);
  }
  check((await entry("e2e-a4 vellichor ops plan"))?._home === POS.ops, "the Operations entry did not move");
  // over HTTP: a worker's token reads nothing at all, whatever the route
  for (const path of ["/api/entities", "/api/grants", "/api/requests", "/api/positions", "/api/queue", "/api/policy", "/api/worker", "/api/pruned"]) {
    const r = await fetch(`${GRAPH}${path}`, { headers: { authorization: `Bearer ${w}` } });
    const text = await r.text();
    check(r.status === 403 && !/vellichor/i.test(text), `${path} refused for a worker: ${r.status} ${text.slice(0, 160)}`);
  }
  const people = await fetch(`${GRAPH}/api/entities`, { headers: { authorization: `Bearer ${TOKENS.alice}` } });
  check(people.status !== 403, `a person's token still reads over HTTP: ${people.status}`);
  // the control: the admin's search does find it, so the worker's reads could have shown it
  const adminSees = await tool("admin", "search_graph", { query: "vellichor crew raises 4 percent" });
  check(leaked(adminSees.results ?? []), `the admin's search finds it: ${JSON.stringify(adminSees).slice(0, 200)}`);
  // a worker whose entry is gone or never was: nothing at all, not the delegating admin's whole view
  const lost = workerToken("#9999:9999");
  const none = await tool(lost, "search_graph", { query: "vellichor crew bench 4" });
  check(Array.isArray(none.results) && none.results.length === 0, `an unresolved audience reads nothing: ${JSON.stringify(none).slice(0, 300)}`);
});

await scenario("grading restricts only for a listed topic: one it can't name stays with the writer's team", async () => {
  await save("bob", "e2e-c1 floater order", "Exatron sent a new order for 500 floaters, job 3260410. [no-topic]");
  const routine = await entry("e2e-c1 floater order");
  check(routine?._home === POS.floor, `stays on the floor: ${routine?._home} (${routine?._grade})`);
  await save("bob", "e2e-c2 floater pay", "The floater crew's pay goes up next month. [admins]");
  check((await entry("e2e-c2 floater pay"))?._home === POS.org, "a listed topic restricts");
});

await scenario("a handler records the operator's decision only when it names one, and takes a proposal's short id", async () => {
  await save("alice", "e2e-h1 dock lights", "Two dock lights are out by door 3.");
  // a person releases it to the floor (a widening: queued, then approved), so a worker's move back up is a proposal, not a change
  const released = await tool("admin", "set_home", { entities: [{ name: "e2e-h1 dock lights" }], to: "Production floor" });
  const rid0 = released.results?.[0]?.id ?? released.results?.[0]?.pendingId;
  check(rid0, `the release is queued: ${JSON.stringify(released).slice(0, 300)}`);
  await api(`/api/queue/${rid0}/approve`, { method: "POST", body: "{}" });
  check((await entry("e2e-h1 dock lights"))?._home === POS.floor, "placed on the floor by a person");
  const e = await entry("e2e-h1 dock lights");
  const job = randomUUID();
  const moved0 = await tool(workerToken(String(e.rid), job), "set_home", { entities: [{ name: "e2e-h1 dock lights" }], to: "Operations", reason: "e2e: an Operations matter" });
  const asked = { pendingId: moved0.results?.[0]?.pendingId ?? moved0.results?.[0]?.id };
  check(moved0.results?.[0]?.placed_by_person && asked.pendingId, `proposed, not applied: ${JSON.stringify(moved0).slice(0, 300)}`);
  const h = randomUUID();
  await tool("admin", "execute_graph", { language: "sql", command: `INSERT INTO Job SET id = '${h}', kind = 'handler', status = 'waiting', payload = '{"for_job":"${job}"}'` });
  const empty = await tool(handlerToken(h), "decide_for_worker", {});
  check(/Nothing to record/.test(empty.error ?? ""), `an empty call is refused: ${JSON.stringify(empty).slice(0, 300)}`);
  const wrong = await tool(handlerToken(h), "decide_for_worker", { approve: ["00000000"] });
  check(/not one pending proposal/.test(wrong.error ?? ""), `an unknown id is refused: ${JSON.stringify(wrong).slice(0, 300)}`);
  const ok = await tool(handlerToken(h), "decide_for_worker", { approve: [asked.pendingId.slice(0, 8)] });
  check(ok.decided, `decided: ${JSON.stringify(ok).slice(0, 300)}`);
  const st = (await sql(`SELECT status FROM PendingWrite WHERE id = '${asked.pendingId}'`))[0]?.status;
  check(st === "approved", `the short id applied it: ${st}`);
  check((await entry("e2e-h1 dock lights"))?._home === POS.ops, "the worker's move is made on the operator's word");
  // a pending proposal the worker didn't raise (here an admin's widening): the operator's word applies it too
  const moved = await tool("admin", "set_home", { entities: [{ name: "e2e-h1 dock lights" }], to: "Production floor", reason: "e2e" });
  const pid = moved.results?.[0]?.pendingId ?? moved.results?.[0]?.id;
  check(pid, `a widening is queued: ${JSON.stringify(moved).slice(0, 300)}`);
  const h2 = randomUUID();
  await tool("admin", "execute_graph", { language: "sql", command: `INSERT INTO Job SET id = '${h2}', kind = 'handler', status = 'waiting', payload = '{"for_job":"${job}"}'` });
  const other = await tool(handlerToken(h2), "decide_for_worker", { approve: [pid.slice(0, 8)] });
  check(other.decided, `decided: ${JSON.stringify(other).slice(0, 300)}`);
  check((await entry("e2e-h1 dock lights"))?._home === POS.floor, "the widening applied");
});

await scenario("an approved raw command that changes nothing isn't recorded as applied", async () => {
  await save("alice", "e2e-r1 raw rename", "The spare saw blades are in cabinet 4.");
  const e = await entry("e2e-r1 raw rename");
  await tool("admin", "execute_graph", { language: "sql", command: `UPDATE ${e.rid} SET _keys = ['e2e:r1']` });
  const w = workerToken(String(e.rid));
  // CONTAINS on a list matches nothing in Cypher: the approval fails and says why
  const miss = await tool(w, "execute_graph", { language: "cypher", command: "MATCH (t) WHERE t._keys CONTAINS 'e2e:r1' SET t.e2e_mark = 'x'", reason: "e2e" });
  check(miss.pendingId, `proposed: ${JSON.stringify(miss).slice(0, 300)}`);
  const failed = await api(`/api/worker/proposals/${miss.pendingId}`, { method: "POST", body: JSON.stringify({ approve: true, reason: "e2e" }) });
  check(/matched nothing/.test(JSON.stringify(failed)), `refused: ${JSON.stringify(failed).slice(0, 300)}`);
  check((await sql(`SELECT status FROM PendingWrite WHERE id = '${miss.pendingId}'`))[0]?.status === "failed", "recorded as failed");
  const hit = await tool(w, "execute_graph", { language: "cypher", command: "MATCH (t) WHERE 'e2e:r1' IN t._keys SET t.e2e_mark = 'x'", reason: "e2e" });
  const ok = await api(`/api/worker/proposals/${hit.pendingId}`, { method: "POST", body: JSON.stringify({ approve: true, reason: "e2e" }) });
  check(ok.approved, `applied: ${JSON.stringify(ok).slice(0, 300)}`);
  check((await sql(`SELECT e2e_mark FROM ${e.rid}`))[0]?.e2e_mark === "x", "the change is in the graph");
});

await scenario("a writer still reads a note grading put above them; others at their position don't", async () => {
  await save("bob", "e2e-w1 pay note", "Diep starts at 21.50 an hour. [admins]");
  const e = await entry("e2e-w1 pay note");
  check(e?._home === POS.org, `graded to the top, got ${e?._home}`);
  const by = (await sql("SELECT _written_by FROM Entity WHERE name = 'e2e-w1 pay note'"))[0]?._written_by;
  check(by === "bob", `written by bob, got ${by}`);
  const found = async (who) => ((await tool(who, "search_graph", { query: "Diep starts at 21.50 an hour" })).results ?? []).find((r) => r.name === "e2e-w1 pay note");
  const mine = await found("bob");
  check(mine, "its writer finds it");
  check(mine.via === "writer", `seen as its writer, got ${mine.via}`);
  check(!(await found("carol")), "carol, above bob but below the top, doesn't");
  // a worker writes no entry text, so no update of its takes the writer over: the way in is refused and the entry is as bob left it
  const up = await tool(workerToken(String(e.rid)), "upsert_entities", { entities: [{ name: "e2e-w1 pay note", facets: { identity: "Diep starts at 21.50 an hour; review at 90 days. [admins]" } }] });
  check(/writes no entries/.test(up.error ?? ""), `a worker's update is refused: ${JSON.stringify(up).slice(0, 300)}`);
  const after = (await sql("SELECT _written_by, text_identity FROM Entity WHERE name = 'e2e-w1 pay note'"))[0];
  check(after?._written_by === "bob", `still written by bob, got ${after?._written_by}`);
  check(after?.text_identity === "Diep starts at 21.50 an hour. [admins]", `the text is bob's: ${after?.text_identity}`);
  // reading isn't owning: its writer can't move it back down
  const moved = await tool("bob", "set_home", { entities: [{ name: "e2e-w1 pay note" }], to: "Production floor" });
  check(moved.error || moved.pendingId || moved.proposed, `bob's move isn't made directly: ${JSON.stringify(moved).slice(0, 200)}`);
  check((await entry("e2e-w1 pay note"))._home === POS.org, "still at the top");
});

await scenario("a thread whose turn died on the model connection waits it out without spending a try", async () => {
  const jid = randomUUID();
  const now = new Date().toISOString();
  const ins = await tool("admin", "execute_graph", { command: `INSERT INTO Job SET id = '${jid}', kind = 'review', job_key = 'e2e:${jid}', payload = '{}', status = 'running', attempts = 0, priority = 1, run_after = '${now}', created_at = '${now}', updated_at = '${now}'`, language: "sql" });
  check(!ins.error, `job inserted: ${JSON.stringify(ins).slice(0, 200)}`);
  const row = async () => (await sql(`SELECT status, attempts, payload, run_after FROM Job WHERE id = '${jid}'`))[0];
  const finish = (body) => api(`/api/worker/threads/${jid}/finish`, { method: "POST", body: JSON.stringify(body) });
  const out = await finish({ status: "failed", summary: "(the turn ended with an error: Connection error.)", outage: "the turn ended with an error: Connection error." });
  check(out.status === "pending" && out.outage, `put off: ${JSON.stringify(out)}`);
  const r = await row();
  check(r.status === "pending" && Number(r.attempts) === 0, `pending, no try spent: ${JSON.stringify(r)}`);
  check(JSON.parse(r.payload).outages === 1, "one outage counted");
  check(Date.parse(r.run_after) > Date.now(), "goes again after the pause");
  const st = await api("/api/worker");
  check(st.dependencies?.["model:ds-flash"]?.ok === false, `the worker model shows out: ${JSON.stringify(st.dependencies)}`);
  const claim = await api("/api/worker/threads/claim", { method: "POST", body: JSON.stringify({ limit: 1 }) });
  check(claim.paused && !(claim.threads ?? []).length, `no thread starts while it's out: ${JSON.stringify(claim)}`);
  // a turn that ends normally: the model is back
  await finish({ status: "done", summary: "done" });
  check((await api("/api/worker")).dependencies?.["model:ds-flash"]?.ok === true, "the worker model is back once a turn ends normally");
  // a work failure still spends a try
  await tool("admin", "execute_graph", { command: `UPDATE Job SET status = 'running' WHERE id = '${jid}'`, language: "sql" });
  await finish({ status: "failed", summary: "bad arguments" });
  check(Number((await row()).attempts) === 1, "a failure of its own spends a try");
});

await scenario("a model with a limit gets no more threads than it serves; the rest wait (or go back) without spending a try", async () => {
  const before = (await api("/api/worker")).pool;
  await api("/api/worker", { method: "PUT", body: JSON.stringify({ pool: { poolSize: 5 } }) });
  try {
    // a worker takes only a record that is on record (R11), and one job per record and home: so four records,
    // each put on record by alice's on-record agent, one section each, every one past the check
    const agent = randomUUID();
    const on = await fetch(`${GRAPH}/api/thread-record`, { method: "PUT", headers: { authorization: `Bearer ${TOKENS.alice}`, "content-type": "application/json" }, body: JSON.stringify({ agent, on: true }) });
    check(on.ok, `alice's agent on record: ${on.status}`);
    const recorder = delegated({ u: "alice", a: agent, p: [POS.ops] });
    const tag = randomUUID().slice(0, 8);
    const sections = [];
    for (const n of [1, 2, 3, 4]) {
      const title = `e2e-l${n} capacity record ${tag}`;
      const r = await tool(recorder, "record_document", { document: { title, recorded_by: "alice", position: POS.ops, reason: "e2e: capacity", sections: [{ text: `Capacity test record ${n}: the saw is on bench ${n}.` }] } });
      check(!r.error, `${title} recorded: ${JSON.stringify(r).slice(0, 200)}`);
      const pending = r.pendingId ?? (r.queued ? r.id : null);
      if (pending) check((await api(`/api/queue/${pending}/approve`, { method: "POST", body: "{}" })).result?.approved !== false, "approved");
      const section = await until(`${title} ready and checked`, async () => {
        const doc = (await sql(`SELECT _doc_status, _doc_id FROM Entity WHERE _kind = 'document' AND name = '${title}'`))[0];
        if (doc?._doc_status !== "ready") return null;
        const sec = (await sql(`SELECT @rid AS rid, _ungraded FROM Entity WHERE _kind = 'section' AND _doc_id = '${doc._doc_id}'`))[0];
        return sec && (sec._ungraded === null || sec._ungraded === undefined) ? String(sec.rid) : null;
      });
      sections.push(section);
    }
    // the record path queues its own jobs for these sections: out of the way, so only this scenario's are counted
    await tool("admin", "execute_graph", { command: `UPDATE Job SET status = 'done', summary = 'e2e: set aside' WHERE kind = 'review' AND status = 'pending' AND (${sections.map((r) => `payload LIKE '%"${r}"%'`).join(" OR ")})`, language: "sql" });
    const now = new Date(Date.now() - 1000).toISOString();
    const ids = [];
    for (const [i, level] of [1, 1, 1, 2].entries()) {
      const jid = randomUUID();
      ids.push(jid);
      const payload = JSON.stringify({ rid: sections[i], level }).replace(/'/g, "\\'");
      const r = await tool("admin", "execute_graph", { command: `INSERT INTO Job SET id = '${jid}', kind = 'review', job_key = 'e2e:${jid}', payload = '${payload}', status = 'pending', attempts = 0, priority = 9, run_after = '${now}', created_at = '${now}', updated_at = '${now}'`, language: "sql" });
      check(!r.error, `job inserted: ${JSON.stringify(r).slice(0, 200)}`);
    }
    // level 1's model has room for one: one level-1 thread and the level-2 one start
    const got = await api("/api/worker/threads/claim", { method: "POST", body: JSON.stringify({ limit: 5, groups: [{ levels: [1], room: 1 }] }) });
    const mine = (got.threads ?? []).filter((t) => ids.includes(t.job));
    check(mine.filter((t) => t.level === 1).length === 1, `one level-1 thread: ${JSON.stringify(mine.map((t) => t.level))}`);
    check(mine.filter((t) => t.level === 2).length === 1, `the level-2 thread too: ${JSON.stringify(mine.map((t) => t.level))}`);
    const rows = await sql(`SELECT id, status, attempts FROM Job WHERE id IN [${ids.map((i) => `'${i}'`).join(",")}]`);
    check(rows.filter((r) => r.status === "pending").length === 2 && rows.every((r) => Number(r.attempts) === 0), `the other two wait, no try spent: ${JSON.stringify(rows)}`);
    // a full model: none of its threads start
    const none = await api("/api/worker/threads/claim", { method: "POST", body: JSON.stringify({ limit: 5, groups: [{ levels: [1], room: 0 }] }) });
    check(!(none.threads ?? []).some((t) => ids.includes(t.job)), "none while it's full");
    // a claimed thread the workspace can't start yet goes back: pending in a minute, no try spent
    const one = mine.find((t) => t.level === 1).job;
    const rel = await api(`/api/worker/threads/${one}/release`, { method: "POST", body: "{}" });
    check(rel.released === true, `released: ${JSON.stringify(rel)}`);
    const back = (await sql(`SELECT status, attempts, run_after FROM Job WHERE id = '${one}'`))[0];
    check(back.status === "pending" && Number(back.attempts) === 0 && Date.parse(back.run_after) > Date.now(), `back in the queue: ${JSON.stringify(back)}`);
    await tool("admin", "execute_graph", { command: `UPDATE Job SET status = 'done' WHERE id IN [${ids.map((i) => `'${i}'`).join(",")}]`, language: "sql" });
  } finally {
    await api("/api/worker", { method: "PUT", body: JSON.stringify({ pool: before }) });
  }
});

await scenario("an update with labels keeps an entry's record id; a new entry still gets its labels", async () => {
  await save("alice", "e2e-r1 coolant", "Coolant on CNC 1 read 4 percent.");
  const before = (await sql("SELECT @rid AS rid, @type AS t FROM Entity WHERE name = 'e2e-r1 coolant'"))[0];
  const up = await tool("alice", "upsert_entities", { entities: [{ name: "e2e-r1 coolant", labels: ["Note"], facets: { state: "Topped up to 7 percent." } }] });
  check(!up.error, `updated: ${JSON.stringify(up).slice(0, 200)}`);
  const after = await sql("SELECT @rid AS rid, @type AS t, text_state FROM Entity WHERE name = 'e2e-r1 coolant'");
  check(after.length === 1 && String(after[0].rid) === String(before.rid), `same record: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  check(after[0].t === before.t && after[0].text_state === "Topped up to 7 percent.", `updated in place: ${JSON.stringify(after[0])}`);
  await tool("alice", "upsert_entities", { entities: [{ name: "e2e-r2 labelled", labels: ["Note"], facets: { identity: "A new labelled note." } }] });
  const fresh = (await sql("SELECT @type AS t FROM Entity WHERE name = 'e2e-r2 labelled'"))[0];
  check(String(fresh?.t).endsWith("Note"), `a new entry takes its label: ${JSON.stringify(fresh)}`);
});

await scenario("nothing in the background kept failing", async () => {
  const st = await api("/api/worker");
  const failing = Object.entries(st.loops ?? {}).filter(([, l]) => !l.ok);
  check(failing.length === 0, `failing loops: ${JSON.stringify(failing)}`);
  check(Object.values(st.dependencies ?? {}).every((d) => d.ok), `still out: ${JSON.stringify(st.dependencies)}`);
});

// ---- the streams' scenarios: every scenarios-<stream>.mjs next to this file (SCENARIOS.md) ----
const E2E_DIR = fileURLToPath(new URL("./", import.meta.url));
const FIXTURES = new URL("../test/fixtures/", import.meta.url);
/** what a scenario file's run(context) receives: this file's helpers, by name */
/** the fake source's control routes: GET /__dump, /__calls; POST /__reset, /__plant */
const source = async (path, body) => (await fetch(`${SOURCE.control}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

const context = {
  GRAPH,
  MODELS,
  SOURCE,
  source,
  sourceDump: () => source("/__dump"),
  TOKENS,
  POS,
  tool,
  sql,
  api,
  models,
  entry,
  thing,
  job,
  until,
  check,
  save,
  delegated,
  workerToken,
  handlerToken,
  randomUUID,
  fixtures: {
    dir: fileURLToPath(FIXTURES),
    read: (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")),
    url: (name) => new URL(name, FIXTURES),
  },
  e2eDir: E2E_DIR,
  // a stream's scenario can import this checkout's modules read-only (`src/model/schema.js`)
  srcUrl: (rel) => new URL(`../src/${rel}`, import.meta.url),
  // the real-model evaluation's modules (graph-rag/eval/), read-only
  evalUrl: (rel) => new URL(`../eval/${rel}`, import.meta.url),
};
const files = discoverScenarioFiles(E2E_DIR);
// the harness's own stream last: what its agents read would raise what people have read
const streams = (await loadScenarioFiles(files)).sort((a, b) => Number(a.stream === "harness") - Number(b.stream === "harness"));
if (files.length) console.log(`\n${streams.length} scenario${streams.length === 1 ? "" : "s"} from ${files.length} stream file${files.length === 1 ? "" : "s"}: ${files.map((f) => f.split("/").pop()).join(", ")}`);
let lastStream = null;
for (const s of streams) {
  if (!selected(s)) continue;
  // a stream's fake source ends with it
  if (lastStream && s.stream !== lastStream) await context.tool("admin", "execute_graph", { language: "sql", command: "DELETE FROM OrgPolicy WHERE scope = 'sources'" });
  lastStream = s.stream;
  const reason = await skipReason(s, context);
  if (reason) {
    results.push({ name: s.name, ok: true, skipped: true, reason });
    console.log(`SKIP ${s.name} [${s.file}]: ${reason}`);
    continue;
  }
  await scenario(`${s.name} [${s.stream}]`, () => s.run(context), s);
}

const failed = results.filter((r) => !r.skipped && !r.ok);
console.log(`\n${summaryLine(results)}`);
// a SKIP or a run that selected nothing proves nothing: neither is a pass
const nothing = results.length === 0;
const skipped = results.filter((r) => r.skipped);
if (nothing) console.log("no scenario ran (an ONLY= that matches nothing?)");
process.exit(failed.length || skipped.length || nothing ? 1 : 0);
