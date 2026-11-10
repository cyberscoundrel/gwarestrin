# The sixty-note oracle

**No longer the acceptance standard (R9).** The 62 notes stay as test input; the first real run is judged on
filing outcomes and tree quality ([ORGANIZATION-MODEL.md](../../../docs/ORGANIZATION-MODEL.md)). The claims,
classes and placements recorded per note below are the earlier design's and are history: atomic claims went
with R2. The fixture is [oracle-sixty.json](oracle-sixty.json).

Sixty real notes from the ux batches (plus the two PO 78912 notes added at the cross-check, 62 in all).

## Where the notes come from

The texts are the seed scripts' own note texts, first recovered from the
sessions that wrote `~/ux-live/b*.mjs` on the host (the host was unreachable
when the oracle was first made), then cross-checked read-only against the
development instance on 2026-11-05: 48 of the 60 are byte-identical to the
seed scripts still in `~/ux-live` (355 notes, ux-aa to ux-aw plus ux-v and
ux-z); the 12 from older batches whose seed scripts are no longer on the host
are confirmed against the graph entry itself, 10 verbatim inside the worker's
rewritten identity facet and 2 (t01, t02) paraphrased with the same content.
No text differed, so no classification changed. Each note's text here is the
text that was saved, not what a worker later edited into it: workers rewrote
most identity facets around the quoted original, and two (aa07, ai06)
deliberately dropped the pay figures from the graph. The development graph
holds 433 ux notes (418 at the snapshot plus ux-aw). The demo instance was
not touched.

`origin_position` is the writer's position in the test tree (org >
Operations (alice) > Production floor (bob)); nothing was seeded from the
root. `placed` is what the graph did with the note: its `_origin`, the
`_home` it ended at, its grade text, and how the text was confirmed. One
note, m03, was written at the root in the graph (pre-batch era) although its
seed line says alice; its `origin_position` keeps the writer. Where a note
has a second row with the same name (m01), the row at the writer's position
is the one reported. Placement over the 60: 23 Ops → admins-only, 15 floor →
floor, 8 Ops → Ops, 5 floor → admins-only, 4 Ops → floor (released to the
derived floor), 4 floor → Ops, 1 root → root.

Spread: 27 batches from ux-m to ux-aw (none from ux-ah, ux-ap or ux-x; ux-u was not recovered), 24
floor notes and 36 Ops notes, plus ux-note 13 (Ops) and ux-note 14 (floor). Ops is over-represented because almost every
note the batches flagged as a failure or an expected admins-only placement
was alice's. Every note the reliability notes and the batch memory name as a
known failure or a watched expectation is in: ak06 payroll, aj10 review,
aj09 tire, am10 coolant quotes, am15 deburr bench, ao04 Kayla extended, aq12
Corvane meeting, aq07 Hyd-Mech, as08 holiday schedule, at03 coffee maker,
z04 the note's own code, au04 and w05 (leaked titles), ar02 (reuse Corvane),
aq01 (same-named Diep), ab05 (quantity graded as money), m01 (EPP-D98 part
sign-offs), t22 (field-dumped text), the am/an/ao/aq/aw admins-only
expectations and w11, the doc's own `mssql:dbo_Job:4471`. The PO 78912
near-duplicate order things are covered by ux-note 13 and ux-note 14, the two
pre-batch notes about the EPP-D98 jobs on that PO: neither note says
"PO 78912"; a worker wrote it into their facets from the ERP row and the
linker minted six keyless order things from that prose (an operator
tolerated them on 2026-10-30). The PO is an attribute of the job rows,
referenced by key, never a node.

## Shape

```
{ id, batch, text, title, writer, origin_position,
  primitive: actor | commitment | event | resource | residue,
  instance: record key (mssql:dbo_Job:3260471) or a name, or null,
  class, claims: [ { kind, subject, class, attribute, value,
                     valid_from, valid_until, authority } ], notes }
```

- `primitive` is what the note is chiefly about; its claims may be of other
  kinds (an order note yields a commitment and a state).
- `kind` is the claim kind from the doc: `commitment | event | state |
  observation`.
- `subject` is a record key where the ERP has the row (employees NGUD, LOWB,
  FRAJ; customers EXATRON, BSE, TORO, COHU-CA, AETRIUM; vendor JOHNH; work
  center INSPECT-2; material MSP-02110K; jobs), the job key when a note names
  a job number the batches invented (3260410, 3260455, 3260471: the key is
  still the reference, the row may not exist), else a name. "the shop" is
  the organization as an actor. Machines like CNC 3 have no row (the ERP has
  one work center `CNC`) and are things by name.
