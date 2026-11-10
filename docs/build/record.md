# Build plan: the record stream

Phase 0, 2026-11-09. Read from `~/reviews/design-rulings.md` (R1 to R11, which outrank
everything here), `~/reviews/user-messages.md`, `docs/ORGANIZATION-MODEL.md` at
`build-base` 5c6626a, and the code listed below at that same commit. No code has been
written. `docs/BUILD.md` from the contract step is not out yet. When it lands, its file
map overrides the file names here.

**Scope.** How a conversation becomes a record: on and off record, condensing, the
record's sections and title, where each section starts, the one typed check per section,
uploads, and handing the record to a worker. Filing itself (outcomes, the filing log,
source writes), classes and the orchestrator belong to other streams. This stream stops
at "the record is stored, checked and queued for a worker, split by home".

**The pipeline after Phase 1** (R4, R11.6):

1. The person switches the thread on record and picks the position (default off, R11.12).
2. The chat agent condenses on-record sections into a document of sections: text only,
   with no claims and no class names (R2, R5).
3. The record tool stores it. Each section starts at the recorder's position (R11.5),
   floored by what the agent read, except the person's own notes (R11.13).
4. One typed check runs per section. It can only restrict, its categories are closed, an
   uncertain answer holds the section one level higher, and no answer means admin-only
   (R4, R11.11).
5. The title settles at the strictest home among its sections (R11.13).
6. The sections are grouped by home, and each group is handed to its own worker
   (R4, R11.6).

A file uploaded on record follows the same path from step 3 (R11.12).

## What carries

| Code | What stays | Ruling |
|---|---|---|
| `record-state.js` | The per-agent thread gate: refused at the call, unknown means off, the person's instance alone sets it, persisted in `ThreadRecord`, off takes effect before it is stored | R11.12 |
| `record-gate.ts`, `manager.ts` (record parts) | Pushing the thread state to graph-rag, retrying, refusing a turn while an off state is unconfirmed | R11.12 |
| `condenser.ts` `switchRecord`, `offRecord`, `threadIdOf`, `recordContext` (state part) | The switch and its state (who, position, reason, since, until), and the block the agent reads at each turn | R11.12 |
| `documents.js` `renderRecord`, `sectionChunks`, `chunk`, `sectionName`, `preview`, `stableUuid`, `canonical`, `recordId` | Sections given by the condenser are stored as one text with spans. Re-sending the same document changes nothing | R2 |
| `ingest.js` document and section entries, `PART_OF` and `NEXT`, `recordTitle`, `readDocument`, `sweepOrphanDocuments`, `startIngest` queue | The document and its sections are the record (R2). A reused title goes beside the earlier record | R2 |
| `ingest.js` server stamps: `recorded_by`, `position`, `recorded_at` come from the token and never from the document | The recorder is the person and never the agent | R11.7 |
| `document-home.js` `settleDocument`, `untitled`, `headingWithout` | A section below the title's home shows a title that says nothing | R11.13 |
| `floor.js` `recordReads`, `derivedFloor`, read marks | An agent cannot write lower than what it read | R11.13 |
| `search.js:200,227`, `ingest.js:568` | Reads of the person's own documents and sections are not marked, so they do not raise the floor | R11.13 |
| `scope.js:103` | A person always reads what they wrote, even when the check raised it above them | R11.5, R11.13 |
| `grading.js` `DEFAULT_TOPICS`, `matchTopic`, `candidates` | The nine categories, the closed match against them, and the positions at or above the origin | R11.11 |
| `policy.js` `restrictedTopics`, `gradingConfidence`, `gradingEnabled`, `topicList` | The categories are admin-editable. The threshold and the switch carry for the check | R11.11 |
| `decisions.js` `askDecisionModel` | The typed decision-model client (state and questions in, probabilities out). It moves to the check | R4 |
| `floor.js` `askAboutPlacement` (review only) | An uncertain section is flagged to a person | R11.11 |

## What changes

