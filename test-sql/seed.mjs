// SQL for the synthetic test database, generated from data.mjs, written to stdout for sqlcmd to run inside
// the SQL Server container. Passwords are never in this output: sqlcmd fills $(GWSYNTH_READ_PASSWORD) and
// $(GWSYNTH_WRITE_PASSWORD) from the container's own environment.
//
//   node test-sql/seed.mjs schema                 the database, its tables and rows
//   node test-sql/seed.mjs access <database> [writable.json]
//                                                 the two logins, their users and grants, and the identity
//                                                 view, in <database>: run after the schema, and after a
//                                                 restore (restore.sh). writable.json maps table -> actions,
//                                                 default data.mjs WRITABLE.
import { readFileSync } from "node:fs";
import { DATABASE, IDENTITY_VIEW, READ_LOGIN, TABLES, WRITABLE, WRITE_LOGIN } from "./data.mjs";

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ident = (n) => {
  if (!NAME_RE.test(n)) throw new Error(`not a plain SQL name: ${n}`);
  return `[${n}]`;
};
const literal = (v, type) => {
  if (v === null || v === undefined) return "NULL";
  if (type === "bit") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  return `N'${String(v).replace(/'/g, "''")}'`;
};

export function schemaSql(database = DATABASE) {
  const out = [
    "SET NOCOUNT ON;",
    `IF DB_ID(N'${database}') IS NOT NULL BEGIN ALTER DATABASE ${ident(database)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${ident(database)}; END;`,
    `CREATE DATABASE ${ident(database)};`,
    "GO",
    `USE ${ident(database)};`,
    "GO",
  ];
  for (const [name, t] of Object.entries(TABLES)) {
    const cols = t.columns.map((c) => `${ident(c.name)} ${c.type}${c.identity ? " IDENTITY(1,1)" : ""} ${c.nullable ? "NULL" : "NOT NULL"}${c.key ? " PRIMARY KEY" : ""}`);
    out.push(`CREATE TABLE dbo.${ident(name)} (${cols.join(", ")});`);
    const identity = t.columns.some((c) => c.identity);
    if (identity) out.push(`SET IDENTITY_INSERT dbo.${ident(name)} ON;`);
    for (const row of t.rows) {
      out.push(`INSERT INTO dbo.${ident(name)} (${t.columns.map((c) => ident(c.name)).join(", ")}) VALUES (${t.columns.map((c) => literal(row[c.name], c.type)).join(", ")});`);
    }
    if (identity) out.push(`SET IDENTITY_INSERT dbo.${ident(name)} OFF;`);
  }
  out.push("GO");
  return out.join("\n") + "\n";
}

/**
 * The logins (server-wide, made once), a user for each in `database`, the read login's SELECT on the dbo schema,
 * the write login's SELECT, INSERT and UPDATE on the chosen tables only (never DELETE), and the identity view
 * the guard reads. The same for the synthetic database and a restored copy, so only names change.
 */
export function accessSql(database = DATABASE, writable = WRITABLE) {
  const out = ["SET NOCOUNT ON;"];
  for (const [login, pw] of [[READ_LOGIN, "GWSYNTH_READ_PASSWORD"], [WRITE_LOGIN, "GWSYNTH_WRITE_PASSWORD"]]) {
    out.push(`IF SUSER_ID(N'${login}') IS NULL CREATE LOGIN ${ident(login)} WITH PASSWORD = N'$(${pw})', CHECK_POLICY = OFF, DEFAULT_DATABASE = ${ident(database)};`);
  }
  out.push("GO", `USE ${ident(database)};`, "GO");
  for (const login of [READ_LOGIN, WRITE_LOGIN]) {
    out.push(`IF USER_ID(N'${login}') IS NULL CREATE USER ${ident(login)} FOR LOGIN ${ident(login)} ELSE ALTER USER ${ident(login)} WITH LOGIN = ${ident(login)};`);
  }
  out.push(`GRANT SELECT ON SCHEMA::dbo TO ${ident(READ_LOGIN)};`);
  const grants = { create: "INSERT", update: "UPDATE" };
  for (const [table, actions] of Object.entries(writable)) {
    const bad = actions.filter((a) => !grants[a]);
    if (bad.length) throw new Error(`${table}: a write login may only create and update, not ${bad.join(", ")}`);
    out.push(`GRANT ${["SELECT", ...actions.map((a) => grants[a])].join(", ")} ON dbo.${ident(table)} TO ${ident(WRITE_LOGIN)};`);
  }
  out.push(
    `IF OBJECT_ID(N'dbo.${IDENTITY_VIEW}', N'V') IS NOT NULL DROP VIEW dbo.${ident(IDENTITY_VIEW)};`,
    "GO",
    // computed on the connection that reads it: the server and database the write DAB is actually connected to
    `CREATE VIEW dbo.${ident(IDENTITY_VIEW)} AS SELECT CAST(1 AS int) AS id, CAST(@@SERVERNAME AS nvarchar(128)) AS server_name, CAST(DB_NAME() AS nvarchar(128)) AS database_name, CAST(SUSER_SNAME() AS nvarchar(128)) AS login_name;`,
    "GO",
    `GRANT SELECT ON dbo.${ident(IDENTITY_VIEW)} TO ${ident(WRITE_LOGIN)};`,
    "GO",
  );
  return out.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [what, database, writableFile] = process.argv.slice(2);
  if (what === "schema") process.stdout.write(schemaSql(database || DATABASE));
  else if (what === "access") process.stdout.write(accessSql(database || DATABASE, writableFile ? JSON.parse(readFileSync(writableFile, "utf8")) : WRITABLE));
  else {
    console.error("usage: seed.mjs schema [database] | access <database> [writable.json]");
    process.exit(2);
  }
}
