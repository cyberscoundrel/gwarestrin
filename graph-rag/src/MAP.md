# server.js: the map and the cut

`server.js` was split into modules by area with no behavior change (see
`docs/ORGANIZATION-MODEL.md`, "Serial step two"); the replay harness passes 22 of 22
on the split as on the original. This file is the map: the modules as they are now,
with what each owns and the stream that takes it, and below it the cut: every
top-level declaration of the file as it was before the move (5,320 lines, commit
`2293266`), with its line range and the module it went to. The move was mechanical:
each module is the concatenation of its declarations in their original order, with
an import block computed from what the code uses, and `export` added to what another
module imports. No string a model sees, no SQL, no prompt and no order of awaits
changes.

## The modules

| Module | Lines | Owns | Stream (from the design doc) |
|---|---|---|---|
| `context.js` | 48 | the environment configuration, `log`, `health`, `loops` | shared; the integrator |
| `db.js` | 104 | ArcadeDB access (`adb*`, `esc`, `likeTerm`), the Entity constants (`ENTITY_LABEL`, `FACETS`, the facet, property and record-id patterns), the vector indexes (`ensureIndex`, `knownIndexes`), `sanitizeFacet` | shared; the integrator |
| `models.js` | 49 | `modelPost`, `embedBatch`, `chat` | shared; the integrator |
| `scope.js` | 218 | identity and scope: the token and position maps and their loaders, `scopeOf`, `homeFilter`, `resolveWriteHome`, `resolveIdentity`, `requireCap`, `personOf`, `isPerson`, `writerOf`, the people and position name helpers | Authority |
| `search.js` | 289 | `searchGraph`, `queryGraph`, `schemaGraph`, `aboutThing`, the result shaping helpers | Queries |
| `floor.js` | 261 | derived data and placement: read marks, `recordReads`, `derivedFloor`, `workerLift`, `workerWriteFloor`, `entryAudience`, `gradeBatch`, `placeEntities`, `regradeTick` | Authority |
| `write.js` | 510 | `upsertEntities`, the pending-write queue (`queueWrite`, `approvePending`, `rejectPending`, `executePending`), `setHome`, `executeGraph`, `backfillIdentity`, the executors an approval runs (`mergeThings`, `foldEntries`, `deleteEntry`, `typedUpdate`) | Authority |
| `sharing.js` | 425 | grants: `grantCache`, `grantAccess`, `revokeGrant`, `listGrants`, share proposals and the shares waiting on a pending write, `findShareable` | Authority |
| `requests.js` | 466 | needs: questions as entries, how they meet assertions, the asker's and the owners' sides | Queries |
| `ingest.js` | 274 | documents: `requestIngest`, `ingestDocument`, `extractFacts`, `readDocument`, the document store handle | Condenser |
| `linker.js` | 228 | `linkMentions`, `jobMentions`, `findThing`, `findEntry`, `thingNamed`, the ABOUT edge helpers | Admission and resolution |
| `worker-pool.js` | 518 | the job queue (`enqueue`, `workerTick`), the thread pool (`claimThreads`, `finishThread`, `resumeThread`), questions, the proposals list, `logChange`, `createTask`, the worker's settings and `workerStatus` | Reconciliation and data entry |
| `worker-tools.js` | 579 | a worker thread's tools (`workerUpsert`, `workerLink`, `workerMerge`, …) and their MCP registration | Reconciliation and data entry |
| `triage.js` | 136 | `intakeWithTriage`, `recordTriageOutcome`, `triageStats` | Reconciliation and data entry (it feeds the master's batches; the decision model itself is `decisions.js`) |
| `master-tools.js` | 343 | the master (`batchTick`, signals, `masterStartWorker`, …), handlers, and the MCP registration of the master, handler and liaison tools | Reconciliation and data entry |
| `pruning.js` | 79 | `pruneExpired`, `prunePreview` | housekeeping; the integrator |
| `org-policy.js` | 70 | the organization policy: `policy`, `loadPolicy`, `savePolicy`, `expiryRules`, `canEditPolicy` | Authority |
| `routes.js` | 459 | the express app: `/mcp` and every `/api/*` route | shared: each stream adds its own route group; the integrator merges |
| `server.js` | 491 | the composition root: `createServer` (the MCP tool table) and `boot` | the integrator |

Two things are not a plain move, both mechanical:

- The four role-gated blocks of the tool table (`if (SCOPED && role === "worker") { server.tool(…) … }`,
  and the same for `master`, `handler`, `liaison`) become `registerWorkerTools(server, { identity, scope, need })`
  in `worker-tools.js` and `registerMasterTools`, `registerHandlerTools`, `registerLiaisonTools` in
  `master-tools.js`. The `server.tool` calls inside are unchanged and in the same order; `createServer` calls
  the function where the block was. This is what brings `server.js` under 600 lines and gives the worker
  and master streams their tools.
- `worker` (the graph worker's settings) is reassigned by `PUT /api/worker`; once that route and the
  variable live in different modules an import can't be assigned, so `worker-pool.js` exports
  `setWorker(next)` and the route calls it.

Shared mutable state is owned by exactly one module and read elsewhere through ES module live bindings
(an `export let` reflects reassignment in every importer): `tokenMap`, `entriesByUser`, `positionMap`
in `scope.js`; `grantCache` in `sharing.js`; `policy`, `policyMeta` in `org-policy.js`; `worker` in
`worker-pool.js`; `positionVecs` in `requests.js`; `ingestQueue` in `ingest.js`. The caches that are
mutated in place (`knownIndexes`, `readMarks`, `chunkCache`, `workerUsage`) stay with their owners the
same way. `context.js` holds what every module shares and nothing reassigns: the configuration, `log`,
`health`, `loops`.

Modules import each other in cycles (the areas call into one another at run time), which ES modules
allow: no module reads another's `const` or `let` at load time, only inside functions, and every
function declaration is hoisted. `routes.js` imports `createServer` from `server.js` for the `/mcp`
route, so the HTTP table stays in one file.

## What the integrator should know

**The write-or-propose decision** is one rule, the Authority stream's `decideWrite` in
`write.js`, built on the contract's `authority.decide` over the policy's authority map
(`policy.authorityMap`, edited in Organization settings) and the position tree:

```js
decideWrite(identity, { kind, cls, attribute, claims, lives }, ctx)
  // kind: upsert | rehome | grant | merge | fold | delete_entry | typed_update | command | ingest | backfill
  // cls, attribute: the commitment class and attribute the write bears on (null: residue, no class)
  // claims: instead of one class, the claims the write carries (the strictest decides); lives: the entry's home for a write to an existing entry
  // ctx: { origin, propose, to, placedBy, reason, policy?, positions? }
  -> { action: "direct" | "propose" | "hidden", floor, home, reason, authority, lift }
```

`direct`: write it. `propose`: `queueWrite({ ..., home: d.home })`, the proposal homed at the
authority position when a class rule put it there (whoever holds it reviews it), else where the entry
lives. `hidden`: the writer is on another branch than the authority: queue it the same way, held
at `d.home`, the common ancestor. `floor` is the lowest home the data may get (the derived floor
raised to the claims' authority); `lift` is set when the derived floor would hold a content write
above where the entry lives (the worker tools phrase `liftRefusal` from it). Queued writers, a
worker's raw command, widening, an entry a person placed and `ctx.propose` all come out as
`propose`, so a site keeps no test of its own. The sites inside the Authority stream's modules use
it already: `executeGraph`, `setHome`, `typedUpdate` (`write.js`), `grantAccess` (`sharing.js`),
`askAboutPlacement` (`floor.js`). The sites outside them, and the call that replaces each:

- `server.js`, the `upsert_entities` tool (`if (caps.write === "queued") queueWrite(...)`):
  `const d = decideWrite(identity, { kind: "upsert", claims: entities.flatMap((e) => e.claims ?? []) }, { origin: home });
  if (d.action !== "direct") return queueWrite({ kind: "upsert", payload: JSON.stringify(write), user: identity.user, home: d.home });`
  and let claims through the tool's schema: on each entity
  `claims: z.array(z.object({ kind: z.string(), class: z.string().optional(), attribute: z.string(), value: z.unknown(), subject: z.unknown().optional(), valid_from: z.string().optional(), valid_until: z.string().optional() }).passthrough()).optional()`.
  `upsertEntities` places an entity carrying `claims` by the rule (`placeByClaims`) and never grades it.
- `server.js`, the `embed_backfill` tool:
  `if (decideWrite(identity, { kind: "backfill" }).action !== "direct") queueWrite({ kind: "backfill", ... })`.
- `worker-tools.js`, `workerUpsert` (per home group; replaces `workerWriteFloor` + `args.propose`):
  `const d = decideWrite(identity, { kind: "upsert", lives, claims: list.flatMap((e) => e.claims ?? []) }, { origin: home, propose: args.propose, reason: args.reason });
  if (d.lift && !args.propose) throw new Error(liftRefusal(names, d.lift));
  if (d.action !== "direct") { queueWrite({ kind: "upsert", payload: JSON.stringify({ ...write, floor: d.floor }), user: identity.user, home: d.home, ...proposalFields(identity, args.reason) }); continue; }`
  (`floor` of the write is `d.floor`).
- `worker-tools.js`, `workerUpdateEntry`: the same as `workerUpsert` with `lives: row._home ?? origin` and
  `claims: await claimsOfEntry(String(row.rid))` (`floor.js`: the entry's CLAIMS edges, else the summary
  a claim-bearing write stored on it).
- `worker-tools.js`, `workerMerge` (`if (args.propose)`):
  `if (decideWrite(identity, { kind: "merge", lives: positionMap.root }, { propose: args.propose, reason: args.reason }).action !== "direct")`.
- `worker-tools.js`, `workerFoldEntries` (`if (args.propose || !sameHome)`):
  `if (decideWrite(identity, { kind: "fold", lives: keep._home, claims: await claimsOfEntry(String(drop.rid)) }, { propose: args.propose || !sameHome, reason: why }).action !== "direct")`.
- `worker-tools.js`, `workerDeleteEntry` (`if (args.propose || edges > 0)`):
  `if (decideWrite(identity, { kind: "delete_entry", lives: row._home, claims: await claimsOfEntry(rid) }, { propose: args.propose || edges > 0, reason: args.reason }).action !== "direct")`.
- `ingest.js`, `requestIngest` (`if (identity.caps.write === "queued")`):
  `const d = decideWrite(identity, { kind: "ingest", claims: sections.flatMap((s) => s.claims ?? []) }, { origin: home });
  if (d.action !== "direct") queueWrite({ kind: "ingest", payload, user: identity.user, home: d.home })`,
  and a section's entity passed to `upsertEntities` carries its `claims` so it is placed by them (the
  grader runs only on sections with none).
- `linker.js`, the unsure-match merge proposal: always a proposal (no person is acting);
  `decideWrite({ user: "graph-rag worker", caps: { write: "queued" }, positions: [] }, { kind: "merge", lives: positionMap.root })`
  returns `propose` and keeps the site honest to the one rule.

**Reading claims** (`floor.js`): `recordReads(identity, items)` takes claims (anything with a
`_home`) as well as home ids, so a read of a claim bounds a write as a read of an entry does;
`workerWriteFloor(identity, livesOrClaim)` likewise; `claimWriteFloor(identity, origin, claims)` is
the floor of a claim-bearing write. `scope.js` has the visibility reading as a question:
`coversClass(scope, cls, attribute)` and `seesClaim(scope, claim, origin)`; `sharing.js`
`recipientCovers(recipient, claims)`. Queries that list claims should filter with `seesClaim`.

**Functions two areas both need**, kept where the map puts them and imported by the other:

- `assertNotWaiting`, `PROPOSED_NOTE`, `logChange`, `createTask` (`worker-pool.js`) are used by
  `worker-tools.js`, `write.js` (`executeGraph`, `setHome`), `master-tools.js` and `routes.js`.
- `thingSeenFrom` and `aboutOnce` (`linker.js`) are used by `floor.js` (`regradeTick`), `write.js`
  (`applyRehome`, `foldEntries`, `mergeThings`) and `triage.js`.
- `ASSERTIONS` and `openNeedsClause` (`requests.js`) are read predicates used by `search.js`,
  `write.js`, `sharing.js` and `routes.js`; they could move to `db.js` if the Queries stream
  would rather not own them.
- `MASTER` (`master-tools.js`) is read by `worker-pool.js` and `worker-tools.js`.
- `recordReads` (`floor.js`) is called by every read: `search.js`, `sharing.js`, `ingest.js`,
  `server.js`.

**Shared state read across areas**: `positionMap` (nearly everywhere), `policy` (`floor`,
`sharing`, `requests`, `pruning`, `routes`, `server`), `worker` (`write`, `linker`,
`master-tools`, `routes`, `server`), `grantCache` (`scope`, `requests`), `entriesByUser`
(`sharing`, `requests`), `knownIndexes` (`search`, `write`, `routes`, `server`), `docStore`
(`write`, `pruning`, `server`).

**Import cycles**: `scope` ↔ `sharing` (scopeOf reads the grant cache), `floor` ↔ `write`,
`write` ↔ `worker-pool` ↔ `linker` ↔ `triage`, `worker-pool` ↔ `master-tools`,
`search` ↔ `requests`, and `routes` → `server` → `routes`. All are safe as they are (nothing
reads another module's binding at load time); a stream that adds top-level code using an
imported `const` or `let` would break one.

**The map's judgment calls**: `triage.js` under Reconciliation rather than Admission;
`sharing.js` and `org-policy.js` under Authority; `pruning.js`, `routes.js` and the three
infrastructure modules with the integrator. Change the table if a stream owner disagrees.

## The cut

Line ranges are in `server.js` as it was before the move. The order is the file's order; each module
keeps it.

| Lines | Kind | Declaration | Module |
|---|---|---|---|
| 53–89 | const | `const { … } = process.env` | context.js |
| 91–100 | const | `OPEN_CAPS` | scope.js |
| 101–101 | const | `OPEN_MODE` | scope.js |
| 102–102 | let | `tokenMap` | scope.js |
| 103–103 | let | `entriesByUser` | scope.js |
| 105–120 | function | `loadTokenMap` | scope.js |
| 122–127 | const | `SCOPED` | scope.js |
| 128–128 | let | `positionMap` | scope.js |
| 130–141 | function | `loadPositionMap` | scope.js |
| 143–158 | function | `scopeOf` | scope.js |
| 160–183 | function | `homeFilter` | scope.js |
| 185–186 | const | `viaOf` | scope.js |
| 188–189 | const | `ownsHome` | scope.js |
| 191–210 | function | `resolveWriteHome` | scope.js |
| 212–220 | function | `positionId` | scope.js |
| 222–226 | const | `homeLabel` | scope.js |
| 228–250 | function | `resolveIdentity` | scope.js |
| 252–262 | function | `requireCap` | scope.js |
| 264–264 | const | `EMBED_DIM_N` | db.js |
| 265–265 | const | `ENTITY_LABEL` | db.js |
| 266–266 | const | `FACET_RE` | db.js |
| 267–267 | const | `PROP_RE` | db.js |
| 269–276 | const | `FACETS` | db.js |
| 278–278 | const | `knownIndexes` | db.js |
| 279–279 | const | `log` | context.js |
| 280–281 | const | `health` | context.js |
| 282–282 | const | `loops` | context.js |
| 283–283 | const | `BASIC` | db.js |
| 285–299 | function | `adb` | db.js |
| 301–307 | function | `adbQueryLang` | db.js |
| 309–312 | function | `adbQuery` | db.js |
| 314–320 | function | `adbCommand` | db.js |
| 322–323 | const | `esc` | db.js |
| 324–325 | const | `likeTerm` | db.js |
| 327–347 | function | `ensureIndex` | db.js |
| 349–355 | function | `ensureFullText` | db.js |
| 357–385 | function | `modelPost` | models.js |
| 387–395 | function | `embedBatch` | models.js |
| 397–405 | const | `questionOf` | search.js |
| 407–408 | const | `validityOf` | search.js |
| 410–418 | function | `publicProps` | search.js |
| 420–429 | function | `identityText` | search.js |
| 431–609 | function | `searchGraph` | search.js |
| 611–613 | const | `readMarks` | floor.js |
| 614–614 | const | `windowMs` | floor.js |
| 616–628 | function | `ensureReadMarkSchema` | floor.js |
| 630–631 | const | `markKey` | floor.js |
| 633–650 | function | `recordReads` | floor.js |
| 652–662 | function | `derivedFloor` | floor.js |
| 664–679 | function | `workerLift` | floor.js |
| 681–690 | function | `workerWriteFloor` | floor.js |
| 692–715 | function | `entryAudience` | floor.js |
| 717–719 | const | `heldNote` | floor.js |
| 721–722 | const | `liftRefusal` | floor.js |
| 724–744 | function | `gradeBatch` | floor.js |
| 746–747 | const | `graderUntil` | floor.js |
| 749–790 | function | `placeEntities` | floor.js |
| 792–924 | function | `upsertEntities` | write.js |
| 926–936 | function | `askAboutPlacement` | floor.js |
| 938–990 | function | `regradeTick` | floor.js |
| 992–1021 | function | `backfillIdentity` | write.js |
| 1023–1034 | function | `queryGraph` | search.js |
| 1036–1051 | function | `executeGraph` | write.js |
| 1053–1054 | const | `DELETE_RE` | write.js |
| 1056–1058 | const | `isPerson` | scope.js |
| 1060–1064 | const | `writerOf` | scope.js |
| 1066–1089 | function | `executePending` | write.js |
| 1091–1131 | function | `setHome` | write.js |
| 1133–1147 | function | `applyRehome` | write.js |
| 1149–1151 | let | `grantCache` | sharing.js |
| 1153–1158 | function | `ensureGrantSchema` | sharing.js |
| 1160–1173 | function | `refreshGrants` | sharing.js |
| 1175–1197 | function | `danglingEntityGrants` | sharing.js |
| 1199–1199 | const | `positionName` | scope.js |
| 1201–1202 | const | `peopleNames` | scope.js |
| 1204–1208 | function | `personScope` | scope.js |
| 1210–1230 | function | `recipientOf` | sharing.js |
| 1232–1232 | const | `recipientName` | sharing.js |
| 1233–1233 | const | `recipientKind` | sharing.js |
| 1235–1243 | function | `peopleView` | scope.js |
| 1245–1251 | function | `recipientSees` | sharing.js |
| 1253–1327 | function | `grantAccess` | sharing.js |
| 1329–1340 | function | `storeGrant` | sharing.js |
| 1342–1357 | function | `revokeGrant` | sharing.js |
| 1359–1386 | function | `listGrants` | sharing.js |
| 1388–1389 | const | `personOf` | scope.js |
| 1391–1405 | function | `pendingEntityWrite` | sharing.js |
| 1407–1454 | function | `resolveWaitingShares` | sharing.js |
| 1456–1463 | function | `dropWaitingShares` | sharing.js |
| 1465–1476 | function | `ownProposal` | sharing.js |
| 1478–1492 | function | `proposalView` | sharing.js |
| 1494–1500 | function | `proposalStatus` | sharing.js |
| 1502–1548 | function | `confirmProposal` | sharing.js |
| 1550–1561 | function | `declineProposal` | sharing.js |
| 1563–1581 | function | `findShareable` | sharing.js |
| 1583–1588 | function | `schemaGraph` | search.js |
| 1590–1592 | const | `QUESTION_GRANTOR` | requests.js |
| 1593–1593 | const | `REQUEST_MATCH_MIN` | requests.js |
| 1594–1595 | const | `ASSERTIONS` | requests.js |
| 1596–1597 | const | `openNeedsClause` | requests.js |
| 1599–1609 | function | `ensureNeedSchema` | requests.js |
| 1611–1627 | const | `needOf` | requests.js |
| 1629–1633 | function | `loadNeed` | requests.js |
| 1635–1644 | function | `needEdges` | requests.js |
| 1646–1647 | const | `holdersMap` | requests.js |
| 1649–1655 | function | `personSees` | requests.js |
| 1657–1676 | function | `shareNeed` | requests.js |
| 1678–1679 | const | `ownerOf` | requests.js |
| 1681–1687 | function | `shownTo` | requests.js |
| 1689–1699 | function | `meet` | requests.js |
| 1701–1725 | function | `matchHidden` | requests.js |
| 1727–1728 | let | `positionVecs` | requests.js |
| 1729–1735 | function | `describedPositions` | requests.js |
| 1737–1740 | function | `needVec` | requests.js |
| 1742–1821 | function | `openNeed` | requests.js |
| 1823–1849 | function | `meetAssertion` | requests.js |
| 1851–1883 | function | `requestAccess` | requests.js |
| 1885–1894 | function | `askerRequest` | requests.js |
| 1896–1904 | function | `alsoAsked` | requests.js |
| 1906–1915 | function | `confirmRequest` | requests.js |
| 1917–1925 | function | `closeNeed` | requests.js |
| 1927–1934 | function | `withdrawRequest` | requests.js |
| 1936–1940 | function | `linkedRids` | requests.js |
| 1942–1961 | function | `shownGroups` | requests.js |
| 1963–1966 | const | `groupOut` | requests.js |
| 1968–1975 | function | `incomingRequests` | requests.js |
| 1977–1980 | function | `groupOf` | requests.js |
| 1982–2019 | function | `answerRequest` | requests.js |
| 2021–2032 | function | `dismissRequest` | requests.js |
| 2034–2038 | function | `expireRequests` | requests.js |
| 2040–2042 | const | `docStore` | ingest.js |
| 2043–2043 | let | `ingestQueue` | ingest.js |
| 2044–2044 | const | `chunkCache` | ingest.js |
| 2046–2051 | function | `ensureDocumentSchema` | ingest.js |
| 2053–2060 | function | `storedChunks` | ingest.js |
| 2062–2066 | function | `edgeOnce` | ingest.js |
| 2068–2071 | function | `chat` | models.js |
| 2073–2137 | function | `ingestDocument` | ingest.js |
| 2139–2190 | function | `extractFacts` | ingest.js |
| 2192–2224 | function | `sweepOrphanDocuments` | ingest.js |
| 2226–2234 | function | `startIngest` | ingest.js |
| 2236–2269 | function | `requestIngest` | ingest.js |
| 2271–2302 | function | `readDocument` | ingest.js |
| 2304–2307 | let | `worker` | worker-pool.js |
| 2308–2309 | const | `workerModel` | worker-pool.js |
| 2310–2310 | const | `workerUsage` | worker-pool.js |
| 2311–2311 | let | `workerTicking` | worker-pool.js |
| 2313–2347 | function | `ensureWorkerSchema` | worker-pool.js |
| 2349–2365 | function | `enqueue` | worker-pool.js |
| 2367–2374 | function | `workerCall` | worker-pool.js |
| 2376–2376 | const | `THING_KINDS_READ` | linker.js |
| 2378–2383 | function | `thingSeenFrom` | linker.js |
| 2385–2389 | function | `aboutOnce` | linker.js |
| 2391–2391 | const | `NOT_A_THING` | linker.js |
| 2393–2494 | function | `linkMentions` | linker.js |
| 2496–2527 | function | `jobMentions` | linker.js |
| 2529–2531 | const | `JOB_ID_RE` | worker-pool.js |
| 2532–2532 | const | `today` | worker-pool.js |
| 2534–2538 | function | `threadsToday` | worker-pool.js |
| 2540–2567 | function | `entryForBrief` | worker-pool.js |
| 2569–2587 | function | `levelRoom` | worker-pool.js |
| 2589–2632 | function | `claimThreads` | worker-pool.js |
| 2634–2639 | function | `threadAgent` | worker-pool.js |
| 2641–2643 | const | `MAX_OUTAGE_DEFERRALS` | worker-pool.js |
| 2645–2708 | function | `finishThread` | worker-pool.js |
| 2710–2727 | function | `resumeThread` | worker-pool.js |
| 2729–2743 | function | `raiseQuestion` | worker-pool.js |
| 2745–2752 | function | `listQuestions` | worker-pool.js |
| 2754–2779 | function | `answerQuestions` | worker-pool.js |
| 2781–2805 | function | `proposalLands` | worker-pool.js |
| 2807–2818 | function | `listProposals` | worker-pool.js |
| 2820–2831 | function | `assertNotWaiting` | worker-pool.js |
| 2833–2834 | const | `PROPOSED_NOTE` | worker-pool.js |
| 2836–2844 | function | `logChange` | worker-pool.js |
| 2846–2905 | function | `workerUpsert` | worker-tools.js |
| 2907–2931 | function | `refuseHiddenNames` | worker-tools.js |
| 2933–2939 | function | `threadAudience` | worker-tools.js |
| 2941–2965 | function | `workerLink` | worker-tools.js |
| 2967–2988 | function | `workerUnlink` | worker-tools.js |
| 2990–2998 | function | `dropIfStray` | worker-tools.js |
| 3000–3011 | function | `workerDeleteThing` | worker-tools.js |
| 3013–3017 | function | `bareThing` | linker.js |
| 3019–3035 | function | `thingNamed` | linker.js |
| 3037–3062 | function | `workerRenameThing` | worker-tools.js |
| 3064–3078 | function | `findThing` | linker.js |
| 3080–3120 | function | `workerRelate` | worker-tools.js |
| 3122–3144 | function | `createTask` | worker-pool.js |
| 3146–3166 | function | `workerFollowup` | worker-tools.js |
| 3168–3190 | function | `workerMerge` | worker-tools.js |
| 3192–3192 | const | `ENTRY_KINDS` | linker.js |
| 3194–3212 | function | `findEntry` | linker.js |
| 3214–3235 | function | `workerFoldEntries` | worker-tools.js |
| 3237–3256 | function | `foldEntries` | write.js |
| 3258–3281 | function | `workerDeleteEntry` | worker-tools.js |
| 3283–3292 | function | `deleteEntry` | write.js |
| 3294–3314 | function | `typedUpdate` | write.js |
| 3316–3327 | function | `typedChange` | write.js |
| 3329–3349 | function | `applyTypedUpdate` | write.js |
| 3351–3372 | function | `workerUnrelate` | worker-tools.js |
| 3374–3401 | function | `workerUpdateEntry` | worker-tools.js |
| 3403–3405 | const | `decisionConfig` | triage.js |
| 3407–3412 | function | `ensureTriageSchema` | triage.js |
| 3414–3497 | function | `intakeWithTriage` | triage.js |
| 3499–3505 | function | `recordTriageOutcome` | triage.js |
| 3507–3527 | function | `triageStats` | triage.js |
| 3529–3535 | const | `MASTER` | master-tools.js |
| 3537–3543 | function | `ensureMasterSchema` | master-tools.js |
| 3545–3554 | function | `emitSignal` | master-tools.js |
| 3556–3564 | function | `openItems` | master-tools.js |
| 3566–3566 | const | `openHandlers` | master-tools.js |
| 3568–3574 | function | `masterStatus` | master-tools.js |
| 3576–3604 | function | `batchTick` | master-tools.js |
| 3606–3620 | function | `masterStartWorker` | master-tools.js |
| 3622–3637 | function | `workerSituation` | master-tools.js |
| 3639–3645 | function | `answerWorker` | master-tools.js |
| 3647–3657 | function | `needsOperator` | master-tools.js |
| 3659–3666 | function | `closeWorker` | master-tools.js |
| 3668–3682 | function | `startHandler` | master-tools.js |
| 3684–3721 | function | `handlerDecide` | master-tools.js |
| 3723–3729 | function | `decideProposal` | master-tools.js |
| 3731–3745 | function | `mergeThings` | write.js |
| 3747–3748 | const | `JOBS` | worker-pool.js |
| 3750–3755 | function | `expireLeases` | worker-pool.js |
| 3757–3766 | function | `wakeIdleWaiting` | worker-pool.js |
| 3768–3804 | function | `workerTick` | worker-pool.js |
| 3806–3845 | function | `aboutThing` | search.js |
| 3847–3849 | const | `pruneSink` | pruning.js |
| 3850–3850 | let | `pruneRunning` | pruning.js |
| 3852–3857 | function | `ensurePruneSchema` | pruning.js |
| 3859–3909 | function | `pruneExpired` | pruning.js |
| 3911–3915 | function | `prunePreview` | pruning.js |
| 3917–3924 | function | `ensurePendingSchema` | write.js |
| 3926–3926 | const | `RID_RE` | db.js |
| 3927–3927 | const | `PENDING_ID_RE` | db.js |
| 3929–3931 | const | `proposalFields` | write.js |
| 3933–3959 | function | `queueWrite` | write.js |
| 3961–3965 | function | `listPending` | write.js |
| 3967–3977 | function | `mayReview` | write.js |
| 3979–4016 | function | `approvePending` | write.js |
| 4017–4034 | function | `rejectPending` | write.js |
| 4036–4040 | function | `sanitizeFacet` | db.js |
| 4042–4045 | const | `facetDoc` | server.js |
| 4047–4722 | function | `createServer` | server.js |
| 4724–4725 | const | `app` | routes.js |
| 4726–4726 | statement | `app.use()` | routes.js |
| 4728–4747 | statement | `app.post("/mcp")` | routes.js |
| 4749–4749 | statement | `app.get("/mcp")` | routes.js |
| 4750–4750 | statement | `app.get("/health")` | routes.js |
| 4752–4757 | function | `queueIdentity` | routes.js |
| 4758–4765 | statement | `app.get("/api/queue")` | routes.js |
| 4766–4773 | statement | `app.post("/api/queue/:id/approve")` | routes.js |
| 4774–4781 | statement | `app.post("/api/queue/:id/reject")` | routes.js |
| 4783–4801 | statement | `app.get("/api/positions")` | routes.js |
| 4803–4805 | const | `policyDefaults` | org-policy.js |
| 4806–4806 | let | `policy` | org-policy.js |
| 4807–4807 | let | `policyMeta` | org-policy.js |
| 4809–4815 | const | `expiryRules` | org-policy.js |
| 4817–4823 | function | `ensurePolicySchema` | org-policy.js |
| 4825–4833 | function | `loadPolicy` | org-policy.js |
| 4835–4861 | function | `savePolicy` | org-policy.js |
| 4863–4863 | const | `canEditPolicy` | org-policy.js |
| 4865–4890 | statement | `app.get("/api/policy")` | routes.js |
| 4891–4916 | function | `workerStatus` | worker-pool.js |
| 4917–4922 | statement | `app.get("/api/worker")` | routes.js |
| 4923–4949 | statement | `app.put("/api/worker")` | routes.js |
| 4950–4959 | statement | `app.get("/api/worker/models")` | routes.js |
| 4960–4966 | const | `rootOnly` | routes.js |
| 4967–4970 | statement | `app.post("/api/worker/threads/claim")` | routes.js |
| 4971–4974 | statement | `app.post("/api/worker/threads/:id/agent")` | routes.js |
| 4975–4985 | statement | `app.post("/api/worker/threads/:id/release")` | routes.js |
| 4986–4989 | statement | `app.post("/api/worker/threads/:id/finish")` | routes.js |
| 4990–4999 | statement | `app.get("/api/worker/signals")` | routes.js |
| 5000–5007 | statement | `app.post("/api/worker/signals/ack")` | routes.js |
| 5008–5022 | statement | `app.post("/api/worker/handlers/claim")` | routes.js |
| 5023–5031 | statement | `app.post("/api/worker/handlers/:id/waiting")` | routes.js |
| 5032–5038 | statement | `app.get("/api/worker/handlers")` | routes.js |
| 5040–5067 | statement | `app.get("/api/worker/threads")` | routes.js |
| 5068–5081 | statement | `app.post("/api/worker/survey")` | routes.js |
| 5082–5086 | statement | `app.get("/api/worker/questions")` | routes.js |
| 5087–5094 | statement | `app.post("/api/worker/questions/answer")` | routes.js |
| 5095–5098 | statement | `app.get("/api/worker/proposals")` | routes.js |
| 5099–5103 | statement | `app.post("/api/worker/proposals/:id")` | routes.js |
| 5105–5116 | statement | `app.post("/api/worker/backfill")` | routes.js |
| 5118–5126 | statement | `app.get("/api/pruned")` | routes.js |
| 5127–5133 | statement | `app.post("/api/pruned/run")` | routes.js |
| 5134–5142 | statement | `app.put("/api/policy")` | routes.js |
| 5144–5156 | function | `httpScope` | routes.js |
| 5157–5157 | const | `httpError` | routes.js |
| 5159–5162 | statement | `app.get("/api/grants")` | routes.js |
| 5163–5178 | statement | `app.post("/api/grants")` | routes.js |
| 5179–5182 | statement | `app.post("/api/grants/:id/revoke")` | routes.js |
| 5183–5187 | statement | `app.get("/api/grants/proposals/:id")` | routes.js |
| 5188–5198 | statement | `app.post("/api/grants/proposals/:id/confirm")` | routes.js |
| 5199–5202 | statement | `app.post("/api/grants/proposals/:id/decline")` | routes.js |
| 5204–5208 | statement | `app.get("/api/requests")` | routes.js |
| 5209–5212 | statement | `app.get("/api/requests/:id")` | routes.js |
| 5213–5216 | statement | `app.post("/api/requests/:id/confirm")` | routes.js |
| 5217–5220 | statement | `app.post("/api/requests/:id/withdraw")` | routes.js |
| 5221–5231 | statement | `app.post("/api/requests/:id/answer")` | routes.js |
| 5232–5235 | statement | `app.post("/api/requests/:id/dismiss")` | routes.js |
| 5237–5248 | statement | `app.get("/api/entities")` | routes.js |
| 5250–5315 | function | `boot` | server.js |
| 5317–5320 | statement | `boot()` | server.js |
