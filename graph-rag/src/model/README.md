# The contract

The shapes every stream shares, from the user's rulings R1 to R11 (`~/reviews/design-rulings.md`) and the
design ([docs/ORGANIZATION-MODEL.md](../../../docs/ORGANIZATION-MODEL.md)). Pure functions over plain objects:
no database, no model calls. Tests in `test/model-*.test.js`. Which stream owns which file is
[docs/BUILD.md](../../../docs/BUILD.md).

A choice no ruling makes is marked in the code with **NEEDS A RULING**, takes the smallest reversible option,
and is listed in BUILD.md.

## Modules

| Module | What it holds |
|---|---|
| `schema.js` | Record keys (`system:table:row`), the types as data, and the idempotent DDL `server.js` runs at every start |
| `classes.js` | Classes, the class graph (several parents), the instance edge, the dependency edge |
| `class-map.js` | The map from classes to positions, used only to choose Filed or Proposed (R6) |
| `record.js` | The record: a condensed document and its text sections (R2) |
| `filing.js` | The filing log's entries, worker accounts, the orchestrator's verdicts, requests (R2, R9, R10, R11) |
| `sources.js` | A source declaration: how each source is read and committed to (R2) |
| `brief.js` | A worker's brief, scoped to an audience (R7, R11) |
| `text.js` | Name and date helpers, and `ShapeError`, which names the field it is about |

## Shapes

**Class** (an `Entity` with `_kind: 'class'`; `classes.js normalizeClass`): `{ name, key, parents, home,
description, evidence, rows_are_nodes, record_table, stages, status }`, which is what R11 says a class holds.
The four primitives (agent, commitment, event, resource) are the only roots (R1). Every other class has at least one
parent and may have several (R9). `assertParents` refuses a cycle, a missing or retired parent, and a class that
reaches no primitive. A class is scoped by home like any node. `rows_are_nodes` is the per-class setting for whether
a table's rows become instance nodes (R3). Stages are for commitment classes only.

**Instance**: any `Entity` with an `INSTANCE_OF` edge to a class, one edge per class
(`normalizeInstanceEdge`). It is visible wherever a section about it is (R11): its `_homes` grow with the
sections related to it by `ABOUT`.

**Dependency** (`DEPENDS_ON`, `normalizeDependency`): from the instance that depends to the one it depends on,
stated by a person, a record or an agent (R1). It carries when it was stated and optionally from and until when.
It is visible only to someone who sees both ends (R11, `dependencyVisible`).

**Record** (`record.js normalizeDocument`): `{ title, description, recorded_by, position, reason, recorded_at,
sections: [{ heading, text }] }`. A section is text: a section carrying `claims` is refused (R2). `position` is where
the sections start; the check can only raise them (R11).

**Filing entry** (`filing.js normalizeEntry`): one piece of a record. A piece is whatever one entry covers, and the
worker decides the split (R11). Its outcome is one of Filed, Proposed, Held or Kept (R2): Filed names the row it
wrote, Proposed says why, Held carries the question to the recorder, and Kept has no target, because the document is
the source. An entry carries its section's home, the worker's account of what it did, and the orchestrator's verdict
on that account (`matches`, `differs` or `unverifiable`, checked against the source, R10 and R11). A Kept piece that
is re-filed later points back with `refiled_from` (R11).

**Request** (`filing.js normalizeRequest`): a worker asking the orchestrator instead of resolving (R10). Its kind
is `class`, `conflict` or `other`.

**Source declaration** (`sources.js normalizeSource`): `{ system, read: { via, url, home }, commit: { via, url,
tables, actions, guard } | { via: "none" } }`. A source with no commit is not writable, so a clear piece is Proposed
(R2). `briefSource` is what a brief may say about a source: how it is committed to, never its URLs. Each entry of
`commit.tables` is a table name or its shape, `{ name, adds, columns, required, defaults }` (`tableShape`):
- `adds`: the table takes new rows (R19). Adding needs `create` among the actions; otherwise an add is Proposed.
- `columns`: `{ Column: "boolean" | { values: [...] } }`. A yes/no column, or one with a fixed set of values, takes
  the model's reading among the values it allows (R18). Anything not declared here is checked against the record's
  words.
- `required` and `defaults`: the columns a new row must be given, and those the source fills itself.
- `delete` may be among the actions only beside a table that takes new rows, and is used for one thing: undoing a
  row graph-rag added, while it still holds what was added.

**The two source contracts** (R19, R20). In production, reads go straight to the database and writes go through a
separate service built around the source, and the two are decoupled (R20). So a source has two seams, each replaceable
on its own: a **read side** and a **write side**. In the test both are one DAB client (`data-entry.js sourceClient`,
reached through `sourceConnection(decl, "read" | "write")`), and graph-rag still reads through the write connection
before it writes; each place is named below.

