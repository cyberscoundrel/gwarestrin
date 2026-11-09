// The Queries stream's acceptance scenarios (docs/ORGANIZATION-MODEL.md, "Queries"): state from
// claims, as_of, contradictions, a question answered from state, and scope over claims. Each is
// { name, run } for the harness loader (run.mjs's style: the same graph-rag, ArcadeDB and fake models
// on the harness network); nothing here runs on import.
//
// The Condenser stream writes claims through the ingest path; until it lands these scenarios make
// the shapes themselves, as raw SQL through the admin's execute_graph: a thing vertex per subject
// (as linker.js creates them), CLAIMS edges from plain entries (saved through upsert_entities, so
// grading homes them) to the thing, per model/schema.js.
//
// They need the integrator's wiring (src/tools-queries.js: registerQueryTools in server.js,
// registerQueryRoutes in routes.js) and `as_of: z.string().optional()` in search_graph's schema.
import { createHmac, randomUUID } from "node:crypto";

const GRAPH = process.env.GRAPH_URL ?? "http://graph-rag:8000";
const MODELS = process.env.MODELS_URL ?? "http://models:4000";
const TOKENS = { admin: "e2e-admin", alice: "e2e-alice", bob: "e2e-bob" };
const POS = { org: "org", ops: "ops", floor: "floor" };
const DAY = 86_400_000;

