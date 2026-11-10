# The synthetic test SQL Server

An invented manufacturing database for filing runs, with no real data in it. It runs as SQL Server 2022 in its own
compose project, with two Data API builder (DAB) instances in front of it. The user has not yet said which real
database may be copied (R11.15), so this stands in. `restore.sh` is for the later case, when a restored copy
replaces it and only the names change.

| | |
|---|---|
| Data | [data.mjs](data.mjs). The names and keys the 62 notes carry are kept; every other value is invented |
| Database, server | `GwSynthMfg` on `gwsynth-sql` (the guard's names) |
| Logins | `gwsynth_read`: `SELECT` on the `dbo` schema. `gwsynth_write`: `SELECT`, plus `INSERT` and/or `UPDATE` on the tables in `data.mjs WRITABLE`, and `SELECT` on the identity view. No `DELETE` anywhere |
| DABs | `http://dab-read:5000/mcp` (every table, read only) and `http://dab-write:5000/mcp` (the writable tables and `dbo_GwConnectionIdentity`) |
| Networks | `<project>_db` (SQL Server and the DABs) and `<project>_api` (the DABs and whoever uses them). Both internal, no published port |
| Passwords | Generated into `test-sql/.env.gwsynth` (untracked, mode 600) on first `up.sh`. Never printed, never in git, never on a command line |

## Use

```bash
test-sql/up.sh
```

This starts a fresh database each time (no volume), seeds it, and starts both DABs. To reach the DABs, put the
container that calls them on the network `gwsynth_api`, for example
`docker network connect gwsynth_api <container>`, or `docker run --network gwsynth_api ...`.

```bash
test-sql/check.sh
```

This runs the live checks: logins, grants, the guard, the restore round trip, no published ports, internal networks,
and the fake DAB against the real one.

```bash
test-sql/down.sh
```

This removes this project's containers and networks, and nothing else. `GWSYNTH_PROJECT=<name>` before any of the
three scripts runs a second, independent copy.

## The source declaration a test run uses

```json
{ "system": "mssql",
  "description": "The synthetic test database (invented data)",
  "read":   { "via": "dab-mcp", "url": "http://dab-read:5000/mcp", "home": "everyone" },
  "commit": { "via": "dab-mcp", "url": "http://dab-write:5000/mcp",
              "tables": ["dbo_Job", "dbo_Job_Operation", "dbo_Work_Center", "dbo_Sales_Order", "dbo_Purchase_Order", "dbo_Maintenance"],
              "guard": { "server": "gwsynth-sql", "database": "GwSynthMfg" } } }
```

`home: "everyone"` is for test configuration only, so the first run can file at every level (the coordinator's
instruction). A declared connection's home defaults to the root. `graph-rag/src/sources.js testDeclaration()`
returns this declaration.

## The guard

Before every write, the write adapter (`graph-rag/src/data-entry.js`) reads `dbo_GwConnectionIdentity` through the
write DAB. That view selects `@@SERVERNAME`, `DB_NAME()` and `SUSER_SNAME()`, which are computed on the write login's
own connection when it is read. The adapter refuses unless the server and database are the declared `guard` names. A
database without the view cannot pass, and neither can a declaration without a guard.

## A restored copy (later)

```bash
test-sql/up.sh
test-sql/restore.sh /path/to/copy-only.bak ErpCopy [writable.json]
GWSYNTH_DATABASE=ErpCopy GWSYNTH_NO_SEED=1 test-sql/up.sh
```

1. `test-sql/up.sh` starts the server, if it is not up.
2. `restore.sh` restores under a new name, then adds the two logins' users, their grants and the identity view.
   Nothing else in the copy changes.
3. The last command points both DABs at the copy.

Then set the declaration's `guard.database` to `ErpCopy`. Nothing else changes. `writable.json` maps
`table -> ["create", "update"]` for the copy's own tables. The tables must be in the `dbo` schema. `check.sh` tests
this round trip on a backup of the synthetic database (`backup.sh`).

No assistant handles the ERP's own login. The backup file is made and put on the host by the user, or whoever holds
that login.
