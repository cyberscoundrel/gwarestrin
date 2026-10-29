// The replay harness's scenarios: each one a failure the live batches found,
// replayed against a real ArcadeDB and graph-rag with fake models (see
// fake-models.mjs and e2e.sh). Run by e2e.sh inside the harness network.
const GRAPH = process.env.GRAPH_URL ?? "http://graph-rag:8000";
const MODELS = process.env.MODELS_URL ?? "http://models:4000";
import { createHmac, randomUUID } from "node:crypto";
const TOKENS = { admin: "e2e-admin", alice: "e2e-alice", bob: "e2e-bob" };
// a graph worker thread's token, as the admin's workspace signs it (graph-rag/src/delegation.js)
const workerToken = (entry) => {
  const body = Buffer.from(JSON.stringify({ u: "admin", a: randomUUID(), r: "worker", j: randomUUID(), e: entry, iat: Math.floor(Date.now() / 1000) })).toString("base64url");
  return `gwa1.${body}.${createHmac("sha256", "e2e-delegation-key-0123456789abcdef").update(`gwa1.${body}`).digest("base64url")}`;
};

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
const entry = async (name) => (await sql(`SELECT @rid AS rid, name, _home, _grade, _ungraded, _mentions_at FROM Entity WHERE name = '${name}'`))[0];
const thing = async (label) => (await sql(`SELECT @rid AS rid, name FROM Entity WHERE _kind = 'thing' AND label = '${label}'`))[0];
const job = async (rid, kind = "mentions") => (await sql(`SELECT status, attempts, error, payload FROM Job WHERE kind = '${kind}' AND payload LIKE '%${rid}%' ORDER BY created_at DESC LIMIT 1`))[0];

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
async function scenario(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, s: Math.round((Date.now() - t0) / 1000) });
    console.log(`PASS ${name} (${Math.round((Date.now() - t0) / 1000)}s)`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e) });
    console.log(`FAIL ${name}: ${String(e?.message ?? e).slice(0, 500)}`);
  } finally {
    // a failed scenario never leaves a model failing for the next one
    for (const model of ["grader", "ds-flash", "embed", "decisions"]) await models("/__ok", { model });
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

await scenario("the linking model out of credit: the job waits without spending retries, then runs", async () => {
  await models("/__fail", { model: "ds-flash", status: 402 });
  await save("alice", "e2e-a3 hill pins", "HILL shipped the gage pins. [things: HILL/supplier]");
  const e = await entry("e2e-a3 hill pins");
  const waiting = await until("job put off", async () => {
    const j = await job(String(e.rid));
    return j?.error ? j : false;
  }, 60_000);
  check(waiting.status === "pending" && Number(waiting.attempts) === 0, `pending with no attempt spent: ${JSON.stringify(waiting)}`);
  const st = await api("/api/worker");
  check(st.dependencies?.["model:ds-flash"]?.ok === false, "the model route shown out");
  await models("/__ok", { model: "ds-flash" });
  await until("job done", async () => ((await job(String(e.rid)))?.status === "done" ? true : false));
  check(await thing("HILL"), "HILL linked");
});

await scenario("an entry's code is never a placeholder thing", async () => {
  await save("alice", "e2e-z04 inspect-2 new pins", "The old pin gauges on INSPECT-2 are retired. [things: e2e-z04/part, INSPECT-2/machine]");
  const e = await entry("e2e-z04 inspect-2 new pins");
  await until("linked", async () => ((await job(String(e.rid)))?.status === "done" ? true : false));
  check(await thing("INSPECT-2"), "INSPECT-2 made a thing");
  check(!(await thing("e2e-z04")), "no placeholder for the entry's code");
});

await scenario("the sweep embeds rows whose text the old inline SQL couldn't parse", async () => {
  await tool("admin", "execute_graph", { language: "sql", command: "INSERT INTO Entity SET name = 'e2e-raw \\\\ and \\' quote', _home = 'org', _origin = 'org'" });
  await until("backfilled", async () => {
    const r = (await sql("SELECT count(*) AS n FROM Entity WHERE name LIKE 'e2e-raw%' AND embed_identity IS NULL"))[0];
    return Number(r?.n) === 0 ? true : false;
  }, 90_000);
});

await scenario("with triage ahead, a new name becomes a thing only after triage: now for no work, else for a worker", async () => {
  await api("/api/worker", { method: "PUT", body: JSON.stringify({ pool: { poolSize: 2, master: true, batchSize: 50, batchMinutes: 60 } }) });
  await save("alice", "e2e-t1 diep starts", "Diep starts on CNC 2 Monday. [things: Diep/person]");
  await save("alice", "e2e-t2 john henry quote [L2]", "Ask John Henry Foster for a quote. [L2] [things: John Henry Foster/supplier]");
  const t1 = await entry("e2e-t1 diep starts");
  const t2 = await entry("e2e-t2 john henry quote [L2]");
  await until("plain one linked after triage", async () => ((await thing("Diep")) ? true : false), 120_000);
  const intake = await until("investigation queued for the master", async () => (await job(String(t2.rid), "intake")) ?? false, 120_000);
  check(String(intake.payload).includes("John Henry Foster"), `the new name goes to the master: ${intake.payload}`);
  check(!(await thing("John Henry Foster")), "no thing made before a worker decides");
  check(!(await job(String(t1.rid), "intake")), "the plain one needs no worker");
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
  check(!(await found("alice")), "alice, above bob but below the top, doesn't");
  // a worker's update never takes the writer over
  await tool(workerToken(String(e.rid)), "update_entry", { entry: String(e.rid), facets: { identity: "Diep starts at 21.50 an hour; review at 90 days. [admins]" } });
  const after = (await sql("SELECT _written_by FROM Entity WHERE name = 'e2e-w1 pay note'"))[0]?._written_by;
  check(after === "bob", `still written by bob, got ${after}`);
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

await scenario("a model with a limit gets no more threads than it serves; the rest wait without spending a try", async () => {
  const before = (await api("/api/worker")).pool;
  await api("/api/worker", { method: "PUT", body: JSON.stringify({ pool: { poolSize: 5 } }) });
  try {
    await save("alice", "e2e-l1 capacity note", "The capacity test note.");
    const rid = String((await entry("e2e-l1 capacity note")).rid);
    const now = new Date(Date.now() - 1000).toISOString();
    const ids = [];
    for (const level of [1, 1, 1, 2]) {
      const jid = randomUUID();
      ids.push(jid);
      const payload = JSON.stringify({ rid, level }).replace(/'/g, "\\'");
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
    await tool("admin", "execute_graph", { command: `UPDATE Job SET status = 'done' WHERE id IN [${ids.map((i) => `'${i}'`).join(",")}]`, language: "sql" });
  } finally {
    await api("/api/worker", { method: "PUT", body: JSON.stringify({ pool: before }) });
  }
});

await scenario("nothing in the background kept failing", async () => {
  const st = await api("/api/worker");
  const failing = Object.entries(st.loops ?? {}).filter(([, l]) => !l.ok);
  check(failing.length === 0, `failing loops: ${JSON.stringify(failing)}`);
  check(Object.values(st.dependencies ?? {}).every((d) => d.ok), `still out: ${JSON.stringify(st.dependencies)}`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
