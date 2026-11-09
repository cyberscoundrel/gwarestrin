# The data contract

The shapes every stream of the organization model codes against
([docs/ORGANIZATION-MODEL.md](../../../docs/ORGANIZATION-MODEL.md)). Three
modules, pure functions over plain objects, no database, no model calls, no
dependency beyond Node and `positions.js`. Tests in `test/model-*.test.js`;
fixtures every stream shares in `test/fixtures/` (`classes.json`,
`policy.json`, `positions.json`, and the sixty-note oracle
`oracle-sixty.json`, whose 95 claims all validate: `test/oracle.test.js`).

## Shapes

**The rule**: an instance is an entity that has an instance relationship to a
class, and classes are of anything, in one tree. `docs/ORGANIZATION-MODEL.md`,
"Classes and instances", is the full text; what follows is the shapes. The
writers and readers have not moved yet: `CommitmentClass`, `_class`,
`_thing_type` and `ACTOR_TYPES` stay in use until they do.

**Class** (`Class` vertex; `schema.validateClass`; fixture `classes.json`): a
kind the organization recognizes. `name` (unique; what claims and policy use),
`stages` (in order; optional), `record_table` (`system:table`, e.g.
`mssql:dbo_Order`, or null when no source system records it), `status` (proposed
| confirmed | retired), `attributes`, `confirmed_by`, `confirmed_at`. Pure
functions take rows carrying `parent`, the confirmed parent's name. The four
primitives are the only roots and the only classes nobody confirms
(`schema.rootClassStatements()`).

**Tree** (`SUBCLASS_OF`, class to parent; `schema.classChain`,
`classAndSubclasses`, `assertSubclassLink`): one confirmed parent per class, a
link confirmed by a person, confirmed from the top, no cycles. A class counts only
when its chain reaches a root through confirmed classes. Rules, stage lists and
attributes inherit, the nearest class winning (`effectiveStages`,
`effectiveAttributes`, `effectiveRecordTable`, `authorityInChain`). A class's
primitive is its root, never stored.

**Instance**: an `Entity` with one `INSTANCE_OF` edge per class, and its record
key in `_keys` when a source system holds it (`system:table:row`,
`mssql:dbo_Job:4471`, the convention `things.js` already resolves by;
`schema.recordKey(cls, row)` builds one). A class in `confirmed` or `retired`
makes an instance; an edge to a `proposed` class is held and doesn't. An instance
with no record table is keyed by name and origin. Nothing else about the instance
lives in the graph.

**Claim** (`CLAIMS` edge, out = the section or entry it was extracted from,
in = the instance, or the `Class` for a class subject, or the section again
while the subject is a value): one primitive bound to a subject with an
interval. While the subject is a value the edge also carries `subject` (JSON),
`subject_norm` and `unresolved` (no-class | no-row | ambiguous).

```
{ kind: commitment | event | state | observation,
  subject: { key | null, name | null, class | null, actor | null },
  class, attribute, value, value_num,
  valid_from, valid_until | null, recorded_at, recorded_by, section }
```

A subject is an instance (`class` stating what the subject is, with a `key`
or a `name`), or the class itself (`scope: "class"`, an optional qualifying
`name`: an aggregate observation or a need on a process, which is what the
oracle's residue needed). An older `actor` field reads as `class` at the gate
and goes when the writers move. The condenser may give a subject as a string: a key when it parses
as one, else a name. The claim's own `class` is what the claim bears on and
never stands in for the subject's (a pay claim about Tomas is `hires` / `pay`,
and Tomas is a person; today's `claims.normalizeSubject` still defaults one
from the other, until the writers move). `attribute` is snake_case; `stage` is
the attribute a class with a stage list in force has, and its value must be
one of those stages. `value` is
stored as a string (numbers and booleans JSON-encoded), with `value_num`
when it is a number. Dates are ISO, or relative to the recording
(`recorded_at`, `recorded_at+14d`; d, w, m, y); a date without a zone is
UTC; a date alone is its start.

**Document** (what the condenser emits; `claims.normalizeDocument`):

```
{ title, description?, recorded_by, position, reason, recorded_at?,
  sections: [{ heading?, text, claims: [claim] }] }
```

Stored as `documents.js` stores a manual: a document entry with the
on-record marker (`_on_record`, `_recorded_by`, `_recorded_at`,
`_record_position`, `_record_reason`), section entries `PART_OF` it, and
each claim a `CLAIMS` edge from its section. A section with no claims is
still stored and searchable; the grader runs on it (decision 2).

**Source reference** (`SourceRef` vertex, `REFERS_TO` from the instance):
one row of a source system by `key`, with `system`, `table`, `row_key`,
`last_seen`, `seen_by`. Never a copy of the row.

