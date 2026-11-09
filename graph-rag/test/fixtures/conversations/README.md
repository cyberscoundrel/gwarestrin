# Conversation batches

The input model [ORGANIZATION-MODEL.md](../../../../docs/ORGANIZATION-MODEL.md)
puts in place of sparse notes: a batch is a set of on-record conversations,
each between a named person at a position and their agent, in which the facts
of one oracle note ([ORACLE.md](../ORACLE.md)) come up in context across a few
turns; with it, the condensed document the condenser is expected to emit and
where each claim and section is expected to land. `oracle-sixty.batch.json`
is generated from `oracle-sixty.json` by `scripts/make-conversation-batch.mjs
generate` (the generator is `graph-rag/e2e/conversations.mjs`); regenerate it
when the oracle changes (`test/harness-batch.test.js` fails when it is stale).

## Shape

```
{ shape: 1, batch, generated_from, generator,
  tree: { root, positions },            the position tree the homes refer to (the fixture tree)
  positions: { floor, Ops, "admins-only" } -> position id,   the batches' three names in the tree's ids
  people: { user: { name, position } },
  counts: { conversations, turns, sections, claims },
  conversations: [ conversation ] }

conversation:
{ id,                "conv-ux-m01"
  note, batch, primitive,                 the oracle note it comes from
  person, person_name, position,          the writer (its user id, spoken name) and the position the record is made under
  on_record: true,
  recorded_at,                            ISO; the document's recorded_at
  turns: [{ role: person | agent, text }],  the person opens; turns alternate
  expected: {
    document,        what the condenser emits, in the contract's shape (src/model/claims.js normalizeDocument):
                     { title, description, recorded_by, position, reason, recorded_at,
                       sections: [{ heading, text, claims: [claim] }] }; every claim has an id "ux-m01#0"
    sections:   [{ index, heading, authority, home }],   per section: the authority of its claims and the position it is seen from
    placements: [{ id, section, authority, home }],      per claim: its section, the authority (floor | Ops | admins-only) and the home
    document_home                                        the position the document entry is seen from (the origin)
  } }
```

Claims of one authority share a section, lowest first; the note's own words go
in the most restricted section and the lower sections carry only their own
claims, so a section never says more than the people who see it may read. A
claim's `home` is `authority.claimHome(tree, origin, authority)`: no lower
than the origin, raised to the authority position. A section's home is that
of its claims; a section with no claims (the oracle's residue) stays at the
origin, where the grader is the only judge.

A record with a claim whose home is above the recorder's position (an
admins-only price recorded from Operations) is proposed by the authority
rule, not written; the person holding that authority approves it, and only
then do its sections and claims land. The end-to-end scenario approves those
as the admin before running the bar; the seeder leaves them in the queue.

## How it is used

- `scripts/make-conversation-batch.mjs seed <batch> --url URL --tokens f` posts
  every conversation's condensed document as its person (through
  `ingest_document` by default; `--tool record_document` posts the document
  under the Condenser tool's `document` argument).
  It takes no default URL and is never run against the development instance
  without the user saying so.
- `scripts/batch-bar.mjs <batch> --url URL --token T` reads the batch's
  documents, sections, `CLAIMS` edges and approved moves back from an instance
  and prints the clean-batch verdict: no operator rescue, no wrong placement,
  no lost text, no hidden title in a lower section, and every claim saying
  what the batch says (subject, kind, class, attribute, value, dates, recorder).
- `graph-rag/e2e/scenarios-harness.mjs` checks the file's shape, validates
  every expected document, and records all sixty-two conversations through
  `record_document`, each as its person's own agent, under
  `policy-oracle.json` with the derived window live, then holds them to the bar.
