// The synthetic manufacturing database: invented rows for a small machine shop, so the 62 test notes
// (graph-rag/test/fixtures/oracle-sixty.json) can be filed against a real SQL Server without any real data.
//
// Names and keys the notes carry are kept as the fixture has them (customers, vendors, employees, jobs, work
// centers); every other value here is invented. No real schema was looked at: the real ERP and the host's
// mssql-server and tcmautomation containers are not touched (R11.15, open).
//
// One module feeds both the SQL seed (seed.mjs) and the unit tests' fake DAB (graph-rag/test/sources.test.js),
// so both hold the same rows.
//
// Some cases are here on purpose, for filing to meet:
//   - two employees called Diep: NGUD active, NGDT inactive (ux-aq01, ux-aa07)
//   - two forklifts, so "the forklift" (ux-aj09) names neither alone
//   - names with no row: Darrin S., Corvane Medical (a prospect), Kayla and Andre (temps from an agency)
//   - job 4471 is Toro's, and Toro's PO on it is also 4471 (ux-w11)
//   - job 3260357 holds 600 pieces due 2026-12-04, which ux-ab05's "1,200 pieces, due mid December" disagrees with
//   - transactional tables (operations, time punches, maintenance, purchase orders) with single surrogate keys:
//     a record key names one column (docs/build/sources.md, unclear item 6)

/** the database and server the guard expects; a restored copy changes only these (test-sql/README.md) */
export const DATABASE = "GwSynthMfg";
export const SERVER = "gwsynth-sql";
export const READ_LOGIN = "gwsynth_read";
export const WRITE_LOGIN = "gwsynth_write";
/** the view the guard reads through the write connection: computed on that connection, never stored */
export const IDENTITY_VIEW = "GwConnectionIdentity";

const t = (columns, rows, extra = {}) => ({ columns, rows, ...extra });
const col = (name, type, opts = {}) => ({ name, type, ...opts });

