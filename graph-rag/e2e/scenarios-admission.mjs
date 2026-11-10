// The Admission and resolution stream's acceptance scenarios (docs/ORGANIZATION-MODEL.md, "Node admission"
// and "Reference, never copy"), in the style of run.mjs: each replays a failure the live batches found
// against a real ArcadeDB and graph-rag with the fake models (fake-models.mjs), inside the harness network
// (e2e.sh). Exported as [{ name, run }] for the Test harness stream's loader; `run(ctx)` takes the loader's
// helpers (tool, sql, api, save, entry, thing, job, until, check, workerToken) and fills in any it lacks
// from the same definitions run.mjs uses, so the file also runs on its own:
//
//   node /e2e/scenarios-admission.mjs        (GRAPH_URL, MODELS_URL as in run.mjs)
//
// The fake linker names things from a "[things: Name/type, ...]" tag and never gives a key, which is the
// point: the linker on its own now mints nothing from a name. Keys arrive through a worker's
// resolve_subject (the Reconciliation stream's one tool for it: the worker's judgement, with the key it
// looked up, resolved through resolve.js and minted by linkMentions) or written in the text, and only keys
// mint instances.
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import { dabTool } from "./fake-dab-core.mjs";

const GRAPH = process.env.GRAPH_URL ?? "http://graph-rag:8000";
const TOKENS = { admin: "e2e-admin", alice: "e2e-alice", bob: "e2e-bob" };

/** the helpers run.mjs defines, for a loader that passes none (or only some) */
function harness(ctx = {}) {
  const h = { ...ctx };
  let id = 1;
  const delegated = (claims) => {
    const body = Buffer.from(JSON.stringify({ u: "admin", a: randomUUID(), iat: Math.floor(Date.now() / 1000), ...claims })).toString("base64url");
    return `gwa1.${body}.${createHmac("sha256", "e2e-delegation-key-0123456789abcdef").update(`gwa1.${body}`).digest("base64url")}`;
  };
  h.workerToken ??= (entry, job = randomUUID()) => delegated({ r: "worker", j: job, e: entry });
  h.tool ??= async (who, name, args) => {
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
  };
  h.sql ??= async (query) => (await h.tool("admin", "query_graph", { query, language: "sql" })).rows ?? [];
  h.api ??= async (path, opts = {}) => (await fetch(`${GRAPH}${path}`, { ...opts, headers: { authorization: `Bearer ${TOKENS.admin}`, "content-type": "application/json" } })).json();
  h.entry ??= async (name) => (await h.sql(`SELECT @rid AS rid, name, _home, _grade, _ungraded, _mentions_at FROM Entity WHERE name = '${name}'`))[0];
  h.thing ??= async (label) => (await h.sql(`SELECT @rid AS rid, name, label, _keys, _class, _thing_type FROM Entity WHERE _kind = 'thing' AND label = '${label}'`))[0];
  h.job ??= async (rid, kind = "mentions") => (await h.sql(`SELECT status, attempts, error, payload FROM Job WHERE kind = '${kind}' AND payload LIKE '%${rid}%' ORDER BY created_at DESC LIMIT 1`))[0];
  h.until ??= async (label, fn, timeoutMs = 240_000) => {
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
  };
  h.check ??= (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  h.save ??= (who, name, text) => h.tool(who, "upsert_entities", { entities: [{ name, facets: { identity: text } }] });
  return h;
}

/** the things a label names (several when two share it), with their keys */
const things = (h, label) => h.sql(`SELECT @rid AS rid, label, _keys, _class, _thing_type FROM Entity WHERE _kind = 'thing' AND label = '${label}'`);
/** the things an entry is ABOUT */
const about = async (h, rid) => (await h.sql(`SELECT @in AS dst, role FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`)).map((e) => ({ dst: String(e.dst), role: e.role }));
/** the SourceRef rows for a key */
const sourceRefs = (h, key) => h.sql(`SELECT @rid AS rid, key, system, \`table\`, row_key, last_seen, seen_by FROM SourceRef WHERE key = '${key}'`);
/** the SourceRefs an instance refers to */
const refersTo = async (h, rid) => (await h.sql(`SELECT key FROM (SELECT expand(out('REFERS_TO')) FROM ${rid})`)).map((r) => r.key);
/** what the linker left unresolved on an entry (the loader's `entry` helper doesn't carry it) */
const unresolvedOn = async (h, name) => JSON.parse((await h.sql(`SELECT _unresolved FROM Entity WHERE name = '${name}'`))[0]?._unresolved ?? "[]");
/** the entry's mentions job has run */
const linkedUp = (h, e) => h.until(`linked: ${e.name}`, async () => ((await h.job(String(e.rid)))?.status === "done" ? true : false));
/** the linker runs on its own here: no master pool, no sorting step (a scenario in run.mjs turns the master on; this stream's cases are about the one-call linker) */
const plainLinker = (h) => h.api("/api/worker", { method: "PUT", body: JSON.stringify({ pool: { poolSize: 0, master: false, sortFirst: false } }) });
/**
 * A worker's explicit judgement with the key it looked up: the one way a name becomes an instance here.
 * One resolve_subject call per thing; returns { thing: rid, minted, key, label, type } or { error }.
 */
const workerResolves = (h, e, { name, type, key }) => h.tool(h.workerToken(String(e.rid)), "resolve_subject", { name, thing: { name, type, ...(key ? { key } : {}) }, reason: "e2e: looked the row up" });

/** the rows a source holds for this file's scenarios: a worker's key must be a row, on a mint too (B17, B19) */
const ROWS = {
  dbo_Employee: { primaryKey: ["Employee"], rows: ["NGUD", "NGDT", "NGZ1", "NGZ2"].map((Employee) => ({ Employee })) },
  dbo_Job: { primaryKey: ["Job"], rows: ["3260356", "3260357", "3260359", "7700001"].map((Job) => ({ Job })) },
  dbo_Customer: { primaryKey: ["Customer"], rows: ["ACMEZ", "EXATRONZ", "GRIDLEY", "TOROZ", "WRENZ"].map((Customer) => ({ Customer })) },
  dbo_Order: { primaryKey: ["Order"], rows: ["5500001", "5500002"].map((Order) => ({ Order })) },
};
let rowSource = null;
/**
 * A read-only fake DAB in this process, pointed at by the organization's stored `sources`. One for the file; its last
 * scenario takes it down.
 */
export async function startRowSource(h, extra = {}) {
  Object.assign(ROWS, extra);
  if (rowSource) return rowSource;
  const server = createServer(async (req, res) => {
    let s = "";
    for await (const c of req) s += c;
    const body = s ? JSON.parse(s) : {};
    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fake-rows" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    };
    if (body.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-rows" } });
    if (body.method !== "tools/call") return reply({});
    reply(dabTool(ROWS, body.params?.name, body.params?.arguments ?? {}, { write: false }));
  });
  await new Promise((r) => server.listen(4291, "0.0.0.0", r));
  server.unref();
  const address = Object.values(networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal)?.address ?? hostname();
  const before = (await h.sql("SELECT json FROM OrgPolicy WHERE scope = 'sources'"))[0]?.json ?? null;
  const set = (command) => h.tool("admin", "execute_graph", { language: "sql", command });
  const json = JSON.stringify({ mssql: { read: `http://${address}:4291/read/mcp` } }).replace(/'/g, "\\'");
  const r = await set(before === null ? `INSERT INTO OrgPolicy SET scope = 'sources', json = '${json}'` : `UPDATE OrgPolicy SET json = '${json}' WHERE scope = 'sources'`);
  h.check(!r.error, `sources stored: ${JSON.stringify(r).slice(0, 200)}`);
  rowSource = {
    stop: async () => {
      server.close();
      rowSource = null;
      await set(before === null ? "DELETE FROM OrgPolicy WHERE scope = 'sources'" : `UPDATE OrgPolicy SET json = '${before.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' WHERE scope = 'sources'`);
    },
  };
  return rowSource;
}

/** a thing as the graph would hold it: the seed a scenario needs, written directly so the scenario controls its homes and keys */
const seedThing = async (h, label, { homes, aliases = [], keys = [], type = null, cls = null }) => {
  const norm = label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const r = await h.tool("admin", "execute_graph", {
    language: "sql",
    command: `CREATE VERTEX Entity SET name = '${label} (seed)', label = '${label}', _kind = 'thing', _norm = '${norm}', _alias_norms = ${JSON.stringify(aliases)}, _keys = ${JSON.stringify(keys)}, _homes = ${JSON.stringify(homes)}, _home = 'org', _thing_type = ${type ? `'${type}'` : "null"}, _class = ${cls ? `'${cls}'` : "null"}`,
  });
  h.check(!r.error, `seed ${label}: ${JSON.stringify(r).slice(0, 200)}`);
  return String((await h.thing(label)).rid);
};
/** a confirmed class, the way the discovery route leaves one */
const seedClass = async (h, name, record_table = null) => {
  await h.tool("admin", "execute_graph", { language: "sql", command: "CREATE VERTEX TYPE CommitmentClass IF NOT EXISTS" });
  await h.tool("admin", "execute_graph", { language: "sql", command: "CREATE PROPERTY CommitmentClass.name IF NOT EXISTS STRING" });
  if ((await h.sql(`SELECT name FROM CommitmentClass WHERE name = '${name}'`)).length) return;
  await h.tool("admin", "execute_graph", { language: "sql", command: `INSERT INTO CommitmentClass SET name = '${name}', description = 'e2e', stages = [], record_table = ${record_table ? `'${record_table}'` : "null"}, status = 'confirmed', confirmed_by = 'admin'` });
};
/** a person's record of one section of claims, as the agent sends it, once it has landed */
const record = async (h, who, title, position, claims) => {
  const r = await h.tool(who, "record_document", { document: { title, reason: "e2e", position, sections: [{ text: `${title}: for the record.`, claims }] } });
  h.check(!r.error, `recorded ${title}: ${JSON.stringify(r).slice(0, 300)}`);
  await h.until(`landed: ${title}`, async () => (await h.sql(`SELECT _doc_status FROM Entity WHERE _kind = 'document' AND name = '${title}'`))[0]?._doc_status === "ready");
};
/** a section's claims with where each points: `unresolved` when back at the section (`subject` is what was written) */
const claimsOf = async (h, title) => {
  const section = (await h.sql(`SELECT @rid AS rid FROM Entity WHERE _kind = 'section' AND _doc_title = '${title}'`))[0];
  const rows = await h.sql(`SELECT @in AS dst, @out AS src, class, attribute, value, subject FROM (SELECT expand(outE('CLAIMS')) FROM ${section.rid})`);
  return rows.map((c) => ({ ...c, dst: String(c.dst), unresolved: String(c.dst) === String(c.src), subject: c.subject ? JSON.parse(c.subject) : null }));
};
/** a scenario that confirms test classes takes them back, so a later stream's count of confirmed classes holds */
const retiring = (run) => async (ctx) => {
  const h = harness(ctx);
  try {
    await run(ctx);
  } finally {
    await h.tool("admin", "execute_graph", { language: "sql", command: "UPDATE CommitmentClass SET status = 'retired' WHERE name LIKE 'e2e-adm-%'" });
  }
};
/** no derived floor while this runs: earlier scenarios' reads would otherwise lift a floor writer's note above the floor (scenarios-authority.mjs does the same) */
const noDerivedFloor = (run) => async (ctx) => {
  const h = harness(ctx);
  const before = (await h.api("/api/policy")).policy ?? {};
  const authorityMap = before.authorityMap ?? { classes: {}, attributes: {} };
  await h.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap, derivedWindowHours: 0 }) });
  try {
    await run(ctx);
  } finally {
    await h.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap, derivedWindowHours: before.derivedWindowHours ?? 12 }) });
  }
};
/** what the linker's model was offered for the last statements (the fake keeps the system prompts) */
const prompts = async (h) => (await (await fetch(`${process.env.MODELS_URL ?? "http://models:4000"}/__prompts`, { method: "POST" })).json()).prompts ?? [];

