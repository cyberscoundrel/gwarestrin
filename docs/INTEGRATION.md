# Integration

## The build on `build-base` (current)

Status: 2026-11-10. `build-base` is at ba583bc: the contract and the removals
([BUILD.md](BUILD.md)). The four streams (record, classes, filing, sources)
build from it; the integrator lands them one at a time, each after the
independent reviewer has passed it, with every check run after each merge and
`build-base` moved only by a fast-forward push. The design is
[ORGANIZATION-MODEL.md](ORGANIZATION-MODEL.md); the rulings
(`~/reviews/design-rulings.md`, R1 to R12) outrank it and this file. The
evaluation plan is [build/integrate.md](build/integrate.md).

### Landed

| # | Branch (tip) | Reviewed | Merge | Conflicts, and what each side kept | Checks |
|---|---|---|---|---|---|
| 0 | contract (ba583bc) | coordinator | fast-forward base | none | graph-rag 172/172, e2e 25/25 |

No stream branch has landed yet.

### The integrator's branch, before landing

`claude/build-integrate-a53e86`: the evaluation (`graph-rag/eval/`,
`test/eval.test.js`), the harness rework (`e2e/fake-source.mjs`, `e2e.sh`,
`run.mjs`, `fake-models.mjs`, `scenarios-harness.mjs`, `SCENARIOS.md`), the
scripts (`scripts/make-records.mjs`, `source-dump.mjs`, `filing-report.mjs`)
and one contract addition: the `BriefLog` document type in `model/schema.js`.
It lands on `build-base` with the first stream merge.

### Ruled since the contract

- **F4 is R12** (the user, 2026-11-10: "Yes, write changes"). A record that
  says something changed is an update, filed to the source given the
  recorder's authority and checked by the orchestrator afterwards; a record
  that describes the current state and disagrees with the source, without
  saying anything changed, is Held with a question to the recorder. The labels
  follow it: of the nine notes with a stated row change or state, eight say
  something changed; ux-m01 ("INSPECT-2 is down") states a state, so it is Held.

### The review of ba583bc (`~/reviews/build-build-base-ba583bc.md`): the integrator's items

- **B3, fixed.** Worker reads no longer take `beyond: true` (`server.js`):
  `search_graph`, `about_thing` and `read_document` read only the worker's
  entry's audience (R11: "each seeing only its audience"), and an audience that
  can't be resolved reads nothing, where it used to fall back to the delegating
  admin's whole view. The orchestrator (master) keeps its full view.
- **Found while fixing B3, and fixed with it.** A worker delegated by an admin
  inherited `raw`, so it was offered `query_graph`, which bypasses every read
  filter. A worker is no longer offered it, and the handler refuses a worker
  too (`server.js`). `execute_graph` stays: a worker's raw command is always a
  proposal for an admin (`write.js`), never run for it.
- **The test.** A replay scenario lists every tool a worker is offered and fails
  on one it doesn't sort into reads or writes. It checks that each read tool,
  with and without `beyond`, returns nothing of a root-only note, a root-only
  document or a root-only instance, that `query_graph` is neither offered nor
  answered, and that `execute_graph` only proposes and shows nothing. A control shows the admin's search does find the note, and a worker
  whose entry doesn't exist reads nothing.
- **Item 9, fixed.** The stale `CommitmentClass` sentence in `model/schema.js`
  is gone, and so are the dead triage statistics in `packages/web/src/lib/api.ts`
  and `GraphWorkerPanel.svelte`. That panel is the filing stream's file,
  changed here at the coordinator's request: five lines, one `{#if}` block.

### Requests to the streams

