# The data contract

The shapes every stream of the organization model codes against
([docs/ORGANIZATION-MODEL.md](../../../docs/ORGANIZATION-MODEL.md)). Three
modules, pure functions over plain objects, no database, no model calls, no
dependency beyond Node and `positions.js`. Tests in `test/model-*.test.js`;
fixtures every stream shares in `test/fixtures/` (`classes.json`,
`policy.json`, `positions.json`, and the sixty-note oracle
`oracle-sixty.json`, whose 95 claims all validate: `test/oracle.test.js`).

## Shapes

**Class** (`CommitmentClass` vertex; fixture `classes.json`): a confirmed
commitment pattern. `name` (unique; what claims and policy use), `stages`
(in order), `record_table` (`system:table`, e.g. `mssql:dbo_Order`, or null
when no source system records it), `status` (proposed | confirmed |
retired), `confirmed_by`, `confirmed_at`. Nothing maps onto a class until a
person confirms it.

**Instance**: an `Entity` with `_kind: 'thing'`, `_class` naming its class,
and its record key in `_keys` (`system:table:row`, `mssql:dbo_Job:4471`,
the convention `things.js` already resolves by; `schema.recordKey(cls, row)`
builds one). An instance with no record table is keyed by name and origin
like any thing. Nothing else about the instance lives in the graph.

**Claim** (`CLAIMS` edge, out = the section or entry it was extracted from,
in = the subject thing): one primitive bound to a subject with an interval.

```
{ kind: commitment | event | state | observation,
  subject: { key | null, name | null, class | null, actor | null },
  class, attribute, value, value_num,
  valid_from, valid_until | null, recorded_at, recorded_by, section }
```

A subject is an instance (`class`, defaulting to the claim's, with a `key`
or a `name`), an actor (`actor`: person | position | customer | supplier |
agent, with a name or key), or the class itself (`scope: "class"`, an
optional qualifying `name`: an aggregate observation or a need on a
process, which is what the oracle's residue needed). The condenser may give
a subject as a string: a key when it parses as one, else a name. A claim
about an actor still names the class it bears on (a pay claim about Tomas
is `hires` / `pay`). `attribute` is snake_case; `stage` is the attribute
every class has and its value must be one of the class's stages. `value` is
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

- **Reference, never copy.** The graph holds keys, claims and provenance;
  rows stay in the source system. A claim's `value` is what was said, not a
  cached column.
- **Interval rule (decision 3).** No dates: `valid_from = recorded_at`, open,
  closed by the next claim on the same attribute of the same subject at that
  claim's `valid_from` (`claims.closeIntervals`). Two claims starting at the
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
  The grader runs only on text that maps to no class.
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
