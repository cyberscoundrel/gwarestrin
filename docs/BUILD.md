# The build: who owns which file

The design is [ORGANIZATION-MODEL.md](ORGANIZATION-MODEL.md), from the user's rulings R1 to R11
(`~/reviews/design-rulings.md`), which outrank everything here. The shared shapes are the contract in
`graph-rag/src/model/` ([model/README.md](../graph-rag/src/model/README.md)). This branch, `build-base`, holds the
contract and the removals; four streams and an integrator build from its tip.

Every file below has exactly one owner. A file not listed is outside the build: changing it is the integrator's
call. A stream may add new files under the names reserved for it below; any other new file is the integrator's.

## record

Condensing to a document with no class vocabulary, the restrict-only typed check per section, starting homes,
document titles, on and off record, uploads.

| Area | Files |
|---|---|
| graph-rag | `src/ingest.js`, `src/documents.js`, `src/docstore.js`, `src/document-home.js`, `src/record-state.js`, `src/record-tools.js`, `src/grading.js`, `src/decisions.js`, `src/placement.js`, `src/floor.js`, `src/tightening.js`, `src/extent.js`, `src/prune.js`, `src/pruning.js`, `src/model/record.js` |
| graph-rag tests | `test/ingest.test.js`, `test/ingest-tool.test.js`, `test/documents.test.js`, `test/docstore.test.js`, `test/grading.test.js`, `test/placement.test.js`, `test/extent.test.js`, `test/prune.test.js`, `test/model-record.test.js` |
| replay | `e2e/scenarios-condenser.mjs`, `e2e/fake-condenser.mjs`, `e2e/scenarios-rehoming.mjs` |
| server | `src/agents/condenser.ts`, `src/agents/record-gate.ts`, `src/agents/standing-instructions.ts`, `src/agents/instructions/chat.ts`, `test/condenser.test.ts` |
| web | `src/components/RecordToggle.svelte` |
| reserved | `graph-rag/src/check.js` (the typed check), `graph-rag/test/check.test.js`, `graph-rag/e2e/scenarios-record.mjs` |

## classes and discovery

The class tree, instance and dependency edges, home from evidence, corrections, and discovery run read-only by the
orchestrator.

| Area | Files |
|---|---|
| graph-rag | `src/discovery.js`, `src/instances.js`, `src/model/classes.js` |
| graph-rag tests | `test/discovery.test.js`, `test/model-classes.test.js`, `test/fixtures/classes.json` |
| server | `src/agents/connection-digest.ts` |
| reserved | `graph-rag/src/classes.js` (class storage, reads and corrections), `graph-rag/src/routes-classes.js`, `graph-rag/test/classes.test.js`, `graph-rag/e2e/scenarios-classes.mjs`, `packages/web/src/components/ClassTreePanel.svelte` |

## filing

The orchestrator and workers, briefs, splitting by home, the four outcomes, the filing log, worker accounts and the
orchestrator's check, requests, re-filing Kept, Filed or Proposed, and approvals.

| Area | Files |
|---|---|
| graph-rag | `src/worker-pool.js`, `src/worker-tools.js`, `src/pool.js`, `src/master-tools.js`, `src/model/filing.js`, `src/model/brief.js`, `src/model/class-map.js` |
| graph-rag tests | `test/pool.test.js`, `test/authority-queue.test.js`, `test/model-filing.test.js`, `test/model-brief.test.js`, `test/model-class-map.test.js`, `test/fixtures/policy.json` |
| server | `src/agents/graph-pool.ts`, `src/agents/instructions/worker.ts`, `src/agents/instructions/master.ts`, `src/agents/instructions/handler.ts`, `src/agents/instructions/liaison.ts`, `src/agents/instructions/graph-roles.ts`, `src/http/graph-queue.ts`, `test/graph-worker-tools.test.ts` |
| web | `src/components/GraphQueuePanel.svelte`, `src/components/GraphWorkerPanel.svelte` |
| reserved | `graph-rag/src/filing.js` (the log's store and the filing tools' handlers), `graph-rag/src/orchestrator.js`, `graph-rag/test/filing.test.js`, `graph-rag/e2e/scenarios-filing.mjs` |