**Audit event** (`AuditEvent` vertex, `WROTE` to the `SourceRef`): an
agent's write to a source system: `key`, `authorized_by` (the person),
`acted_by` (the agent), `position`, `at`, `change` (JSON), `outcome`
(applied | proposed | refused | failed), `pending_id`.

**Policy** (fixture `policy.json`; `authority.validatePolicy`): what an
admin edits. `classes[name].authority`, `classes[name].attributes[attr]`,
`attributes[attr]`, optional `default`, each a position id. This replaces
`restrictedTopics` for everything that maps to a class.

## Invariants

- **No class, no instance.** `schema.instanceClass(subject, classes)` is the
  gate, asked only after looking finds no instance: a key by the class whose
  record table holds it, or the subclass of it named; a confirmed class stated for
  the subject, which needs the row when a table is in force. Otherwise the subject
  is a value on its claim, and `reason` says why. A primitive holds no instances
  directly, and nobody is exempt: a person before any class is confirmed is a
  value. The gate is about classes, not who may mint: a key, a person, a worker.
- **The edge is the only record.** A mint writes entity and first edge in one
  transaction; nothing stores a class name beside it, and a read of a class filters
  by `authority.visible`.
- **Migration is a plan, and idempotent.** `schema.planInstanceMigration` turns
  `_class`, `_thing_type` and `CommitmentClass` rows into new classes and edges.
  It never confirms a class. Run it twice and the second plan is empty.
  `schema.instanceEdgeSql` makes each edge, safe to repeat.
- **Reference, never copy.** The graph holds keys, claims and provenance;
  rows stay in the source system. A claim's `value` is what was said, not a
  cached column.
- **Interval rule (decision 3).** No dates: `valid_from = recorded_at`, open,
  closed by the next claim on the same attribute of the same subject at that
  claim's `valid_from` (`claims.closeIntervals`, applied per reader at read
  time over the claims that reader sees: a claim above someone never ends
  what they see, and nothing stamps a close on the stored edge). Two claims starting at the
  same instant both stay open; with different values they are a
  contradiction (`claims.overlaps`), never a succession. An event is a point
  (`valid_from = valid_until = at`) unless the text gives it an end (a
  two-day closure); it neither closes nor is closed. An explicit
  `valid_until` is kept.
- **State is a query.** `claims.stateOf(claims, subject, asOf)` is the
  current state; the latest `valid_from` in force wins. Contradiction is
  two overlapping claims with different values, after closing.
- **Authority is one rule.** `authority.decide(identity, class, attribute,
  policy, positions)`: `direct` when the identity holds the authority
  position or one above it; `propose` when it holds one below; `hidden` when
  it holds none on that line. No rule for a class means the writer's own
  position holds it. An identity with `caps.write: 'queued'` never gets
  `direct`. An authority position the tree does not know counts as the
  root.
- **The three readings.** Visibility: a claim is seen when `decide` is
  `direct` (`authority.visible`). Proposals: a write goes through when
  `direct`, is queued when `propose`, and when `hidden` is held at the
  common ancestor for someone with authority over both sides. Grading: a
  claim is homed at `authority.claimHome(positions, origin, authority)`, the
  lowest position at or above both its origin and its authority; a section
  is homed no lower than its most restricted claim and no lower than its
  document (decision 5), the stricter winning (`positions.commonAncestor`).
  The grader runs on text no rule covers: a section with no claim, a claim
  with no rule (decision 2), or a sentence no ruled claim states; its verdict
  can only restrict further than the claims' placement (`placement.claimsSettle`).
  A policy's attribute names are normalized as a claim's are. An authority
  a policy names that the tree no longer has stays in the map and counts as
  the root (`staleAuthorities` lists them; `policy.normalizeStored` logs them).
- **Provenance sets the home; nothing widens it.** `claimHome` never returns
  a position below the origin. Unknown anything fails upward.
- **Errors name the field.** `ClaimError.field` is a path
  (`sections[1].claims[0].value`); `validateDocument` returns every claim's
  error at once; `validatePolicy` throws with the field.
- **Confirmed classes gate claims.** With a class set given, a claim naming
  an unconfirmed class is an error; never mint a class from one occurrence.
  Without one (a stream that has not loaded them), any name passes and
  stages go unchecked.
- **DDL is idempotent.** `schema.statements()` is safe to run at every start;
  it extends `Entity` and declares the new types; it redeclares nothing that
  exists. Nothing in this directory executes it.

## What the existing code gets from this

`things.js normalizeKey` and `schema.parseKey` agree on `system:table:row`;
the Admission stream should import the latter. `policy.restrictedTopics`
stays for the grader's residue; the Authority stream replaces the ~15
`queueWrite` level tests with `decide`. `documents.js` is the storage shape
for everything on record; its `parseExtraction` facts become claims through
`normalizeClaim`.
