// Live checks of graph-rag's source adapters (graph-rag/src/data-entry.js) against the synthetic test SQL Server
// through its two real DABs. Run by check.sh in a container on the project's api network, with the checkout
// mounted read-only at /repo. Each phase prints "ok"/"FAIL" lines and exits non-zero on any failure.
//
//   node check.mjs adapters                 read, find, guard, write, create, moved, not writable
//   node check.mjs parity                   the fake DAB (graph-rag/e2e/fake-dab-core.mjs) answers as the real one
//   node check.mjs guard <database> <pass|refuse>
//   node check.mjs write-copy <database>    a guarded write lands in <database> (the DABs point at it)
import { TABLES, entityOf, keyColumn } from "./data.mjs";

const REPO = process.env.REPO ?? "/repo";
const de = await import(`${REPO}/graph-rag/src/data-entry.js`);
const { normalizeSource } = await import(`${REPO}/graph-rag/src/model/sources.js`);
const { testDeclaration } = await import(`${REPO}/graph-rag/src/sources.js`);
const { dabTool } = await import(`${REPO}/graph-rag/e2e/fake-dab-core.mjs`);

const READ = "http://dab-read:5000/mcp";
const WRITE = "http://dab-write:5000/mcp";
const fails = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails.push(what);
};
const decl = (database = "GwSynthMfg") => ({ mssql: normalizeSource(testDeclaration({ database })) });
function journal() {
  const entries = [];
  return { entries, begin: async (a) => (entries.push({ ...a, status: "begun" }), entries.length - 1), settle: async (id, status, d) => Object.assign(entries[id], { status, ...d }) };
}
const opts = (extra = {}) => ({ sources: decl(), ...extra });