*The read side.* What graph-rag reads for itself:
- to check a write: the row as it stands (condition 4's expected old values, a value the row already holds), the
  table's rows (condition 2's "only match", R19's "a row already holds it"), and the rows of a table a reference
  column names (I-58);
- to resolve names: rows by a column's value or by words in them (`resolve_name`, `find_rows`);
- for discovery: the tables, each table's key and columns, row counts, the values of few-valued columns, a few rows.

| call | takes | answers |
|---|---|---|
| `tables()` | | the table names the connection exposes |
| `describe(table)` | | `{ pk: [{ name, type }] \| null, columns: { column: "number" \| "string" \| "unknown" } \| null }` |
| `find(table, { where, orderby, first })` | `where`: `[[column, op, value]]`, every one holding, `op` one of eq ne gt ge lt le; `orderby`: columns, ascending | rows. A value the column's type can't hold matches nothing |
| `read(table, key)` | the row's key value | `{ row, key_column, key_value }` or nothing; more than one row, or a row whose key isn't the one asked, is an error |

Every read is made for an audience (R11.6, R11.9): a declaration's `read.home` is who may read through that
connection, and graph-rag refuses a read for an audience that can't see it, before anything is read.

*An agent reading the database directly* (R20's production shape) needs in place of graph-rag's `describe_source`,
`find_rows` and `resolve_name` (I-59, the test's simplification):
- a read connection per audience: a database login or role whose grants are exactly what that position may see. It's
  handed only connections whose `read.home` its audience sees, as a brief lists sources today;
- the tables and columns it may read, and the key of each (graph-rag names tables and keys in record keys,
  `system:table:row`, and the agent must use the same);
- a search it can actually use: text matching and paging that the database's own read tool takes. DAB 2.0.12's filter
  has no contains or startswith, which is why `find_rows` exists;
- nothing written: a read-only login.
graph-rag no longer sees such reads. What keeps an agent within its audience is then the connection it is handed and
the database's permissions, including the tables a class homed above the agent records (today
`filing.js assertTableReadable` refuses those at the call).

*The write side.* What a source's write service must offer for R16 to R19 to hold when graph-rag isn't the one
touching the database. "Test" says how the test's connection (DAB 2.0.12 over the synthetic SQL Server) does it
today.

| the service must | why | test |
|---|---|---|
| **update a row given the expected old values** of the columns it writes, refusing when the row no longer holds them, atomically | condition 4: a row that moved is never written over (R2) | graph-rag does it: commitRow reads the row through the write connection, compares, then sends `update_record`. Not atomic: a change between the read and the write is not caught |
| **say whether the row already holds the values**, or treat such an update as done | a write that changes nothing lands with nothing sent, and is logged | graph-rag does it, from the same read |
| **add a row and return the key the source made**, refusing a key the caller gives | R19: the key is the source's | native (`create_record` returns the row; an IDENTITY key refuses one given) |
| **make an add safe to repeat**: take an idempotency key (the piece: record, section, table), and answer a repeat with the row the first one made | one piece adds at most one row, however often it is filed or retried, a lost answer included | graph-rag does it: its filing log (`FilingAttempt`) and an in-process lock. A lost answer leaves the attempt unknown, and the piece is Held rather than risk a second row. The source has no idempotency key |
| **remove an added row only while it still holds what was added**, atomically | undo (I-48, I-52) | graph-rag does it: removeAdded reads the row through the write connection, compares, then sends `delete_record` (granted only on the tables that take new rows). Not atomic |
| **read back a row after a lost answer**, by its key | a transport error mid-write is settled by reading, never by sending again | graph-rag does it through the write connection |
| **declare its shape**: which tables take updates, which take new rows, the columns a new row needs and those the source fills, the fixed-choice values, the yes/no columns, the reference columns | R18, R19, I-58 decide from it | declared beside the source (`commit.tables` shapes, `model/sources.js`); DAB doesn't describe it |
| **say which server and database it writes to**, so a write never lands in the wrong place | the guard | the identity view, read through the write connection (`checkGuard`) |
| **refuse what the caller may not do** (a table or action not granted) | defence in depth beyond the declaration | native: DAB's per-entity permissions and the SQL login's grants |

The checks stay in graph-rag whatever stands behind either side: the declaration, the class map (condition 1), R16's
conditions 2 and 3 and R19's, I-39 as narrowed, and the filing log (begun before each write and settled after).
A service that takes the expected old values and an idempotency key makes conditions 4, the one-row rule and undo
atomic, where today they are read-then-write.

*What still goes around both seams:* the test harness's own checks (`test-sql/check.mjs` calls DAB directly to test
it), the eval's before and after dumps, and `mcpToolCall`, the DAB implementation's transport.

**Brief** (`brief.js scopeBrief`, `assertBrief`): `{ audience, record, sections, classes, instances, sources }`.
The audience is the home of the sections the brief is for. `splitByHome` gives one brief, and one worker, per home
(R11). `scopeBrief` drops what the audience can't see and counts what it dropped without naming it, and
`assertBrief` refuses a brief that still holds anything above the audience.

**Filed or Proposed** (`class-map.js filedOrProposed`): the authority that counts is the recorder's, never the
agent's. A class missing from the map means Proposed, and so does a source that isn't writable (R2, R11). A class with
no entry of its own takes its parents' entries, and the strictest wins where they conflict (R9, `mapPositionOf`).

## Invariants

- **DDL is idempotent.** `schema.statements()` is safe to run at every start, and nothing in this directory runs it.
- **Reference, never copy.** The graph holds keys and sections; rows stay in the source. A transactional row's key
  sits in a section, with no per-row node (R3).
- **No audit nodes.** Every filing outcome, source writes included, is a `FilingEntry` document, which no graph read
  returns (R9).
- **Errors name the field.** `ShapeError.field` is a path such as `sections[1].text` or `target.key`.

## Removed by the rulings

Atomic claims and every claim-based state query (R2), the linker and triage (R4), word lists and noun tables (R3),
the person gate on classes (R5), the single authority-over-a-class rule (R6), the migration (R8), audit nodes and
source-reference nodes (R3, R9), and one parent per class (R9).