## sources

Source declarations, read and write adapters through the data API, an isolated synthetic test SQL Server and its
guard.

| Area | Files |
|---|---|
| graph-rag | `src/data-entry.js`, `src/model/sources.js` |
| graph-rag tests | `test/data-entry.test.js`, `test/model-sources.test.js` |
| replay | `e2e/fake-dab-core.mjs`, `e2e/adapter-check.mts` |
| infra | `dab/`, `dab-config.example/` |
| reserved | `graph-rag/src/sources.js` (declarations' store and route), `graph-rag/test/sources.test.js`, `graph-rag/e2e/scenarios-sources.mjs`, `test-sql/` (the synthetic SQL Server: compose file, seed, guard) |

## integrator

The replay harness, the real-model evaluation, and the shared files.

| Area | Files |
|---|---|
| graph-rag | `src/server.js`, `src/routes.js`, `src/context.js`, `src/db.js`, `src/models.js`, `src/health.js`, `src/scope.js`, `src/search.js`, `src/write.js`, `src/rawcount.js`, `src/sharing.js`, `src/grants.js`, `src/delegation.js`, `src/positions.js`, `src/policy.js`, `src/org-policy.js`, `src/requests.js`, `src/needs.js`, `src/model/schema.js`, `src/model/text.js`, `src/model/README.md`, `src/MAP.md`, `Dockerfile`, `package.json` |
| graph-rag tests | `test/write-decision.test.js`, `test/rawcount.test.js`, `test/positions.test.js`, `test/grants.test.js`, `test/delegation.test.js`, `test/health.test.js`, `test/needs.test.js`, `test/policy.test.js`, `test/harness-loader.test.js`, `test/harness-fakes.test.js`, `test/model-schema.test.js`, `test/fixtures/positions.json`, `test/fixtures/policy-oracle.json`, `test/fixtures/oracle-sixty.json`, `test/fixtures/ORACLE.md` |
| replay | `e2e/e2e.sh`, `e2e/run.mjs`, `e2e/scenarios.mjs`, `e2e/fake-models.mjs`, `e2e/shift-clock.mjs`, `e2e/SCENARIOS.md`, `e2e/scenarios-harness.mjs` |
| server and web | `packages/server/src/http/knowledge.ts`, `packages/server/src/agents/manager.ts`, `packages/web/src/components/OrgSettingsPanel.svelte` |
| infra and docs | `docker-compose.yml`, `scripts/`, `docs/BUILD.md`, `docs/INTEGRATION.md` |
| reserved | `graph-rag/eval/` (the real-model evaluation) |

## The shared files, and the rule for touching them

`server.js` (the MCP tool table and boot), `routes.js` (the HTTP route groups), `search.js`, `scope.js`, `write.js`
(the pending-write queue and approvals), `model/schema.js` (the DDL), `policy.js` and `org-policy.js` (the stored
policy, the class map included), `knowledge.ts`, `manager.ts` and `OrgSettingsPanel.svelte` are read by every stream
and owned by the integrator.

- **Put the code in your own module.** A stream exports `register<Stream>Tools(server, ctx)`,
  `register<Stream>Routes(app)` or `ensure<Stream>Schema()` from a file it owns, and asks the integrator for the one
  call that wires it. Nobody else edits a shared file.
- **Ask for a schema change.** A new type, property or index goes in the request as a `TYPES` entry, and the
  integrator adds it to `model/schema.js`. Nothing outside `model/schema.js` declares a type the contract names.
- **Contract changes go through the integrator.** A stream that needs a contract shape changed says why and which
  ruling it serves. The contract's tests change in the same commit.
- **Requests are small and listed.** One message per request to the integrator, naming the file, the call, and the
  test that shows it. The integrator merges streams one at a time, in the order they finish, and runs every check
  after each.

## Checks

Every commit on a stream branch keeps all of these green:

- `npm test` in `graph-rag`
- `graph-rag/e2e/e2e.sh`
- `npx tsc --noEmit -p .` and `npx vitest run` in `packages/server`
- `npx svelte-check --tsconfig ./tsconfig.json`, `npx vite build` and `npx vitest run` in `packages/web`

Other sessions run the harness at the same time. If yours collides, retry, and never remove a container you did not
start.

## Choices that need a ruling

No ruling covers these. Each is the smallest reversible option, marked `NEEDS A RULING` in the code.

| # | Where | The choice made | Owner |
|---|---|---|---|
| 1 | `model/classes.js` | A class name is unique in the organization, whatever the homes. | classes |
| 2 | `model/classes.js` | A class whose `rows_are_nodes` is unset keeps its rows in the source. | classes |
| 3 | `model/classes.js` | The four roots are homed at `everyone`. | classes |
| 4 | `model/classes.js` | A dependency carries when it was stated, and optionally from and until when; the instances' own times are theirs. | classes |
| 5 | `model/class-map.js` | The stored map keeps its global `attributes` and `default` entries, and they decide nothing. A class's own per-column entries count, strictest of what is written. | filing |
| 6 | `model/class-map.js` | A class with no entry of its own takes its nearest ancestors' entries, strictest of them; its own entry wins over its parents'. | filing |
| 7 | `model/class-map.js` | A recorder has authority when they hold the mapped position or one above it. | filing |
| 8 | `model/filing.js` | The filing log is a `FilingEntry` document type in the same ArcadeDB database: no vertex, no edge, and no graph read returns it. | filing |
| 9 | `model/filing.js` | An orchestrator's verdict is `matches`, `differs` or `unverifiable`. | filing |
| 10 | `model/filing.js` | A source conflict is Held, with a question to the recorder (R2), and also raises a `conflict` request (R11). Request kinds are `class`, `conflict` and `other`. | filing |
| 11 | `model/sources.js` | A source write may create and update, never delete. | sources |
| 12 | `data-entry.js` | When the recorder has left or moved, the adapter returns `refused` and writes nothing. The filing stream records it as Held. | sources, filing |
| 13 | `data-entry.js` | A proposal on a class missing from the map is approved by a person at the root. | sources |
| 14 | `tightening.js` | Re-homing moves the sections about a class's own instances, by its class-level entry; subclasses' instances and per-column entries move nothing. | record |

## What `build-base` removed

| Removed | Ruling | What replaces it, and who builds it |
|---|---|---|
| Atomic claims: `model/claims.js`, CLAIMS edges, claim placement and claim floors, `state.js` and the state tools and routes, `search_graph`'s `as_of`, answering questions from state, fact extraction on ingest | R2 | Sections are the record (record) |
| The linker, `resolve.js`, `things.js` and their name rules, mention jobs | R3, R4 | Workers resolve names against the source while filing (filing); `instances.js` keeps the few helpers left (classes) |
| Triage, and the master's claim and triage shapes | R4 | Every record gets a worker (filing) |
| The noun tables, table classification by name, drafts for a person, the confirm and retire routes, `propose_class`, the confirm panel and its proxies, the `CommitmentClass` store | R3, R5 | Class storage on the contract, discovery by the orchestrator, corrections (classes) |
| Audit nodes and source-reference nodes: `audit.js`, `sourceref.js` | R3, R9 | The filing log (filing) |
| The single authority rule: `decide`, `visible`, `claimHome`, per-claim visibility in `scope.js` | R6 | `class-map.js filedOrProposed` for Filed or Proposed (filing); `decideWrite` keeps only the site rules and the derived floor for graph writes |
| The claim-shaped worker tools (`confirm_claim`, `record_conflict`, `resolve_subject`, `mark_need_met`, `enter_data` by claim) | R2 | The filing tools (filing) |
| The 62-note bar (`conversations.mjs`, `scripts/batch-bar.mjs`, `scripts/make-conversation-batch.mjs`, the generated batch) | R9 | The notes stay as test input in `oracle-sixty.json`; the real-model evaluation (integrator) |

The language-model grader still places sections until the record stream's typed check replaces it (R4).
`integration` had no migration code to remove: the earlier contract's migration plan was never merged.