async function adapters() {
  const tables = await de.describeSource("mssql", opts());
  check(tables.status === "found" && Object.keys(TABLES).every((t) => tables.tables.includes(entityOf(t))), `the read DAB exposes every table: ${tables.tables?.length}`);
  const ngud = await de.getRow("mssql:dbo_Employee:NGUD", opts());
  check(ngud.status === "found" && ngud.row.Status === "Active", `a row by key: ${ngud.status}`);
  check((await de.getRow("mssql:dbo_Job:4471", opts())).row?.Customer === "TORO", "a number key");
  const dieps = await de.findRows({ system: "mssql", table: "dbo_Employee", column: "First_Name", value: "diep" }, opts());
  check(dieps.status === "ambiguous" && dieps.rows.map((r) => r.key).join() === "mssql:dbo_Employee:NGDT,mssql:dbo_Employee:NGUD", `two Dieps, case-insensitively: ${dieps.rows?.map((r) => r.key)}`);
  const active = await de.findRows({ system: "mssql", table: "dbo_Employee", column: "First_Name", value: "Diep", also: { Status: "Active" } }, opts());
  check(active.status === "found" && active.rows[0].key === "mssql:dbo_Employee:NGUD", `narrowed to the active one: ${active.status}`);
  const exa = await de.findRows({ system: "mssql", table: "dbo_Customer", column: "Name", value: "exa", mode: "prefix" }, opts());
  check(exa.status === "found" && exa.rows[0].key === "mssql:dbo_Customer:EXATRON", `a prefix as a range: ${exa.status}`);
  const cnc = await de.findRows({ system: "mssql", table: "dbo_Work_Center", column: "Work_Center", value: "cnc", mode: "prefix", first: 3 }, opts());
  check(cnc.status === "ambiguous" && cnc.rows.length === 3 && cnc.more, `a capped prefix says there are more: ${cnc.rows?.length} ${cnc.more}`);
  check((await de.findRows({ system: "mssql", table: "dbo_Customer", column: "Name", value: "Corvane Medical" }, opts())).status === "none", "a name with no row");
  const bad = await de.findRows({ system: "mssql", table: "dbo_Customer", column: "Nope", value: "x" }, opts());
  check(bad.status === "refused", `an unknown column is refused: ${bad.why}`);
  await de.mcpToolCall(READ, "update_record", { entity: "dbo_Job", keys: { Job: 4471 }, fields: { Priority: 1 } }).then(
    () => check(false, "the read DAB updated a row"),
    (e) => check(e.errorType === "PermissionDenied", `the read DAB refuses an update: ${e.errorType}`),
  );
  await de.mcpToolCall(WRITE, "delete_record", { entity: "dbo_Job", keys: { Job: 4471 } }).then(
    () => check(false, "the write DAB deleted a row"),
    (e) => check(e.errorType === "PermissionDenied", `the write DAB refuses a delete: ${e.errorType}`),
  );
  await de.mcpToolCall(WRITE, "read_records", { entity: "dbo_Customer", first: 1 }).then(
    () => check(false, "the write DAB exposes a table it may not write"),
    (e) => check(e.errorType === "EntityNotFound", `the write DAB exposes only its tables: ${e.errorType}`),
  );

  const g = await de.checkGuard(decl().mssql);
  check(g.ok && g.server === "gwsynth-sql" && g.database === "GwSynthMfg" && g.login === "gwsynth_write", `the guard reads the write connection: ${g.server}/${g.database} as ${g.login}`);
  const wrong = await de.checkGuard(decl("ErpLive").mssql);
  check(!wrong.ok && /not the declared gwsynth-sql\/ErpLive/.test(wrong.why), `the guard refuses other names: ${wrong.why}`);

  const log = journal();
  const w = await de.commitRow({ key: "mssql:dbo_Job:3260410", fields: { Promised_Date: "2026-12-12" }, before: { Promised_Date: "2026-12-05" } }, opts({ journal: log }));
  check(w.status === "written" && log.entries[0]?.status === "written", `ux-aj02's due date written, logged first: ${w.status} ${w.why ?? ""}`);
  const after = await de.getRow("mssql:dbo_Job:3260410", opts());
  check(String(after.row?.Promised_Date).startsWith("2026-12-12"), `the read side sees it: ${after.row?.Promised_Date}`);
  const again = await de.commitRow({ key: "mssql:dbo_Job:3260410", fields: { Promised_Date: "2026-12-19" }, before: { Promised_Date: "2026-12-05" } }, opts({ journal: log }));
  check(again.status === "moved" && log.entries.length === 1, `a row that moved since it was read is not written over: ${again.status}`);
  const already = await de.commitRow({ key: "mssql:dbo_Job:3260410", fields: { Promised_Date: "2026-12-12" } }, opts({ journal: log }));
  check(already.status === "already", `a row already holding it needs no write: ${already.status}`);
  const cust = await de.commitRow({ key: "mssql:dbo_Customer:EXATRON", fields: { Terms: "Net 45" } }, opts({ journal: log }));
  check(cust.status === "not_writable" && cust.filing === "proposed", `a table not declared writable is Proposed: ${cust.status}`);
  const nolog = await de.commitRow({ key: "mssql:dbo_Job:4471", fields: { Priority: 1 } }, opts({ journal: null }));
  check(nolog.status === "refused" && (await de.getRow("mssql:dbo_Job:4471", opts())).row.Priority === 5, `no filing log, no write: ${nolog.why}`);
  const guarded = await de.commitRow({ key: "mssql:dbo_Job:4471", fields: { Priority: 1 } }, { sources: decl("ErpLive"), journal: journal() });
  check(guarded.status === "refused" && (await de.getRow("mssql:dbo_Job:4471", opts())).row.Priority === 5, `the guard stops a write to other names: ${guarded.status}`);
  const made = await de.createRow({ system: "mssql", table: "dbo_Maintenance", data: { Equipment: "FL-TOYOTA", Opened: "2026-11-09", Description: "Backup beeper not working; tagged out (ux-aa05)", Status: "Open" } }, opts({ journal: log }));
  check(made.status === "written" && /^mssql:dbo_Maintenance:\d+$/.test(made.key ?? ""), `a create returns the key the source made: ${made.key}`);
  const createJob = await de.createRow({ system: "mssql", table: "dbo_Job", data: { Job: 1, Customer: "TORO" } }, opts({ journal: log }));
  check(createJob.status === "refused" && createJob.filing === "held", `the write login can't create where it may only update: ${createJob.status}`);
  const unreachable = await de.getRow("mssql:dbo_Job:4471", { sources: { mssql: normalizeSource({ ...testDeclaration(), read: { via: "dab-mcp", url: "http://nowhere.invalid:5000/mcp" } }) } });
  check(unreachable.status === "unreachable" && unreachable.filing === "held", `an unreachable source points to Held: ${unreachable.status}`);
}

