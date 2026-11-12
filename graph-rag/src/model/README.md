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

**The source interface** (R19; `data-entry.js sourceClient`, reached through `sourceConnection(decl, side)`). Every
read and write graph-rag makes of a source goes through these calls and nothing else. The test's DAB connection is
one implementation; a production middleman (an MCP server in front of a real system) is another, and the two are
swapped behind the declaration's `via` without touching filing. `side` is `read` (the read endpoint) or `write` (the
write endpoint, whose reads are made through the write connection).

| call | takes | answers | used for |
|---|---|---|---|
| `tables()` | | the table names the endpoint exposes | which tables a class may come from; a search's table check |
| `describe(table)` | | `{ pk: [{ name, type }] \| null, columns: { column: "number" \| "string" \| "unknown" } \| null }` | the key a record key names; column checks |
| `find(table, { where, orderby, first })` | `where`: `[[column, op, value]]`, every one holding, `op` one of eq ne gt ge lt le; `orderby`: columns, ascending | rows. A value the column's type can't hold matches nothing | names resolved against the source (R3), searches, paging by key, the guard |
| `read(table, key)` | the row's key value | `{ row, key_column, key_value }` or nothing; more than one row, or a row whose key isn't the one asked, is an error | the row before a write, and after a lost answer |
| `update(table, hit, fields)` | the row as read, the columns to write | the source's answer | R16 writes. The key is never written |
| `add(table, data)` | the new row's columns, never its key | the row the source made, its key included | R19 adds |
| `remove(table, hit)` | the row as read | the source's answer | undoing an add, only |

The contract around the calls:
- An implementation throws with `transport: true` when the source couldn't be reached, so that nothing is known,
  and throws a plain error when the source said no. A write call is never sent twice: a lost answer is settled by
  reading the row back.
- The checks stay in graph-rag, outside the interface: the declaration, the guard (`checkGuard`, a `find` on the
  connection's identity view through the write side), the filing log (begun before each write and settled after),
  `before` and `expect` (a row that has moved is never written over or removed), R16's conditions and R19's.
- Where the DAB implementation differs from a middleman: `describe` learns the key from DAB's paging cursor (DAB
  2.0.12 names no fields), and `find` writes DAB's OData filter.
- What still goes around the interface: the test harness's own checks (`test-sql/check.mjs` calls DAB directly to
  test it), and `mcpToolCall` itself, which is the DAB implementation's transport.

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
