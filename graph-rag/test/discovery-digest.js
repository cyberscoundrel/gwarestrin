// The ux test tree's connected system, as a survey would have digested it
// (the Discovery stream's tests; docs/ORGANIZATION-MODEL.md). The tables of
// the ERP the batches reference: customers, employees, vendors, work centers
// and materials as master data; orders, jobs and maintenance as transactions,
// with the distinct values of each status column read by the survey; and the
// survey's pattern entry naming the class no table records (hires). The
// expected draft is fixtures/classes.json.
export const UX_DIGEST = {
  system: "mssql",
  tables: [
    { name: "dbo_Customer", columns: ["CustomerID", "Name", "CreditLimit", "PaymentTerms"], rows: 212 },
    { name: "dbo_Employee", columns: ["EmployeeID", "Name", "WorkCenterID", "Shift"], rows: 48 },
    { name: "dbo_Vendor", columns: ["VendorID", "Name", "Terms"], rows: 61 },
    { name: "dbo_WorkCenter", columns: ["WorkCenterID", "Name", "Capacity"], rows: 12 },
    { name: "dbo_Material", columns: ["MaterialID", "Description", "UOM"], rows: 1890 },
    { name: "dbo_OrderStatus", columns: ["StatusCode", "Description"], rows: 6 },
    {
      name: "dbo_Order",
      columns: ["OrderID", "CustomerID", "Status", "Quantity", "DueDate", "Price", "Margin"],
      rows: 9_120,
      status_values: { Status: ["Quoted", "Ordered", "In Production", "Shipped", "Invoiced", "Paid"] },
    },
    {
      name: "dbo_Job",
      columns: ["JobID", "Status", "MachineID", "OperatorID", "ShiftCover", "Quantity", "DueDate"],
      rows: 31_400,
      status_values: { Status: ["Planned", "Running", "Paused", "Done"] },
    },
    {
      name: "dbo_Maintenance",
      columns: ["MaintenanceID", "Status", "MachineID", "TechnicianID", "BookedFor", "Parts"],
      rows: 403,
      status_values: { Status: ["Booked", "In Progress", "Done"] },
    },
  ],
};

/** the survey's pattern entries: one names the class no table records, one is plain prose */
export const UX_PATTERNS = [
  {
    name: "mssql: hiring (pattern)",
    text: "Hiring runs outside the ERP: openings are posted on the board and the owner decides. [class: hires; stages: opened, interviewing, offered, hired, declined; table: none; attributes: candidate, start_date, pay, dismissal; description: a hire: a commitment of a position to a person; no source system records it]",
  },
  { name: "mssql: jobs per customer (pattern)", text: "TORO and EXATRON account for 40% of open jobs." },
];

/** the digest as the text an agent gets (connection-digest.ts), for the loader */
export const UX_DIGEST_TEXT = [
  `Tables (${UX_DIGEST.tables.length}, all named dbo_…): ${UX_DIGEST.tables.map((t) => t.name.slice(4)).join(", ")}`,
  ...UX_DIGEST.tables.flatMap((t) => [
    `${t.name} columns: ${t.columns.join(", ")}`,
    `${t.name} rows: ${t.rows.toLocaleString("en-US")}`,
    ...Object.entries(t.status_values ?? {}).map(([c, v]) => `${t.name} ${c} values: ${v.join(", ")}`),
  ]),
].join("\n");