// a graph worker thread's token, as the admin's workspace signs it (graph-rag/src/delegation.js)
const delegated = (claims) => {
  const body = Buffer.from(JSON.stringify({ u: "admin", a: randomUUID(), iat: Math.floor(Date.now() / 1000), ...claims })).toString("base64url");
  return `gwa1.${body}.${createHmac("sha256", "e2e-delegation-key-0123456789abcdef").update(`gwa1.${body}`).digest("base64url")}`;
};
const workerToken = (entry, job = randomUUID()) => delegated({ r: "worker", j: job, e: entry });

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
const api = async (path, who = "admin", opts = {}) => (await fetch(`${GRAPH}${path}`, { ...opts, headers: { authorization: `Bearer ${TOKENS[who] ?? who}`, "content-type": "application/json" } })).json();
const models = (path, body) => fetch(`${MODELS}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const save = (who, name, text) => tool(who, "upsert_entities", { entities: [{ name, facets: { identity: text } }] });
const entry = async (name) => (await sql(`SELECT @rid AS rid, name, _home FROM Entity WHERE name = '${esc(name)}'`))[0];
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const iso = (ms) => new Date(ms).toISOString();
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
async function until(label, fn, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = `threw: ${e}`;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out: ${label} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
}

/**
 * The one confirmed class these scenarios need (jobs, recorded in mssql:dbo_Job), so a row number in
 * a question reads as a job's key. The types themselves (CLAIMS, CommitmentClass, Entity._class) are
 * model/schema.js statements(), which the server runs at boot.
 */
let schemaReady = false;
async function schema() {
  if (schemaReady) return;
  if (!(await sql("SELECT name FROM CommitmentClass WHERE name = 'jobs'")).length) {
    const r = await tool("admin", "execute_graph", { language: "sql", command: "CREATE VERTEX CommitmentClass SET name = 'jobs', record_table = 'mssql:dbo_Job', status = 'confirmed', stages = ['planned', 'running', 'paused', 'done']" });
    check(!r.error, `the jobs class: ${r.error}`);
  }
  schemaReady = true;
}

const list = (xs) => `[${xs.map((x) => `'${esc(x)}'`).join(",")}]`;

/**
 * A thing as linker.js creates one: seen from the homes of the statements about it. One an earlier
 * scenario (or the baseline run) made already is reused, with these homes and keys added.
 */
async function thing({ label, type, aliases = [], keys = [], cls = null, homes }) {
  const name = `${label} (${type})`;
  const have = (await sql(`SELECT @rid AS rid, _homes, _keys FROM Entity WHERE _kind = 'thing' AND name = '${esc(name)}'`))[0];
  if (have) {
    const r = await tool("admin", "execute_graph", {
      language: "sql",
      command: `UPDATE ${have.rid} SET _homes = ${list([...new Set([...(have._homes ?? []), ...homes])])}, _keys = ${list([...new Set([...(have._keys ?? []), ...keys])])}${cls ? `, _class = '${esc(cls)}'` : ""}`,
    });
    check(!r.error, `thing ${label} widened: ${r.error}`);
    return have;
  }
  const norm = label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // a key is an identity: a thing already carrying it (the Condenser mints one, named after the key, for a claim whose
  // subject is a key no thing holds) becomes this one, rather than a second thing answering the same key
  const keyed = keys.length ? (await sql(`SELECT @rid AS rid, _homes, _keys FROM Entity WHERE _kind = 'thing' AND _keys CONTAINSANY ${list(keys)}`))[0] : null;
  if (keyed) {
    const r = await tool("admin", "execute_graph", {
      language: "sql",
      command: `UPDATE ${keyed.rid} SET name = '${esc(name)}', label = '${esc(label)}', _thing_type = '${type}', _norm = '${esc(norm)}', _alias_norms = ${list(aliases)}, _homes = ${list([...new Set([...(keyed._homes ?? []), ...homes])])}, _keys = ${list([...new Set([...(keyed._keys ?? []), ...keys])])}${cls ? `, _class = '${esc(cls)}'` : ""}`,
    });
    check(!r.error, `thing ${label} takes over the thing keyed ${keys.join(", ")}: ${r.error}`);
    return keyed;
  }
  const r = await tool("admin", "execute_graph", {
    language: "sql",
    command: `CREATE VERTEX Entity SET name = '${esc(name)}', label = '${esc(label)}', _kind = 'thing', _thing_type = '${type}', _norm = '${esc(norm)}', _alias_norms = ${list(aliases)}, _keys = ${list(keys)}, _homes = ${list(homes)}, _home = 'org', _origin = 'org'${cls ? `, _class = '${esc(cls)}'` : ""}, updated_at = '${iso(Date.now())}'`,
  });
  check(!r.error, `thing ${label}: ${r.error}`);
  return (await sql(`SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND name = '${esc(name)}'`))[0];
}

/**
 * An entry homed where the scenario needs it. Grading places a note by what its writer read lately,
 * and an earlier scenario may have had the writer read above their position (the baseline's "a
 * writer still reads a note grading put above them" leaves bob's marks at the top for hours), so a
 * note meant for the floor is released there by the admin when it landed higher (a widening: queued,
 * then approved, as a person would).
 */
async function homed(name, positionName, positionId) {
  const e = await entry(name);
  check(e?.rid, `entry ${name} exists`);
  if (e._home === positionId) return e;
  const asked = await tool("admin", "set_home", { entities: [{ name }], to: positionName });
  const pid = asked.results?.[0]?.id ?? asked.results?.[0]?.pendingId;
  if (pid) {
    const ok = await api(`/api/queue/${pid}/approve`, "admin", { method: "POST", body: "{}" });
    check(ok.result?.approved, `release of ${name} approved: ${JSON.stringify(ok).slice(0, 200)}`);
  } else check(!asked.error, `move ${name}: ${JSON.stringify(asked).slice(0, 200)}`);
  const after = await entry(name);
  check(after?._home === positionId, `${name} at ${positionId}: ${after?._home}`);
  return after;
}

/** one claim: a CLAIMS edge from the entry (its section) to the thing */
async function claim(entryName, thingRid, c) {
  const e = await entry(entryName);
  check(e?.rid, `entry ${entryName} exists`);
  const props = { id: c.id ?? randomUUID(), kind: c.kind ?? "state", class: c.class ?? null, attribute: c.attribute, value: c.value, valid_from: c.valid_from, valid_until: c.valid_until ?? null, recorded_at: c.recorded_at ?? c.valid_from, recorded_by: c.recorded_by ?? "alice" };
  const sets = Object.entries(props)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k} = '${esc(String(v))}'`)
    .join(", ");
  const r = await tool("admin", "execute_graph", { language: "sql", command: `CREATE EDGE CLAIMS FROM ${e.rid} TO ${thingRid} SET ${sets}` });
  check(!r.error, `claim ${c.attribute} = ${c.value}: ${r.error}`);
  return props.id;
}

/** a condensed document through the real path (record_document), one section with these claims */
const record = async (who, title, position, text, claims) => {
  const r = await tool(who, "record_document", { document: { title, recorded_by: who, position, reason: "e2e", sections: [{ text, claims }] } });
  check(!r.error && !r.pendingId, `${title} recorded directly: ${JSON.stringify(r).slice(0, 300)}`);
  return r;
};