| Code | Change | Ruling |
|---|---|---|
| `grading.js` | The language-model prompt and parser (`gradingPrompt`, `parseVerdicts`) go. `decide` keeps restrict-only and drops `release`. No answer gives the root (admin-only), not one level up | R4, R11.11 |
| `floor.js` `gradeBatch`, `placeEntities`, `regradeTick` | Grading calls the typed check per section, never `/chat/completions`. A section with no answer waits at the root, marked unchecked, and the recheck loop places it once the decision model answers. The grader's end date (`until`) goes with the language model | R4, R11.11 |
| `placement.js` `place`, `applyFloor` | Keep the floor and restrict-only. A new section with no answer goes to the root | R11.11 |
| `ingest.js` `recordDocument` | No classes, claims or authority decision. Home = the position the person chose at the switch, which must be one of theirs. The tool's `home` argument goes. Floor = `derivedFloor`. The record is handed to the worker queue by home once it is ready | R2, R5, R11.5, R11.6 |
| `ingest.js` `ingestDocument` | The title's own grading (`docPlaced`) goes. The title takes the strictest home among its sections. Sections go through the check only | R11.13, R4 |
| `ingest.js` `requestIngest` | For a chat agent, `ingest_document` becomes the record path: the text is stored as is, chunked, checked, and given a worker. `extract` goes | R2, R3, R11.12 |
| `documents.js` `prepareRecord` | Validates sections only: heading, text, title, description, reason. A section carrying `claims` or a class name is refused with the field named | R2, R5 |
| `record-tools.js` | The tool description drops claims and classes. The schema stays loose and the contract judges | R2, R5 |
| `condenser.ts` | `classesBlock`, `PROPOSE_CLASS`, `fetchConfirmedClasses` and `ConfirmedClass` go. The block states the record and what to condense. `condensedFromEvent` drops `claims` | R5 |
| `instructions/chat.ts` `RECORD_INSTRUCTIONS` | Rewritten without claims, primitives or classes: sections of plain text, in the person's words. "Documents" now says a file uploaded on record is a record. The `valid_until`-on-a-claim text goes | R2, R5, R11.12 |
| `manager.ts` | Stops reading confirmed classes for the record block | R5 |
| `record-state.js` `OFF_RECORD_TOOLS` | Claim-state tools (`current_state`, `state_as_of`, `conflicts`, `state_history`) leave the list when the contract step removes them | R2 |

## What is new