- `valid_from` / `valid_until`: an ISO date where the text gives one (Nov and
  Dec are 2026, Jan onward 2027), `recorded_at` for the default interval of
  decision 3, `recorded_at+14d` style offsets for durations, `null` for
  open-ended or for a relative date ("Friday", "next week") the condenser
  resolves from the recording time.
- `authority`: the position whose authority covers the claim: `floor`,
  `Ops`, `admins-only`, as the batches use them. Where the batches accepted
  a grader's call that the authority map would answer differently (ao04,
  aq12), the oracle states the map's answer and the note records the
  grader's.

## Counts

| primitive | notes |
|---|---|
| commitment | 27 |
| event | 13 |
| actor | 11 |
| resource | 8 |
| residue | 3 |

100 claims: 39 commitment, 32 state, 17 event, 12 observation; by authority
42 Ops, 39 floor, 19 admins-only. (The sixty alone: 95 claims; the two PO
78912 notes add five.) Two notes fit a primitive and yield no
claim (aa11 is residue, ab11 is an event with nothing to record).

## The residue

Three of 62, none of them a fifth primitive:

- **ux-aa11** "The thing from Tuesday is sorted, no further action needed."
  An event whose subject exists only in the writer's head. Unresolvable
  subject, not a missing shape. Decision 2 covers it: store the section with
  no claim and let the condenser ask.
- **ux-t22** "Several customers complained about late cryo-optic parts this
  quarter; something in how we schedule the inspection step may be off
  across the board." An observation about a class of orders and a step of a
  class, plus a diagnostic question. The claim shape takes an instance or an
  actor as subject; here the subject is a class.
- **ux-w14** "Feels like quotes stall everywhere lately, not just Montana. Is
  it one person, the process, or the tooling?" The same: an observation on
  the quote class and a need whose subject is the class.

## What the residue suggests

Not a fifth primitive. The four held on 59 of 62 and the three that did not
fail on the subject, not the kind. Two of three are claims whose subject is
a class (a process) rather than an instance: an aggregate observation and a
diagnostic need. The fix is an attribute of the existing shape: `subject`
may be a class as well as an instance or actor, and a need on a class is
answered by a query over its instances (quote cycle times, inspection-step
lateness), which is the "current state" query the Queries stream builds
anyway. The third is an unresolvable subject, already covered by decision 2.

Two stretches worth naming, both classified as fitting:

- **Intentions and contingent plans** (av06 the owner's retirement, aq10 the
  conditional layoff, aj12 considering closing second shift, m03 "we should
  stop quoting below cost"). Nothing is owed yet, so they are not
  commitments; the oracle records them as a state of the actor (an
  intention) or a conditional commitment the way a quote is one. If more
  of these turn up in condensed conversations, "proposed" belongs on a
  commitment as a status, not as a new primitive.
- **Judgements as values** (ad03 "can run setups on his own", au13 "a big
  help", m03 "Karl thinks"). They fit as observations whose value is a
  person's judgement; admission rule 3 is what lets them earn a node when
  no system records them.

Patterns the sixty make concrete, for the streams:

- One note, several authorities: al04 (order at Ops, price admins-only),
  am12 and aw10 (restriction at Ops, the medical reason admins-only), au04
  (acceptance admins-only, status from December 1 at Ops), ab06 (an opening
  at Ops, offers admins-only). The grader wobbles (am10, ak06, ao04, aq12)
  were all on notes where the topic word and the attribute's authority
  disagree.
- Contradiction is two claims on one attribute with overlapping intervals:
  ac13 vs ad15 (rack contents), aa13 vs ac08 (October scrap), y05 vs z01
  (what shipped), af04 "no plans" at Ops vs aq10's contingent plan
  admins-only, which must not count as one.
- Changes of terms edit attributes on the same instance, they mint nothing:
  aj02 (due date, partial shipments), aa14 → ab08 → ac09 → ad07 (leave and
  cover), t02 → ag14 → ai14 → ak14 (the party).
- Things inside claims, never nodes: the front left tire (aj09), the deburr
  bench (am15), the time clock and the holiday schedule (as08), the note's
  own code (z04, v02), EPP-D98 as a part number on a job (m01).
- Resolution by key and class before embedding: Diep is NGUD, the active
  employee, in aa07, ab02, aq01, aw10; the inactive NGDT never matches a
  floor assignment.