/** the fake DAB, loaded with data.mjs, against the real one: the same calls, the same answers */
async function parity() {
  const fakeTables = () => Object.fromEntries(Object.entries(TABLES).map(([t, v]) => [entityOf(t), { primaryKey: [keyColumn(t)], identity: v.columns.some((c) => c.identity), rows: v.rows.map((r) => ({ ...r })) }]));
  const readTables = fakeTables();
  const writeTables = Object.fromEntries(["Job", "Maintenance"].map((t) => [entityOf(t), readTables[entityOf(t)]]));
  const parse = (r) => JSON.parse(r.content[0].text);
  const real = async (url, name, args) => de.mcpToolCall(url, name, args).then((r) => ({ ok: true, r }), (e) => ({ ok: false, type: e.errorType, message: e.errorMessage ?? e.message }));
  const fake = (write, name, args) => {
    const r = dabTool(write ? writeTables : readTables, name, args, { write });
    return r.isError ? { ok: false, type: parse(r).error?.type, message: parse(r).error?.message } : { ok: true, r: parse(r) };
  };
  const keys = (x, table) => (de.rowsOf(x.r).map((row) => row[keyColumn(table)]) ?? []).join(",");
  const cases = [
    ["Employee", false, "read_records", { entity: "dbo_Employee", filter: "First_Name eq 'diep'" }],
    ["Employee", false, "read_records", { entity: "dbo_Employee", filter: "First_Name eq 'Diep' and Status eq 'Active'" }],
    ["Customer", false, "read_records", { entity: "dbo_Customer", filter: "Name ge 'exa'", orderby: ["Name asc"], first: 2 }],
    ["Work_Center", false, "read_records", { entity: "dbo_Work_Center", filter: "Work_Center ge 'CNC' and Work_Center lt 'CND'" }],
    ["Job", false, "read_records", { entity: "dbo_Job", filter: "Job eq 3260357 or Job eq 4471" }],
    ["Job", false, "read_records", { entity: "dbo_Job", filter: "Status ne 'Active'" }],
    ["Job", false, "read_records", { entity: "dbo_Job", first: 1 }],
    ["Job", false, "read_records", { entity: "dbo_Job", filter: "Job eq '4471'" }],
    ["Customer", false, "read_records", { entity: "dbo_Customer", filter: "contains(Name,'Exa')" }],
    ["Customer", false, "read_records", { entity: "dbo_Customer", filter: "Nope eq 'x'" }],
    ["Job", false, "update_record", { entity: "dbo_Job", keys: { Job: 4471 }, fields: { Priority: 1 } }],
    ["Job", true, "update_record", { entity: "dbo_Job", keys: { Job: 1 }, fields: { Priority: 1 } }],
    ["Job", true, "update_record", { entity: "dbo_Job", keys: { Job: 4471 }, fields: { Nope: 1 } }],
    ["Job", true, "update_record", { entity: "dbo_Job", keys: { Job: 4471 }, fields: { Job: 4472 } }],
    ["Maintenance", true, "create_record", { entity: "dbo_Maintenance", data: { Maintenance: 99, Opened: "2026-11-09", Description: "x", Status: "Open" } }],
    ["Job", true, "delete_record", { entity: "dbo_Job", keys: { Job: 4471 } }],
    ["Customer", true, "read_records", { entity: "dbo_Customer" }],
  ];
  for (const [table, write, name, args] of cases) {
    const a = await real(write ? WRITE : READ, name, args);
    const b = fake(write, name, args);
    const what = `${write ? "write" : "read"} ${name} ${JSON.stringify(args).slice(0, 90)}`;
    if (a.ok !== b.ok) check(false, `${what}: real ${a.ok ? "answered" : a.type}, fake ${b.ok ? "answered" : b.type}`);
    else if (!a.ok) check(a.type === b.type && a.message === b.message, `${what}: both refuse, ${a.type}${a.message === b.message ? "" : `: real "${a.message}", fake "${b.message}"`}`);
    else {
      const ka = keys(a, table);
      const kb = keys(b, table);
      const ca = Boolean(a.r?.result?.after);
      const cb = Boolean(b.r?.result?.after);
      check(ka === kb && ca === cb, `${what}: rows ${ka || "none"}${ka === kb ? "" : ` vs fake ${kb}`}, cursor ${ca}${ca === cb ? "" : ` vs fake ${cb}`}`);
    }
  }
}

async function guardPhase(database, expect) {
  const g = await de.checkGuard(decl(database).mssql);
  check(expect === "pass" ? g.ok && g.database === database : !g.ok, `guard declared for ${database}: ${g.ok ? "passes" : `refuses (${g.why})`}`);
}

async function writeCopy(database) {
  const log = journal();
  const w = await de.commitRow({ key: "mssql:dbo_Job:4471", fields: { Priority: 2 }, before: { Priority: 5 } }, { sources: decl(database), journal: log });
  check(w.status === "written", `a guarded write lands in ${database}: ${w.status} ${w.why ?? ""}`);
}

const [phase, ...rest] = process.argv.slice(2);
if (phase === "adapters") await adapters();
else if (phase === "parity") await parity();
else if (phase === "guard") await guardPhase(...rest);
else if (phase === "write-copy") await writeCopy(...rest);
else {
  console.error("usage: check.mjs adapters | parity | guard <database> <pass|refuse> | write-copy <database>");
  process.exit(2);
}
process.exit(fails.length ? 1 : 0);
