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

**Source declaration** (`sources.js normalizeSource`): `{ system, read: { via, url }, commit: { via, url, tables,
actions } | { via: "none" } }`. A source with no commit is not writable, so a clear piece is Proposed (R2).
`briefSource` is what a brief may say about a source: how it is committed to, never its URLs.

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