| What | Where (until BUILD.md says) | Ruling |
|---|---|---|
| **The typed check.** One decision-model call per section. Its questions are `category` (a choice among the categories plus "none") and `visible_from` (a choice among the recorder's position and the positions above it). Code decides from the probabilities. A home is restricted only when a category other than "none" clears the threshold. Uncertain means neither "none" nor a category clears it: the section is held one level higher and flagged. No answer or an error means the root, marked unchecked. A section at the root has nothing above it, so no call is made | `graph-rag/src/check.js`, called from `floor.js` | R4, R11.11 |
| **Source writes closed to chat agents.** A person's chat agent gets only each connection's read tools (the `readTools` list workers already use), on or off record. Workers write to sources | `packages/server/src/agents/scaffold.ts`, a small hunk | R11.12, R2, R7 |
| **Uploads on record.** A file uploaded to the agent's workspace while its current thread is on record becomes a record under the person: text stored as is, chunked into sections, checked, given a worker. Off record, an upload stays a file in the workspace and nothing reaches the graph | `packages/server/src/http/files.ts`, a small hunk. It calls graph-rag as the person's instance. A new graph-rag route sits beside `/api/thread-record` | R11.12 |
| **Handing a record to workers by home.** Once checked and settled, the sections are grouped by effective home, and one filing job per group is queued with the doc id and its section indexes. Each worker sees only its own group | `ingest.js`, which calls the filing stream's enqueue | R4, R11.6, R7 |
| **No entity writes by chat agents.** `upsert_entities` and `embed_backfill` are not registered for a chat agent. Only the record tool writes. Nothing mints except the orchestrator and workers | `graph-rag/src/server.js`, a small hunk, unless the contract step does it | R7, R2 |

## What is removed in this area

- Claims and everything that writes or reads them in the record path: `recordClaims`,
  `writeClaimedSection`, `subjectThing`, `confirmedClasses`, the authority path
  (`authorityPolicy`, `writeRules.decideWrite` over claims, `placementRules.placeByClaims`),
  and `placement.js` `claimKeys`, `hasClaims`, `claimsSettle`, `placeByClaims`. Also
  `floor.js` `claimWriteFloor`, `claimsOfEntry`, `claimsFollowEntry` (R2, R6).
- Extracted facts: `extractFacts`, `extractionPrompt`, `parseExtraction`, `extract` (R2, R3).
- The language-model grader and its fallback (R4), and release suggestions, since the check
  only restricts (R4).
- The linker call `recordSubject` from ingest (R4).
- The condenser's class vocabulary and `propose_class` in the chat instructions (R5).

The contract step may delete some of these first. This stream deletes whatever is left in
its files.

## Tests (each fails before its change and passes after)

The fakes return fixed probability distributions, chosen per fixture by a section id the
test sets. Tests assert what code does with them: restrict-only, the threshold, one level
up, root on no answer. A fake never decides a home, and no test checks that a model
classified well. That is for real models, under proposal B.

graph-rag unit tests:
1. A section with a confident "none" stays at the recorder's position.
2. A confident category with `visible_from` above raises the section there. `visible_from`
   below the origin is ignored.
3. A category under the threshold holds the section one level higher and queues a review.
4. A decision-model error, a timeout or no key gives the root, marked unchecked. When the
   model answers again, the recheck places it, never below the recorder's position or the
   floor.
5. A section at the root makes no call.
6. Categories edited by an admin are what the call sends. A category outside the list never
   restricts.
7. `prepareRecord` refuses `claims` and a class field on a section, with the field named.
8. A record's sections start at the switch position, not at a `home` argument.
9. The agent read a higher home in the window: the section is floored there. The agent read
   only the person's own sections: no floor.
10. The title and description take the strictest home among the sections, with no title
    grading. A section below shows the untitled name.
11. A record with sections at two homes queues two filing jobs, each holding only its own
    sections.
12. `ingest_document` from a chat agent goes the record path. `extract` is refused.
13. `upsert_entities` is not on a chat agent's tool list.

graph-rag e2e (`scenarios-condenser.mjs`, rewritten, and a new upload scenario):

14. An off-record thread is refused at every write tool and route, including the upload
    route. It carries.
15. An on-record document with three sections at three sensitivities becomes one record:
    three homes, the title at the strictest, two or three filing jobs.
16. A decision-model outage during a record leaves its sections at the root. They come down
    when the model is back.
17. A file uploaded on record is a record with a filing job. Off record, nothing.

server vitest:

18. `recordContext` lists no classes and says nothing of claims.
19. The chat instructions name no primitive, class or claim.
20. A chat agent's `.mcp.json` lists only read tools for a connection that has write tools.
    A graph worker's is unchanged.
21. An upload while on record calls graph-rag once with the person's instance token. While
    off, it never calls.
22. `condensedFromEvent` reads `on_record` without claims.

web: whatever the contract changes in `ThreadRecordState`. No web change is planned
otherwise.

## Shared files expected (smallest hunks, named again in the Phase 1 report)

- `graph-rag/src/server.js`: the record tool's registration, no `upsert_entities` or
  `embed_backfill` for chat agents, and the upload route.
- `packages/server/src/agents/scaffold.ts`: read-only connection tools for chat agents.
- `packages/server/src/http/files.ts`: the on-record upload hook.
- `graph-rag/src/context.js`: the check's model settings, if they differ from `DECISION_*`.
- `graph-rag/e2e/fake-models.mjs`: the check's endpoint, replacing the fake grader.

## Needing a ruling

Each is built as the smallest reversible option, marked `NEEDS RULING` in the code, and
listed again in the Phase 1 report.

1. **How high the check raises.** R4 and R11.11 give closed categories and "uncertain holds
   one level higher", but not how high a confident category raises. Built: the decision
   model also picks `visible_from` from the positions at or above the recorder. This is
   today's grader rule, typed. The alternative is a map from category to position, editable
   by an admin.
2. **What "uncertain" is in numbers.** Built: the existing `gradingConfidence` (0.6),
   applied to the top answer of the category question.
3. **"Admin-only" is the root position.** With the check switched off or no decision key
   set, every section has no answer and stays at the root. That is the ruling read
   literally, so development and e2e need the fake decision model.
4. **Which uploads count, and how they are stored.** Built: files uploaded through the
   Files panel to an agent whose current thread is on record, text-like files only, stored
   as is and chunked, not condensed. A chat image attachment and binary files are not
   recorded, and the person is told. Undecided: PDFs and office files, and whether an
   upload should be condensed.
5. **A queued writer's record.** Today an identity whose writes queue has its record wait
   for approval before it is ingested. Built: kept as is. Under R11.7 a recorder's
   authority shows in the filing outcome (Proposed), so this queue may be redundant.
6. **Reads while off record.** R11.12 says nothing from an off-record thread reaches the
   graph or any source. Built: read tools stay open off record (search, read a document,
   read a source), with "reaches" read as "is stored in or written to". A search query
   still carries conversation text to the graph service and to sources.
7. **A chat agent writing to a source while on record.** Built: never, since workers file
   (R2) and the tool list is fixed when the agent connects, so a per-thread gate would need
   a proxy. Reversible by configuration.
8. **Off-record turns inside an on-record condense.** The tools enforce the thread's state
   when the record tool is called. They cannot see which turns the agent condensed, so
   leaving out what was said off record is still an instruction. Stronger enforcement
   would mean the server handing the condenser only the on-record part of the transcript.
   Not built.
9. **The record tool's `home` argument.** Built: removed. The position chosen at the switch
   is where a section starts (R11.5). The person can still move a section with `set_home`
   as today.
10. **End dates.** The grader's judged end date goes with the language model (R4). A
    writer-given `valid_until` on the record stays. Not built: a typed question for end
    dates.

## Depends on

- `docs/BUILD.md`: the file map, the shape of a section and a document, and the filing
  stream's enqueue (the job's shape for one home group).