/** with the derived-data window off: what a person read in earlier scenarios would otherwise lift their write */
async function withWindowOff(fn) {
  const before = (await api("/api/policy")).policy ?? {};
  await api("/api/policy", "admin", { method: "PUT", body: JSON.stringify({ derivedWindowHours: 0 }) });
  try {
    return await fn();
  } finally {
    await api("/api/policy", "admin", { method: "PUT", body: JSON.stringify({ derivedWindowHours: before.derivedWindowHours ?? 12 }) });
  }
}

/** the state of one attribute across every thing the answer names (a name or key can mean more than one) */
const stateOf = (r, attr) => (r?.things ?? []).map((t) => t?.state?.[attr]).find(Boolean);

export const scenarios = [
  {
    name: "Kayla's assignment: two claims, the later closes the earlier; the state before and after the change date",
    run: async () => {
      await schema();
      const now = Date.now();
      const change = now + 30 * DAY;
      await save("alice", "e2e-q1 kayla temp", "Kayla's temp assignment runs until the change.");
      await save("alice", "e2e-q1 kayla permanent", "Kayla is permanent from the change date.");
      const k = await thing({ label: "Kayla", type: "person", homes: [POS.ops] });
      const first = await claim("e2e-q1 kayla temp", k.rid, { class: "employment", attribute: "assignment", value: "temporary", valid_from: iso(now - 30 * DAY) });
      const second = await claim("e2e-q1 kayla permanent", k.rid, { class: "employment", attribute: "assignment", value: "permanent", valid_from: iso(change), recorded_at: iso(now - DAY) });
      const cur = await tool("alice", "current_state", { subject: "Kayla" });
      check(stateOf(cur, "assignment")?.value === "temporary", `now, before the change: ${JSON.stringify(cur).slice(0, 400)}`);
      check(stateOf(cur, "assignment").valid_until === iso(change), `the earlier claim is closed where the later starts: ${JSON.stringify(stateOf(cur, "assignment"))}`);
      check(stateOf(cur, "assignment").closed_by === second, "and says by which claim");
      check(stateOf(cur, "assignment").section?.name === "e2e-q1 kayla temp", `the state names its section: ${JSON.stringify(stateOf(cur, "assignment").section)}`);
      const after = await tool("alice", "state_as_of", { subject: "Kayla", as_of: iso(change + 15 * DAY) });
      check(stateOf(after, "assignment")?.value === "permanent", `after the change: ${JSON.stringify(after).slice(0, 400)}`);
      const before = await tool("alice", "state_as_of", { subject: "Kayla", as_of: iso(now - 10 * DAY) });
      check(stateOf(before, "assignment")?.value === "temporary", `before the change: ${JSON.stringify(before).slice(0, 400)}`);
      check(stateOf(before, "assignment").id === first, "the earlier claim by id");
      const early = await tool("alice", "state_as_of", { subject: "Kayla", as_of: iso(now - 60 * DAY) });
      check(stateOf(early, "assignment") === undefined, `nothing known yet: ${JSON.stringify(early).slice(0, 300)}`);
      const h = await tool("alice", "state_history", { subject: "Kayla", attribute: "assignment" });
      check(h.things?.[0]?.history?.map((c) => c.value).join(",") === "temporary,permanent", `history oldest first: ${JSON.stringify(h).slice(0, 300)}`);
      // about_thing carries the same state beside the statements, and the HTTP route answers alike
      const about = await tool("alice", "about_thing", { name: "Kayla" });
      check(about.things?.[0]?.state?.assignment?.value === "temporary", `about_thing shows the state: ${JSON.stringify(about).slice(0, 400)}`);
      const http = await api(`/api/state/as-of?subject=Kayla&date=${encodeURIComponent(iso(change + DAY))}`, "alice");
      check(stateOf(http, "assignment")?.value === "permanent", `the route: ${JSON.stringify(http).slice(0, 300)}`);
      const bad = await api("/api/state/as-of?subject=Kayla&date=Friday", "alice");
      check(/as_of must be an ISO date/.test(bad.error ?? ""), `a date it can't read is refused: ${JSON.stringify(bad)}`);
    },
  },
  {
    name: "a question about job 4471's stage is answered from state, with no model call, and the need is met by the claim's section",
    run: async () => {
      await schema();
      await save("bob", "e2e-q2 job 4471 running", "Job 4471 is running on CNC 2.");
      await homed("e2e-q2 job 4471 running", "Production floor", POS.floor);
      const j = await thing({ label: "Job 4471", type: "order", aliases: ["4471"], keys: ["mssql:dbo_Job:4471"], cls: "jobs", homes: [POS.floor] });
      await claim("e2e-q2 job 4471 running", j.rid, { class: "jobs", attribute: "stage", value: "running", valid_from: iso(Date.now() - DAY), recorded_by: "bob" });
      // the claim vocabulary is cached for a few seconds
      await new Promise((r) => setTimeout(r, 5500));
      // an embedding of the question would wait on the fake model: a quick answer embedded nothing
      await models("/__slow", { model: "embed", match: "What stage is job 4471", ms: 8000 });
      try {
        const t0 = Date.now();
        const r = await tool("bob", "request_access", { question: "What stage is job 4471 at?" });
        const took = Date.now() - t0;
        check(r.answer?.value === "running", `answered from state: ${JSON.stringify(r).slice(0, 400)}`);
        check(r.answer.attribute === "stage" && r.answer.subject?.keys?.includes("mssql:dbo_Job:4471"), `the claim and its subject: ${JSON.stringify(r.answer)}`);
        check(r.status === "answered" && r.still_open === false, `the need is answered, not open: ${r.status}`);
        check((r.shared ?? []).includes("e2e-q2 job 4471 running"), `met by the claim's section: ${JSON.stringify(r.shared)}`);
        check(took < 4000, `no model call on the way (took ${took} ms; an embedding would have waited 8 s)`);
        const need = (await sql(`SELECT _status, _met_by FROM Entity WHERE _kind = 'need' AND _qid = '${r.id}'`))[0];
        check(need?._status === "met" && need._met_by, `marked met by the claim: ${JSON.stringify(need)}`);
        const open = await api("/api/state/needs", "bob");
        check(!(open.needs ?? []).some((n) => n.id === r.id), "not among the open needs");
      } finally {
        await models("/__slow", {});
      }
      // a question state can't answer runs the embedding path as before
      const other = await tool("bob", "request_access", { question: "Who keeps the forklift certification paperwork?" });
      check(other.status === "asked" && !other.answer, `the embedding path for the rest: ${JSON.stringify(other).slice(0, 300)}`);
      const listed = await api("/api/state/needs", "bob");
      const mine = (listed.needs ?? []).find((n) => n.id === other.id);
      check(mine && mine.kind === "commitment" && mine.class === "need" && mine.owed_to === "bob" && mine.value === "Who keeps the forklift certification paperwork?", `an open need listed as a commitment with the sign flipped: ${JSON.stringify(listed).slice(0, 400)}`);
    },
  },
  {
    name: "a conflict between two overlapping pay claims is listed with both claims and their sections",
    run: async () => {
      await schema();
      const t0 = iso(Date.now() - 20 * DAY);
      await save("alice", "e2e-q3 tomas pay a", "Tomas Reyes is paid 21.50 an hour. [admins]");
      await save("alice", "e2e-q3 tomas pay b", "Tomas Reyes is paid 22 an hour. [admins]");
      await save("alice", "e2e-q3 tomas pay c", "Tomas Reyes goes to 23 an hour next month. [admins]");
      check((await entry("e2e-q3 tomas pay a"))?._home === POS.org, "pay notes are graded to the top");
      const t = await thing({ label: "Tomas Reyes", type: "person", homes: [POS.org] });
      const raise = iso(Date.now() + 20 * DAY);
      const a = await claim("e2e-q3 tomas pay a", t.rid, { class: "employment", attribute: "pay_rate", value: "21.50 per hour", valid_from: t0 });
      const b = await claim("e2e-q3 tomas pay b", t.rid, { class: "employment", attribute: "pay_rate", value: "22 per hour", valid_from: t0, recorded_by: "bob" });
      await claim("e2e-q3 tomas pay c", t.rid, { class: "employment", attribute: "pay_rate", value: "23 per hour", valid_from: raise });
      const r = await tool("admin", "conflicts", { subject: "Tomas Reyes" });
      const list = r.things?.[0]?.conflicts ?? [];
      check(list.length === 1, `one contradiction (the later raise supersedes, it doesn't contradict): ${JSON.stringify(r).slice(0, 500)}`);
      check(list[0].attribute === "pay_rate", `on pay_rate: ${list[0].attribute}`);
      check(list[0].claims.map((c) => c.id).sort().join() === [a, b].sort().join(), `the two overlapping claims: ${JSON.stringify(list[0].claims.map((c) => c.id))}`);
      check(list[0].claims.map((c) => c.section?.name).sort().join() === "e2e-q3 tomas pay a,e2e-q3 tomas pay b", `with their sections: ${JSON.stringify(list[0].claims.map((c) => c.section))}`);
      check(list[0].claims.every((c) => c.valid_until === raise), `both closed by the raise, which contradicts neither: ${JSON.stringify(list[0].claims.map((c) => c.valid_until))}`);
      const http = await api("/api/state/conflicts?subject=Tomas%20Reyes", "admin");
      check((http.things?.[0]?.conflicts ?? []).length === 1, `the route lists it too: ${JSON.stringify(http).slice(0, 300)}`);
      const bob = await tool("bob", "conflicts", { subject: "Tomas Reyes" });
      check((bob.things ?? []).every((x) => (x.conflicts ?? []).length === 0), `the floor sees none of the pay claims, so no conflict: ${JSON.stringify(bob).slice(0, 300)}`);
    },
  },
  {
    name: "a worker whose scope excludes a claim never sees it in state; beyond: true does",
    run: async () => {
      await schema();
      await save("bob", "e2e-q4 diep shift", "Diep Q4 ran the late shift this week.");
      await save("admin", "e2e-q4 diep pay", "Diep Q4's rate goes to 21.50 an hour. [admins]");
      await homed("e2e-q4 diep shift", "Production floor", POS.floor);
      check((await entry("e2e-q4 diep pay"))?._home === POS.org, "the pay note is graded to the top");
      // a name and a key of the scenario's own: other streams write Dieps (the batch notes' NGUD, the admission scenarios' same-named
      // pair), so nothing here is looked up by a name another stream might also write
      const d = await thing({ label: "Diep Q4", type: "person", keys: ["mssql:dbo_Employee:E2EQ4"], homes: [POS.floor, POS.org] });
      await claim("e2e-q4 diep shift", d.rid, { class: "work assignment", attribute: "shift", value: "late", valid_from: iso(Date.now() - 2 * DAY), recorded_by: "bob" });
      await claim("e2e-q4 diep pay", d.rid, { class: "employment", attribute: "pay_rate", value: "21.50 per hour", valid_from: iso(Date.now() - 2 * DAY), recorded_by: "admin" });
      const e = await entry("e2e-q4 diep shift");
      const w = workerToken(String(e.rid));
      const mine = await tool(w, "current_state", { subject: "Diep Q4" });
      check(stateOf(mine, "shift")?.value === "late", `the floor's claim: ${JSON.stringify(mine).slice(0, 400)}`);
      check(stateOf(mine, "pay_rate") === undefined, `never the pay claim: ${JSON.stringify(mine).slice(0, 400)}`);
      const diep = (mine.things ?? []).find((t) => t.state?.shift);
      check(diep?.claims === 1, `one claim counted on Diep Q4: ${JSON.stringify((mine.things ?? []).map((t) => [t.name, t.claims]))}`);
      // a claim read bounds the worker's writes like any read: nothing beyond the floor was shown, so its one write to
      // the graph (resolve_subject: its judgement on a subject, minting a thing) isn't held, and is seen from the entry's home
      const resolve = (name, type) => tool(w, "resolve_subject", { name, thing: { name, type }, reason: "e2e" });
      const plain = await resolve("e2e-q4 late shift board", "place");
      check(plain.thing && !plain.error, `a scoped state read holds nothing: ${JSON.stringify(plain).slice(0, 300)}`);
      check(((await sql(`SELECT _homes FROM ${plain.thing}`))[0]?._homes ?? []).includes(POS.floor), "seen from the floor, where the entry lives");
      const all = await tool(w, "current_state", { subject: "mssql:dbo_Employee:E2EQ4", beyond: true });
      check(stateOf(all, "pay_rate")?.value === "21.50 per hour" && stateOf(all, "shift")?.value === "late", `beyond: both, by key too: ${JSON.stringify(all).slice(0, 400)}`);
      // having read the pay claim's section at the top, the worker's next judgement is held: nothing minted
      const held = await resolve("e2e-q4 pay ledger", "part");
      check(/Not written/.test(held.error ?? ""), `a read beyond the floor holds the write: ${JSON.stringify(held).slice(0, 300)}`);
      check(!(await sql("SELECT @rid FROM Entity WHERE _kind = 'thing' AND _norm = 'e2e-q4 pay ledger'")).length, "nothing minted while held");
      // the same for the person on the floor, and for alice above the floor but below the top; the admin sees both
      for (const who of ["bob", "alice"]) {
        const r = await tool(who, "current_state", { subject: "Diep Q4" });
        check(stateOf(r, "shift") && !stateOf(r, "pay_rate"), `${who} sees the shift and not the pay: ${JSON.stringify(r).slice(0, 300)}`);
      }
      const admin = await tool("admin", "current_state", { subject: "Diep Q4" });
      check(stateOf(admin, "pay_rate") && stateOf(admin, "shift"), "the admin sees both");
      // history and the HTTP route keep the same line
      const h = await tool("bob", "state_history", { subject: "Diep Q4", attribute: "pay_rate" });
      check((h.things ?? []).every((t) => (t.history ?? []).length === 0), `no pay history for the floor: ${JSON.stringify(h).slice(0, 300)}`);
      const http = await api("/api/state/current?subject=Diep%20Q4", "bob");
      check(stateOf(http, "shift") && !stateOf(http, "pay_rate"), `the route scopes alike: ${JSON.stringify(http).slice(0, 300)}`);
    },
  },
  {
    name: "search as_of keeps a claim-bearing hit only while one of its claims held, and leaves plain hits alone",
    run: async () => {
      await schema();
      const now = Date.now();
      await save("alice", "e2e-q5 corvane quoted", "The Corvane bracket order is quoted.");
      await save("alice", "e2e-q5 corvane ordered", "The Corvane bracket order came in.");
      await save("alice", "e2e-q5 corvane note", "Corvane asked about the bracket order's packaging.");
      const c = await thing({ label: "Corvane bracket order", type: "order", keys: ["mssql:dbo_Order:9001"], cls: "orders", homes: [POS.ops] });
      await claim("e2e-q5 corvane quoted", c.rid, { class: "orders", attribute: "stage", value: "quoted", valid_from: iso(now - 30 * DAY) });
      await claim("e2e-q5 corvane ordered", c.rid, { class: "orders", attribute: "stage", value: "ordered", valid_from: iso(now - 10 * DAY) });
      const names = (r) => (r.results ?? []).map((x) => x.name).filter((n) => n.startsWith("e2e-q5"));
      const plain = await tool("alice", "search_graph", { query: "Corvane bracket order", k: 8 });
      check(names(plain).length === 3, `without as_of every hit shows: ${names(plain)}`);
      const then = await tool("alice", "search_graph", { query: "Corvane bracket order", k: 8, as_of: iso(now - 20 * DAY) });
      check(names(then).includes("e2e-q5 corvane quoted") && !names(then).includes("e2e-q5 corvane ordered"), `20 days ago it was quoted: ${names(then)}`);
      check(names(then).includes("e2e-q5 corvane note"), `a hit bearing no claim passes: ${names(then)}`);
      const quoted = (then.results ?? []).find((x) => x.name === "e2e-q5 corvane quoted");
      check(quoted?.claims?.[0]?.value === "quoted" && quoted.claims[0].subject === "Corvane bracket order", `the hit says what held: ${JSON.stringify(quoted?.claims)}`);
      const today = await tool("alice", "search_graph", { query: "Corvane bracket order", k: 8, as_of: iso(now) });
      check(names(today).includes("e2e-q5 corvane ordered") && !names(today).includes("e2e-q5 corvane quoted"), `today it is ordered (the quote closed): ${names(today)}`);
    },
  },
  {
    name: "B7: a claim above the reader neither closes the reader's visible claim nor shows a change, in either arrival order",
    run: async () => {
      await schema();
      await withWindowOff(async () => {
        const now = Date.now();
        for (const [job, order] of [["88101", ["bob", "admin"]], ["88102", ["admin", "bob"]]]) {
          const subject = { key: `mssql:dbo_Job:${job}`, class: "jobs" };
          const write = {
            bob: () => record("bob", `e2e-b7 ${job} bob`, POS.floor, "Job machine is CNC 2.", [{ kind: "state", subject, attribute: "machine", value: "CNC 2", valid_from: iso(now - 2 * DAY) }]),
            admin: () => record("admin", `e2e-b7 ${job} admin`, POS.org, "Job machine is CNC 9 secret.", [{ kind: "state", subject, attribute: "machine", value: "CNC 9 secret", valid_from: iso(now - DAY) }]),
          };
          for (const who of order) await write[who]();
          await until(`both claims on job ${job} are stored`, async () => (await sql(`SELECT id FROM CLAIMS WHERE @in._keys CONTAINS 'mssql:dbo_Job:${job}'`)).length >= 2);
          const key = `mssql:dbo_Job:${job}`;
          const cur = await tool("bob", "current_state", { subject: key });
          const seen = stateOf(cur, "machine");
          check(seen?.value === "CNC 2", `order ${order}: bob reads his claim: ${JSON.stringify(cur).slice(0, 400)}`);
          check(seen.valid_until === null && seen.closed_by === undefined, `order ${order}: nothing he can see closed it: ${JSON.stringify(seen)}`);
          check((cur.things ?? [])[0]?.claims === 1, `order ${order}: one claim counted: ${JSON.stringify(cur).slice(0, 200)}`);
          const hist = await tool("bob", "state_history", { subject: key, attribute: "machine" });
          check(hist.things?.[0]?.history?.length === 1 && hist.things[0].history[0].valid_until === null, `order ${order}: his history has no change in it: ${JSON.stringify(hist).slice(0, 400)}`);
          const search = await tool("bob", "search_graph", { query: `e2e-b7 ${job} bob`, k: 4, as_of: iso(now) });
          check((search.results ?? []).some((r) => r.name.startsWith(`e2e-b7 ${job} bob`)), `order ${order}: search as_of still shows bob's section: ${(search.results ?? []).map((r) => r.name)}`);
          const admin = await tool("admin", "current_state", { subject: key });
          check(stateOf(admin, "machine")?.value === "CNC 9 secret", `order ${order}: the admin reads the latest: ${JSON.stringify(admin).slice(0, 400)}`);
          const adminHist = await tool("admin", "state_history", { subject: key, attribute: "machine" });
          check(adminHist.things?.[0]?.history?.[0]?.closed_by !== undefined, `order ${order}: the admin sees the succession: ${JSON.stringify(adminHist).slice(0, 400)}`);
        }
      });
    },
  },
  {
    name: "B6: a later policy change takes effect on claims already written, in current_state, history and search as_of",
    run: async () => {
      await schema();
      await withWindowOff(async () => {
        const subject = { key: "mssql:dbo_Job:88103", class: "jobs" };
        await record("bob", "e2e-b6 88103 rate", POS.floor, "The zz_rate is 21.50.", [{ kind: "state", subject, attribute: "zz_rate", value: 21.5, valid_from: iso(Date.now() - DAY) }]);
        await until("the claim is stored", async () => (await sql("SELECT id FROM CLAIMS WHERE attribute = 'zz_rate'")).length >= 1);
        const key = "mssql:dbo_Job:88103";
        check(stateOf(await tool("bob", "current_state", { subject: key }), "zz_rate")?.value === "21.5", "before the rule, bob reads it");
        const before = (await api("/api/policy")).policy;
        await api("/api/policy", "admin", { method: "PUT", body: JSON.stringify({ authorityMap: { classes: {}, attributes: { zz_rate: POS.org } } }) });
        try {
          const cur = await tool("bob", "current_state", { subject: key });
          check(stateOf(cur, "zz_rate") === undefined, `an admin moved zz_rate to the top: bob's state loses it: ${JSON.stringify(cur).slice(0, 400)}`);
          // its only statement moved up, so the subject is no longer seen from the floor at all (decision 5)
          check((cur.things ?? []).every((t) => t.claims === 0), `and doesn't count it: ${JSON.stringify(cur).slice(0, 300)}`);
          const hist = await tool("bob", "state_history", { subject: key, attribute: "zz_rate" });
          check((hist.things ?? []).every((t) => (t.history ?? []).length === 0), `nor in history: ${JSON.stringify(hist).slice(0, 300)}`);
          const search = await tool("bob", "search_graph", { query: "e2e-b6 88103 rate", k: 4, as_of: iso(Date.now()) });
          check((search.results ?? []).every((r) => !(r.claims ?? []).some((c) => c.attribute === "zz_rate")), `nor on a search hit: ${JSON.stringify(search.results?.map((r) => r.claims)).slice(0, 300)}`);
          check(stateOf(await tool("admin", "current_state", { subject: key }), "zz_rate")?.value === "21.5", "the top still reads it");
        } finally {
          await api("/api/policy", "admin", { method: "PUT", body: JSON.stringify({ authorityMap: before.authorityMap ?? { classes: {}, attributes: {} } }) });
        }
      });
    },
  },
  {
    name: "B10: mark_need_met can't close a need with a claim the asker can't see; a claim they can see closes it",
    run: async () => {
      await schema();
      await withWindowOff(async () => {
        const asked = await tool("bob", "request_access", { question: "Who keeps the e2e-b10 spare parts crib key?" });
        check(asked.status === "asked" && asked.id, `the need is open: ${JSON.stringify(asked).slice(0, 300)}`);
        const subject = { key: "mssql:dbo_Job:88104", class: "jobs" };
        const now = Date.now();
        await record("admin", "e2e-b10 88104 admin", POS.org, "The crib key is with admin.", [{ kind: "state", subject, attribute: "crib_key", value: "admin secret", valid_from: iso(now - DAY) }]);
        await record("bob", "e2e-b10 88104 bob", POS.floor, "The crib key is on the hook.", [{ kind: "state", subject, attribute: "crib_key", value: "on the hook", valid_from: iso(now - 2 * DAY) }]);
        const claims = await until("both claims are stored", async () => {
          const rows = await sql("SELECT id, value, @out AS src FROM CLAIMS WHERE attribute = 'crib_key'");
          return rows.length >= 2 ? rows : null;
        });
        const hidden = claims.find((c) => c.value === "admin secret");
        const visible = claims.find((c) => c.value === "on the hook");
        const refused = await tool(workerToken(String(hidden.src)), "mark_need_met", { need: asked.id, claim_id: hidden.id, reason: "e2e" });
        check(/can't see it/.test(refused.error ?? ""), `a claim the asker can't see is refused: ${JSON.stringify(refused).slice(0, 300)}`);
        check((await sql(`SELECT _status FROM Entity WHERE _kind = 'need' AND _qid = '${asked.id}'`))[0]?._status === "open", "the need stays open");
        const stillAsked = await api(`/api/requests/${asked.id}`, "bob").catch(() => null);
        if (stillAsked && !stillAsked.error) check(stillAsked.status === "asked" && (stillAsked.shared ?? []).length === 0, `bob learns nothing: ${JSON.stringify(stillAsked).slice(0, 300)}`);
        const met = await tool(workerToken(String(visible.src)), "mark_need_met", { need: asked.id, claim_id: visible.id, reason: "e2e" });
        check(met.met === true, `a claim bob sees closes it: ${JSON.stringify(met).slice(0, 300)}`);
        check((await sql(`SELECT _status FROM Entity WHERE _kind = 'need' AND _qid = '${asked.id}'`))[0]?._status === "met", "the need is met");
      });
    },
  },
  {
    name: "B11: an attribute word in a question doesn't auto-close it: wrong intent or another time reach an owner; the current value is answered",
    run: async () => {
      await schema();
      await withWindowOff(async () => {
        const job = { key: "mssql:dbo_Job:88106", class: "jobs" };
        const rack = { name: "rack Z1 e2e", class: "jobs" };
        await record("bob", "e2e-b11 job 88106", POS.floor, "Job 88106 machine is CNC 2.", [{ kind: "state", subject: job, attribute: "machine", value: "CNC 2", valid_from: iso(Date.now() - DAY) }]);
        await record("bob", "e2e-b11 rack", POS.floor, "Rack Z1 holds aluminum.", [{ kind: "state", subject: rack, attribute: "holds", value: "aluminum", valid_from: iso(Date.now() - DAY) }]);
        await until("the claims are stored", async () => (await sql("SELECT id FROM CLAIMS WHERE attribute IN ['holds', 'machine'] AND value IN ['aluminum', 'CNC 2']")).length >= 2);
        await new Promise((r) => setTimeout(r, 5500)); // the claim vocabulary is cached for a few seconds
        for (const question of ["Who holds the key to rack Z1 e2e?", "Which machine was job 88106 on three weeks ago?"]) {
          const r = await tool("bob", "request_access", { question });
          check(!r.answer, `not answered from state: ${JSON.stringify(r).slice(0, 300)}`);
          check(r.status === "asked" && r.still_open !== false, `the need stays open and reaches an owner: ${JSON.stringify(r).slice(0, 300)}`);
        }
        const yes = await tool("bob", "request_access", { question: "What machine is job 88106 on?" });
        check(yes.answer?.value === "CNC 2", `the current value is answered: ${JSON.stringify(yes).slice(0, 300)}`);
        check(yes.status === "answered", `and closed: ${yes.status}`);
      });
    },
  },
];

export default scenarios;
