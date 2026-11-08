// The Discovery stream's acceptance scenarios for the replay harness (see
// run.mjs and e2e.sh): the survey drafts the ux tree's classes; an
// unconfirmed class maps nothing; confirmation makes it available. Exported
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
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const classes = async (status) => (await api(`/api/discovery/classes${status ? `?status=${status}` : ""}`)).classes ?? [];
const named = async (name) => (await classes()).find((c) => c.name === name);
const resolve = async (key) => (await api(`/api/discovery/resolve?key=${encodeURIComponent(key)}`)).class ?? null;

/** the ux test tree's ERP, digested the way an agent gets it (connection-digest.ts), with the status values the survey read */
const UX_DIGEST_TEXT = [
  "Tables (8, all named dbo_…): Customer, Employee, Vendor, WorkCenter, Order, Job, Maintenance, OrderStatus",
  "dbo_Customer columns: CustomerID, Name, CreditLimit, PaymentTerms",
  "dbo_Employee columns: EmployeeID, Name, WorkCenterID, Shift",
  "dbo_Vendor columns: VendorID, Name, Terms",
  "dbo_WorkCenter columns: WorkCenterID, Name, Capacity",
  "dbo_OrderStatus columns: StatusCode, Description",
  "dbo_Order columns: OrderID, CustomerID, Status, Quantity, DueDate, Price, Margin",
  "dbo_Order rows: 9,120",
  "dbo_Order Status values: Quoted, Ordered, In Production, Shipped, Invoiced, Paid",
  "dbo_Job columns: JobID, Status, MachineID, OperatorID, ShiftCover, Quantity, DueDate",
  "dbo_Job rows: 31,400",
  "dbo_Job Status values: Planned, Running, Paused, Done",
  "dbo_Maintenance columns: MaintenanceID, Status, MachineID, TechnicianID, BookedFor, Parts",
  "dbo_Maintenance rows: 403",
  "dbo_Maintenance Status values: Booked, In Progress, Done",
].join("\n");
const UX_PATTERNS = [{ name: "mssql: hiring (pattern)", text: "Hiring runs outside the ERP. [class: hires; stages: opened, interviewing, offered, hired, declined; table: none; attributes: candidate, start_date, pay, dismissal; description: a hire: a commitment of a position to a person; no source system records it]" }];
const UX_CLASSES = { orders: "mssql:dbo_Order", jobs: "mssql:dbo_Job", maintenance: "mssql:dbo_Maintenance", hires: null };