export const TABLES = {
  Customer: t(
    [col("Customer", "nvarchar(20)", { key: true }), col("Name", "nvarchar(80)"), col("Status", "nvarchar(12)"), col("City", "nvarchar(40)"), col("State", "nchar(2)"), col("Terms", "nvarchar(20)"), col("Credit_Limit", "decimal(12,2)")],
    [
      { Customer: "AETRIUM", Name: "Aetrium", Status: "Active", City: "North Branch", State: "MN", Terms: "Net 30", Credit_Limit: 40000 },
      { Customer: "BRIGHTLINE", Name: "Brightline Medical", Status: "Active", City: "Plymouth", State: "MN", Terms: "Net 45", Credit_Limit: 120000 },
      { Customer: "BSE", Name: "BSE", Status: "Active", City: "Eagan", State: "MN", Terms: "Net 30", Credit_Limit: 25000 },
      { Customer: "COHU-CA", Name: "Cohu", Status: "Active", City: "Poway", State: "CA", Terms: "Net 30", Credit_Limit: 60000 },
      { Customer: "EXATRON", Name: "Exatron", Status: "Active", City: "San Jose", State: "CA", Terms: "Net 30", Credit_Limit: 150000 },
      { Customer: "MONTANA", Name: "Montana Instruments", Status: "Active", City: "Bozeman", State: "MT", Terms: "Net 30", Credit_Limit: 30000 },
      { Customer: "TORO", Name: "Toro", Status: "Active", City: "Bloomington", State: "MN", Terms: "Net 30", Credit_Limit: 50000 },
    ],
  ),
  Vendor: t(
    [col("Vendor", "nvarchar(20)", { key: true }), col("Name", "nvarchar(80)"), col("Status", "nvarchar(12)"), col("Supplies", "nvarchar(80)"), col("Terms", "nvarchar(20)")],
    [
      { Vendor: "BLASER", Name: "Blaser", Status: "Active", Supplies: "coolant", Terms: "Net 30" },
      { Vendor: "HANGSTER", Name: "Hangsterfer's", Status: "Active", Supplies: "coolant", Terms: "Net 30" },
      { Vendor: "HILL", Name: "HILL", Status: "Active", Supplies: "gages and pins", Terms: "Net 30" },
      { Vendor: "HYDMECH", Name: "Hyd-Mech", Status: "Active", Supplies: "saw parts and blades", Terms: "Net 30" },
      { Vendor: "JOHNH", Name: "John Henry Foster", Status: "Active", Supplies: "compressor service", Terms: "Net 30" },
      { Vendor: "MASTERFL", Name: "Master Fluid", Status: "Active", Supplies: "coolant", Terms: "Net 30" },
      { Vendor: "METALSUP", Name: "Metal Supply Co", Status: "Active", Supplies: "bar stock: 4140, titanium, aluminum", Terms: "Net 30" },
      { Vendor: "STAFFMRK", Name: "Staffmark", Status: "Active", Supplies: "temporary staff", Terms: "Net 15" },
    ],
  ),
  Work_Center: t(
    [col("Work_Center", "nvarchar(20)", { key: true }), col("Description", "nvarchar(80)"), col("Department", "nvarchar(30)"), col("Status", "nvarchar(12)"), col("Status_Note", "nvarchar(200)", { nullable: true })],
    [
      { Work_Center: "CNC 1", Description: "Vertical machining center", Department: "Machining", Status: "Up", Status_Note: null },
      { Work_Center: "CNC 2", Description: "Vertical machining center", Department: "Machining", Status: "Up", Status_Note: null },
      { Work_Center: "CNC 3", Description: "Horizontal machining center", Department: "Machining", Status: "Up", Status_Note: null },
      { Work_Center: "CNC 4", Description: "Turning center", Department: "Machining", Status: "Up", Status_Note: null },
      { Work_Center: "CNC 5", Description: "Turning center with bar feeder", Department: "Machining", Status: "Up", Status_Note: null },
      { Work_Center: "DEBURR", Description: "Deburr bench", Department: "Finishing", Status: "Up", Status_Note: null },
      { Work_Center: "FINAL INSP", Description: "Final inspection", Department: "Quality", Status: "Up", Status_Note: null },
      { Work_Center: "INSPECT-2", Description: "In-process inspection, gage bench", Department: "Quality", Status: "Up", Status_Note: null },
      { Work_Center: "SAW", Description: "Hyd-Mech band saw", Department: "Material", Status: "Up", Status_Note: null },
      { Work_Center: "SHIPPING", Description: "Shipping and receiving dock", Department: "Shipping", Status: "Up", Status_Note: null },
    ],
  ),
  Employee: t(
    [col("Employee", "nvarchar(10)", { key: true }), col("First_Name", "nvarchar(40)"), col("Last_Name", "nvarchar(40)"), col("Status", "nvarchar(12)"), col("Type", "nvarchar(12)"), col("Department", "nvarchar(30)"), col("Hire_Date", "date"), col("Pay_Rate", "decimal(8,2)", { nullable: true })],
    [
      { Employee: "ALEXR", First_Name: "Alexander", Last_Name: "Ruiz", Status: "Active", Type: "Regular", Department: "Quality", Hire_Date: "2019-04-15", Pay_Rate: 27.0 },
      { Employee: "FRAJ", First_Name: "John", Last_Name: "Fraley", Status: "Active", Type: "Regular", Department: "Assembly", Hire_Date: "2016-09-06", Pay_Rate: 29.25 },
      { Employee: "KARLM", First_Name: "Karl", Last_Name: "Moberg", Status: "Active", Type: "Regular", Department: "Sales", Hire_Date: "2012-01-09", Pay_Rate: null },
      { Employee: "LOWB", First_Name: "Brian", Last_Name: "Lowe", Status: "Active", Type: "Regular", Department: "Shipping", Hire_Date: "2020-06-01", Pay_Rate: 23.5 },
      { Employee: "LUCASP", First_Name: "Lucas", Last_Name: "Petit", Status: "Active", Type: "Regular", Department: "Quality", Hire_Date: "2021-03-22", Pay_Rate: 25.75 },
      { Employee: "NGDT", First_Name: "Diep", Last_Name: "Nguyen", Status: "Inactive", Type: "Regular", Department: "Machining", Hire_Date: "2014-05-12", Pay_Rate: 22.0 },
      { Employee: "NGUD", First_Name: "Diep", Last_Name: "Nguyen", Status: "Active", Type: "Regular", Department: "Machining", Hire_Date: "2026-08-03", Pay_Rate: null },
      { Employee: "REYT", First_Name: "Tomas", Last_Name: "Reyes", Status: "Active", Type: "Regular", Department: "Machining", Hire_Date: "2026-08-24", Pay_Rate: 20.0 },
      { Employee: "VEGM", First_Name: "Marisol", Last_Name: "Vega", Status: "Active", Type: "Regular", Department: "Shipping", Hire_Date: "2017-11-13", Pay_Rate: 26.0 },
    ],
  ),
  Equipment: t(
    [col("Equipment", "nvarchar(20)", { key: true }), col("Description", "nvarchar(80)"), col("Location", "nvarchar(40)"), col("Status", "nvarchar(20)"), col("Work_Center", "nvarchar(20)", { nullable: true })],
    [
      { Equipment: "FL-HYSTER", Description: "Hyster forklift", Location: "Warehouse", Status: "In service", Work_Center: null },
      { Equipment: "FL-TOYOTA", Description: "Toyota forklift", Location: "Dock", Status: "In service", Work_Center: "SHIPPING" },
      { Equipment: "GAGE-PIN-OLD", Description: "Pin gage set", Location: "INSPECT-2", Status: "In service", Work_Center: "INSPECT-2" },
      { Equipment: "SAW-BLADE", Description: "Band saw blade stock", Location: "Saw", Status: "In service", Work_Center: "SAW" },
    ],
  ),
  Material: t(
    [col("Material", "nvarchar(30)", { key: true }), col("Description", "nvarchar(80)"), col("Type", "nvarchar(12)"), col("Customer", "nvarchar(20)", { nullable: true }), col("Unit_Price", "decimal(10,2)", { nullable: true }), col("Location", "nvarchar(20)", { nullable: true })],
    [
      { Material: "4140-BAR-1.25", Description: "4140 bar 1.25 in", Type: "Raw", Customer: null, Unit_Price: null, Location: "Rack A" },
      { Material: "AL-6061-BAR-2", Description: "6061 aluminum bar 2 in", Type: "Raw", Customer: null, Unit_Price: null, Location: "Rack C" },
      { Material: "BL-BLANK-100", Description: "Titanium blank", Type: "Finished", Customer: "BRIGHTLINE", Unit_Price: 41.0, Location: null },
      { Material: "COH-SKT-220", Description: "Socket body", Type: "Finished", Customer: "COHU-CA", Unit_Price: 18.4, Location: null },
      { Material: "AET-BRG-HSG", Description: "Bearing housing", Type: "Finished", Customer: "AETRIUM", Unit_Price: 32.0, Location: null },
      { Material: "EPP-D98-1-A", Description: "COPPERHEAD SOCKET BASE", Type: "Finished", Customer: "EXATRON", Unit_Price: 12.75, Location: null },
      { Material: "EPP-D98-2-B", Description: "COPPERHEAD SOCKET FLOATER", Type: "Finished", Customer: "EXATRON", Unit_Price: 14.2, Location: null },
      { Material: "TI-BAR-1", Description: "Titanium bar 1 in (Brightline)", Type: "Raw", Customer: null, Unit_Price: null, Location: "Rack C" },
      { Material: "TORO-SHAFT-7", Description: "Drive shaft", Type: "Finished", Customer: "TORO", Unit_Price: 9.6, Location: null },
    ],
  ),
  Sales_Order: t(
    [col("Sales_Order", "int", { key: true }), col("Customer", "nvarchar(20)"), col("Customer_PO", "nvarchar(30)"), col("Order_Date", "date"), col("Status", "nvarchar(12)")],
    [
      { Sales_Order: 51007, Customer: "TORO", Customer_PO: "4471", Order_Date: "2026-10-12", Status: "Open" },
      { Sales_Order: 51012, Customer: "EXATRON", Customer_PO: "78912", Order_Date: "2026-10-20", Status: "Open" },
      { Sales_Order: 51019, Customer: "BSE", Customer_PO: "B-22817", Order_Date: "2026-10-23", Status: "Open" },
      { Sales_Order: 51031, Customer: "EXATRON", Customer_PO: "79140", Order_Date: "2026-11-02", Status: "Open" },
      { Sales_Order: 51036, Customer: "BRIGHTLINE", Customer_PO: "BLM-4410", Order_Date: "2026-11-04", Status: "Open" },
      { Sales_Order: 51040, Customer: "COHU-CA", Customer_PO: "CQ-1188", Order_Date: "2026-11-05", Status: "Open" },
    ],
  ),
  Job: t(
    [col("Job", "int", { key: true }), col("Customer", "nvarchar(20)"), col("Sales_Order", "int", { nullable: true }), col("Part_Number", "nvarchar(30)"), col("Order_Quantity", "int"), col("Shipped_Quantity", "int"), col("Unit_Price", "decimal(10,2)"), col("Status", "nvarchar(12)"), col("Promised_Date", "date"), col("Certs_Required", "bit"), col("Priority", "int")],
    [
      { Job: 4471, Customer: "TORO", Sales_Order: 51007, Part_Number: "TORO-SHAFT-7", Order_Quantity: 300, Shipped_Quantity: 0, Unit_Price: 9.6, Status: "Active", Promised_Date: "2026-11-24", Certs_Required: false, Priority: 5 },
      { Job: 3260356, Customer: "EXATRON", Sales_Order: 51012, Part_Number: "EPP-D98-1-A", Order_Quantity: 800, Shipped_Quantity: 0, Unit_Price: 12.75, Status: "Active", Promised_Date: "2026-11-12", Certs_Required: false, Priority: 3 },
      { Job: 3260357, Customer: "EXATRON", Sales_Order: 51012, Part_Number: "EPP-D98-2-B", Order_Quantity: 600, Shipped_Quantity: 0, Unit_Price: 14.2, Status: "Active", Promised_Date: "2026-12-04", Certs_Required: false, Priority: 3 },
      { Job: 3260372, Customer: "BSE", Sales_Order: 51019, Part_Number: "AET-BRG-HSG", Order_Quantity: 120, Shipped_Quantity: 0, Unit_Price: 32.0, Status: "Active", Promised_Date: "2026-11-20", Certs_Required: false, Priority: 4 },
      { Job: 3260390, Customer: "AETRIUM", Sales_Order: null, Part_Number: "AET-BRG-HSG", Order_Quantity: 200, Shipped_Quantity: 200, Unit_Price: 32.0, Status: "Complete", Promised_Date: "2026-10-30", Certs_Required: false, Priority: 5 },
      { Job: 3260401, Customer: "COHU-CA", Sales_Order: 51040, Part_Number: "COH-SKT-220", Order_Quantity: 1000, Shipped_Quantity: 0, Unit_Price: 18.4, Status: "Active", Promised_Date: "2026-12-15", Certs_Required: true, Priority: 5 },
      { Job: 3260410, Customer: "EXATRON", Sales_Order: 51031, Part_Number: "EPP-D98-2-B", Order_Quantity: 500, Shipped_Quantity: 0, Unit_Price: 14.2, Status: "Active", Promised_Date: "2026-12-05", Certs_Required: false, Priority: 4 },
      { Job: 3260455, Customer: "BRIGHTLINE", Sales_Order: 51036, Part_Number: "BL-BLANK-100", Order_Quantity: 2000, Shipped_Quantity: 0, Unit_Price: 41.0, Status: "Active", Promised_Date: "2027-02-26", Certs_Required: true, Priority: 5 },
    ],
  ),
  Job_Operation: t(
    [col("Job_Operation", "int", { key: true, identity: true }), col("Job", "int"), col("Sequence", "int"), col("Work_Center", "nvarchar(20)"), col("Status", "nvarchar(12)"), col("Est_Hours", "decimal(8,2)")],
    [
      [4471, 10, "SAW", "Complete", 2],
      [4471, 20, "CNC 4", "Active", 9],
      [4471, 30, "FINAL INSP", "Open", 2],
      [3260356, 10, "CNC 5", "Complete", 14],
      [3260356, 20, "INSPECT-2", "Active", 4],
      [3260356, 30, "FINAL INSP", "Open", 3],
      [3260357, 10, "CNC 5", "Complete", 11],
      [3260357, 20, "INSPECT-2", "Complete", 3],
      [3260357, 30, "FINAL INSP", "Active", 3],
      [3260372, 10, "CNC 1", "Active", 16],
      [3260372, 20, "DEBURR", "Open", 3],
      [3260410, 10, "CNC 5", "Open", 8],
      [3260410, 20, "INSPECT-2", "Open", 3],
      [3260455, 10, "SAW", "Open", 6],
      [3260455, 20, "CNC 3", "Open", 40],
    ].map(([Job, Sequence, Work_Center, Status, Est_Hours], i) => ({ Job_Operation: i + 1, Job, Sequence, Work_Center, Status, Est_Hours })),
  ),
  Time_Punch: t(
    [col("Time_Punch", "int", { key: true, identity: true }), col("Employee", "nvarchar(10)"), col("Job", "int", { nullable: true }), col("Work_Center", "nvarchar(20)"), col("Punch_In", "datetime2"), col("Punch_Out", "datetime2", { nullable: true })],
    [
      ["NGUD", 3260356, "CNC 5", "2026-11-03T06:58:00", "2026-11-03T15:31:00"],
      ["REYT", 4471, "CNC 4", "2026-11-03T07:02:00", "2026-11-03T15:30:00"],
      ["LUCASP", 3260356, "INSPECT-2", "2026-11-03T07:00:00", "2026-11-03T15:30:00"],
      ["NGUD", 3260357, "CNC 5", "2026-11-04T06:55:00", "2026-11-04T15:29:00"],
      ["VEGM", null, "SHIPPING", "2026-11-04T07:00:00", "2026-11-04T15:30:00"],
    ].map(([Employee, Job, Work_Center, Punch_In, Punch_Out], i) => ({ Time_Punch: i + 1, Employee, Job, Work_Center, Punch_In, Punch_Out })),
  ),
  Purchase_Order: t(
    [col("Purchase_Order", "int", { key: true, identity: true }), col("Vendor", "nvarchar(20)"), col("Description", "nvarchar(200)"), col("Order_Date", "date"), col("Status", "nvarchar(12)"), col("Amount", "decimal(12,2)", { nullable: true })],
    [
      { Purchase_Order: 1, Vendor: "HILL", Description: "Pin gage set, replacement for INSPECT-2", Order_Date: "2026-10-28", Status: "Received", Amount: 612.0 },
      { Purchase_Order: 2, Vendor: "METALSUP", Description: "Titanium bar for Brightline blanks", Order_Date: "2026-11-05", Status: "Open", Amount: 8800.0 },
    ],
  ),
  Maintenance: t(
    [col("Maintenance", "int", { key: true, identity: true }), col("Equipment", "nvarchar(20)", { nullable: true }), col("Work_Center", "nvarchar(20)", { nullable: true }), col("Opened", "date"), col("Description", "nvarchar(400)"), col("Status", "nvarchar(12)")],
    [
      { Maintenance: 1, Equipment: null, Work_Center: "CNC 2", Opened: "2026-10-27", Description: "Warm-up routine runs long; operator reports slow spindle warm-up", Status: "Open" },
      { Maintenance: 2, Equipment: "FL-HYSTER", Work_Center: null, Opened: "2026-09-14", Description: "Annual inspection", Status: "Closed" },
    ],
  ),
};

