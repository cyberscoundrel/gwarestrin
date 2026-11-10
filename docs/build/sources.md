# Sources stream: plan (phase 0)

Written 2026-11-09 before any code, from `~/reviews/design-rulings.md` (R1 to R11),
`~/reviews/user-messages.md` and `docs/ORGANIZATION-MODEL.md` (proposal B), read
against `graph-rag/src/data-entry.js`, `dab/`, `dab-config.example/`,
`graph-rag/e2e/fake-dab-core.mjs` and its two users, and `docker-compose.yml`'s
`dab` and `dab-write`. The rulings outrank this file. `docs/BUILD.md`, when the
contract step writes it, overrides the file map here.

**The stream's job.** How workers read from and commit to source systems, and an
isolated, invented test database to run that against. The user's words behind it:
"information from incomeing condensed records need to commit the data to the relevant
source by some means, for an sql server this might just be a write" (R2), and "a
worker has tool access to those data sources for data entry to act on a summary
document".

## What carries

From `graph-rag/src/data-entry.js`, the transport and row-safety parts. None of them
depend on claims or on the authority rule, and they were checked against a running
DAB 2.0.12.

| Part | Lines today | Why it carries |
|---|---|---|
| `mcpToolCall`, the session handshake, `isError` as "the tool said no" | 109-139 | Every SQL Server read and write goes through DAB (R2, brief) |
| `DAB_CALLS` (`read_records`, `update_record`, `create_record`), `odata`, `rowsOf` | 89-150 | DAB 2.0.12's real argument shapes |
| `primaryKeyFrom`: the key learned from the paging cursor, never guessed | 158-175 | A section stores the row's key (R3), so the key must be the real one |
| `sourceClient.readRow`: one row by verified key, refusing two rows or the wrong row | 183-211 | Read tools for verification (R3) |
| `assertWritable`: only the row's own columns, never its key, no unsafe numbers | 222-228 | A write changes one row's facts, not which row it is |
| `sameValue` | 304-315 | Comparing what a section says with what a row holds |
| The three-step write: an entry before the write, the write, then settle; read back after a transport error; settle a lost attempt by the next one (`applyEntry`, `afterWriteError`, `settleOpenAttempts`) | 566-675 | "any source row changed without a Filed entry" is zero tolerance in proposal B, so no write may happen without an entry first. It is re-aimed from AuditEvent nodes at the filing log (R9) |
| `graph-rag/e2e/fake-dab-core.mjs` | all | Both the unit tests and the replay harness keep one fake that refuses what real DAB refuses |
| `dab/Dockerfile` (DAB 2.0.12 on .NET 8) | all | The two test DAB containers use the same image, built under their own tag |
| `dab-config.example/dab-config-write.json`'s shape: autoentities limited to chosen tables, read, create and update, never delete | all | The write login's limits (brief) |

## What changes

