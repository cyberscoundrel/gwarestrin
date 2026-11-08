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
// point: the linker on its own now mints nothing from a name. Keys arrive through a worker's link_things
// (its judgement, with the key it looked up) or written in the text, and only keys mint instances.
import { createHmac, randomUUID } from "node:crypto";

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
  h.entry ??= async (name) => (await h.sql(`SELECT @rid AS rid, name, _home, _grade, _ungraded, _mentions_at, _unresolved FROM Entity WHERE name = '${name}'`))[0];
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
/** the entry's mentions job has run */
const linkedUp = (h, e) => h.until(`linked: ${e.name}`, async () => ((await h.job(String(e.rid)))?.status === "done" ? true : false));
/** the linker runs on its own here: no master pool, no sorting step (a scenario in run.mjs turns the master on; this stream's cases are about the one-call linker) */
const plainLinker = (h) => h.api("/api/worker", { method: "PUT", body: JSON.stringify({ pool: { poolSize: 0, master: false, sortFirst: false } }) });
/** a worker's explicit judgement with the key it looked up: the one way a name becomes an instance here */
const workerLinks = (h, e, list) => h.tool(h.workerToken(String(e.rid)), "link_things", { things: list });

export default [
  {
    name: "the same-named Diep: the linker links neither on a bare name, and the key decides",
    async run(ctx) {
      const h = harness(ctx);
      await plainLinker(h);
      // two employees called Diep, each from its ERP row: a worker that looked them up links them by key
      await h.save("alice", "e2e-adm1 diep roster", "Two people on the roster are called Diep.");
      const roster = await h.entry("e2e-adm1 diep roster");
      const made = await workerLinks(h, roster, [
        { name: "Diep", type: "person", key: "mssql:dbo_Employee:NGUD" },
        { name: "Diep", type: "person", key: "mssql:dbo_Employee:NGDT" },
      ]);
      h.check((made.linked ?? []).filter((l) => l.created && l.how === "key").length === 2, `two instances minted by key: ${JSON.stringify(made).slice(0, 400)}`);
      const dieps = await things(h, "Diep");
      h.check(dieps.length === 2, `two things called Diep, one per key: ${JSON.stringify(dieps)}`);
      const active = dieps.find((d) => (d._keys ?? []).includes("mssql:dbo_Employee:NGUD"));
      const inactive = dieps.find((d) => (d._keys ?? []).includes("mssql:dbo_Employee:NGDT"));
      h.check(active && inactive, "each holds its key");
      h.check((await sourceRefs(h, "mssql:dbo_Employee:NGUD")).length === 1 && (await sourceRefs(h, "mssql:dbo_Employee:NGDT")).length === 1, "each row has one SourceRef");
      h.check((await refersTo(h, String(active.rid))).includes("mssql:dbo_Employee:NGUD"), "the instance refers to its row");
      // the floor's note names Diep with no key: the linker on its own links neither and mints no third
      await h.save("bob", "e2e-adm2 diep on cnc 5", "Diep is running CNC 5 this afternoon. [things: Diep/person]");
      const note = await h.entry("e2e-adm2 diep on cnc 5");
      await linkedUp(h, note);
      const links = await about(h, String(note.rid));
      h.check(!links.some((l) => [String(active.rid), String(inactive.rid)].includes(l.dst)), `neither Diep linked on a bare name: ${JSON.stringify(links)}`);
      h.check((await things(h, "Diep")).length === 2, "no third Diep minted");
      const after = await h.entry("e2e-adm2 diep on cnc 5");
      const unresolved = JSON.parse(after?._unresolved ?? "[]");
      const diep = unresolved.find((u) => u.name === "Diep");
      h.check(diep && (diep.candidates ?? []).length === 2, `the mention comes back unresolved with both candidates: ${after?._unresolved}`);
      // the worker that checked the roster links with the key: the active employee, nothing new
      const settled = await workerLinks(h, note, [{ name: "Diep", type: "person", key: "mssql:dbo_Employee:NGUD" }]);
      h.check((settled.linked ?? []).some((l) => l.linked && l.how === "key" && !l.created), `linked by key, not created: ${JSON.stringify(settled).slice(0, 300)}`);
      const now = await about(h, String(note.rid));
      h.check(now.some((l) => l.dst === String(active.rid)) && !now.some((l) => l.dst === String(inactive.rid)), `about the active Diep only: ${JSON.stringify(now)}`);
      h.check((await things(h, "Diep")).length === 2, "still two");
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
      const row = await h.entry("e2e-adm3 holiday schedule posted");
      const unresolved = JSON.parse(row?._unresolved ?? "[]").map((u) => u.name);
      h.check(unresolved.includes("holiday schedule") && unresolved.includes("time clock"), `both names come back unresolved for a worker or a person: ${row?._unresolved}`);
      h.check(row._mentions_at, "the linking step is recorded as run");
      // no "other" type anywhere: the fake's type was dropped, not stored
      const others = await h.sql("SELECT count(*) AS n FROM Entity WHERE _kind = 'thing' AND _thing_type = 'other'");
      h.check(Number(others[0]?.n ?? 0) === 0, "nothing is typed other");
    },
  },
  {
    name: "PO 78912 twice yields one instance with one SourceRef, and the PO number in prose mints nothing",
    async run(ctx) {
      const h = harness(ctx);
      await plainLinker(h);
      // the confirmed class whose record table the PO belongs to (the Discovery stream's output; declared here as the contract declares it)
      await h.tool("admin", "execute_graph", { language: "sql", command: "CREATE VERTEX TYPE CommitmentClass IF NOT EXISTS" });
      await h.tool("admin", "execute_graph", { language: "sql", command: "CREATE PROPERTY CommitmentClass.name IF NOT EXISTS STRING" });
      if (!(await h.sql("SELECT name FROM CommitmentClass WHERE name = 'orders'")).length)
        await h.tool("admin", "execute_graph", { language: "sql", command: "INSERT INTO CommitmentClass SET name = 'orders', description = 'a customer order', stages = ['quoted', 'ordered', 'shipped', 'paid'], record_table = 'mssql:dbo_Order', status = 'confirmed', confirmed_by = 'admin'" });
      // the two notes behind the PO 78912 cluster (ux-note 13 and 14); neither says "PO 78912": a worker found it in the ERP row
      await h.save("alice", "e2e-adm4 job 3260356 slips", "Alexander said the inspect- is backed up again, so job 3260356 for Exatron (EPP-D98-1-A) probably slips to next week.");
      await h.save("bob", "e2e-adm5 exatron wants it earlier", "Called Exatron about EPP-D98-2-B - they want the next batch earlier. Darrin S. is checking material.");
      const n13 = await h.entry("e2e-adm4 job 3260356 slips");
      const n14 = await h.entry("e2e-adm5 exatron wants it earlier");
      await linkedUp(h, n13);
      await linkedUp(h, n14);
      const first = await workerLinks(h, n13, [{ name: "PO 78912", type: "order", key: "mssql:dbo_Order:78912" }]);
      h.check((first.linked ?? []).some((l) => l.created && l.how === "key"), `the first worker mints the instance from the key: ${JSON.stringify(first).slice(0, 300)}`);
      const second = await workerLinks(h, n14, [{ name: "customer PO 78912", type: "order", key: "mssql:dbo_Order:78912" }]);
      h.check((second.linked ?? []).some((l) => l.linked && !l.created && l.how === "key"), `the second finds it: ${JSON.stringify(second).slice(0, 300)}`);
      const pos = await h.sql("SELECT @rid AS rid, label, _keys, _class, _alias_norms FROM Entity WHERE _kind = 'thing' AND _keys CONTAINS 'mssql:dbo_Order:78912'");
      h.check(pos.length === 1, `one instance for the key: ${JSON.stringify(pos)}`);
      h.check(pos[0]._class === "orders", `with its class from the record table: ${pos[0]._class}`);
      h.check((pos[0]._alias_norms ?? []).includes("customer po 78912"), `the second spelling is an alias: ${JSON.stringify(pos[0]._alias_norms)}`);
      const refs = await sourceRefs(h, "mssql:dbo_Order:78912");
      h.check(refs.length === 1, `one SourceRef: ${JSON.stringify(refs)}`);
      h.check(refs[0].system === "mssql" && refs[0].table === "dbo_Order" && refs[0].row_key === "78912" && refs[0].last_seen, `the reference holds the key's parts and when it was seen, nothing of the row: ${JSON.stringify(refs[0])}`);
      h.check(!Object.keys(refs[0]).some((k) => /customer|amount|status|due/i.test(k)), "no row columns");
      const edges = await h.sql(`SELECT count(*) AS n FROM (SELECT expand(outE('REFERS_TO')) FROM ${pos[0].rid})`);
      h.check(Number(edges[0]?.n) === 1, `one REFERS_TO edge: ${JSON.stringify(edges)}`);
      for (const e of [n13, n14]) h.check((await about(h, String(e.rid))).some((l) => l.dst === String(pos[0].rid)), `${e.name} is about it`);
      // the same PO written in prose by a third note, with no key: the linker on its own mints no order thing from the number
      await h.save("alice", "e2e-adm6 po 78912 prose", "Customer PO 78912 covers both EPP-D98 jobs. [things: PO 78912 for Exatron/order, order 78912/order, Exatron PO 78912/order]");
      const n = await h.entry("e2e-adm6 po 78912 prose");
      await linkedUp(h, n);
      const orders = await h.sql("SELECT label, _keys FROM Entity WHERE _kind = 'thing' AND (_norm LIKE '%78912%' OR _alias_norms CONTAINS 'order 78912')");
      h.check(orders.length === 1 && (orders[0]._keys ?? []).includes("mssql:dbo_Order:78912"), `still the one keyed instance, no keyless order things: ${JSON.stringify(orders)}`);
      // a key written in the text resolves without a model, to the same instance
      await h.save("alice", "e2e-adm7 po 78912 by key", "Both EPP-D98 jobs ship against mssql:dbo_Order:78912 next week.");
      const k = await h.entry("e2e-adm7 po 78912 by key");
      await linkedUp(h, k);
      h.check((await about(h, String(k.rid))).some((l) => l.dst === String(pos[0].rid)), "the key in the text links to the instance");
      h.check((await sourceRefs(h, "mssql:dbo_Order:78912")).length === 1, "still one SourceRef, touched");
    },
  },
];

// run on its own: the same loop run.mjs uses
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const h = harness();
  await h.until("graph-rag up", async () => (await h.api("/api/worker")).enabled !== undefined, 120_000);
  let failed = 0;
  const scenarios = (await import(import.meta.url)).default;
  for (const s of scenarios) {
    const t0 = Date.now();
    try {
      await s.run(h);
      console.log(`PASS ${s.name} (${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${s.name}: ${String(e?.message ?? e).slice(0, 600)}`);
    }
  }
  console.log(`${scenarios.length - failed}/${scenarios.length} admission scenarios pass`);
  process.exit(failed ? 1 : 0);
}
