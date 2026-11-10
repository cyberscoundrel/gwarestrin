// The test source the labels are judged against, and M0, the test map (docs/build/integrate.md, section 3).
//
// The source is the sources stream's synthetic database, read from its own module (test-sql/data.mjs): the same
// rows feed its SQL seed (compose project gwsynth), the unit tests' fake DAB, the replay harness's fake source
// (e2e/fake-source.mjs) and these labels, so all four hold one dataset. This file only reshapes it: tables as DAB
// names them (`dbo_Job`), `{ primaryKey, rows }` as fake-dab-core.mjs serves them, and what a write may touch, from
// test-sql's WRITABLE. Nothing here is real data. (The file keeps its name from S0, the integrator's assumed source
// the first labels were written against; the synthetic database replaced it on 2026-11-10.)
//
// OPEN (R11.15): which database the first real-model run copies, and which models may see it, is the user's to
// answer. The synthetic database stands in for it with invented rows only; using it is not that answer.
//
// NEEDS A RULING (M0): the test map is keyed by a class's source table, because classes don't exist until
// discovery mints them; no attribute entries (R6 maps classes). The positions follow the test positions' own
// descriptions: the floor holds "jobs, machines, shifts, maintenance"; Operations holds "orders, customers,
// suppliers, staffing"; employees (pay, hiring) sit at the root. Before a real run, an admin sets the system's class
// map from this, one entry per class discovery made from these tables.
import { TABLES, WRITABLE, keyColumn } from "../../test-sql/data.mjs";

export const SYSTEM = "mssql";

/** the test positions: org > ops > floor, and who records at each */
export const POSITIONS = {
  root: "org",
  positions: {
    org: { name: "Top of the organization", description: "owners and admins: pay, dismissal, prices and margins" },
    ops: { name: "Operations", parent: "org", description: "orders, customers, suppliers, staffing" },
    floor: { name: "Production floor", parent: "ops", description: "jobs, machines, shifts, maintenance" },
  },
};
export const PEOPLE = { admin: "org", alice: "ops", bob: "floor" };

const entity = (table) => `dbo_${table}`;

/** the dataset: table name (as DAB names it) -> { primaryKey, rows }, a fresh copy each call */
export function dataset() {
  return Object.fromEntries(Object.entries(TABLES).map(([t, v]) => [entity(t), { primaryKey: [keyColumn(t)], rows: v.rows.map((r) => ({ ...r })) }]));
}

/**
 * What may be written: per table, the actions the write login has (test-sql WRITABLE: create and update, never
 * delete) and the columns (every column but the key; DAB's entity permissions name no column limits).
 */
export const COMMIT = {
  tables: Object.fromEntries(Object.entries(WRITABLE).map(([t, actions]) => [entity(t), actions])),
  columns: Object.fromEntries(Object.keys(WRITABLE).map((t) => [entity(t), TABLES[t].columns.filter((c) => !c.key).map((c) => c.name)])),
};

/** M0: source table -> the position whose holders (and those above) have authority (NEEDS A RULING, above) */
export const MAP = {
  "mssql:dbo_Job": "floor",
  "mssql:dbo_Job_Operation": "floor",
  "mssql:dbo_Work_Center": "floor",
  "mssql:dbo_Equipment": "floor",
  "mssql:dbo_Maintenance": "floor",
  "mssql:dbo_Time_Punch": "floor",
  "mssql:dbo_Sales_Order": "ops",
  "mssql:dbo_Customer": "ops",
  "mssql:dbo_Vendor": "ops",
  "mssql:dbo_Purchase_Order": "ops",
  "mssql:dbo_Material": "ops",
  "mssql:dbo_Employee": "org",
};

/** a row's key as the contract writes it: system:table:row (several key columns joined by ",") */
export const rowKey = (table, primaryKey, row) => `${SYSTEM}:${table}:${primaryKey.map((c) => row[c]).join(",")}`;