export const scenarios = [
  {
    name: "discovery: the survey drafts the ux tree's classes, proposed and unconfirmed, master data as things",
    async run() {
      // the survey thread files one draft the way its brief says: a proposed CommitmentClass through execute_graph, applied by the admin
      await tool("admin", "execute_graph", { language: "sql", command: "CREATE VERTEX Entity SET name = 'e2e-disc survey task', _kind = 'task', _home = 'org', _origin = 'org'" });
      const task = (await sql("SELECT @rid AS rid FROM Entity WHERE name = 'e2e-disc survey task' AND _kind = 'task'"))[0];
      check(task?.rid, "the survey's task entry exists");
      await classes(); // the class type is declared on first use
      const filed = await tool(workerToken(String(task.rid)), "execute_graph", {
        language: "sql",
        command:
          "INSERT INTO CommitmentClass SET name = 'maintenance', description = 'a maintenance booking: a commitment of a machine\\'s time to a service', stages = ['booked', 'in_progress', 'done'], record_table = 'mssql:dbo_Maintenance', status = 'proposed', proposed_by = 'survey:mssql', confirmed_by = null, confirmed_at = null, attributes = ['stage', 'machine', 'technician', 'booked_for', 'parts'], reasons = ['dbo_Maintenance names maintenance: rows are commitments', 'stages from the distinct values of Status', '403 rows']",
        reason: "the survey's draft class for dbo_Maintenance",
      });
      check(filed.pendingId, `a worker's raw write is a proposal, not a confirmation: ${JSON.stringify(filed).slice(0, 300)}`);
      check(!(await named("maintenance")), "nothing is filed until the admin applies the proposal");
      const applied = await post(`/api/worker/proposals/${filed.pendingId}`, { approve: true, reason: "e2e" });
      check(applied.approved, `applied: ${JSON.stringify(applied).slice(0, 300)}`);
      const m = await named("maintenance");
      check(m?.status === "proposed", `the survey's draft is proposed, not confirmed: ${JSON.stringify(m)}`);
      check(m.confirmed_by === null && m.confirmed_at === null, "nobody has confirmed it");
      // the loader drafts the rest from the digest; the survey's own draft is not drafted twice
      const r = await post("/api/discovery/draft", { system: "mssql", digest: UX_DIGEST_TEXT, patterns: UX_PATTERNS });
      check(r.status === 200, `drafted: ${JSON.stringify(r).slice(0, 300)}`);
      check(
        r.drafted.map((d) => d.name).sort().join(",") === "hires,jobs,orders",
        `three new drafts: ${r.drafted.map((d) => d.name).join(", ")}`,
      );
      check(r.not_drafted.some((s) => s.name === "maintenance" && /already proposed/.test(s.reason)), `maintenance skipped as the survey's: ${JSON.stringify(r.not_drafted)}`);
      const master = Object.fromEntries(r.tables_skipped.map((s) => [s.table, s]));
      check(master.dbo_Customer?.role === "actor" && master.dbo_WorkCenter?.role === "resource", `master data are actors or resources: ${JSON.stringify(r.tables_skipped).slice(0, 300)}`);
      check(master.dbo_OrderStatus?.kind === "lookup", "a lookup table is neither");
      for (const [name, table] of Object.entries(UX_CLASSES)) {
        const c = await named(name);
        check(c?.status === "proposed", `${name} is proposed: ${JSON.stringify(c)}`);
        check(c.record_table === table, `${name} records in ${table}: ${c.record_table}`);
        check(c.stages.length >= 3, `${name} has stages: ${c.stages.join(", ")}`);
        check(c.reasons.length >= 1, `${name} says why`);
      }
      check((await named("orders")).stages.join(",") === "quoted,ordered,in_production,shipped,invoiced,paid", "orders' stages come from the status column's values");
      // the same digest again drafts nothing new
      const again = await post("/api/discovery/draft", { system: "mssql", digest: UX_DIGEST_TEXT, patterns: UX_PATTERNS });
      check(again.drafted.length === 0 && again.not_drafted.length === 4, `a re-run adds nothing: ${JSON.stringify(again).slice(0, 300)}`);
    },
  },
  {
    name: "discovery: an unconfirmed class maps nothing, and only a person at the root may confirm",
    async run() {
      check((await named("orders"))?.status === "proposed", "orders is still a draft");
      check((await resolve("mssql:dbo_Order:9001")) === null, "a record key of a proposed class maps to no class");
      check((await resolve("mssql:dbo_Job:4471")) === null, "nor does a job's");
      check((await classes("confirmed")).every((c) => !(c.name in UX_CLASSES)), "none of the drafts is listed as confirmed");
      // alice (Operations) and bob (the floor) may read but not confirm
      const alice = await api("/api/discovery/classes", {}, "alice");
      check(alice.status === 200 && alice.canConfirm === false, `alice reads, cannot confirm: ${JSON.stringify(alice).slice(0, 120)}`);
      const denied = await post("/api/discovery/classes/orders/confirm", {}, "alice");
      check(denied.status === 403, `alice's confirmation is refused: ${JSON.stringify(denied)}`);
      const deniedBob = await post("/api/discovery/classes/orders/retire", {}, "bob");
      check(deniedBob.status === 403, `bob's retirement is refused: ${JSON.stringify(deniedBob)}`);
      // a worker (an agent at the root) may not either: a person confirms
      const task = (await sql("SELECT @rid AS rid FROM Entity WHERE name = 'e2e-disc survey task' AND _kind = 'task'"))[0];
      const agent = await post("/api/discovery/classes/orders/confirm", {}, workerToken(String(task.rid)));
      check(agent.status === 403, `an agent's confirmation is refused: ${JSON.stringify(agent)}`);
      check((await named("orders"))?.status === "proposed", "orders is still a draft after the refusals");
      // a confirmation with no stages is refused too
      const bare = await post("/api/discovery/classes/orders/confirm", { stages: [] });
      check(bare.status === 400 && /at least one stage/.test(bare.error ?? ""), `no stages, no class: ${JSON.stringify(bare)}`);
    },
  },
  {
    name: "discovery: confirmation makes a class available; a retired one maps nothing; a new table is one event",
    async run() {
      // the admin confirms orders, correcting a stage name as they do
      const ok = await post("/api/discovery/classes/orders/confirm", { stages: ["quoted", "ordered", "in production", "shipped", "invoiced", "paid"], description: "a customer order: a commitment to deliver" });
      check(ok.status === 200 && ok.class?.status === "confirmed", `confirmed: ${JSON.stringify(ok).slice(0, 300)}`);
      check(ok.class.confirmed_by === "admin" && ok.class.confirmed_at, "by whom and when");
      check(ok.class.stages.join(",") === "quoted,ordered,in_production,shipped,invoiced,paid", `stages normalized: ${ok.class.stages}`);
      const mapped = await resolve("mssql:dbo_Order:9001");
      check(mapped?.name === "orders", `a record key maps to the confirmed class: ${JSON.stringify(mapped)}`);
      check((await classes("confirmed")).some((c) => c.name === "orders"), "listed as confirmed");
      check((await resolve("mssql:dbo_Job:4471")) === null, "jobs, still a draft, maps nothing");
      // a confirmation may rename; the old name is gone, the table follows
      const renamed = await post("/api/discovery/classes/maintenance/confirm", { name: "maintenance bookings" });
      check(renamed.status === 200 && renamed.class.name === "maintenance_bookings", `renamed on confirmation: ${JSON.stringify(renamed).slice(0, 200)}`);
      check(!(await named("maintenance")) && (await resolve("mssql:dbo_Maintenance:77"))?.name === "maintenance_bookings", "the record table maps to the new name");
      // a second class cannot take a confirmed class's table
      const clash = await post("/api/discovery/classes/jobs/confirm", { record_table: "mssql:dbo_Order" });
      check(clash.status === 409, `one table, one class: ${JSON.stringify(clash)}`);
      // retiring takes a class out of every mapping
      const retired = await post("/api/discovery/classes/orders/retire", { reason: "e2e" });
      check(retired.status === 200 && retired.class.status === "retired", `retired: ${JSON.stringify(retired).slice(0, 200)}`);
      check((await resolve("mssql:dbo_Order:9001")) === null, "a retired class maps nothing");
      // incremental discovery: a table already known or retired is no event; a new one is one draft
      const known = await post("/api/discovery/event", { system: "mssql", table: "dbo_Job" });
      check(known.draft === null && /already the record table of "jobs"/.test(known.reason), `a known table drafts nothing: ${JSON.stringify(known)}`);
      const gone = await post("/api/discovery/event", { system: "mssql", table: "dbo_Order" });
      check(gone.draft === null && /retired/.test(gone.reason), `a retired class is not drafted again: ${JSON.stringify(gone)}`);
      const fresh = await post("/api/discovery/event", { system: "mssql", table: { name: "dbo_Quote", columns: ["QuoteID", "CustomerID", "Status", "Price"], status_values: { Status: ["Sent", "Accepted", "Declined"] } } });
      check(fresh.draft?.name === "quotes" && fresh.draft.status === "proposed", `a new table is one draft: ${JSON.stringify(fresh).slice(0, 200)}`);
      check((await named("quotes"))?.stages.join(",") === "sent,accepted,declined", "filed with its stages");
      // a worker filing a class it keeps meeting: a draft by that worker, never confirmed
      const filed = await post("/api/discovery/event", { filed: { name: "shift swaps", stages: ["asked", "agreed", "done"], reason: "three notes this week" }, by: "worker:e2e" });
      check(filed.draft?.name === "shift_swaps" && filed.draft.proposed_by === "worker:e2e" && filed.draft.status === "proposed", `a worker's filing is a draft: ${JSON.stringify(filed).slice(0, 200)}`);
      check((await resolve("mssql:dbo_Quote:1")) === null && (await classes("confirmed")).every((c) => c.name !== "shift_swaps"), "neither maps until a person confirms");
    },
  },
];

export default scenarios;