/**
 * What the write login may do, table by table: create and update (model/sources.js, NEEDS A RULING 11), and delete
 * only on the tables that take new rows (R19), where graph-rag's write adapter uses it for one thing: undoing a row it
 * added, while the row still holds what was added (I-52). Every other table is read-only to it, and it cannot even
 * read them.
 */
export const WRITABLE = {
  Job: ["update"],
  Job_Operation: ["create", "update"],
  Work_Center: ["update"],
  Sales_Order: ["create", "update"],
  Purchase_Order: ["create", "update", "delete"],
  Maintenance: ["create", "update", "delete"],
};

/**
 * The shapes the source declaration gives graph-rag for these tables (R18, R19; graph-rag/src/sources.js TEST_SHAPES
 * holds the same, and graph-rag/test/sources.test.js holds them equal): yes/no columns (a SQL bit), the columns with a
 * fixed set of values, and the tables that take new rows, with the columns a new row needs (not null, no default,
 * not the identity key). Passed to graph-rag as DAB_TABLE_SHAPES by the harness.
 */
export const CHOICES = {
  Job: { Status: ["Active", "Hold", "Complete", "Closed"] },
  Job_Operation: { Status: ["Open", "Active", "Complete"] },
  Work_Center: { Status: ["Up", "Down"] },
  Sales_Order: { Status: ["Open", "Shipped", "Closed"] },
  Purchase_Order: { Status: ["Open", "Received", "Closed"] },
  Maintenance: { Status: ["Open", "Closed"] },
};
/**
 * The columns that hold another table's keys (I-58): condition 3 takes for them only a key of that table the record
 * names, never words from the note. Every value the test rows hold in them is such a key (a test checks it).
 */
