// The Discovery stream's acceptance scenarios for the replay harness (see
// run.mjs and e2e.sh): a survey run with the tools its brief names drafts the
// ux tree's classes; an unconfirmed class maps nothing; confirmation makes it
// available; what no class covers is stored, graded and proposed. Exported
// as `{ name, run }` for the harness's loader (the Test harness stream wires
// them in). Each `run` is self-contained: it reaches graph-rag at GRAPH_URL
// with the harness's tokens, like run.mjs does.
import { createHmac, randomUUID } from "node:crypto";

const GRAPH = process.env.GRAPH_URL ?? "http://graph-rag:8000";
const TOKENS = { admin: "e2e-admin", alice: "e2e-alice", bob: "e2e-bob" };
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
const api = async (path, opts = {}, who = "admin") => {
  const r = await fetch(`${GRAPH}${path}`, { ...opts, headers: { authorization: `Bearer ${TOKENS[who] ?? who}`, "content-type": "application/json" } });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const post = (path, body, who = "admin") => api(path, { method: "POST", body: JSON.stringify(body) }, who);
const put = (path, body, who = "admin") => api(path, { method: "PUT", body: JSON.stringify(body) }, who);
async function toolsList(who) {
  const r = await fetch(`${GRAPH}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKENS[who] ?? who}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/list", params: {} }),
  });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  return (JSON.parse(line ? line.slice(5) : t).result?.tools ?? []).map((x) => x.name);
}
const until = async (label, fn, ms = 120_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
};
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const classes = async (status) => (await api(`/api/discovery/classes${status ? `?status=${status}` : ""}`)).classes ?? [];
const named_ = async (name) => (await classes()).find((c) => c.name === name);
const resolve = async (key) => (await api(`/api/discovery/resolve?key=${encodeURIComponent(key)}`)).class ?? null;

/** the ux test tree's ERP, digested the way an agent gets it (connection-digest.ts), with the status values the survey read; every table carries an E2ed prefix so the classes it drafts (e2ed_orders, ...) are this file's alone on the harness's shared graph */
const UX_DIGEST_TEXT = [
  "Tables (8, all named dbo_…): E2edCustomer, E2edEmployee, E2edVendor, E2edWorkCenter, E2edOrder, E2edJob, E2edMaintenance, E2edOrderStatus",
  "dbo_E2edCustomer columns: CustomerID, Name, CreditLimit, PaymentTerms",
  "dbo_E2edEmployee columns: EmployeeID, Name, WorkCenterID, Shift",
  "dbo_E2edVendor columns: VendorID, Name, Terms",
  "dbo_E2edWorkCenter columns: WorkCenterID, Name, Capacity",
  "dbo_E2edOrderStatus columns: StatusCode, Description",
  "dbo_E2edOrder columns: OrderID, CustomerID, Status, Quantity, DueDate, Price, Margin",
  "dbo_E2edOrder rows: 9,120",
  "dbo_E2edOrder Status values: Quoted, Ordered, In Production, Shipped, Invoiced, Paid",
  "dbo_E2edJob columns: JobID, Status, MachineID, OperatorID, ShiftCover, Quantity, DueDate",
  "dbo_E2edJob rows: 31,400",
  "dbo_E2edJob Status values: Planned, Running, Paused, Done",
  "dbo_E2edMaintenance columns: MaintenanceID, Status, MachineID, TechnicianID, BookedFor, Parts",
  "dbo_E2edMaintenance rows: 403",
  "dbo_E2edMaintenance Status values: Booked, In Progress, Done",
].join("\n");
const UX_PATTERNS = [{ name: "mssql: hiring (pattern)", text: "Hiring runs outside the ERP. [class: e2ed hires; stages: opened, interviewing, offered, hired, declined; table: none; attributes: candidate, start_date, pay, dismissal; description: a hire: a commitment of a position to a person; no source system records it]" }];
/** the survey's final report as the thread would send it: prose, the digest lines the brief asks for, and the tag for the class no table records */
const SURVEY_REPORT = [
  "The shop makes machined parts. mssql: dbo_E2edOrder (orders): one row is a customer order, key OrderID. Its rows are commitments (a class).",
  "- Jobs: 31k rows, most on CNC",
  "Seeded dbo_E2edCustomer (1 of 212); left the rest for when a record names them.",
  UX_DIGEST_TEXT,
  UX_PATTERNS[0].text,
].join("\n");
const UX_CLASSES = { e2ed_orders: "mssql:dbo_E2edOrder", e2ed_jobs: "mssql:dbo_E2edJob", e2ed_maintenance: "mssql:dbo_E2edMaintenance", e2ed_hires: null };

export const scenarios = [
  {
    name: "discovery: a survey run with the tools its brief names drafts the ux tree's classes, proposed and unconfirmed, master data as things",
    async run() {
      await classes(); // the class type is declared on first use
      const pool = (await api("/api/worker")).pool;
      await put("/api/worker", { pool: { poolSize: 5, dailyThreads: 5000 } });
      try {
        // the admin starts the survey; the workspace claims its thread and gets the brief
        const started = await post("/api/worker/survey", { connection: "mssql", focus: "e2ed", audience: "admin" });
        check(started.job, `the survey is queued: ${JSON.stringify(started).slice(0, 300)}`);
        const got = await post("/api/worker/threads/claim", { limit: 50 });
        const me = (got.threads ?? []).find((t) => t.job === started.job);
        for (const t of got.threads ?? []) if (t.job !== started.job) await post(`/api/worker/threads/${t.job}/release`, {});
        check(me, `the survey's thread is claimed: ${JSON.stringify(got).slice(0, 300)}`);
        check(/^A task for you: Survey: mssql/.test(me.message), "its brief is the survey's");
        const token = workerToken(me.entry, me.job);

        // every graph-rag tool the brief names is listed for this very token, and it names nothing a worker is refused
        const listed = new Set(await toolsList(token));
        const named = [...new Set([...me.message.matchAll(/graph-rag_([a-z_]+)/g)].map((m) => m[1]))];
        check(named.length >= 2 && named.every((t) => listed.has(t)), `the brief's tools (${named.join(", ")}) are all this worker's: ${[...listed].join(", ")}`);
        check(!/upsert_entities|link_things|relate_things|queue_followup/.test(me.message), "it names none of the old job's tools");

        // step 2: a master-data row becomes a thing by key, the way the brief says
        const seeded = await tool(token, "resolve_subject", { name: "E2ed Toro", thing: { name: "E2ed Toro", type: "customer", key: "mssql:dbo_E2edCustomer:E2EDTORO" }, reason: "survey: master data" });
        check(seeded.minted && seeded.key === "mssql:dbo_E2edCustomer:E2EDTORO", `step 2 seeds a thing: ${JSON.stringify(seeded).slice(0, 300)}`);
        const thing = (await sql("SELECT _thing_type, _keys FROM Entity WHERE _kind = 'thing' AND _keys CONTAINS 'mssql:dbo_E2edCustomer:E2EDTORO'"))[0];
        check(thing?._thing_type === "customer", `the seeded thing has its type and key: ${JSON.stringify(thing)}`);

        // step 5, a table whose name hides that it's a class: the tool files a draft the thread can't confirm
        const filed = await tool(token, "propose_class", { name: "e2ed_maintenance", description: "a maintenance booking: a commitment of a machine's time to a service", stages: ["booked", "in_progress", "done"], record_table: "mssql:dbo_E2edMaintenance", attributes: ["stage", "machine", "technician", "booked_for", "parts"], reason: "dbo_E2edMaintenance's rows are commitments: 403 rows with a status" });
        check(filed.draft?.status === "proposed" && filed.draft.proposed_by === "survey:mssql", `the survey's draft: ${JSON.stringify(filed).slice(0, 300)}`);
        const m = await named_("e2ed_maintenance");
        check(m?.status === "proposed" && m.confirmed_by === null && m.confirmed_at === null, `the survey's draft is proposed, not confirmed: ${JSON.stringify(m)}`);
        check(!listed.has("confirm_class"), "no tool confirms a class");

        // the thread's turn ends: its report's table lines and its class tag are filed as drafts, with nobody calling a route for them
        const done = await post(`/api/worker/threads/${me.job}/finish`, { status: "done", summary: SURVEY_REPORT });
        check(done.status === "done", `finished: ${JSON.stringify(done)}`);
        for (const [name, table] of Object.entries(UX_CLASSES)) {
          const c = await named_(name);
          check(c?.status === "proposed", `${name} is proposed: ${JSON.stringify(c)}`);
          check(c.record_table === table, `${name} records in ${table}: ${c.record_table}`);
          check(c.stages.length >= 3, `${name} has stages: ${c.stages.join(", ")}`);
          check(c.reasons.length >= 1, `${name} says why`);
          check(/^survey:mssql/.test(c.proposed_by ?? ""), `${name} was the survey's: ${c.proposed_by}`);
        }
        check((await named_("e2ed_orders")).stages.join(",") === "quoted,ordered,in_production,shipped,invoiced,paid", "orders' stages come from the status column's values");
        const all = (await classes()).map((c) => c.name);
        check(!all.some((n) => /^e2ed_(customers|work_centers|employees|vendors|order_statuses)$/.test(n)), `no master-data or lookup table became a class: ${all.join(", ")}`);
        check(!all.includes("jobs_31k"), "a report's free bullet is no table");

        // the loader, on the route knowledge.ts proxies: a re-run drafts nothing new, and says what the rest are
        const again = await post("/api/discovery/draft", { system: "mssql", digest: UX_DIGEST_TEXT, patterns: UX_PATTERNS });
        check(again.status === 200 && again.drafted.length === 0 && again.not_drafted.length === 4, `a re-run adds nothing: ${JSON.stringify(again).slice(0, 300)}`);
        check(again.not_drafted.some((x) => x.name === "e2ed_maintenance" && /already proposed/.test(x.reason)), `maintenance is known: ${JSON.stringify(again.not_drafted)}`);
        const master = Object.fromEntries(again.tables_skipped.map((x) => [x.table, x]));
        check(master.dbo_E2edCustomer?.role === "actor" && master.dbo_E2edWorkCenter?.role === "resource", `master data are actors or resources: ${JSON.stringify(again.tables_skipped).slice(0, 300)}`);
        check(master.dbo_E2edOrderStatus?.kind === "lookup", "a lookup table is neither");
        // only a person at the root reaches that route
        check((await post("/api/discovery/draft", { system: "mssql", digest: UX_DIGEST_TEXT }, "alice")).status === 403, "alice can't run the loader");
      } finally {
        await put("/api/worker", { pool });
      }
    },
  },
  {
    name: "discovery: an unconfirmed class maps nothing, and only a person at the root may confirm",
    async run() {
      check((await named_("e2ed_orders"))?.status === "proposed", "orders is still a draft");
      check((await resolve("mssql:dbo_E2edOrder:9001")) === null, "a record key of a proposed class maps to no class");
      check((await resolve("mssql:dbo_E2edJob:4471")) === null, "nor does a job's");
      check((await classes("confirmed")).every((c) => !(c.name in UX_CLASSES)), "none of the drafts is listed as confirmed");
      // alice (Operations) and bob (the floor) may read but not confirm
      const alice = await api("/api/discovery/classes", {}, "alice");
      check(alice.status === 200 && alice.canConfirm === false, `alice reads, cannot confirm: ${JSON.stringify(alice).slice(0, 120)}`);
      const denied = await post("/api/discovery/classes/e2ed_orders/confirm", {}, "alice");
      check(denied.status === 403, `alice's confirmation is refused: ${JSON.stringify(denied)}`);
      const deniedBob = await post("/api/discovery/classes/e2ed_orders/retire", {}, "bob");
      check(deniedBob.status === 403, `bob's retirement is refused: ${JSON.stringify(deniedBob)}`);
      // a worker (an agent at the root) may not either: a person confirms
      const task = (await sql("SELECT @rid AS rid FROM Entity WHERE name = 'Survey: mssql' AND _kind = 'task'"))[0];
      const agent = await post("/api/discovery/classes/e2ed_orders/confirm", {}, workerToken(String(task.rid)));
      check(agent.status === 403, `an agent's confirmation is refused: ${JSON.stringify(agent)}`);
      check((await named_("e2ed_orders"))?.status === "proposed", "orders is still a draft after the refusals");
      // a confirmation with no stages is refused too
      const bare = await post("/api/discovery/classes/e2ed_orders/confirm", { stages: [] });
      check(bare.status === 400 && /at least one stage/.test(bare.error ?? ""), `no stages, no class: ${JSON.stringify(bare)}`);
    },
  },
  {
    name: "discovery: confirmation makes a class available; a retired one maps nothing; a new table is one event",
    async run() {
      // the admin confirms orders, correcting a stage name as they do
      const ok = await post("/api/discovery/classes/e2ed_orders/confirm", { stages: ["quoted", "ordered", "in production", "shipped", "invoiced", "paid"], description: "a customer order: a commitment to deliver" });
      check(ok.status === 200 && ok.class?.status === "confirmed", `confirmed: ${JSON.stringify(ok).slice(0, 300)}`);
      check(ok.class.confirmed_by === "admin" && ok.class.confirmed_at, "by whom and when");
      check(ok.class.stages.join(",") === "quoted,ordered,in_production,shipped,invoiced,paid", `stages normalized: ${ok.class.stages}`);
      const mapped = await resolve("mssql:dbo_E2edOrder:9001");
      check(mapped?.name === "e2ed_orders", `a record key maps to the confirmed class: ${JSON.stringify(mapped)}`);
      check((await classes("confirmed")).some((c) => c.name === "e2ed_orders"), "listed as confirmed");
      check((await resolve("mssql:dbo_E2edJob:4471")) === null, "jobs, still a draft, maps nothing");
      // a confirmation may rename; the old name is gone, the table follows
      const renamed = await post("/api/discovery/classes/e2ed_maintenance/confirm", { name: "e2ed maintenance bookings" });
      check(renamed.status === 200 && renamed.class.name === "e2ed_maintenance_bookings", `renamed on confirmation: ${JSON.stringify(renamed).slice(0, 200)}`);
      check(!(await named_("e2ed_maintenance")) && (await resolve("mssql:dbo_E2edMaintenance:77"))?.name === "e2ed_maintenance_bookings", "the record table maps to the new name");
      // a second class cannot take a confirmed class's table
      const clash = await post("/api/discovery/classes/e2ed_jobs/confirm", { record_table: "mssql:dbo_E2edOrder" });
      check(clash.status === 409, `one table, one class: ${JSON.stringify(clash)}`);
      // retiring takes a class out of every mapping
      const retired = await post("/api/discovery/classes/e2ed_orders/retire", { reason: "e2e" });
      check(retired.status === 200 && retired.class.status === "retired", `retired: ${JSON.stringify(retired).slice(0, 200)}`);
      check((await resolve("mssql:dbo_E2edOrder:9001")) === null, "a retired class maps nothing");
      // incremental discovery: a table already known or retired is no event; a new one is one draft
      const known = await post("/api/discovery/event", { system: "mssql", table: "dbo_E2edJob" });
      check(known.draft === null && /already the record table of "e2ed_jobs"/.test(known.reason), `a known table drafts nothing: ${JSON.stringify(known)}`);
      const gone = await post("/api/discovery/event", { system: "mssql", table: "dbo_E2edOrder" });
      check(gone.draft === null && /retired/.test(gone.reason), `a retired class is not drafted again: ${JSON.stringify(gone)}`);
      const fresh = await post("/api/discovery/event", { system: "mssql", table: { name: "dbo_E2edQuote", columns: ["QuoteID", "CustomerID", "Status", "Price"], status_values: { Status: ["Sent", "Accepted", "Declined"] } } });
      check(fresh.draft?.name === "e2ed_quotes" && fresh.draft.status === "proposed", `a new table is one draft: ${JSON.stringify(fresh).slice(0, 200)}`);
      check((await named_("e2ed_quotes"))?.stages.join(",") === "sent,accepted,declined", "filed with its stages");
      // a worker filing a class it keeps meeting: a draft by that worker, never confirmed
      const filed = await post("/api/discovery/event", { filed: { name: "e2ed shift swaps", stages: ["asked", "agreed", "done"], reason: "three notes this week" }, by: "worker:e2e" });
      check(filed.draft?.name === "e2ed_shift_swaps" && filed.draft.proposed_by === "worker:e2e" && filed.draft.status === "proposed", `a worker's filing is a draft: ${JSON.stringify(filed).slice(0, 200)}`);
      check((await resolve("mssql:dbo_E2edQuote:1")) === null && (await classes("confirmed")).every((c) => c.name !== "e2ed_shift_swaps"), "neither maps until a person confirms");
    },
  },
  {
    name: "discovery: what no class covers is stored, graded and proposed for a person; one occurrence is not a class",
    async run() {
      const sendRecord = (who, title, text) => tool(who, "record_document", { document: { title, description: "a condensed section", reason: "e2e: decision 2", sections: [{ heading: "the matter", text, claims: [] }] } });
      const first = await sendRecord("alice", "e2e-disc apprentice one", "We took on an apprentice for the summer through the county program; the paperwork went in on Monday.");
      check(first.on_record && first.doc_id && first.claims === 0, `stored with no claim: ${JSON.stringify(first).slice(0, 300)}`);
      const section = await until("the section is stored and graded", async () => (await sql(`SELECT _grade, _home FROM Entity WHERE _kind = 'section' AND _doc_id = '${first.doc_id}'`)).find((r) => r._grade));
      check(/graded|admins|kept|Operations/.test(section._grade), `the grader judged it: ${JSON.stringify(section)}`);
      // the agent proposes a class for a person, from the document it just recorded
      const noDoc = await tool("alice", "propose_class", { name: "e2ed apprenticeships", reason: "recurs" });
      check(/document/.test(noDoc.error ?? ""), `a chat agent must say which document: ${JSON.stringify(noDoc)}`);
      const made = await tool("alice", "propose_class", { name: "e2ed apprenticeships", reason: "recurs", document: "00000000-0000-4000-8000-000000000000" });
      check(/on-record document/.test(made.error ?? ""), `a made-up document is refused: ${JSON.stringify(made)}`);
      const proposed = await tool("alice", "propose_class", { name: "e2ed apprenticeships", stages: ["applied", "placed", "finished"], reason: "taking on apprentices comes round each season", document: first.doc_id });
      check(proposed.draft?.status === "proposed" && proposed.draft.proposed_by === "chat:alice", `alice's draft: ${JSON.stringify(proposed).slice(0, 300)}`);
      const row = await named_("e2ed_apprenticeships");
      check(row?.status === "proposed" && row.occurrences.length === 1 && row.confirmed_by === null, `a draft for a person: ${JSON.stringify(row)}`);
      // the admin sees it and, seen once, can't confirm it
      const once = await post("/api/discovery/classes/e2ed_apprenticeships/confirm", {});
      check(once.status === 409 && /seen in one section/.test(once.error ?? ""), `one occurrence is not a class: ${JSON.stringify(once)}`);
      check((await classes("confirmed")).every((c) => c.name !== "e2ed_apprenticeships"), "not confirmed");
      // the same document again counts nothing; a second document is the pattern recurring
      const same = await tool("alice", "propose_class", { name: "e2ed apprenticeships", reason: "recurs", document: first.doc_id });
      check(same.draft === null && same.occurrences === 1, `the same document counts once: ${JSON.stringify(same)}`);
      const second = await sendRecord("bob", "e2e-disc apprentice two", "Second apprentice this year: started on the deburr bench through the county program.");
      check(second.doc_id, `bob's record: ${JSON.stringify(second).slice(0, 200)}`);
      const counted = await tool("bob", "propose_class", { name: "e2ed apprenticeships", reason: "another one on the floor", document: second.doc_id });
      check(counted.counted && counted.occurrences === 2, `a second section counts: ${JSON.stringify(counted)}`);
      const ok = await post("/api/discovery/classes/e2ed_apprenticeships/confirm", {});
      check(ok.status === 200 && ok.class?.status === "confirmed" && ok.class.confirmed_by === "admin", `a person confirms the recurring pattern: ${JSON.stringify(ok).slice(0, 300)}`);
      // actors and resources stay things
      const master = await tool("alice", "propose_class", { name: "work centers", reason: "they keep coming up", document: first.doc_id });
      check(master.draft === null && /master data/.test(master.reason ?? ""), `master data is no class: ${JSON.stringify(master)}`);
      // agents can't confirm: the route is a person's, and there is no such tool
      check(!(await toolsList("alice")).includes("confirm_class"), "no tool confirms");
    },
  },
];

export default scenarios;
