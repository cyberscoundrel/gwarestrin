// S0: the test source the labels assume (docs/build/integrate.md, section 3), and M0, the test map. A
// synthetic dataset in the shape fake-dab-core.mjs serves (`{ table: { primaryKey, rows } }`), its
// declaration (model/sources.js shape, URLs left to the caller), and the columns a write may touch.
// Nothing here is real data. The sources stream's synthetic SQL Server (test-sql/) replaces the dataset for a
// real run; `checkAgainst` in labels.mjs says which labels a different dataset would change.
//
// NEEDS A RULING (S0): which tables and columns are writable is the integrator's assumption, made from the
// notes, until the sources stream publishes its declaration.
// NEEDS A RULING (M0): the test map is keyed by a class's source table, because classes don't exist until
// discovery mints them; no attribute entries (R6 maps classes).

export const SYSTEM = "mssql";

/** the test positions: org > ops > floor, and who records at each */
export const POSITIONS = {
  root: "org",
  positions: {
    org: { name: "Top of the organization", description: "owners and admins" },
    ops: { name: "Operations", parent: "org", description: "orders, customers, suppliers, staffing" },
    floor: { name: "Production floor", parent: "ops", description: "jobs, machines, shifts, maintenance" },
  },
};
export const PEOPLE = { admin: "org", alice: "ops", bob: "floor" };

/** the dataset: table name (as DAB names it) -> { primaryKey, rows } */
export function dataset() {
  return {
    dbo_Employee: {
      primaryKey: ["Employee"],
      rows: [
        { Employee: "NGUD", First_Name: "Diep", Last_Name: "Nguyen", Status: "Active", Department: "Production", Hourly_Rate: 19.5 },
        { Employee: "NGDT", First_Name: "Diep", Last_Name: "Ngo", Status: "Inactive", Department: "Production", Hourly_Rate: 18.0 },
        { Employee: "LOWB", First_Name: "Brian", Last_Name: "Lowe", Status: "Active", Department: "Shipping", Hourly_Rate: 22.0 },
        { Employee: "FRAJ", First_Name: "John", Last_Name: "Franks", Status: "Active", Department: "Assembly", Hourly_Rate: 24.0 },
      ],
    },
    dbo_Customer: {
      primaryKey: ["Customer"],
      rows: [
        { Customer: "EXATRON", Name: "Exatron", Status: "Active" },
        { Customer: "BSE", Name: "BSE", Status: "Active" },
        { Customer: "TORO", Name: "Toro", Status: "Active" },
        { Customer: "COHU-CA", Name: "Cohu", Status: "Active" },
        { Customer: "AETRIUM", Name: "Aetrium", Status: "Active" },
      ],
    },
    dbo_Vendor: {
      primaryKey: ["Vendor"],
      rows: [{ Vendor: "JOHNH", Name: "John Henry Foster", Status: "Active" }],
    },
    dbo_Material: {
      primaryKey: ["Material"],
      rows: [{ Material: "MSP-02110K", Description: "4140 bar, 2.110 in", Location: "Rack C" }],
    },
    dbo_Work_Center: {
      primaryKey: ["Work_Center"],
      rows: [
        { Work_Center: "INSPECT-2", Description: "Inspection 2", Status: "Up" },
        { Work_Center: "CNC", Description: "CNC machining", Status: "Up" },
        { Work_Center: "FINAL INSP", Description: "Final inspection", Status: "Up" },
      ],
    },
    dbo_Job: {
      primaryKey: ["Job"],
      rows: [
        { Job: "3260356", Customer: "EXATRON", Part_Number: "EPP-D98-1-A", Status: "Active", Order_Quantity: 600, Qty_Shipped: 0, Unit_Price: 14.2, Promised_Date: "2026-11-13" },
        { Job: "3260357", Customer: "EXATRON", Part_Number: "EPP-D98-2-B", Status: "Active", Order_Quantity: 600, Qty_Shipped: 0, Unit_Price: 14.2, Promised_Date: "2026-11-13" },
        { Job: "3260372", Customer: "BSE", Part_Number: "BSE-4410", Status: "Active", Order_Quantity: 250, Qty_Shipped: 0, Unit_Price: 31.0, Promised_Date: "2026-11-20" },
        { Job: "4471", Customer: "TORO", Part_Number: "TOR-118", Status: "Active", Order_Quantity: 400, Qty_Shipped: 0, Unit_Price: 9.75, Promised_Date: "2026-12-04" },
      ],
    },
  };
}

/** what may be written: the declaration's tables and actions, and the columns per table */
export const COMMIT = {
  tables: ["dbo_Job", "dbo_Work_Center"],
  actions: ["create", "update"],
  columns: {
    dbo_Job: ["Customer", "Part_Number", "Status", "Order_Quantity", "Qty_Shipped", "Unit_Price", "Promised_Date"],
    dbo_Work_Center: ["Status"],
  },
};

/** the declaration in model/sources.js's shape, given where the fake (or real) endpoints are */
export const declaration = ({ read, write }) => ({
  system: SYSTEM,
  description: "S0: the synthetic test ERP (jobs, work centers, employees, customers, vendors, material)",
  read: { via: "dab-mcp", url: read },
  commit: write ? { via: "dab-mcp", url: write, tables: COMMIT.tables, actions: COMMIT.actions } : { via: "none" },
});

/** M0: source table -> the position whose holders (and those above) have authority */
export const MAP = {
  "mssql:dbo_Job": "ops",
  "mssql:dbo_Work_Center": "floor",
  "mssql:dbo_Customer": "ops",
  "mssql:dbo_Vendor": "ops",
  "mssql:dbo_Material": "ops",
  "mssql:dbo_Employee": "org",
};

/** a row's key as the contract writes it: system:table:row (several key columns joined by ",") */
export const rowKey = (table, primaryKey, row) => `${SYSTEM}:${table}:${primaryKey.map((c) => row[c]).join(",")}`;
