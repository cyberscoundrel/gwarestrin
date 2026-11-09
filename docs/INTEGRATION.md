# Integrating the seven streams

Status: 2026-11-09. The `integration` branch merges the seven stream branches
of [ORGANIZATION-MODEL.md](ORGANIZATION-MODEL.md) one at a time in dependency
order, each gated by `graph-rag`'s unit tests and the replay harness
(`graph-rag/e2e/e2e.sh`), with the wiring each stream left for the integrator
in separate commits. Nothing here is merged into `main` or deployed: moving
`main` is the user's decision after this report.

## Merge order and the wiring commits

| # | Branch (tip merged) | Merge commit | Wiring commits (integration's own) |
|---|---|---|---|
| 1 | `claude/stream-harness-2d67f9` (4b7203d, then 78d9875 at the end) | 5d20127, 81425d9 | — |
| 2 | `claude/stream-condenser-8c5036` (c0a49c4, then d04cc40, 563e5f2, 899369b) | caa932a, 4df0a90, 3540c66, b7672bb | 0e69f79 `server.js`: `registerRecordTools` for writing identities with no role; `model/schema.statements()` at boot. 838497f, 643f6cf `e2e/scenarios-harness.mjs`: the end-to-end batch posts `{ document }` to `record_document` and confirms the classes its claims name first |
| 3 | `claude/stream-admission-ba992d` (b32860d, then f8bb57a) | 989fb6d, 645c867 | — (its exports kept every signature; `sourceref.js`'s DDL is in the boot statements) |
| 4 | `claude/stream-authority-a67b98` (158782c) | 12e0676 | 9c314e8 `server.js`: `upsert_entities` takes `claims` per entity and decides through `decideWrite`; `embed_backfill` the same; `ingest.js`: a manual's `requestIngest` decides through `decideWrite` (the condensed-document path already did) |
| 5 | `claude/stream-discovery-5147ad` (341c683, then ea6b2bf) | 8a74691, 0c556ee | 19516a1 `routes.js`: `registerDiscoveryRoutes(app)`; `server.js`: `ensureDiscoverySchema()` at boot. The merge resolved `OrgSettingsPanel.svelte` by keeping both new sections (Commitment classes before Authority) |
| 6 | `claude/stream-queries-229b0e` (796aab2, then 7ff9351, 8cd8ec4, 5820e54) | 14f3ff8, 69b72aa, 7ef8270, e3a7f7b | 09e4070 `server.js`: `registerQueryTools` after `about_thing`, `as_of` on `search_graph`; `routes.js`: `registerQueryRoutes(app)` |
| 7 | `claude/stream-reconcile-9b8634` (18e1f50, then 298a9cb) | fe073d0, 45cd273 | — (`registerWorkerTools` kept its call; `data_entry` runs through `executePending` as the Authority branch wired it) |

Every "then" tip is a fix the owning stream committed in its own files at the
integrator's request during the merge (listed per stream below); no stream's
file was patched from this branch. The integration's own commits touch
`server.js`, `routes.js`, `ingest.js` (two decision sites) and
`e2e/scenarios-harness.mjs` only, plus this file.

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
`run.mjs`'s `entry()` for the Authority scenarios' helpers.

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
(the one in `ingest.js` is the fallback when `decideWrite` is absent). Its
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
and a thing type the linker admits (Admission removed `other`; 5820e54).

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
`dab-config.example/dab-config-write.json` are in the tree, not deployed; the
DAB tool argument shapes in `DAB_CALLS` are assumptions to check against a live
instance's `tools/list`.

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
   identity (carol) for a negative check and the batch scenario sets the window
   to zero for its run; the Authority stream did not change the rule. Whether a
   writer's own notes should raise their floor is for the user to decide.
2. **The oracle's need ux-t07.** One need in the sixty-note oracle has an
   authority that follows what it asks about rather than its class. The
   contract and the streams treat authority as a property of the class (and
   attribute); this one case does not fit and was left as the oracle records
   it, for the user.