const SCENARIOS = [
  {
    name: "the same-named Diep: the linker links neither on a bare name, and the key decides",
    async run(ctx) {
      const h = harness(ctx);
      await plainLinker(h);
      await startRowSource(h);
      // two employees called Diep, each from its ERP row: a worker that looked them up links them by key
      // (bob's, at the floor: the candidates below are read from the floor, and a name reaches only what its reader can see)
      await h.save("bob", "e2e-adm1 diep roster", "Two people on the roster are called Diep.");
      const roster = await h.entry("e2e-adm1 diep roster");
      const made = [];
      for (const key of ["mssql:dbo_Employee:NGUD", "mssql:dbo_Employee:NGDT"]) made.push(await workerResolves(h, roster, { name: "Diep", type: "person", key }));
      h.check(made.every((m) => m.minted === true && m.thing && !m.error), `two instances minted by key: ${JSON.stringify(made).slice(0, 400)}`);
      h.check(made[0].thing !== made[1].thing, "two different instances");
      // (a built-in scenario may have left a keyless "Diep" from the old triage path: the keyed two are what this one is about)
      const dieps = await things(h, "Diep");
      const active = dieps.find((d) => (d._keys ?? []).includes("mssql:dbo_Employee:NGUD"));
      const inactive = dieps.find((d) => (d._keys ?? []).includes("mssql:dbo_Employee:NGDT"));
      h.check(active && inactive && active.rid !== inactive.rid, `one thing per key: ${JSON.stringify(dieps)}`);
      h.check((await sourceRefs(h, "mssql:dbo_Employee:NGUD")).length === 1 && (await sourceRefs(h, "mssql:dbo_Employee:NGDT")).length === 1, "each row has one SourceRef");
      h.check((await refersTo(h, String(active.rid))).includes("mssql:dbo_Employee:NGUD"), "the instance refers to its row");
      // the floor's note names Diep with no key: the linker on its own links neither and mints no third
      await h.save("bob", "e2e-adm2 diep on cnc 5", "Diep is running CNC 5 this afternoon. [things: Diep/person]");
      const note = await h.entry("e2e-adm2 diep on cnc 5");
      await linkedUp(h, note);
      const links = await about(h, String(note.rid));
      h.check(!links.some((l) => [String(active.rid), String(inactive.rid)].includes(l.dst)), `neither Diep linked on a bare name: ${JSON.stringify(links)}`);
      h.check((await things(h, "Diep")).length === dieps.length, "no further Diep minted");
      const unresolved = await unresolvedOn(h, "e2e-adm2 diep on cnc 5");
      const diep = unresolved.find((u) => u.name === "Diep");
      h.check(diep && [String(active.rid), String(inactive.rid)].every((c) => (diep.candidates ?? []).includes(c)), `the mention comes back unresolved with both keyed Dieps among its candidates: ${JSON.stringify(unresolved)}`);
      // the worker that checked the roster links with the key: the active employee, nothing new
      const settled = await workerResolves(h, note, { name: "Diep", type: "person", key: "mssql:dbo_Employee:NGUD" });
      h.check(settled.minted === false && settled.thing === String(active.rid) && settled.key === "mssql:dbo_Employee:NGUD", `resolved by key to the active Diep, nothing created: ${JSON.stringify(settled).slice(0, 300)}`);
      const now = await about(h, String(note.rid));
      h.check(now.some((l) => l.dst === String(active.rid)) && !now.some((l) => l.dst === String(inactive.rid)), `about the active Diep only: ${JSON.stringify(now)}`);
      h.check((await things(h, "Diep")).length === dieps.length, "still nothing new");
    },
  },
  {
    name: "the holiday-schedule note mints nothing: a schedule and a time clock are content inside the claim",
    async run(ctx) {
      const h = harness(ctx);
      await plainLinker(h);
      const before = Number((await h.sql("SELECT count(*) AS n FROM Entity WHERE _kind = 'thing'"))[0]?.n ?? 0);
      await h.save("alice", "e2e-adm3 holiday schedule posted", "The holiday schedule is posted next to the time clock. [things: holiday schedule/other, time clock/machine]");
      const e = await h.entry("e2e-adm3 holiday schedule posted");
      await linkedUp(h, e);
      h.check(!(await h.thing("holiday schedule")), "no thing for the schedule");
      h.check(!(await h.thing("time clock")), "no thing for the time clock");
      h.check((await about(h, String(e.rid))).length === 0, "the note is linked to nothing");
      const after = Number((await h.sql("SELECT count(*) AS n FROM Entity WHERE _kind = 'thing'"))[0]?.n ?? 0);
      h.check(after === before, `no thing minted at all (${before} -> ${after})`);
      const unresolved = (await unresolvedOn(h, "e2e-adm3 holiday schedule posted")).map((u) => u.name);
      h.check(unresolved.includes("holiday schedule") && unresolved.includes("time clock"), `both names come back unresolved for a worker or a person: ${JSON.stringify(unresolved)}`);
      h.check((await h.entry("e2e-adm3 holiday schedule posted"))._mentions_at, "the linking step is recorded as run");
      // no "other" type anywhere: the fake's type was dropped, not stored
      const others = await h.sql("SELECT count(*) AS n FROM Entity WHERE _kind = 'thing' AND _thing_type = 'other'");
      h.check(Number(others[0]?.n ?? 0) === 0, "nothing is typed other");
    },
  },
  {
    name: "PO 78912 is never a node: its notes link their jobs by key, the number stays in a claim, and a model that makes it a key mints nothing",
    run: retiring(async (ctx) => {
      const h = harness(ctx);
      await plainLinker(h);
      // a confirmed class recording to a table, so the model's prompt offers the key's shape, and the class the record path's PO claim names
      await seedClass(h, "orders", "mssql:dbo_Order");
      await seedClass(h, "e2e-adm-job-note");
      await new Promise((r) => setTimeout(r, 6000)); // the linker rereads confirmed classes within a few seconds when it had none
      // the two notes behind the cluster (ux-note 13 and 14); neither says "PO 78912": the ERP row says it, on the job
      await h.save("alice", "e2e-adm4 job 3260356 slips", "Alexander said the inspect- is backed up again, so job 3260356 for Exatron (EPP-D98-1-A) probably slips to next week.");
      await h.save("bob", "e2e-adm5 exatron wants it earlier", "Called Exatron about EPP-D98-2-B - they want the next batch earlier. Darrin S. is checking material.");
      const n13 = await h.entry("e2e-adm4 job 3260356 slips");
      const n14 = await h.entry("e2e-adm5 exatron wants it earlier");
      await linkedUp(h, n13);
      await linkedUp(h, n14);
      await startRowSource(h);
      // a worker that looked the jobs up links each by its own row's key: the job is the instance
      const j13 = await workerResolves(h, n13, { name: "3260356", type: "order", key: "mssql:dbo_Job:3260356" });
      const j14 = await workerResolves(h, n14, { name: "3260357", type: "order", key: "mssql:dbo_Job:3260357" });
      h.check(j13.minted === true && j14.minted === true && j13.thing !== j14.thing, `one instance per job row: ${JSON.stringify([j13, j14]).slice(0, 400)}`);
      const refs = await sourceRefs(h, "mssql:dbo_Job:3260356");
      h.check(refs.length === 1 && refs[0].system === "mssql" && refs[0].table === "dbo_Job" && refs[0].row_key === "3260356" && refs[0].last_seen, `one SourceRef, the key's parts and when it was seen, nothing of the row: ${JSON.stringify(refs)}`);
      h.check(!Object.keys(refs[0]).some((k) => /customer|amount|status|due/i.test(k)), "no row columns");
      for (const [note, job] of [[n13, j13], [n14, j14]]) h.check((await about(h, String(note.rid))).some((l) => l.dst === job.thing), `${note.name} is about its job`);
      // the PO is an attribute of the job: one claim on the job's key, its number a value there
      await record(h, "alice", "e2e-adm6 po on the job", "ops", [{ kind: "state", subject: { key: "mssql:dbo_Job:3260356", class: "e2e-adm-job-note" }, class: "e2e-adm-job-note", attribute: "customer_po", value: "78912" }]);
      const [poClaim] = await claimsOf(h, "e2e-adm6 po on the job");
      h.check(poClaim.dst === j13.thing && poClaim.value === "78912", `the number is a value on the job: ${JSON.stringify(poClaim)}`);
      // a model that makes the number a key (the prompt lists orders' record table; nothing checked the row) mints nothing and finds nothing
      await h.save("alice", "e2e-adm6a po 78912 prose", "Customer PO 78912 covers both EPP-D98 jobs. [things: PO 78912/order/key=mssql|dbo_Order|78912/class=orders, PO 78912 for Exatron/order, order 78912/order, Exatron PO 78912/order]");
      const n = await h.entry("e2e-adm6a po 78912 prose");
      await linkedUp(h, n);
      const pos = await h.sql("SELECT label, _keys FROM Entity WHERE _kind = 'thing' AND (_norm LIKE '%78912%' OR _alias_norms CONTAINS 'order 78912' OR _keys CONTAINS 'mssql:dbo_Order:78912')");
      h.check(pos.length === 0, `the PO is no node, keyed or not: ${JSON.stringify(pos)}`);
      h.check((await sourceRefs(h, "mssql:dbo_Order:78912")).length === 0, "and no SourceRef for a row nothing checked");
      const left = await unresolvedOn(h, "e2e-adm6a po 78912 prose");
      h.check(left.some((u) => u.name === "PO 78912" && u.key === "mssql:dbo_Order:78912"), `the name goes back with the model's key as a hint, for a worker or a person: ${JSON.stringify(left)}`);
      // a key the statement itself writes is an identity all the same
      await h.save("alice", "e2e-adm7 a job by key", "Job mssql:dbo_Job:3260359 ships next week.");
      const k = await h.entry("e2e-adm7 a job by key");
      await linkedUp(h, k);
      const keyed = await h.sql("SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND _keys CONTAINS 'mssql:dbo_Job:3260359'");
      h.check(keyed.length === 1 && (await about(h, String(k.rid))).some((l) => l.dst === String(keyed[0].rid)), `a key in the text mints and links its instance: ${JSON.stringify(keyed)}`);
      h.check((await sourceRefs(h, "mssql:dbo_Job:3260359")).length === 1, "with its SourceRef");
    }),
  },
  {
    name: "a floor note can't pull an org-only thing down: its name isn't offered, it isn't linked, and the floor still can't see it",
    run: noDerivedFloor(async (ctx) => {
      const h = harness(ctx);
      await plainLinker(h);
      const bluebird = await seedThing(h, "Project Bluebird", { homes: ["org"], aliases: ["bluebird"], keys: ["mssql:dbo_Project:BB"], type: "project" });
      await h.save("bob", "e2e-adm8 decal peeling", "The bluebird decal on the saw guard is peeling. [things: bluebird/project]");
      const note = await h.entry("e2e-adm8 decal peeling");
      h.check(note._home === "floor", `the note is homed at the floor, or this tests nothing: ${note._home}`);
      await linkedUp(h, note);
      const offered = await prompts(h);
      const listed = offered.filter((p) => p.includes("Project Bluebird")).map((p) => p.split("\n").filter((l) => l.includes("Bluebird")).join(" | "));
      h.check(offered.length && !listed.length, `the model is not offered a name its reader can't see (note at ${note._home}): ${JSON.stringify(listed)}`);
      h.check(!(await about(h, String(note.rid))).some((l) => l.dst === bluebird), "not linked");
      h.check(JSON.stringify((await h.sql(`SELECT _homes FROM ${bluebird}`))[0]._homes) === '["org"]', "its homes are unchanged");
      const seen = await h.tool("bob", "about_thing", { name: "bluebird" });
      h.check(!(seen.things ?? []).length && !JSON.stringify(seen).includes("Project Bluebird"), `the floor still sees nothing: ${JSON.stringify(seen).slice(0, 300)}`);
      const left = await unresolvedOn(h, "e2e-adm8 decal peeling");
      const name = left.find((u) => u.name === "bluebird");
      h.check(name && !name.candidates?.length, `it stays unresolved, with no candidate its reader can't see: ${JSON.stringify(left)}`);
      // the worker on that note is the floor's worker: asked for the name it gets nothing back, not the label
      const tried = await h.tool(h.workerToken(String(note.rid)), "resolve_subject", { name: "bluebird", reason: "e2e" });
      h.check(!JSON.stringify(tried).includes("Project Bluebird"), `the worker's answer holds no hidden name: ${JSON.stringify(tried).slice(0, 300)}`);
      h.check(JSON.stringify((await h.sql(`SELECT _homes FROM ${bluebird}`))[0]._homes) === '["org"]', "and its homes are still unchanged");
      // from where it can be seen, the name resolves as it always did
      await h.save("admin", "e2e-adm9 bluebird budget", "The bluebird budget is closed. [things: bluebird/project]");
      const top = await h.entry("e2e-adm9 bluebird budget");
      await linkedUp(h, top);
      h.check((await about(h, String(top.rid))).some((l) => l.dst === bluebird), "a note at the root links it");
    }),
  },
  {
    name: "the record path: a key miss never lands on a same-named row, an ambiguous name mints nothing, the same name under two classes is two subjects, and what is content stays in the claim",
    run: retiring(async (ctx) => {
      const h = harness(ctx);
      for (const c of ["e2e-adm-staff", "e2e-adm-quote", "e2e-adm-sample", "e2e-adm-notice", "e2e-adm-payroll", "e2e-adm-rack", "e2e-adm-need"]) await seedClass(h, c);
      // only Zara NGZ1 exists; a claim about NGZ2 by key does not find her by name and hand her a second employee's key
      const z1 = await seedThing(h, "Zara", { homes: ["floor"], keys: ["mssql:dbo_Employee:NGZ1"], type: "person" });
      await record(h, "bob", "e2e-adm10 zara ngz2", "floor", [{ kind: "state", subject: { key: "mssql:dbo_Employee:NGZ2", name: "Zara", actor: "person" }, class: "e2e-adm-staff", attribute: "station", value: "CNC 5" }]);
      const [c1] = await claimsOf(h, "e2e-adm10 zara ngz2");
      h.check(c1.dst !== z1 && !c1.unresolved, `the claim is on a new instance for NGZ2: ${JSON.stringify(c1)}`);
      const keys1 = (await h.sql(`SELECT _keys FROM ${z1}`))[0]._keys;
      h.check(JSON.stringify(keys1) === '["mssql:dbo_Employee:NGZ1"]', `NGZ1's thing keeps only its own key: ${JSON.stringify(keys1)}`);
      // two Zaras now: each document naming only "Zara" stays unresolved, and neither mints a third
      const zaras = (await things(h, "Zara")).length;
      await record(h, "bob", "e2e-adm11 zara one", "floor", [{ kind: "state", subject: { name: "Zara", actor: "person" }, class: "e2e-adm-staff", attribute: "station", value: "CNC 7" }]);
      await record(h, "bob", "e2e-adm12 zara two", "floor", [{ kind: "state", subject: { name: "Zara", actor: "person" }, class: "e2e-adm-staff", attribute: "shift", value: "second" }]);
      for (const title of ["e2e-adm11 zara one", "e2e-adm12 zara two"]) {
        const [c] = await claimsOf(h, title);
        h.check(c.unresolved && c.subject?.name === "Zara", `${title}: unresolved, the subject as written: ${JSON.stringify(c)}`);
      }
      h.check((await things(h, "Zara")).length === zaras, `no third Zara: ${zaras} -> ${(await things(h, "Zara")).length}`);
      // ux-w14: two claims on one class subject under two classes are two things, not the first class's
      await record(h, "alice", "e2e-adm13 quotes stall", "ops", [
        { kind: "observation", subject: { scope: "class", name: "adm quotes", class: "e2e-adm-quote" }, class: "e2e-adm-quote", attribute: "cycle_time", value: "stalling" },
        { kind: "commitment", subject: { scope: "class", name: "adm quotes", class: "e2e-adm-need" }, class: "e2e-adm-need", attribute: "question", value: "one person, the process, or the tooling?" },
      ]);
      const w14 = await claimsOf(h, "e2e-adm13 quotes stall");
      h.check(w14.length === 2 && new Set(w14.map((c) => c.dst)).size === 2 && !w14.some((c) => c.unresolved), `a thing per class: ${JSON.stringify(w14)}`);
      // Q-77 under two classes: two subjects, two things (each a commitment no source records)
      await record(h, "alice", "e2e-adm14 q77", "ops", [
        { kind: "commitment", subject: { name: "Q-77", class: "e2e-adm-quote" }, class: "e2e-adm-quote", attribute: "offered", value: "yes" },
        { kind: "commitment", subject: { name: "Q-77", class: "e2e-adm-sample" }, class: "e2e-adm-sample", attribute: "shipped", value: "yes" },
      ]);
      const q = await claimsOf(h, "e2e-adm14 q77");
      h.check(q.length === 2 && new Set(q.map((c) => c.dst)).size === 2 && !q.some((c) => c.unresolved), `one thing per class: ${JSON.stringify(q)}`);
      const q77 = await h.sql("SELECT label, _thing_type, _class FROM Entity WHERE _kind = 'thing' AND _norm = 'q 77' AND _class IN ['e2e-adm-quote', 'e2e-adm-sample']");
      h.check(q77.length === 2 && q77.every((t) => t._thing_type !== "other"), `no "other": ${JSON.stringify(q77)}`);
      // ORACLE.md: things inside claims, never nodes. Content stays on the claim, with its subject as written
      await record(h, "alice", "e2e-adm15 notices", "ops", [
        { kind: "event", subject: { name: "holiday schedule", class: "e2e-adm-notice" }, class: "e2e-adm-notice", attribute: "posted_at", value: "next to the time clock" },
        { kind: "state", subject: { name: "payroll", class: "e2e-adm-payroll" }, class: "e2e-adm-payroll", attribute: "frequency", value: "biweekly" },
      ]);
      h.check(!(await h.thing("holiday schedule")) && !(await h.thing("payroll")), "no node for the schedule or for payroll");
      const notices = await claimsOf(h, "e2e-adm15 notices");
      h.check(notices.length === 2 && notices.every((c) => c.unresolved && c.value), `both claims kept, on the section: ${JSON.stringify(notices)}`);
      h.check(new Set(notices.map((c) => c.subject?.name)).has("holiday schedule"), "the subject as written is on the claim");
      // admission's second rule: named from a second place, it has earned its node
      await record(h, "alice", "e2e-adm16 rack z9 a", "ops", [{ kind: "state", subject: { name: "rack Z9", class: "e2e-adm-rack" }, class: "e2e-adm-rack", attribute: "holds", value: "aluminum" }]);
      h.check(!(await h.thing("rack Z9")), "one reference earns no node");
      await record(h, "alice", "e2e-adm17 rack z9 b", "ops", [{ kind: "state", subject: { name: "rack Z9", class: "e2e-adm-rack" }, class: "e2e-adm-rack", attribute: "holds", value: "steel" }]);
      const z9 = (await things(h, "rack Z9"))[0];
      h.check(z9 && z9._thing_type !== "other" && z9._class === "e2e-adm-rack", `a second place earns the node: ${JSON.stringify(z9)}`);
      h.check(!(await claimsOf(h, "e2e-adm17 rack z9 b"))[0].unresolved, "and the claim that earned it lands on it");
    }),
  },
  {
    name: "a keyed mention finds the keyless thing of its name, and a key is the same key in any case",
    run: noDerivedFloor(async (ctx) => {
      const h = harness(ctx);
      await plainLinker(h);
      // B19: a key an existing thing learns must be a row the source holds, so this needs a source that holds them
      await startRowSource(h);
      await h.save("bob", "e2e-adm18 keyless", "Called Exatronz about the next batch.");
      const note = await h.entry("e2e-adm18 keyless");
      // keyless: the worker's key finds it, and it learns the key
      const keyless = await seedThing(h, "Exatronz", { homes: ["floor"], type: "customer" });
      // the stored sources are cached for a minute: until it picks these up the resolve is refused with a connection error
      const a = await workerResolves(h, note, { name: "Exatronz", type: "customer", key: "mssql:dbo_Customer:EXATRONZ" });
      h.check(a.minted === false && a.thing === keyless, `found, not minted: ${JSON.stringify(a).slice(0, 300)}`);
      h.check((await things(h, "Exatronz")).length === 1, "one Exatronz");
      h.check(((await h.sql(`SELECT _keys FROM ${keyless}`))[0]._keys ?? []).includes("mssql:dbo_Customer:EXATRONZ"), "it learned the key");
      // a thing of another kind by that name, or holding another key, is not the row
      const otherKind = await seedThing(h, "Gridley", { homes: ["floor"], type: "machine" });
      const b = await workerResolves(h, note, { name: "Gridley", type: "customer", key: "mssql:dbo_Customer:GRIDLEY" });
      h.check(b.minted === true && b.thing !== otherKind, `a machine named Gridley is not customer GRIDLEY: ${JSON.stringify(b).slice(0, 300)}`);
      // the wrong case finds the row: no second instance, no second spelling of the key
      const toro = await seedThing(h, "Toroz", { homes: ["floor"], keys: ["mssql:dbo_Customer:TOROZ"], type: "customer" });
      const c = await workerResolves(h, note, { name: "Toroz", type: "customer", key: "mssql:dbo_Customer:Toroz" });
      h.check(c.minted === false && c.thing === toro, `the row, whatever the case: ${JSON.stringify(c).slice(0, 300)}`);
      h.check((await things(h, "Toroz")).length === 1, "one Toroz");
      h.check(JSON.stringify((await h.sql(`SELECT _keys FROM ${toro}`))[0]._keys) === '["mssql:dbo_Customer:TOROZ"]', "one spelling of the key");
      await h.save("bob", "e2e-adm19 wrong case in text", "Sent mssql:dbo_Customer:toroz the corrected cert.");
      const n = await h.entry("e2e-adm19 wrong case in text");
      await linkedUp(h, n);
      h.check((await about(h, String(n.rid))).some((l) => l.dst === toro), "a key in the text finds it too");
      h.check((await sourceRefs(h, "mssql:dbo_Customer:toroz")).length === 0, "the SourceRef keeps the row's own spelling");
    }),
  },
  {
    name: "same-named people aren't settled by a model's pick, in the first call or the residue's: both stay candidates and the note stays unresolved",
    async run(ctx) {
      const h = harness(ctx);
      await plainLinker(h);
      const k1 = await seedThing(h, "Zelda", { homes: ["floor"], keys: ["mssql:dbo_Employee:ZK1"], type: "person" });
      const k2 = String((await h.tool("admin", "execute_graph", { language: "sql", command: "CREATE VERTEX Entity SET name = 'Zelda (seed2)', label = 'Zelda', _kind = 'thing', _norm = 'zelda', _keys = ['mssql:dbo_Employee:ZK2'], _homes = ['floor'], _home = 'org', _thing_type = 'person'" })).error ? "" : (await h.sql("SELECT @rid AS rid FROM Entity WHERE name = 'Zelda (seed2)'"))[0].rid);
      h.check(k1 && k2 && k1 !== k2, "two Zeldas seeded");
      // the model answers candidate 1 for the name both share
      await h.save("bob", "e2e-adm20 zelda on cnc 5", "Zelda is running CNC 5 this afternoon. [things: Zelda/person/1]");
      const first = await h.entry("e2e-adm20 zelda on cnc 5");
      await linkedUp(h, first);
      const offered = await prompts(h);
      h.check(offered.some((p) => p.includes("mssql:dbo_Employee:ZK1") && p.includes("mssql:dbo_Employee:ZK2")), "the model was offered both, and picked one");
      h.check(!(await about(h, String(first.rid))).some((l) => [k1, k2].includes(l.dst)), "the model's pick links neither");
      const u1 = (await unresolvedOn(h, "e2e-adm20 zelda on cnc 5")).find((u) => u.name === "Zelda");
      h.check(u1 && [k1, k2].every((c) => (u1.candidates ?? []).includes(c)), `unresolved with both candidates: ${JSON.stringify(u1)}`);
      // the residue's closed call picks one (the fake answers with a rid): that doesn't settle it either
      await h.save("bob", "e2e-adm21 zelda on cnc 7", "Zelda took over CNC 7. [things: Zelda/person] [pick: Zelda=ZK2]");
      const second = await h.entry("e2e-adm21 zelda on cnc 7");
      await linkedUp(h, second);
      h.check(!(await about(h, String(second.rid))).some((l) => [k1, k2].includes(l.dst)), "the residue's pick links neither");
      h.check((await things(h, "Zelda")).length === 2, "and nothing was minted");
    },
  },
  {
    name: "a name that collides with a hidden thing makes its own thing, and never binds to the hidden one (NB2)",
    run: noDerivedFloor(async (ctx) => {
      const h = harness(ctx);
      await plainLinker(h);
      await seedClass(h, "e2e-adm-nb2");
      const hidden = await seedThing(h, "Hidcust", { homes: ["org"], aliases: ["hc secret"], keys: ["mssql:dbo_Customer:HC"], type: "customer" });
      await record(h, "bob", "e2e-adm20 hidcust", "floor", [{ kind: "state", subject: { name: "Hidcust", actor: "customer" }, class: "e2e-adm-nb2", attribute: "status", value: "floor says hi" }]);
      const [c] = await claimsOf(h, "e2e-adm20 hidcust");
      h.check(!c.unresolved && c.dst !== hidden, `the claim is on the floor's own thing: ${JSON.stringify(c)}`);
      const row = (await h.sql(`SELECT _homes FROM ${hidden}`))[0];
      h.check(JSON.stringify(row._homes) === '["org"]', `the hidden thing's homes are unchanged: ${JSON.stringify(row)}`);
      h.check((await things(h, "Hidcust")).length === 2, "two things, one each side of the line");
      const seen = JSON.stringify(await h.tool("bob", "about_thing", { name: "hc secret" }));
      h.check(!seen.includes("mssql:dbo_Customer:HC") && !seen.includes("Hidcust"), `the floor learns nothing of it: ${seen.slice(0, 300)}`);
      // the same collision through a worker: it makes its own, without being told the other exists
      await h.save("bob", "e2e-adm21 heron", "Project Heronz rack needs a label.");
      const note = await h.entry("e2e-adm21 heron");
      await linkedUp(h, note);
      const heron = await seedThing(h, "Project Heronz", { homes: ["org"], aliases: ["heron secret"], keys: ["mssql:dbo_Project:HZ"], type: "project" });
      const made = await workerResolves(h, note, { name: "Project Heronz", type: "project" });
      h.check(made.minted === true && made.thing !== heron && !made.error, `its own thing: ${JSON.stringify(made).slice(0, 300)}`);
      h.check(!JSON.stringify(made).includes("heron secret") && !/can't be found/.test(JSON.stringify(made)), "nothing says a hidden one exists");
      h.check(JSON.stringify((await h.sql(`SELECT _homes FROM ${heron}`))[0]._homes) === '["org"]', "and the hidden one stays where it is");
    }),
  },
  {
    name: "a key reaches a hidden thing without bringing it down: the link is made, its label, aliases and other keys stay above (B9)",
    run: retiring(noDerivedFloor(async (ctx) => {
      const h = harness(ctx);
      await plainLinker(h);
      await startRowSource(h);
      await seedClass(h, "e2e-adm-hidden");
      const kestrel = await seedThing(h, "Project Kestrelz", { homes: ["org"], aliases: ["kestrel secret alias"], keys: ["mssql:dbo_Project:KZ", "mssql:dbo_ProjectSecret:KZ9"], type: "project" });
      await h.save("bob", "e2e-adm22 key in floor note", "Please check mssql:dbo_Project:KZ for me.");
      const note = await h.entry("e2e-adm22 key in floor note");
      await linkedUp(h, note);
      h.check((await about(h, String(note.rid))).some((l) => l.dst === kestrel), "the note is linked: one instance per key");
      h.check(JSON.stringify((await h.sql(`SELECT _homes FROM ${kestrel}`))[0]._homes) === '["org"]', "the thing is not pulled down");
      for (const name of ["mssql:dbo_Project:KZ", "Project Kestrelz", "kestrel secret alias"]) {
        const r = await h.tool("bob", "about_thing", { name });
        h.check(!(r.things ?? []).length, `about_thing "${name}" from the floor: ${JSON.stringify(r).slice(0, 300)}`);
      }
      const found = JSON.stringify(await h.tool("bob", "search_graph", { query: "check mssql:dbo_Project:KZ", as_of: new Date().toISOString() }));
      h.check(!found.includes("Kestrelz") && !found.includes("KZ9"), `search doesn't name it either: ${found.slice(0, 400)}`);
      const admin = JSON.stringify(await h.tool("admin", "about_thing", { name: "mssql:dbo_Project:KZ" }));
      h.check(admin.includes("Project Kestrelz"), "above, it's there");
      // a worker on the floor's section resolving by key: told the instance is held, and nothing about it
      await seedThing(h, "Project Wrenz", { homes: ["org"], aliases: ["wren secret"], keys: ["mssql:dbo_Customer:WRENZ"], type: "customer" });
      const wren = String((await h.thing("Project Wrenz")).rid);
      await h.save("bob", "e2e-adm23 worker by key", "Something about a row, see the worker.");
      const wn = await h.entry("e2e-adm23 worker by key");
      await linkedUp(h, wn);
      const r = await h.tool(h.workerToken(String(wn.rid)), "resolve_subject", { name: "the row", thing: { key: "mssql:dbo_Customer:WRENZ" }, reason: "e2e" });
      h.check(!r.error && r.thing === wren && r.minted === false, `resolved to the instance holding the key: ${JSON.stringify(r).slice(0, 300)}`);
      const said = JSON.stringify(r);
      h.check(!said.includes("Wrenz") && !said.includes("wren secret"), `and told nothing of it: ${said.slice(0, 300)}`);
      h.check(JSON.stringify((await h.sql(`SELECT _homes FROM ${wren}`))[0]._homes) === '["org"]', "the worker didn't bring it down");
      // the worker's brief for that section is as quiet
      const brief = await h.sql(`SELECT _unresolved FROM ${String(wn.rid)}`);
      h.check(!JSON.stringify(brief).includes("Wrenz"), "nothing written on the section names it");
      // what the floor wrote about a row it can't see the thing of stays its own to read: as the key, and nothing more
      await record(h, "bob", "e2e-adm24 floor claim on the row", "floor", [{ kind: "state", subject: { key: "mssql:dbo_Customer:WRENZ" }, class: "e2e-adm-hidden", attribute: "note", value: "from the floor" }]);
      const own = JSON.stringify(await h.tool("bob", "current_state", { subject: "mssql:dbo_Customer:WRENZ" }));
      h.check(own.includes("from the floor"), `the floor reads its own claim: ${own.slice(0, 300)}`);
      h.check(!own.includes("Wrenz") && !own.includes("wren secret"), `and nothing of the thing: ${own.slice(0, 300)}`);
    })),
  },
  {
    name: "what a restricted statement teaches a thing the floor knows stays restricted: aliases, keys and class (B8)",
    run: retiring(noDerivedFloor(async (ctx) => {
      const h = harness(ctx);
      await plainLinker(h);
      await seedClass(h, "e2e-adm-b8");
      // an org-home claim naming a floor-known thing by key, under a name the floor hasn't got
      const fennel = await seedThing(h, "Fennelz", { homes: ["floor"], keys: ["mssql:dbo_Customer:FENZ"], type: "customer" });
      await record(h, "admin", "e2e-adm25 fennel restricted", "org", [{ kind: "state", subject: { key: "mssql:dbo_Customer:FENZ", name: "Ken dismissal case" }, class: "e2e-adm-b8", attribute: "note", value: "x" }]);
      const [c] = await claimsOf(h, "e2e-adm25 fennel restricted");
      h.check(c.dst === fennel, `the claim is on the thing: ${JSON.stringify(c)}`);
      const floorSees = JSON.stringify(await h.tool("bob", "about_thing", { name: "Fennelz" }));
      h.check(!floorSees.includes("ken dismissal") && !floorSees.includes("Ken dismissal"), `the alias doesn't reach the floor: ${floorSees.slice(0, 300)}`);
      const byName = await h.tool("bob", "about_thing", { name: "Ken dismissal case" });
      h.check(!(byName.things ?? []).length, `nor does the floor find it by that name: ${JSON.stringify(byName).slice(0, 200)}`);
      h.check(!JSON.stringify(await h.sql(`SELECT _alias_norms FROM ${fennel}`)).includes("ken dismissal"), "the restricted name isn't among the names everyone reads");
      const top = await h.tool("admin", "about_thing", { name: "Fennelz" });
      h.check(JSON.stringify(top).includes("ken dismissal"), `above, it shows: ${JSON.stringify(top).slice(0, 300)}`);
      // and it resolves from above, by that name, like any alias
      await record(h, "admin", "e2e-adm26 fennel by name", "org", [{ kind: "state", subject: { name: "Ken dismissal case" }, class: "e2e-adm-b8", attribute: "note2", value: "y" }]);
      h.check((await claimsOf(h, "e2e-adm26 fennel by name"))[0].dst === fennel, "a restricted reader resolves by it");
      // a key first supplied by an org-home claim doesn't show in floor keys, and still names the row
      const gantry = await seedThing(h, "Gantryz", { homes: ["floor"], type: "customer" });
      await record(h, "admin", "e2e-adm27 gantry key", "org", [{ kind: "state", subject: { key: "mssql:dbo_Customer:GANZ", name: "Gantryz" }, class: "e2e-adm-b8", attribute: "note", value: "x" }]);
      h.check((await claimsOf(h, "e2e-adm27 gantry key"))[0].dst === gantry, "the keyless thing is that row");
      const floorKeys = JSON.stringify(await h.tool("bob", "about_thing", { name: "Gantryz" }));
      h.check(!floorKeys.includes("GANZ"), `the key doesn't show on the floor: ${floorKeys.slice(0, 300)}`);
      h.check(!JSON.stringify(await h.sql(`SELECT _keys FROM ${gantry}`)).includes("GANZ"), "and it isn't among the keys everyone reads");
      // the held key is still the row's identity: no second instance by key from anywhere, and a floor statement of it opens it
      await h.save("bob", "e2e-adm28 gantry key on floor", "Sent mssql:dbo_Customer:GANZ the cert.");
      const n = await h.entry("e2e-adm28 gantry key on floor");
      await linkedUp(h, n);
      h.check((await things(h, "Gantryz")).length === 1 && (await about(h, String(n.rid))).some((l) => l.dst === gantry), "one instance, found by the held key");
      h.check(JSON.stringify(await h.sql(`SELECT _keys FROM ${gantry}`)).includes("GANZ"), "stated at the floor, it is the floor's to read");
      // the class stamp: a restricted claim doesn't label a floor thing either
      const clsless = await seedThing(h, "Stampz", { homes: ["floor"], keys: ["mssql:dbo_Customer:STZ"], type: "customer" });
      await record(h, "admin", "e2e-adm29 stamp", "org", [{ kind: "state", subject: { key: "mssql:dbo_Customer:STZ", class: "e2e-adm-b8" }, class: "e2e-adm-b8", attribute: "note", value: "x" }]);
      h.check(!(await h.sql(`SELECT _class FROM ${clsless}`))[0]._class, "no class from above");
    })),
  },
  {
    name: "a second mention earns a node only for an individual: never-nodes stay claims in every spelling, a rack earns one, and the first claim moves onto it (B14, NB4)",
    run: retiring(noDerivedFloor(async (ctx) => {
      const h = harness(ctx);
      await plainLinker(h);
      for (const c of ["e2e-adm-note2", "e2e-adm-rack2"]) await seedClass(h, c);
      for (const [i, name] of ["holiday schedule", "Holiday Schedule", "the time clock", "Time Clock"].entries()) {
        for (const n of [1, 2]) await record(h, "alice", `e2e-adm30-${i}-${n}`, "ops", [{ kind: "event", subject: { name, class: "e2e-adm-note2" }, class: "e2e-adm-note2", attribute: "posted_at", value: `spot ${n}` }]);
        h.check(!(await things(h, name)).length, `no thing for "${name}"`);
        h.check((await claimsOf(h, `e2e-adm30-${i}-2`))[0].unresolved, `"${name}" stays a claim`);
      }
      await record(h, "alice", "e2e-adm31 payroll commitment", "ops", [{ kind: "commitment", subject: { name: "payroll", class: "e2e-adm-note2" }, class: "e2e-adm-note2", attribute: "due", value: "friday" }]);
      h.check(!(await things(h, "payroll")).length, "a commitment on payroll isn't a node");
      // floor first, ops second: the second earns the thing, the first moves onto it, and the floor can see the name it wrote
      await record(h, "bob", "e2e-adm32 rack first", "floor", [{ kind: "state", subject: { name: "rack Q7", class: "e2e-adm-rack2" }, class: "e2e-adm-rack2", attribute: "holds", value: "titanium" }]);
      h.check((await claimsOf(h, "e2e-adm32 rack first"))[0].unresolved, "named once, no thing yet");
      await record(h, "alice", "e2e-adm33 rack second", "ops", [{ kind: "state", subject: { name: "rack Q7", class: "e2e-adm-rack2" }, class: "e2e-adm-rack2", attribute: "holds", value: "aluminum" }]);
      const rack = (await things(h, "rack Q7"))[0];
      h.check(rack, "the second place earns it");
      const [first] = await claimsOf(h, "e2e-adm32 rack first");
      h.check(!first.unresolved && first.dst === String(rack.rid), `the first claim is on the thing now: ${JSON.stringify(first)}`);
      const history = JSON.stringify(await h.tool("alice", "state_history", { subject: "rack Q7", attribute: "holds" }));
      h.check(history.includes("titanium") && history.includes("aluminum"), `both are the rack's history: ${history.slice(0, 500)}`);
      const fromFloor = JSON.stringify(await h.tool("bob", "state_history", { subject: "rack Q7", attribute: "holds" }));
      h.check(fromFloor.includes("titanium"), `the floor reads its own claim on it: ${fromFloor.slice(0, 400)}`);
      // the same name in another class is another subject: its first mention isn't moved, and doesn't count
      await record(h, "alice", "e2e-adm34 rack other class", "ops", [{ kind: "state", subject: { name: "rack P8", class: "e2e-adm-note2" }, class: "e2e-adm-note2", attribute: "holds", value: "x" }]);
      await record(h, "alice", "e2e-adm35 rack other class 2", "ops", [{ kind: "state", subject: { name: "rack P8", class: "e2e-adm-rack2" }, class: "e2e-adm-rack2", attribute: "holds", value: "y" }]);
      h.check(!(await things(h, "rack P8")).length, `one place per class: nothing minted yet`);
      // a person's name is one subject whatever class it's written under: the second earns the node, and the first class's claim moves onto it
      await record(h, "alice", "e2e-adm46 tomaz one", "ops", [{ kind: "event", subject: { name: "Tomaz Reyesz", class: "e2e-adm-note2" }, class: "e2e-adm-note2", attribute: "completed", value: "training" }]);
      await record(h, "alice", "e2e-adm47 tomaz two", "ops", [{ kind: "state", subject: { name: "Tomaz Reyesz", class: "e2e-adm-rack2" }, class: "e2e-adm-rack2", attribute: "can_run", value: "setups" }]);
      const [tomaz] = await things(h, "Tomaz Reyesz");
      h.check(tomaz, "two places, two classes: one thing");
      h.check(!(await claimsOf(h, "e2e-adm46 tomaz one"))[0].unresolved && (await claimsOf(h, "e2e-adm47 tomaz two"))[0].dst === String(tomaz.rid), "both claims rest on it");
    })),
  },
  {
    name: "people, customers and machines written with a class are things on first mention; same-named people stay unsettled by the class route (NB4, B16)",
    run: retiring(noDerivedFloor(async (ctx) => {
      const h = harness(ctx);
      await plainLinker(h);
      for (const c of ["e2e-adm-x employment", "e2e-adm-x customer", "e2e-adm-x work center"]) await seedClass(h, c);
      await record(h, "alice", "e2e-adm36 kayla", "ops", [{ kind: "state", subject: { name: "Kaylaz", class: "e2e-adm-x employment" }, class: "e2e-adm-x employment", attribute: "status", value: "permanent" }]);
      const kayla = (await things(h, "Kaylaz"))[0];
      h.check(kayla && kayla._thing_type === "person", `a person by the class: ${JSON.stringify([kayla, await claimsOf(h, "e2e-adm36 kayla")])}`);
      h.check(!(await claimsOf(h, "e2e-adm36 kayla"))[0].unresolved, "the claim is on her");
      await record(h, "alice", "e2e-adm37 corvane", "ops", [{ kind: "state", subject: { name: "Corvanez Medical", class: "e2e-adm-x customer" }, class: "e2e-adm-x customer", attribute: "status", value: "prospect" }]);
      h.check((await things(h, "Corvanez Medical"))[0]?._thing_type === "customer", "a customer by its class");
      await record(h, "alice", "e2e-adm38 cnc", "ops", [{ kind: "observation", subject: { name: "CNC 97", class: "e2e-adm-x work center" }, class: "e2e-adm-x work center", attribute: "fault", value: "spindle" }]);
      h.check((await things(h, "CNC 97"))[0]?._thing_type === "machine", "a machine by its class and number");
      await record(h, "alice", "e2e-adm39 not a person", "ops", [{ kind: "state", subject: { name: "shift coverage", class: "e2e-adm-x employment" }, class: "e2e-adm-x employment", attribute: "status", value: "x" }]);
      h.check(!(await things(h, "shift coverage")).length, "a phrase in a person's class is no person");
      await seedClass(h, "e2e-adm-hires");
      const a = await seedThing(h, "Diep Cz", { homes: ["ops"], keys: ["mssql:dbo_Employee:C1"], type: "person", cls: "e2e-adm-hires" });
      await h.tool("admin", "execute_graph", { language: "sql", command: "CREATE VERTEX Entity SET name = 'Diep Cz (seed2)', label = 'Diep Cz', _kind = 'thing', _norm = 'diep cz', _keys = ['mssql:dbo_Employee:C2'], _homes = ['ops'], _home = 'org', _thing_type = 'person'" });
      for (const n of [1, 2]) {
        await record(h, "alice", `e2e-adm40-${n}`, "ops", [{ kind: "state", subject: "Diep Cz", class: "e2e-adm-hires", attribute: "status", value: `v${n}` }]);
        const [c] = await claimsOf(h, `e2e-adm40-${n}`);
        h.check(c.unresolved, `a class stamp on one of two people settles nothing: ${JSON.stringify(c)}`);
      }
      h.check((await things(h, "Diep Cz")).length === 2, "and no third is made");
      void a;
    })),
  },
  {
    name: "PO 78912 by every route: named twice, as a commitment, with a key the source doesn't hold, through a worker; a key the source holds is an instance (B17)",
    run: retiring(noDerivedFloor(async (ctx) => {
      const h = harness(ctx);
      await plainLinker(h);
      await startRowSource(h);
      await seedClass(h, "e2e-adm-orders", "mssql:dbo_Order");
      await seedClass(h, "e2e-adm-free");
      const pos = async () => h.sql("SELECT label, _keys FROM Entity WHERE _kind = 'thing' AND (label LIKE '%78912%' OR _keys.asString() LIKE '%78912%')");
      for (const n of [1, 2]) await record(h, "alice", `e2e-adm41-${n}`, "ops", [{ kind: "state", subject: { name: "PO 78912", class: "e2e-adm-orders" }, class: "e2e-adm-orders", attribute: "status", value: `v${n}` }]);
      h.check(!(await pos()).length, "named twice under a table's class: no node");
      for (const n of [1, 2]) await record(h, "alice", `e2e-adm42-${n}`, "ops", [{ kind: "commitment", subject: { name: "P.O. 78912", class: "e2e-adm-free" }, class: "e2e-adm-free", attribute: "due", value: `v${n}` }]);
      h.check(!(await pos()).length, "named twice under a class with no table, as a commitment, spelled another way: no node");
      await record(h, "alice", "e2e-adm43 po by key", "ops", [{ kind: "state", subject: { key: "mssql:dbo_Order:78912", name: "PO 78912", class: "e2e-adm-orders" }, class: "e2e-adm-orders", attribute: "status", value: "open" }]);
      const [byKey] = await claimsOf(h, "e2e-adm43 po by key");
      h.check(byKey.unresolved && !(await pos()).length, `a key the source doesn't hold mints nothing: ${JSON.stringify(byKey)}`);
      await h.save("alice", "e2e-adm44 po worker", "PO 78912 again.");
      const note = await h.entry("e2e-adm44 po worker");
      await linkedUp(h, note);
      const byName = await workerResolves(h, note, { name: "PO 78912", type: "order" });
      h.check(byName.error && !(await pos()).length, `a worker's judgement doesn't make a row's number a node: ${JSON.stringify(byName).slice(0, 200)}`);
      const noRow = await workerResolves(h, note, { name: "PO 78912", type: "order", key: "mssql:dbo_Order:78912" });
      h.check(noRow.error && !(await pos()).length, `nor a key the source doesn't hold: ${JSON.stringify(noRow).slice(0, 200)}`);
      // the source has this row: the key is an identity, and an instance is made of it
      await record(h, "alice", "e2e-adm45 real order", "ops", [{ kind: "state", subject: { key: "mssql:dbo_Order:5500001", class: "e2e-adm-orders" }, class: "e2e-adm-orders", attribute: "status", value: "open" }]);
      const [real] = await claimsOf(h, "e2e-adm45 real order");
      h.check(!real.unresolved, `a row the source holds: ${JSON.stringify(real)}`);
      const ok = await workerResolves(h, note, { name: "Order 5500002", type: "order", key: "mssql:dbo_Order:5500002" });
      h.check(ok.minted === true && !ok.error, `a worker, with a row: ${JSON.stringify(ok).slice(0, 200)}`);
      // a key minted later brings the earlier key-only claim onto the instance
      const [early] = await claimsOf(h, "e2e-adm43 po by key");
      h.check(early.unresolved, "still none for the PO: its row never appeared");
    })),
  },
  {
    name: "(the row source goes away)",
    async run(ctx) {
      if (!rowSource) return;
      await rowSource.stop();
    },
  },
];
export default SCENARIOS;

// run on its own: the same loop run.mjs uses
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const h = harness();
  await h.until("graph-rag up", async () => (await h.api("/api/worker")).enabled !== undefined, 120_000);
  let failed = 0;
  for (const s of SCENARIOS) {
    const t0 = Date.now();
    try {
      await s.run(h);
      console.log(`PASS ${s.name} (${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${s.name}: ${String(e?.message ?? e).slice(0, 600)}`);
    }
  }
  console.log(`${SCENARIOS.length - failed}/${SCENARIOS.length} admission scenarios pass`);
  process.exit(failed ? 1 : 0);
}