export const REFERENCES = {
  Job: { Customer: "Customer", Sales_Order: "Sales_Order", Part_Number: "Material" },
  Job_Operation: { Job: "Job", Work_Center: "Work_Center" },
  Sales_Order: { Customer: "Customer" },
  Purchase_Order: { Vendor: "Vendor" },
  Maintenance: { Equipment: "Equipment", Work_Center: "Work_Center" },
};
export function shapes() {
  const out = {};
  for (const [table, actions] of Object.entries(WRITABLE)) {
    const cols = TABLES[table].columns;
    const columns = {
      ...Object.fromEntries(cols.filter((c) => c.type === "bit").map((c) => [c.name, "boolean"])),
      ...Object.fromEntries(Object.entries(CHOICES[table] ?? {}).map(([c, values]) => [c, { values }])),
      ...Object.fromEntries(Object.entries(REFERENCES[table] ?? {}).map(([c, t]) => [c, { references: entityOf(t) }])),
    };
    const adds = actions.includes("delete") && actions.includes("create");
    out[entityOf(table)] = { ...(adds ? { adds: true } : {}), columns, ...(adds ? { required: cols.filter((c) => !c.key && !c.nullable).map((c) => c.name) } : {}) };
  }
  return out;
}

/** the DAB entity name of a table, as the autoentities pattern names them ({schema}_{object}) */
export const entityOf = (table) => `dbo_${table}`;
/** the record key of a row: mssql:dbo_Job:4471 */
export const keyColumn = (table) => TABLES[table].columns.find((c) => c.key).name;