- The contract step's removals: claims, the linker, triage, the authority map.
- The filing stream: its enqueue, and briefs that read only one home group (R7, R11.6).

---

# Phase 1: what was built

Built on `build-base` at ba583bc, following `docs/BUILD.md`. Each item names its ruling and the tests that show
it.

## The pipeline as it runs

1. **On and off record (R11.12).** Off record is the default. `record-state.js` refuses every tool from a chat
   agent that is not a read, at the call. The switch now also carries the position the person chose
   (`PUT /api/thread-record {position}`), held while the thread is on record.
2. **Where a section starts (R11.5).** `ingest.js recordHome`: the position the person chose at the switch,
   when it is one they hold, else their own position. The record tool's `home` argument is gone.
3. **What the agent read (R11.13).** The derived floor (`floor.js derivedFloor`) holds every section no lower
   than what the writing agent read. The person's own notes are not marked as reads (`readDocument`,
   `search.js`), so they don't raise it.
4. **The check (R4, R11.11).** `check.js`, new. It makes one typed decision-model call per section, asking two
   closed questions: `category` (the policy's categories, default the nine in code, plus `none`) and
   `visible_from` (the recorder's position and those above it). Code decides from the probabilities:
   - a sure `none` stays;
   - a sure category with a sure level goes to that level;
   - anything unsure is held one level higher and a rehome proposal back is queued for a person;
   - no answer (unconfigured, switched off, an error, an unusable answer) is the root, admin-only, marked
     `_ungraded`. `regradeTick` rechecks it once the decision model answers.

   The language-model grader, its prompt, its parser and its release suggestions are gone (`grading.js` keeps
   only the categories).
5. **The title (R11.13).** The title is not checked on its own. It takes the strictest home among its sections
   (`settleDocument`), and comes down with them after a recheck.
6. **A file on record is a record (R11.12).** The new tool `record_file {file, text, title?, reason?}` stores
   the text as it is, chunks it into sections, and checks each one. The same file sent again is the same record.
   `ingest_document` with plain text takes the same path, so everything a person or their agent ingests is a
   record. Off record a chat agent is refused at the call; a person's own token records directly. The server
   half is `record-gate.ts recordUpload`, which sends an upload through `record_file` with the agent's own
   token, text files only.
7. **To a worker.** Each section is queued the way every write is (`write.js`). Splitting by home is the
   filing stream's (R11.6).

## Tests

| What | Where |
|---|---|
| The check's questions, verdicts, thresholds, no answer, unsure, one call per section | `graph-rag/test/check.test.js` (16) |
| Placement: restrict-only, admin-only on no answer, the floor, updates never widen | `graph-rag/test/placement.test.js` |
| No language-model grader left; the nine categories | `graph-rag/test/grading.test.js` |
| The record tools: no `home`, no claim or class words, `record_file`, both gated off record, the thread's position, where a record starts | `graph-rag/test/ingest-tool.test.js` |
| The position pushed to graph-rag; an upload on record goes through `record_file`, off record nothing, text only; the instructions | `packages/server/test/condenser.test.ts` |
| Replay: where a section starts; the check's three outcomes, the flag and the title; no answer then recheck; a file on record; an agent's reads versus its person's own notes | `graph-rag/e2e/scenarios-record.mjs` (5) |
| Replay: the condenser scenarios moved to the check, `record_file` in the off-record list, plain text as a record | `graph-rag/e2e/scenarios-condenser.mjs` |

## Shared files touched (commit 4ccd02c, for the integrator to take or redo)

- `graph-rag/e2e/fake-models.mjs`: a note's `[admins]` marker answers the check's two questions (a sure
  category, only the top), as it answered the old grader. Without it, six built-in scenarios fail.
- `graph-rag/e2e/run.mjs`: the outage scenario fails `decisions` instead of `grader`, and expects admin-only
  (R11.11) instead of one level up.

## Requests to the integrator (not built here: the files are the integrator's)

1. `packages/server/src/http/files.ts`: after an upload to an agent whose current thread is on record, call
   `recordUpload(new McpHttpClient(graphUrl, agentGraphToken), { file, bytes, onRecord: true })` per file and
   return what each says. Test: `condenser.test.ts`, "a file uploaded on record is a record". Until then a chat
   agent records a file through `record_file` itself, as its instructions say.
2. `packages/server/src/agents/manager.ts pushRecordGate`: send `gatePushOf(id, state)` (condenser.ts) instead of
   `{ agent, thread, on }`, so graph-rag hears the position chosen at the switch. Today the switch takes the
   profile's first position, and graph-rag falls back to the same default, so behaviour is unchanged until a
   person can choose.
3. `graph-rag/src/requests.js`: drop the `gradeBatch` call. It now always gives no answer, so a question lasts
   as long as it is open. Also `server.js` (its boot log line) and `routes.js` (`graderModel`): report the check
   (`DECISION_*`) instead of `GRADER_MODEL`.
4. `packages/server/src/agents/scaffold.ts`: give a chat agent only each connection's read tools (the
   `readTools` list graph workers get), so nothing reaches a source from a chat agent (R11.12, R2; choice 7).
5. `graph-rag/src/server.js`: don't register `upsert_entities` and `embed_backfill` for a chat agent. Only the
   record tools write, and nothing mints except the orchestrator and workers (R7).
6. Filing: a section with `_ungraded` set is still waiting for its check, admin-only. Filing it before then
   files it for the root's audience.

## Choices that need a ruling (marked `NEEDS A RULING` in the code)

| # | Where | The choice made |
|---|---|---|
| 1 | `check.js checkVerdict` | How high a sure category raises: the model's `visible_from` choice, from the recorder's position up. |
| 2 | `check.js checkVerdict` | "Unsure" means a probability under `gradingConfidence` (0.6). It holds at the stricter of one level up and an above-origin level the model leaned to. |
| 3 | `check.js adminOnly`, `floor.js checkReady` | "Admin-only" is the root. The check switched off, or no decision key, counts as no answer. |
| 4 | `ingest.js recordFile`, `record-gate.ts` | Only text files go on record, stored as they are and not condensed. PDFs and office files are refused. |
| 5 | `ingest.js putOnRecord` | A queued writer's record still waits for approval before it is checked and filed. |
| 6 | `record-state.js` | Reads stay open off record: "reaches" is read as "is stored in or written to". |
| 7 | request 4 above | A chat agent never writes to a source, even on record. Not built here (scaffold.ts). |
| 8 | (not built) | Off-record turns inside an on-record condense: the tools gate the thread's state at the call, not which turns the agent condensed. |
| 9 | `ingest.js recordHome` | The record tool's `home` argument is gone. A person moves a section afterwards with `set_home`. |
| 10 | `floor.js gradeBatch` | No typed question judges end dates. A writer's own `valid_until` stands. |
| 11 | `floor.js placeEntities` | R4 says once per section. Every entity written through `upsertEntities` is checked the same way (the restrict-only side). |

## Review of ba583bc: the record stream's two items

- **B2 (blocking), fixed.** `tightening.js` now calls `settleDocument` after every raise, in place of
  `documentFollows`, so the title takes the strictest home among its sections (R11.13). It also settles a
  section the rule finds already raised, so a restart between the raise and the settling still settles the
  title. Scenario: `scenarios-rehoming.mjs`, "re-homing raises a section and its document's title goes with the
  strictest section". It failed on the old code (the document stayed at floor) and passes now.
- **Non-blocking 6, restored** in `scenarios-rehoming.mjs`, against classes, `INSTANCE_OF` and `ABOUT`:
  - loosening widens nothing; a person lowers a section with `set_home`, and the next tightening moves it again;
  - a restart partway finishes the change (now including the title the crash left behind), and running it
    twice changes nothing;
  - a direct edit of the stored policy, and a crash before the change was logged;
  - a section waiting for its check.
- **Found while restoring the last one, and fixed.** A section with no answer waits at the root, so a rule that
  tightens doesn't move it. Its recheck would then have placed it below the rule. The waiting marker now
  carries `rule`, the home the class map requires, and `regradeTick` places the section no lower than that.
  This failed on the old code and passes now.

## Review of b076783: five blocking findings

Each fix has a test that fails at b076783 and passes now.

| # | Fix | Test (failed at b076783) |
|---|---|---|
| R-B1 | `files.ts` (integrator's, an 8-line hunk) calls `record-gate.ts recordUploadsFor` after an upload. When the agent's current thread is on record, each file goes to graph-rag's `record_file` with the agent's own token. Off record, and for a graph worker, nothing is sent. The reply lists what each file became. | `condenser.test.ts`, "a file uploaded while the thread is on record goes to graph-rag's record_file", through the real route and manager |
| R-B2 | `manager.ts` (integrator's, one line) pushes `gatePushOf(id, state)`, so graph-rag hears the position the thread is on record under (R11.5). | `condenser.test.ts`, "graph-rag is told the position" |
| R-B3 | `check.js placeChecked`: new text over an existing entry follows R11.11. Unsure holds it at least one level above where it started and flags a person. No answer is admin-only and marked; the marker's `keep` stops its recheck going below where it was (`floor.js`). | `scenarios-record.mjs`, "new text written over a section follows R11.11", and "new text over a section with no answer"; `check.test.js` |
| R-B4 | `write.js` (integrator's, a 3-line hunk) settles the documents of the sections a write touched, so a title follows a section the check raised on an update (R11.13). | `scenarios-record.mjs`, "new text written over a section…" (title at ops, then at org) |
| R-B5 | `check.js piecesOf` and `strictestVerdict`: a long section is checked whole, in 6000-character pieces that overlap by 400. The strictest piece holds; an unsure piece makes the section unsure, and a piece with no answer makes it no answer. The recheck marker keeps the whole text (`write.js`). | `scenarios-record.mjs`, "a long section is checked whole"; `check.test.js` |

`fake-models.mjs`: this branch's side stays `entry: said`, so it is compatible with the reviewer's resolution
`answerChoice(q, { criteria: spec.criteria ?? {}, entry: said })`.

Newly marked (review non-blocking 6): record 12, no chosen position means the deepest held position; record 13,
what "the same file" is; record 14, a sure "none" ignores `visible_from` and is sure at the same threshold as a
category (non-blocking 1).

Requests 1 and 2 above (files.ts, manager.ts) are now done here as listed hunks; the other requests stand.