| To | Request | Why |
|---|---|---|
| filing | `packages/server/src/agents/instructions/worker.ts:13` and `graph-roles.ts:30` still tell workers about `beyond: true` and `query_graph`, which workers no longer have (B3) | The instructions should name only the tools a worker is offered |
| filing | Expect a one-block change in `GraphWorkerPanel.svelte` (the triage line removed, review item 9) when merging | So the conflict, if any, keeps both |
| filing | Write every brief, exactly as sent, to `BriefLog` (`model/schema.js`): `{ id, record, audience, worker, brief (JSON), dropped (JSON), at }` | The leak gate scans every brief as sent (proposal B; integrate.md 2.6). Without it the gate sees only what workers wrote |
| filing | A Held entry for a piece with no source at all (ux-aa11, "the thing from Tuesday") needs a `target.table`, which `normalizeEntry` requires | Either a table is named or the shape allows none; see choice I-6 |
| classes | Name the property that holds an instance's source key (`eval/collect.mjs` reads `_record_key`, `record_key` or `key`) | Placement checks compare the key with the row |
| record | The path a file uploaded on record takes (R11), for `make-records.mjs seed` (it calls `record_document` as the person today) | The 62 notes enter as uploaded documents (choice I-8) |
| sources | Publish the synthetic database's tables, writable columns and rows, as a dump `make-records.mjs check --data` reads | The outcome labels are computed against S0 until then (choice I-1) |

### Choices needing a ruling

The contract's, as [BUILD.md](BUILD.md) lists them (owner in brackets):

| # | The choice made |
|---|---|
| 1 | A class name is unique in the organization, whatever the homes (classes) |
| 2 | A class whose `rows_are_nodes` is unset keeps its rows in the source (classes) |
| 3 | The four roots are homed at `everyone` (classes) |
| 4 | A dependency carries when it was stated, and optionally from and until when (classes) |
| 5 | The stored map's global `attributes` and `default` entries decide nothing; a class's per-column entries count, strictest wins (filing) |
| 6 | A class with no entry takes its nearest ancestors' entries, strictest of them (filing) |
| 7 | A recorder has authority when they hold the mapped position or one above it (filing) |
| 8 | The filing log is a `FilingEntry` document type in the same ArcadeDB (filing) |
| 9 | An orchestrator's verdict is `matches`, `differs` or `unverifiable` (filing) |
| 10 | A source conflict is Held with a question and also raises a `conflict` request (filing) |
| 11 | A source write may create and update, never delete (sources) |
| 12 | A recorder who has left or moved: the adapter refuses and the piece is Held (sources, filing) |
| 13 | A proposal on a class missing from the map is approved by a person at the root (sources) |
| 14 | Re-homing moves the sections about a class's own instances only (record) |

The integrator's (labels and evaluation, [build/integrate.md](build/integrate.md)):

