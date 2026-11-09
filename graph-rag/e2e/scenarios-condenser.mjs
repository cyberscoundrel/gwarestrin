// The Condenser stream's acceptance scenarios for the replay harness (see
// run.mjs for the style; the harness's loader runs them): an off-record
// thread writes nothing; an on-record section becomes one document of three
// sections whose claims sit at three sensitivities, each seen by the right
// people; a manual ingests exactly as before. The condenser is the fake in
// fake-condenser.mjs (a canned document per thread), sent the way a chat
// agent sends it: ingest_document with the document as JSON in text.
//
// Exports an array of { name, run(ctx) }. ctx is the harness's helper set
// ({ tool, sql, api, until, check, POS }); when the loader passes none, the
// helpers below are built from GRAPH_URL. Run on its own too:
//   node scenarios-condenser.mjs   (inside the harness network)
import { createHmac, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CLASSES, documentFor, ingestArgs, OFF_RECORD_MARKER, seedClasses, THREADS } from "./fake-condenser.mjs";

export function helpers(env = process.env) {
  const GRAPH = env.GRAPH_URL ?? "http://graph-rag:8000";
  const TOKENS = { admin: "e2e-admin", alice: "e2e-alice", bob: "e2e-bob" };
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
  const api = (path, init = {}) => fetch(`${GRAPH}${path}`, { ...init, headers: { authorization: `Bearer ${TOKENS.admin}`, "content-type": "application/json", ...(init.headers ?? {}) } }).then((r) => r.json());
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
  const check = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  // a delegated token as the admin's workspace signs one (run.mjs; graph-rag/src/delegation.js)
  const delegated = (claims) => {
    const body = Buffer.from(JSON.stringify({ u: "admin", a: randomUUID(), iat: Math.floor(Date.now() / 1000), ...claims })).toString("base64url");
    return `gwa1.${body}.${createHmac("sha256", "e2e-delegation-key-0123456789abcdef").update(`gwa1.${body}`).digest("base64url")}`;
  };
  return { GRAPH, TOKENS, tool, sql, api, until, check, delegated, POS: { org: "org", ops: "ops", floor: "floor" } };
}

/**
 * Send a condensed document the way the agent does: through record_document when the integrator has wired
 * it (the tool the harness also looks for), else through ingest_document with the document as JSON in text.
 */
async function sendRecord(ctx, who, document) {
  const tools = await listTools(ctx, who);
  const named = tools.find((n) => /condens|on_record|record_document/.test(n));
  if (named) return ctx.tool(who, named, { document });
  return ctx.tool(who, "ingest_document", ingestArgs(document));
}