| Today | Becomes | Ruling |
|---|---|---|
| `sourcesConfig`: a URL pair per system from the environment or an `OrgPolicy` "sources" row | A **source declaration** per source: how it is read, how it is committed to, which tables it takes writes on, the guard's expected names, and the home of each connection. SQL Server is one kind (`dab-mcp`); the shape does not assume SQL | R2 "Each source declares how it is committed to"; R11.9 |
| Errors are thrown as text | Every call answers with a typed result: `ok`, `not_found`, `ambiguous`, `refused` (the source said no), `unreachable` (transport, timeout, no endpoint). `unreachable` is what makes the filing stream mark a piece Held | R3 "if unreachable the piece is Held" |
| `writeRow` updates only | `update` and `create` on declared tables. `update` takes the values the worker read before writing and refuses if the row has moved since, so a write never overwrites what the worker did not see | R2 Held: "never overwrites" |
| Each attempt is an `AuditEvent` vertex (`audit.js`) | Each attempt is an entry in the one filing log outside the graph. The adapter takes the log as an injected interface (`begin`, `settle`), so it does not own the log's storage | R9 "no audit nodes" |
| Name lookup lived in `linker.js` (`sourceClient(...).readRow` to check a key) | A **read adapter** the worker calls: describe a source's tables, find rows whose column matches a name (`eq`, `contains`, `startswith`, capped), read a row by key | R3 "Workers resolve names against the source with read tools"; R4 linker removed |
| The write DAB is reached by graph-rag after `decideWrite` | The write adapter writes only what the filing stream hands it as Filed, after the guard passes. It decides nothing about authority | R6, R11.7 (authority is the filing stream's) |
| `fake-dab-core.mjs`: read, update, create | Adds `contains` and `startswith` filters, a computed identity view for the guard, and an unreachable mode, each matching what real DAB 2.0.12 answers (checked against the synthetic stack, not assumed) | Brief |

## What goes

Removed with the claims and the single authority rule. The contract step may already
remove these; whoever BUILD.md names does it.

| Part | Ruling |
|---|---|
| `fieldsForClaim`, `confirmAgainstRow`, `rowKeyFor`, `columnFor` as a claim's attribute-to-column match | R2 atomic claims go |
| `decideWrite`, `authorityPolicy`, `authorityMapFor`, `decisionKeys`, `reviewHome`, `standingOf`, `assertApproverHolds`, `strictest` | R6 the single authority-over-a-class rule is dropped; the class-to-position map only chooses Filed or Proposed, in the filing stream |
| `recordAuditEvent` and the other `audit.js` calls | R9 |
| `classesOfTable` over `CommitmentClass` with `status = 'confirmed'` | R5 no person gate |
| `linker.js`'s source check | R4 |

`enterData`, `applyProposedEntry` and `describeEntry` are split: their row-writing
core moves into the write adapter, and their deciding parts go.

## What is new

### Source declarations (R2)

One declaration per source, stored where the contract says (today's `OrgPolicy`
"sources" row is the nearest carrier). A tentative shape:

```
{ name: "mssql",              // the record-key prefix: mssql:dbo_Job:4471
  kind: "dab-mcp",            // how it is read and committed to; another kind is another adapter
  read:  { url, home },       // home: the position whose people may see what this connection reads (R11.9)
  write: { url, tables: ["dbo_Job", ...], guard: { server, database } } | null }
```

A source with no `write`, or a table not in `write.tables`, is "not writable", which
R2 makes Proposed. The brief's line on "how each source is committed to" (R7) is
rendered from the declaration without URLs or credentials.

### Read adapter (R3)

`describe(source)`, `find(source, table, column, value, mode)`, `get(source, key)`.
`find` returns at most a few candidates and says when there are more; one candidate
is a match, several are `ambiguous`. Which column to search is the worker's choice
from `describe`, not a list in code (R3 "no word lists").

### Write adapter (R2)

`update(source, key, fields, { before })` and `create(source, table, row)`. Steps:
the guard; a log entry begun; the write through the write DAB; read back; the entry
settled. Never delete.

### The guard (brief; proposal B step 4)

Before any write, the run asks the write connection which server and database it
holds and refuses unless they are the declared test names. Plan: a view in the test
database, `dbo.GwConnectionIdentity`, selecting `@@SERVERNAME`, `DB_NAME()` and
`SUSER_SNAME()`. These are computed on the write login's own connection at query time,
so the answer is what the write DAB is actually connected to, not a stored value. The
write DAB exposes only this view beside its write tables. A database without the view
cannot pass, so a write DAB pointed anywhere else refuses by default. The expected
names come from the declaration, so a restored real copy needs only new names. The
check runs before every write (one read).

### The synthetic test database

Nothing in it is real data. It uses the names and keys the 62 notes already carry in
`graph-rag/test/fixtures/oracle-sixty.json`, so the notes can be filed against it, and
invents everything else. It does not copy any real schema: the real ERP has not been
looked at (R11.15), and the `mssql-server` and `tcmautomation` containers are not
touched.

- **Data as one module**, `synthetic-mfg` (JavaScript data), from which both the
  SQL seed and the fake DAB's tables are generated, so the unit tests and the real
  container hold the same rows. A unit test checks that every `mssql:` key in
  `oracle-sixty.json` exists in it.
- **Keys the notes name:** `dbo_Customer` AETRIUM, COHU-CA, EXATRON (plus BSE, TORO,
  BRIGHTLINE named in texts); `dbo_Employee` FRAJ, NGUD, LOWB, and an inactive
  same-named NGDT, because aq01 and aa07 test that Diep resolves to the active one;
  `dbo_Job` 3260356, 3260357, 3260372, 3260410, 3260455, 4471; `dbo_Vendor` JOHNH
  (plus HILL, Master Fluid, Blaser, Hangsterfer, Staffmark, Hyd-Mech named in texts);
  `dbo_Work_Center` INSPECT-2, FINAL INSP, CNC 1 to CNC 5, SAW, DEBURR.
- **Lasting individuals and transactional rows (R3):** customers, vendors, employees,
  work centers, parts and equipment are tables with single keys; orders, job
  operations and time punches are transactional tables, so filing can show sections
  storing a key without per-row nodes.
- **Cases on purpose:** a name with two candidates (Diep), a name with none (Darrin
  S., Corvane Medical as a prospect, Kayla as a temp), PO 4471 against job 4471 (w11),
  a job whose source value disagrees with a note, and notes with no source at all
  (fridge, holiday party) that should end Kept.
- **The stack:** its own compose project (`gwsynth`), SQL Server 2022 from the
  `mcr.microsoft.com/mssql/server:2022-latest` image already on the host, two
  internal networks and no published port: `db` (SQL Server and the two DABs only)
  and `api` (the two DABs and whatever runs the check). Two DAB containers built from
  `dab/` under their own tag: read, whose login has `SELECT` on the tables; write,
  whose login has `SELECT`, `INSERT` and `UPDATE` on chosen tables and the identity
  view, nothing else, and no `DELETE`.
- **Secrets:** `sa`, read and write passwords generated on first run into an
  untracked env file (named in `.gitignore`), passed to the containers by
  environment, never echoed and never in a log. DAB configs are rendered at start
  inside the containers' environment, not written into the checkout.
- **Restore script:** restores a `.bak` under a new database name (`RESTORE ... WITH
  MOVE`), then creates the two logins, their grants and the identity view. Tested on a
  copy-only backup of the synthetic database, restored under a second name: the
  guard then passes only with that name declared.

### Tests

Every behaviour gets a test that fails first. No model is involved in this stream.

- Unit (`npm test` in `graph-rag`), against `fake-dab-core.mjs`: typed results,
  unreachable versus refused versus not found, `find` modes and caps, ambiguity,
  update refused when the row moved, create, the guard refusing a wrong server, a
  wrong database and a missing view, nothing written without a begun log entry,
  and the oracle-key consistency check.
- Against the live synthetic stack (a script in the stream's own folder, run beside
  `graph-rag/e2e/e2e.sh`): the read login cannot write; the write login cannot delete
  or touch an unchosen table; the guard refuses a decoy database on the same server
  and passes the right one; the restore round trip; no container has a published
  port and the networks are internal; the fake DAB's answers match the real DAB's for
  the same calls.
- `graph-rag/e2e/e2e.sh` is run unchanged; any scenario of mine goes in a
  `scenarios-sources.mjs` per `SCENARIOS.md`. Only containers this stream starts are
  ever removed.

## Unclear in the rulings

Each of these gets the smallest reversible choice, marked `NEEDS RULING` in code and
in the phase report.

1. **Reachable to read, unreachable to write** (R2 against R3). R3 makes an
   unreachable source Held, and R2 makes a source that is not writable Proposed. When
   the read side answers and the write side does not, which is it? Choice: Held,
   since a person approving a Proposed piece could not apply it either, and Held is
   re-filed later. A source declared without a write side is Proposed, as R2 says.
2. **A write whose result cannot be told** (R2's four outcomes). The transport broke
   and the row cannot be read back. None of Filed, Proposed, Held, Kept fits. Choice:
   the log entry stays open as attempted, the piece is reported Held, and the next
   attempt on the row settles it by what the row holds (today's behaviour).
3. **What "the source disagrees" means for a write** (R2 Held, R11.2 "conflicts with
   a source" is high stakes). A note that moves a due date contradicts the row by
   design. The adapter only offers the mechanism: the worker gives the values it read,
   and the write is refused if the row moved since. Whether a differing value is an
   update to file or a conflict to request is the filing stream's call, not made here.
4. **The home of a source connection** (R11.9: "a class from a table gets the home of
   the connection that can read that table"). One read login reads every table, so
   every table class gets one home, and nothing rules which. Choice: the declaration
   carries a `home`, defaulting to the root (the strictest), until a person sets it.
5. **Whether a worker's source reads are filtered by the record's audience** (R7: a
   brief contains only what the record audience can see). The read login can read
   every table, including ones a class home may restrict. Choice: workers read only
   through graph-rag's read adapter, never the DAB endpoint directly, and the adapter
   takes a list of allowed tables from its caller, so the filing or brief stream can
   narrow it. No narrowing rule is invented here.
6. **Composite keys** (R3 "a section stores the key"). `system:table:row` names one
   column; real transactional tables often key by two (job and step). Today such a
   table is refused. Choice: keep refusing, and the synthetic transactional tables get
   single keys, until the contract states a composite-key form.
7. **Which database the first real run copies, and which models see it** (R11.15,
   open). Not touched: the synthetic database stands in, and the restore script waits
   for the user's backup file. Real models run against it only when the coordinator
   says so.
8. **Real names in an invented database.** The customer, vendor and employee names
   and keys come from the committed fixture, which came from real notes. The brief
   asks the database to agree with them, so they are kept and every other value is
   invented. Flagged so the user can see it; no rule is assumed.

## Files (tentative; BUILD.md overrides)

- `graph-rag/src/sources/`: `declarations.js`, `dab.js` (the carried transport),
  `read.js`, `write.js`, `guard.js`.
- `graph-rag/test/sources-*.test.js`, `graph-rag/test/fixtures/synthetic-mfg.js`.
- `sources/synthetic/`: `compose.yml`, `schema.sql`, `seed.mjs`, `init.sh`,
  `restore.sh`, `check.sh`, DAB config templates.
- Shared files, smallest hunks: `graph-rag/e2e/fake-dab-core.mjs` (new filters, the
  identity view, unreachable mode), `.gitignore` (the env file), and whatever
  `data-entry.js` keeps once BUILD.md says who removes its claim and authority parts.
- Not touched: `docker-compose.yml`'s `dab` and `dab-write`, which serve the
  development deployment.