| # | The choice made |
|---|---|
| I-1 | **S0**, the test source the labels assume: Job and Work_Center writable (create, update; named columns), Employee, Customer, Vendor and Material read-only; the invented jobs 3260410, 3260455, 3260471 absent; no Brightline, Corvane or HILL rows. Replaced by the sources stream's synthetic database when it ships |
| I-2 | **M0**, the test map, keyed by a class's source table (Job and Customer and Vendor and Material at Operations, Work_Center at the floor, Employee at the root), because classes don't exist until discovery mints them |
| I-3 | Authority is the recorder's position at or above the mapped one (the same as contract choice 7) |
| I-4 | No attribute-level map entries in M0: Operations files a price on a Job row; visibility is the check's job |
| I-5 | **Someone or something the source should hold but doesn't** (Lucas, Marisol Vega, Tomas, Kayla, Brightline, Corvane, HILL, Andre, Darrin S.): the labels accept a new instance with Kept and a Held question to the recorder alike, and the report says which each model chose (the coordinator: that is what the user wants to observe) |
| I-6 | ux-aa11's unresolvable subject is labelled Held; Kept is accepted |
| I-7 | A disagreement with an earlier Kept document (ux-ad15 against ux-ac13) is labelled Held, since for Kept the document is the source |
| I-8 | The records enter as uploaded documents, one section each, with the condenser out of the first run, so every setup gets identical input; note codes are stripped from titles (ux-v02's text keeps its own "Per ux-z03") |
| I-9 | Marker records (six, seeded) are added beside the 62 for the leak gate; a marker's home is read from the graph after the run, not planted |
| I-10 | S0 has no free-text notes column, so a Filed piece is always a structured value |
| I-11 | ux-t07 stays as input, labelled Kept |
| I-12 | **R12's reading of ux-m01**: "INSPECT-2 is down until the gauge is recalibrated" describes a state and says nothing changed, so it is Held, not Filed |
| I-13 | The `BriefLog` type is added to the contract (`model/schema.js`) for the leak gate; the filing stream writes it |
| I-14 | The test configuration sets the synthetic connection's home to everyone (the coordinator), so the source carries no markers and source writes are scanned as seen by everyone |

---

The rest of this file is the earlier integration report (the `integration`
branch, before the rulings), kept as history.

## History: integrating the seven streams

Status: 2026-11-09. The `integration` branch merges the seven stream branches
of [ORGANIZATION-MODEL.md](ORGANIZATION-MODEL.md) one at a time in dependency
order, each gated by `graph-rag`'s unit tests and the replay harness
(`graph-rag/e2e/e2e.sh`), with the wiring each stream left for the integrator
in separate commits. Nothing here is merged into `main` or deployed: moving
`main` is the user's decision after this report.

An independent review of 9a84cd2 (`~/reviews/integration-9a84cd2.md`) found 25
blocking findings, B1-B25. A re-review of 2a1a12f
(`~/reviews/integration-2a1a12f.md`) found 10 of them fixed, 15 partly fixed
and 5 new ones (NB1-NB5). A second round of fixes is merged here; nothing has
reviewed this tree independently yet. See
[The review's findings](#the-reviews-findings-b1-b25) and
[Round two](#round-two-the-re-review-of-2a1a12f) at the end. The sections below
describe the first integration and are corrected where the reviews showed them
false.

## Merge order and the wiring commits

| # | Branch (tip merged) | Merge commit | Wiring commits (integration's own) |
|---|---|---|---|
| 1 | `claude/stream-harness-2d67f9` (4b7203d, then 78d9875 at the end) | 5d20127, 81425d9 | — |
| 2 | `claude/stream-condenser-8c5036` (c0a49c4, then d04cc40, 563e5f2, 899369b) | caa932a, 4df0a90, 3540c66, b7672bb | 0e69f79 `server.js`: `registerRecordTools` for writing identities with no role; `model/schema.statements()` at boot. 838497f, 643f6cf `e2e/scenarios-harness.mjs`: the end-to-end batch posts `{ document }` to `record_document` and confirms the classes its claims name first |
| 3 | `claude/stream-admission-ba992d` (b32860d, then f8bb57a) | 989fb6d, 645c867 | — (its exports kept every signature; `sourceref.js`'s DDL is in the boot statements) |
| 4 | `claude/stream-authority-a67b98` (158782c) | 12e0676 | 9c314e8 `server.js`: `upsert_entities` takes `claims` per entity for placement and decides through `decideWrite` (the claims place the entry and are then discarded: no CLAIMS edge, no error; review N3, still open); `embed_backfill` the same; `ingest.js`: a manual's `requestIngest` decides through `decideWrite` (the condensed-document path already did) |
| 5 | `claude/stream-discovery-5147ad` (341c683, then ea6b2bf) | 8a74691, 0c556ee | 19516a1 `routes.js`: `registerDiscoveryRoutes(app)`; `server.js`: `ensureDiscoverySchema()` at boot. The merge 8a74691 kept the two new sections of `OrgSettingsPanel.svelte` (Commitment classes before Authority) and dropped the existing "Derived data" section's render, which both parents had. That was this conflict resolution's error (review B25), restored by fix-discovery |
| 6 | `claude/stream-queries-229b0e` (796aab2, then 7ff9351, 8cd8ec4, 5820e54) | 14f3ff8, 69b72aa, 7ef8270, e3a7f7b | 09e4070 `server.js`: `registerQueryTools` after `about_thing`, `as_of` on `search_graph`; `routes.js`: `registerQueryRoutes(app)` |
| 7 | `claude/stream-reconcile-9b8634` (18e1f50, then 298a9cb) | fe073d0, 45cd273 | — (`registerWorkerTools` kept its call; `data_entry` runs through `executePending` as the Authority branch wired it) |

Every "then" tip is a fix the owning stream committed in its own files at the
integrator's request during the merge (listed per stream below). The
integration's own commits touch `server.js`, `routes.js`, `ingest.js` (two
decision sites) and `e2e/scenarios-harness.mjs`, plus this file. `ingest.js`
and `scenarios-harness.mjs` belong to streams, so those commits did patch
streams' files from this branch, as did the conflict resolution in 8a74691.

The Reconciliation branch was rebased onto the Condenser's 5e22242 before it
started, so its `instructions/*`, `ingest.js` and e2e condenser files merged
as the Condenser's later commits left them.

## What each stream's report said it lacked, and how it was resolved

**Test harness.** Seven built-in scenarios rewritten for the reconciliation
tools failed until Admission and Reconciliation landed (by design); the
"with triage ahead" scenario passed once Admission was in. Its end-to-end
conversation-batch scenario had never run (it switches on when a tool matching
`/condens|on_record|record_document/` is listed); once `record_document` was
wired it exposed four harness-side mismatches, fixed by the harness session
on its branch and by two integration commits: the tool's argument shape, the
classes the batch names (the oracle's, not `fixtures/classes.json`) needing
confirmation in the graph, a collision with its own bar scenario's rows (same
titles and claim ids), bob's derived floor from an earlier scenario, and the
absence of an authority map for the sections it expects above the recorder.
The harness session's 78d9875 (merged at 81425d9) runs the batch under a
policy derived from the batch's own placements (`authorityMapOf`) with the
derived window at zero, approves the records the rule proposes (a record with
a claim above the recorder's authority is proposed, by design), gives the bar
scenario a prefix of its own, and adds `_authority` and `_claim_classes` to
`run.mjs`'s `entry()` for the Authority scenarios' helpers. That scenario ran
5 of the 62 notes and read only ids and homes, so its green proved little
(review B22); it is replaced, see the findings section.

**Condenser.** (1) No tool table to add `record_document` to: wired in
`server.js` (0e69f79); `ingest_document` with the document as JSON in `text`
still works. (2) `decideWrite`/`placeByClaims` read through namespace imports:
present after the Authority merge, so a record is decided by its claims'
authority and claimed sections are placed by `placeByClaims`. (3)
`fetchConfirmedClasses` returned null below the root: the Condenser session
rewired it to the Discovery route `GET /api/discovery/classes?status=confirmed`
(d04cc40), `query_graph` as the root fallback. (4) Its "CLAIMS edges" check,
reported failing in the full suite by the harness stream: passed in every full
run here at c0a49c4 and later (the earlier failure was the 5e22242 version). (5)
The stored text of a recorded section began with the heading line, unlike a
manual's chunks; fixed at 563e5f2 so the bar's text comparison holds. (6) A
record's payload `floor` was `decideWrite`'s floor over all the document's
claims, so one admins-only claim lifted every section of the document to the
top; now the derived floor alone (899369b), each section placed by its own
claims through `placeByClaims` and the residue by the grader, the document
bounding them from below. The proposal's review home is still the strictest
claim's.

**Admission.** Three built-in scenarios that asserted a bare name becomes a
thing were already rewritten by the harness stream. Its `_unresolved` marker
replaces the master's `fresh` names; the Reconciliation branch reads it. The
linker reads confirmed classes from `CommitmentClass` rows (Discovery's
output), so no wiring was needed. Two of its scenarios minted through the
worker tool `link_things`, which Reconciliation removes; rewritten around
`resolve_subject` (f8bb57a; one alias assertion dropped, since the found-by-key
path adds no alias).

**Authority.** All its sites were inside its own modules; the three outside
(`upsert_entities`, `embed_backfill`, the manual ingest) are 9c314e8. After
the merge no `caps.write === "queued"` site test remains outside `write.js`
(the one in `ingest.js` is the fallback when `decideWrite` is absent). That
was true and misleading: `data-entry.js` hard-coded `write: "direct"` for the
person it acted for, so queued people could write directly (review B2, fixed
by fix-entry). Its
`data_entry` queue case (`executePending` → `data-entry.js
applyProposedEntry`, `refusePending` → `refuseProposedEntry`) loads the module
lazily and worked unchanged once Reconciliation landed.

**Discovery.** `knowledge.ts` proxies for the confirm panel were outside its
ownership; kept, since the panel cannot reach graph-rag without them. Its
`reasons` and `attributes` class properties are declared from its own module
(`EXTRA_CLASS_PROPERTIES`), ensured at boot (19516a1); the contract owner may
take them into `TYPES.CommitmentClass`. Its scenarios drafted `orders`/`jobs`,
which the Condenser scenario confirms first on the shared graph; fixed by the
Discovery session with names of its own (ea6b2bf).

**Queries.** Its three wiring lines are 09e4070. Its fourth scenario used the
worker tool `update_entry`, which Reconciliation removes; the Queries session
rewrote the held/not-held checks around `resolve_subject` (796aab2) and dropped
its own DDL in favour of the boot statements. Its scope scenario then collided
on the key `mssql:dbo_Employee:NGUD` with an instance the batch scenario's
record of ux-aq01 had minted (the record path mints an instance for a key no
thing carries); its `thing()` helper now reuses a thing by key and the
scenario takes a key of its own (7ff9351), then a person's name of its own
too, since the Admission scenarios mint two same-named Dieps by key (8cd8ec4),
and a thing type the linker admits (Admission removed `other` from the linker,
5820e54; `ingest.js` went on minting `other` until fix-resolve, review B14).

**Reconciliation.** (1) `resolve_subject` on a bare name matching an existing
thing linked nothing: fixed at 88a93d5 (an `ABOUT` edge through `aboutOnce`,
the thing seen from the worker's floor). (2) `audit.js` and `sourceref.js`
both created `SourceRef` rows on the same key: `audit.js` now stores rows and
`REFERS_TO` edges through `sourceref.js` (355910b). (3) `resolveSubjectStub`
read classes from an `OrgPolicy` row; now from the confirmed `CommitmentClass`
rows via the linker's `confirmedClassList` (18e1f50). (4) With the Authority
branch present, `data-entry.js decideWrite` delegated to `write.js` without
the stored authority map, so two of its unit tests failed on the merged tree;
fixed at 298a9cb (the map is resolved first, the live `authorityMap` winning
over the stub's `OrgPolicy` row, and handed to `write.js`'s rule as
`ctx.policy`). The `dab-write` compose service and
`dab-config.example/dab-config-write.json` are in the tree, not deployed. The
DAB tool argument shapes in `DAB_CALLS` were assumptions, and they were wrong
(review B20); fix-entry made them DAB 2.0.12's and checked them against a live
instance.

## Results

On the final tree (`integration` at the merge of 5820e54, after e3a7f7b):

| Check | Result |
|---|---|
| `graph-rag` unit tests (`npm test`) | 250 passed, 0 failed, 0 skipped |
| Replay harness (`graph-rag/e2e/e2e.sh`, full suite) | 48 of 48 scenarios passed, none skipped: 21 built-in (the retired grading-sensitive one is gone), harness 3, condenser 4, admission 3, authority 4, discovery 3, queries 5, reconcile 5 |
| `packages/server`: `tsc --noEmit` | clean |
| `packages/server`: vitest | 26 files, 179 tests passed |
| `packages/web`: `svelte-check` | 0 errors, 0 warnings |
| `packages/web`: `vite build` | built (the usual chunk-size warnings) |

These are the results of the first integration, at e3a7f7b, reproduced by the
review at 9a84cd2; the current results are in the findings section. The counts
below were reported at the time and cannot be checked from the tree.

The harness was run after every merge; the counts along the way were 15/23
(harness alone on main, the eight failures awaiting Admission and
Reconciliation), 19/28 (Condenser), 25/31 (Admission), 28/35 (Authority),
28/38 (Discovery, three ordering failures), 32/43 (Queries), 43/48
(Reconciliation), then 46, 47 and 48 of 48 as the stream fixes above landed.
Nothing is deployed; the development instance and the demo were not touched.

The root `package-lock.json` is unchanged (an `npm install` for the server and
web checks only added `peer` flags, reverted); `graph-rag/package-lock.json`
is not tracked and was not added.

## Two decisions for the user (not taken here)

1. **A writer's own notes above their position.** A search records what it
   shows as reads, and a writer's own notes graded above them show via
   "writer", so searching once raises that person's derived floor for the
   window (`derivedWindowHours`). The harness stream dodged it with a fourth
   identity (carol) for a negative check; the landing batch now records through
   fresh agents with the window live, and a scenario of its own covers the
   record path under a live floor (with another person's note, so it does not
   decide this). The Authority stream did not change the rule. Whether a
   writer's own notes should raise their floor is for the user to decide.
2. **The oracle's need ux-t07.** One need in the sixty-note oracle has an
   authority that follows what it asks about rather than its class. The
   contract and the streams treat authority as a property of the class (and
   attribute); this one case does not fit and was left as the oracle records
   it, for the user. It does not fail the landing bar on this path only because
   the section is raised by the note's other claim, so the bar is silent on it.

## The review's findings (B1-B25)

Merged into `integration` one at a time on `claude/fix-harness-merge-609120`,
with `npm test` and `e2e.sh` after each, and each conflict resolution read with
`git show --cc`. B22 (the harness) is 4e7d177.

| # | Branch (tip) | Merge | Findings | Conflicts | Wiring commit |
|---|---|---|---|---|---|
| 1 | `claude/fix-visibility-c135d1` (13cf282) | 39b25ca | B4 B5 B6 B7 B10 B11 | none | b575f85: closing is a read, so a stored claim keeps its own interval; the grader may judge a section whose claims don't settle it |
| 2 | `claude/fix-record-d1e7ea` (7d95c40) | 4088831 | B1, B2 (recording), B8 B12 B13 B21 | none | 85fa2da: the recording time is the server's; a batch agent's thread goes on record first |
| 3 | `claude/fix-resolve-734b26` (cba8c2f) | 88995d0 | B9 B14 B15 B16 B17 | `ingest.js`: kept fix-record's per-home lookup and stable claim ids, fix-visibility's removal of write-time closing, fix-resolve's claim with no thing | 7121b4c: the bar reads a claim with no thing by the subject written on it; two condenser scenarios given a subject that earns a node, or counted by document |
| 4 | `claude/fix-entry-77694e` (a94537a) | 23e58c5 | B2 (authorization), B3 B18 B19 B20 | `e2e.sh`: both token additions; `worker-tools.js`: both imports | 8ab1720: a key an existing thing already holds in another case is not a new key (the row check, B19, and any-case keys, B15); the admission scenario gets a fake source holding those rows |
| 5 | `claude/fix-discovery-9921bf` (bc974ea) | 9e4bc40 | B23 B24 B25 | `server.js`, `worker-pool.js`: imports | 56ac8e3: `propose_class` is listed only when the thread is on record |

The harness (B22): all 62 oracle notes go through `record_document`, each as
its person's own delegated agent, under the hand-written
`test/fixtures/policy-oracle.json` with the derived window live; the harness
stream runs last so its notes reach no other scenario. The bar compares each
landed claim's subject, kind, class, attribute, value, dates and recorder, the
section it came from, and section, document and claim homes against the oracle.
A row corrupted on any of those fails it, in the unit tests and on rows read
back from a real ArcadeDB; the re-review found exceptions, closed in round two
(below). `e2e.sh` now also tags its image per run, so
sessions running side by side cannot swap builds.

Results at 2a1a12f (round two's are below):

| Check | Result |
|---|---|
| `graph-rag` unit tests (`npm test`) | 294 passed, 0 failed |
| Replay harness (`graph-rag/e2e/e2e.sh`, full suite) | 72 of 72 passed: 21 built-in, admission 7, authority 8, condenser 9, discovery 4, harness 4, queries 9, reconcile 10 |
| The landing bar | `CLEAN oracle-sixty: 62/62 documents, 100/100 claims; rescues 0, misplaced 0, lost 0, hidden titles 0, wrong content 0` |
| `packages/server`: `tsc --noEmit` | clean |
| `packages/server`: vitest | 27 files, 183 tests passed |
| `packages/web`: `svelte-check` | 0 errors, 0 warnings |
| `packages/web`: `vite build` | built (the usual chunk-size warnings) |

Against 9a84cd2 the same bar failed 7 of 62 notes: six refused outright for a
null `valid_from` (ux-w05, ab06, ad03, ai06, am06, aq12; B21) and one on the
wrong thing (ux-w14; B14). All seven pass now.

## Round two: the re-review of 2a1a12f

Merged one at a time on `claude/fix-harness-merge-609120`, each with `npm test`
and `e2e.sh`, and each conflict resolution read with `git show --cc`. The
Discovery branch had nothing new. B22's second round is 9ccdd3a.

| # | Branch (tip) | Merge | Findings | Conflicts | Wiring commit |
|---|---|---|---|---|---|
| 1 | `claude/fix-visibility-c135d1` (cd5d641) | 0985b21 | B4 B11 remainders, NB3, B6 re-homing on a tightened rule (the user's decision) | none | none |
| 2 | `claude/fix-record-d1e7ea` (a4009b2) | d0074b3 | B1 remainder, NB1, B8 document title | `floor.js`, `write.js`, `ingest.js`: fix-record's title-after-sections order, with fix-visibility's claim text, regrade floor and claims following the entry. `e2e.sh`: the clock and `AFTER`. `conversations.mjs`, `harness-batch.test.js`, `scenarios-harness.mjs`: section origin with the untitled section, in the shared landing helper | c0b03ea: a regrade floors a section by the document's own grade (`_doc_base`). `settleDocument` had raised `_home` to the waiting section's, so nothing came down after an outage; shown failing on the bare merge. Scenarios find a section by its document |
| 3 | `claude/fix-resolve-734b26` (218bf55) | 7a86f17 | B8 alias and key, B9 B14 B16 B17, NB2, NB4 | `ingest.js`: `ownSections`, with the per-section authority read. `scenarios-harness.mjs`: no connected source, the shared class list | aced4c1: the bar reads B9 and NB2 as they are (see below); a stream's fake source ends with its stream |
| 4 | `claude/fix-entry-77694e` (b92bf55) | c6b91a9 | B2 B3 B18 B19 remainders, NB5 | `worker-tools.js` `keyOf`: fix-resolve's held keys and hidden label, with fix-entry's class lookup that fails closed and the claim's scope | 95d95ad: the bar's hand-seeded rows carry a vector, so the harness's sweep leaves their text alone |

Two scenarios changed name and widened; none was dropped. "An off-record
thread can reach no graph write tool" is now "can write nothing at any tool or
route" (fix-record). "The authority decision covers every column written" is
now "an entry writes only what the claim says" (fix-entry).

**fix-record changed the oracle's expected answer in one way:** `document_home`
for the 20 notes with a section above the writer's position is now the most
restricted section's home, following the B8 rule. `conversationOf` computes it; no claim,
section home or placement changed.

**The bar (B22).** It no longer depends on today's date: the batch's absolute
dates move to the run's day, and it passes with the server and runner clocks
faked forward (`CLOCK_SHIFT_DAYS`, 30 and 200 days). It now also fails on a
subject stated beside its thing, a null claim home, a duplicate thing, an
appended tail, a failed document, document and section origin, a section's
`_doc_id`, `closed_by`, an extra section, a claim from outside the batch, and
a thing's `_homes`. It runs twice: under `policy-oracle.json` and under the
shipped default map. A SKIP or an empty run now exits non-zero.
Not checked: a thing's `_home`, because every writer sets it to the root and
scoping reads `_homes`.

Two of those checks were narrowed at aced4c1, because the fixes made the states
they flagged legitimate, and unit tests pin both sides:
a keyed subject may be seen only from above its claim (B9: a key links without
bringing the thing down), while a keyless one must be seen from its claim; and
a second keyless thing of the same name counts only when the two share a home
(NB2: a name never binds to a thing its writer can't see). So the bar does not
catch a keyless duplicate made across a parent and child home, which it cannot
tell from that legitimate case in the rows alone.

Results on this tree (`integration` as pushed):

| Check | Result |
|---|---|
| `graph-rag` unit tests (`npm test`) | 318 passed, 0 failed |
| Replay harness (`graph-rag/e2e/e2e.sh`, full suite) | 99 of 99 passed: 21 built-in, admission 14, authority 8, condenser 10, discovery 4, harness 5, queries 9, reconcile 13, visibility 15 |
| The landing bar, under `policy-oracle.json` and under the shipped default map | both `CLEAN oracle-sixty: 62/62 documents, 100/100 claims; rescues 0, misplaced 0, lost 0, hidden titles 0, wrong content 0` |
| The landing bar with the clock 30 days ahead | 5 of 5 harness scenarios passed, both bars CLEAN, first recording stamped 2026-12-09 |
| `packages/server`: `tsc --noEmit` | clean |
| `packages/server`: vitest | 27 files, 184 tests passed (see the EPIPE note below) |
| `packages/web`: `svelte-check` | 0 errors, 0 warnings |
| `packages/web`: `vite build` | built |

Still open, none of them failing the bar:

- **The first mention of a keyless name has no thing until a worker resolves
  it.** After NB4, 24 of the 100 batch claims land on no thing under the oracle
  policy and 40 under the default map (the prefixed run, which earlier
  scenarios have not seeded). A second mention earns a thing only for an
  individual, and the first claim then moves onto it. The rest wait for a
  worker, and `POOL_DEFAULTS.poolSize` is 0: **a default pool never adopts
  them.** No worker runs in the harness. The bar checks the subject as
  written, not that such a claim is ever adopted.
- **The same name can now be two things across homes (NB2).** A floor note
  naming something only known above the floor makes its own thing. In the
  batch that is "CNC 2" and "Kayla". It is what NB2 asked for, and nothing
  joins the two until a worker does.
- **A tightened rule and a document's title disagree.** Decision 5 in
  `ORGANIZATION-MODEL.md` says the document and its title stay while another
  section is still seen there, and `tightening.js` does that. B8's rule says a
  title is no lower than its most restricted section, and every other route
  settles it so. So after a tightening the title stays at the old home until
  the next move or regrade of any section of that document raises it.
  `scenarios-visibility.mjs` asserts decision 5, and the merge leaves it. Which
  rule holds is for the user.
- **The oracle's classes are confirmed by raw SQL in the batch.** The confirm
  route renames every class to plural snake_case, so 49 of the oracle's 50
  names don't survive it, and the 50th, `equipment`, is a name Discovery
  forbids. This stays open for the class-model change that follows this work
  (an instance edge to a class and a class hierarchy); it has not been started.
- **`packages/server` vitest intermittently exits 1 with every test passing:**
  an EPIPE from `test/openshell-fs.test.ts` ("streams a download byte-exact").
  3 of 7 runs here, and 1 of 8 at 2a1a12f, in a test and module these merges
  don't touch.
- Everything under "Not blocking" in the reviews that a fix did not touch,
  including N3 above. Neither review covered a real model or deploying onto
  existing data.

The harness clock, an open item at 2a1a12f, is resolved above.