async function listTools(ctx, who) {
  const GRAPH = ctx.GRAPH ?? process.env.GRAPH_URL ?? "http://graph-rag:8000";
  const token = ctx.TOKENS?.[who] ?? who;
  const r = await fetch(`${GRAPH}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  try {
    return (JSON.parse(line ? line.slice(5) : t).result?.tools ?? []).map((x) => x.name);
  } catch {
    return [];
  }
}

export const scenarios = [
  {
    name: "condenser: an off-record thread writes nothing",
    async run(ctx) {
      const { tool, sql, check } = ctx;
      const before = Number((await sql("SELECT count(*) AS n FROM Entity WHERE _kind = 'document' AND _on_record = true"))[0]?.n ?? 0);
      const thread = THREADS["off-record quality chat"];
      check(thread.on === false, "the thread is off record");
      check(documentFor(thread) === null, "the condenser emits nothing for an off-record thread");
      // nothing was sent, so nothing of the conversation is in the graph: not as a document, not as a note
      const after = Number((await sql("SELECT count(*) AS n FROM Entity WHERE _kind = 'document' AND _on_record = true"))[0]?.n ?? 0);
      check(after === before, `no document appeared (${before} -> ${after})`);
      const found = (await tool("admin", "search_graph", { query: `${OFF_RECORD_MARKER} gauge drifted` })).results ?? [];
      check(!found.some((r) => JSON.stringify(r).includes(OFF_RECORD_MARKER)), `nothing of the off-record thread is in the graph: ${JSON.stringify(found).slice(0, 200)}`);
      const rows = await sql(`SELECT count(*) AS n FROM Entity WHERE text_identity LIKE '%${OFF_RECORD_MARKER}%'`);
      check(Number(rows[0]?.n ?? 0) === 0, "no entry carries the thread's words");
    },
  },
  {
    name: "condenser: an on-record section becomes one document, three sections at three sensitivities, its claims seen by the right people",
    async run(ctx) {
      const { tool, sql, api, until, check, POS } = ctx;
      // the recorder: a chat agent of the admin's positioned at Operations (a fresh identity, so nothing a person
      // read earlier in the run lifts this write's floor; a graph token carries its profile's positions the same way)
      const opsAgent = ctx.delegated({ p: [POS.ops] });
      // the confirmed classes (the Discovery stream's confirm flow, stood in for by the fixture)
      for (const cmd of seedClasses()) {
        const r = await tool("admin", "execute_graph", { language: "sql", command: cmd });
        check(!r.error, `class seeded: ${JSON.stringify(r).slice(0, 200)}`);
      }
      const confirmed = await sql("SELECT name FROM CommitmentClass WHERE status = 'confirmed'");
      check(CLASSES.every((c) => confirmed.some((r) => r.name === c.name)), `classes confirmed: ${JSON.stringify(confirmed)}`);

      const doc = documentFor("operations handover");
      check(doc && doc.sections.length === 3, "the fake condenser's document has three sections");
      const sent = await sendRecord(ctx, opsAgent, doc);
      check(sent.doc_id && sent.on_record === true, `recorded: ${JSON.stringify(sent).slice(0, 300)}`);
      check(sent.sections === 3 && sent.claims === 4, `three sections and four claims announced: ${JSON.stringify(sent).slice(0, 200)}`);
      check(/3 confirmed classes/.test(sent.classes ?? ""), `checked against the confirmed classes: ${sent.classes}`);

      const entry = await until("the document is ready", async () => {
        const d = (await sql(`SELECT @rid AS rid, _home, _doc_status, _on_record, _recorded_by, _record_position, _record_reason, claims FROM Entity WHERE _kind = 'document' AND _doc_id = '${sent.doc_id}'`))[0];
        return d?._doc_status === "ready" ? d : false;
      });
      check(entry._on_record === true, "the document carries the on-record marker");
      check(entry._recorded_by === "admin" && entry._record_position === "ops" && entry._record_reason === "Thursday handover", `who (the token's person, not the document's word), where, why: ${JSON.stringify(entry)}`);
      check(Number(entry.claims) === 4, `four claims written: ${entry.claims}`);
      check(entry._home === POS.ops, `the document is seen from Operations: ${entry._home}`);

      const sections = await sql(`SELECT @rid AS rid, name, _home, _section FROM Entity WHERE _kind = 'section' AND _doc_id = '${sent.doc_id}' ORDER BY _section`);
      check(sections.length === 3, `three sections stored: ${sections.length}`);
      const parts = await sql(`SELECT count(*) AS n FROM PART_OF WHERE @in = ${entry.rid}`);
      check(Number(parts[0]?.n) === 3, `each section PART_OF the document: ${JSON.stringify(parts)}`);
      // sensitivities: a section with claims is homed by them (the recorder's position; the grader is not asked);
      // the free-text residue is graded as before, here to the top; nothing sits below where the recorder writes
      check(sections[0]._home === POS.ops, `the Toro section (claims) is at Operations: ${sections[0]._home}`);
      check(sections[1]._home === POS.org, `the pricing section (free text, graded) is at the top: ${sections[1]._home}`);
      const grades = await sql(`SELECT _section, _grade FROM Entity WHERE _kind = 'section' AND _doc_id = '${sent.doc_id}' ORDER BY _section`);
      check(/claims/.test(grades[0]._grade ?? "") && /graded|admins/.test(grades[1]._grade ?? ""), `how each was placed: ${JSON.stringify(grades)}`);
      // ...and the shop-hours section released to everyone, which a person approves (the standing instructions' set_home step)
      const moved = await tool(opsAgent, "set_home", { entities: [{ name: sections[2].name }], to: "Everyone" });
      const pid = moved.results?.[0]?.pendingId ?? moved.results?.[0]?.id;
      check(pid, `the release to everyone is queued: ${JSON.stringify(moved).slice(0, 300)}`);
      const ok = await api(`/api/queue/${pid}/approve`, { method: "POST", body: "{}" });
      check(ok.result?.approved || ok.approved, `approved: ${JSON.stringify(ok).slice(0, 300)}`);
      const homes = await sql(`SELECT _section, _home FROM Entity WHERE _kind = 'section' AND _doc_id = '${sent.doc_id}' ORDER BY _section`);
      check(homes[2]._home === "everyone", `the shop-hours section is for everyone: ${homes[2]._home}`);

      // the claims: one CLAIMS edge from each section to its subject, homed where the section is
      const claims = await sql(`SELECT @out._section AS section, @in.name AS subject, @in._class AS subject_class, @in._keys AS keys, kind, class, attribute, value, value_num, valid_from, valid_until, recorded_by, _home FROM CLAIMS WHERE @out._doc_id = '${sent.doc_id}' ORDER BY section, attribute`);
      check(claims.length === 4, `four CLAIMS edges: ${JSON.stringify(claims).slice(0, 400)}`);
      check(claims.every((c) => c.recorded_by === "admin"), "every claim is the recorder's");
      const job = claims.filter((c) => c.class === "jobs" && c.attribute === "stage")[0];
      check(job && job.value === "planned" && (job.keys ?? []).includes("mssql:dbo_Job:4471") && job.subject_class === "jobs", `job 4471 is the subject, keyed, of class jobs: ${JSON.stringify(job)}`);
      const machine = claims.find((c) => c.attribute === "machine");
      check(machine && machine.value === "CNC 2" && machine.valid_from && machine.valid_until === null, `a state with no dates runs from the recording, open: ${JSON.stringify(machine)}`);
      const closure = claims.find((c) => c.attribute === "shop_closure");
      check(closure && closure.kind === "event" && closure.valid_from === closure.valid_until, `an event is a point in time: ${JSON.stringify(closure)}`);
      check(claims.filter((c) => Number(c.section) === 0).every((c) => c._home === POS.ops), "the Toro claims are seen from Operations");
      // a claim is seen by whoever sees its section (decision 5): the shop-hours claim went to everyone with its section
      const bySection = await sql(`SELECT @out._section AS section, @out._home AS section_home FROM CLAIMS WHERE @out._doc_id = '${sent.doc_id}'`);
      check(bySection.filter((c) => Number(c.section) === 2).every((c) => c.section_home === "everyone"), `the shop-hours claim is for everyone with its section: ${JSON.stringify(bySection)}`);
      check(bySection.filter((c) => Number(c.section) === 0).every((c) => c.section_home === POS.ops), "the Toro claims stay at Operations with theirs");

      // each seen by the right people: read_document shows each person only the sections they see
      const seen = async (who) => ((await tool(who, "read_document", { document: sent.doc_id })).contents ?? []).map((c) => c.section);
      check(JSON.stringify(await seen("admin")) === "[1,2,3]", `the admin sees all three: ${JSON.stringify(await seen("admin"))}`);
      check(JSON.stringify(await seen("alice")) === "[1,3]", `alice sees hers and everyone's, not the pay: ${JSON.stringify(await seen("alice"))}`);
      check(JSON.stringify(await seen("bob")) === "[3]", `bob, on the floor, sees only what is for everyone: ${JSON.stringify(await seen("bob"))}`);
      const text = (await tool("bob", "read_document", { document: sent.doc_id, section: 3 })).sections?.[0]?.text ?? "";
      check(/closes at noon on Friday/.test(text) && !/Aetrium/.test(text), `bob reads the shop hours and nothing of the pricing: ${text.slice(0, 200)}`);
      // and the subjects exist once: a thing for job 4471 with its key and class, minted by the record
      const things = await sql("SELECT name, _class, _keys FROM Entity WHERE _kind = 'thing' AND _keys CONTAINS 'mssql:dbo_Job:4471'");
      check(things.length === 1 && things[0]._class === "jobs", `one thing for job 4471, of class jobs: ${JSON.stringify(things)}`);
    },
  },
  {
    name: "condenser: a claim on a class nobody confirmed is refused with its field named, and nothing is stored",
    async run(ctx) {
      const { tool, sql, check } = ctx;
      const doc = documentFor("unconfirmed class");
      const count = async () => Number((await sql("SELECT count(*) AS n FROM Entity WHERE name = 'e2e-cond Aetrium quote'"))[0]?.n ?? 0);
      const before = await count();
      const r = await sendRecord(ctx, ctx.delegated({ p: [ctx.POS.ops] }), doc);
      check(/sections\[0\]\.claims\[0\]\.(subject\.)?class: not a confirmed class: quotes/.test(r.error ?? JSON.stringify(r)), `refused by field: ${JSON.stringify(r).slice(0, 300)}`);
      check((await count()) === before, "nothing stored");
      // without the claim the section still goes on record (decision 2: the text, no claim, graded as usual)
      doc.sections[0].claims = [];
      const ok = await sendRecord(ctx, ctx.delegated({ p: [ctx.POS.ops] }), doc);
      check(ok.on_record === true && ok.claims === 0 && ok.sections === 1, `recorded without a claim: ${JSON.stringify(ok).slice(0, 200)}`);
    },
  },
  {
    name: "condenser: a manual ingests exactly as before",
    async run(ctx) {
      const { tool, sql, until, check, POS } = ctx;
      const para = (w) => Array.from({ length: 12 }, (_, i) => `${w} step ${i + 1}: check the ${w} every 500 hours and log the reading.`).join(" ");
      const text = `# e2e-cond Mill 1 manual\n\n## Lubrication\n\n${para("spindle")}\n\n## Coolant\n\n${para("coolant")}\n\n## Safety\n\n${para("guard")}\n`;
      const r = await tool("alice", "ingest_document", { title: "e2e-cond Mill 1 manual", description: "The Mill 1 manual.", text, extract: false });
      check(r.doc_id && r.ingesting === true && r.on_record === undefined, `a manual ingests as before: ${JSON.stringify(r).slice(0, 200)}`);
      const entry = await until("the manual is ready", async () => {
        const d = (await sql(`SELECT @rid AS rid, _home, _doc_status, _on_record, claims, facts, sections FROM Entity WHERE _kind = 'document' AND _doc_id = '${r.doc_id}'`))[0];
        return d?._doc_status === "ready" ? d : false;
      });
      check(entry._on_record !== true, "no on-record marker on a manual");
      check(entry.claims === undefined || entry.claims === null, "no claims on a manual");
      check(Number(entry.facts) === 0, "no extraction when not asked");
      // written from the writer's position; the derived floor may hold it higher when alice read above it
      // earlier in the run (reading an entry released to everyone lifts it to the root), as for any write
      const origin = (await sql(`SELECT _origin FROM Entity WHERE _kind = 'document' AND _doc_id = '${r.doc_id}'`))[0]?._origin;
      check(origin === POS.ops, `written from the writer's position: ${origin}`);
      check([POS.ops, POS.org].includes(entry._home), `seen from the writer's position, or held above it by what she read: ${entry._home}`);
      const sections = await sql(`SELECT @rid AS rid, _section FROM Entity WHERE _kind = 'section' AND _doc_id = '${r.doc_id}' ORDER BY _section`);
      check(sections.length === r.sections && sections.length >= 3, `its sections as chunked (${r.sections} announced, ${sections.length} stored)`);
      const edges = await sql(`SELECT count(*) AS n FROM CLAIMS WHERE @out._doc_id = '${r.doc_id}'`);
      check(Number(edges[0]?.n ?? 0) === 0, "no CLAIMS edges from a manual's sections");
      const read = await tool("alice", "read_document", { document: "e2e-cond Mill 1 manual", section: 1 });
      check(/spindle step 1/.test(read.sections?.[0]?.text ?? ""), `read back from the store: ${JSON.stringify(read).slice(0, 200)}`);
      check((read.contents ?? []).some((c) => c.heading === "Coolant"), `headings as chunked: ${JSON.stringify(read.contents)}`);
    },
  },
];

export default scenarios;

// run on its own inside the harness network (the loader normally does this)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ctx = helpers();
  await ctx.until("graph-rag up", async () => (await ctx.api("/api/worker")).enabled !== undefined, 120_000);
  let failed = 0;
  for (const s of scenarios) {
    const t0 = Date.now();
    try {
      await s.run(ctx);
      console.log(`PASS ${s.name} (${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${s.name}: ${String(e?.message ?? e).slice(0, 600)}`);
    }
  }
  console.log(`\n${scenarios.length - failed}/${scenarios.length} condenser scenarios passed`);
  process.exit(failed ? 1 : 0);
}
