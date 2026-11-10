# Filing stream: plan (phase 0)

The filing stream builds the orchestrator, the workers, and how a record gets filed.
This is the plan from reading the rulings (`~/reviews/design-rulings.md`, R1 to R11),
the user's messages (`~/reviews/user-messages.md`), `docs/ORGANIZATION-MODEL.md` at
`build-base` 5c6626a, and the current code. No code has been written. The file map in
`docs/BUILD.md`, once the contract step lands it, overrides the file lists here.

The rulings outrank this plan. Where they leave something open, this plan picks the
smallest reversible option and lists it under [Needs a ruling](#needs-a-ruling), each
with an id (F1, F2, …) that the code will carry in a `NEEDS RULING (Fn)` comment.

## What I read

| Area | Files |
|---|---|
| graph-rag | `worker-pool.js` (804 lines), `worker-tools.js` (420), `master-tools.js` (395), `pool.js` (235, survey brief skipped), `needs.js` (331), `requests.js` (549), `write.js` (638) |
| server | `agents/graph-pool.ts` (440), `agents/instructions/worker.ts`, `master.ts`, `graph-roles.ts`, plus `handler.ts` and `liaison.ts` because `graph-roles.ts` imports them |
| For context only | `data-entry.js` (authority and source writes), `floor.js` (`entryAudience`, the derived floor), `server.js` (tool registration by role) |

## What carries

These parts keep their shape. Their content changes where the next section says so.

| What | Where | Why it carries |
|---|---|---|
| The job queue: `enqueue`, `Job` rows, leases, `expireLeases`, retries, outage deferral, the daily budget | `worker-pool.js` | Not touched by any ruling. Workers still run as threads (R7). |
| Claiming threads, recording the agent, finishing and resuming a thread (`claimThreads`, `threadAgent`, `finishThread`, `resumeThread`, `wakeIdleWaiting`) | `worker-pool.js` | The lifecycle stays. What goes into the brief and what a finish requires change (R7, R10). |
| A brief composed in code at claim time, never written by the orchestrator, and refused before any worker sees it if it would carry anything above the audience | `worker-pool.js` `claimThreads`, `pool.js` `checkBriefFloor` | R7 says the brief is "enforced in code". This mechanism is that enforcement. It gets wider: it now covers classes, instances, dependencies and sources as well as sections. |
| One worker per home | `master-tools.js` `masterStartWorker`, `pool.js` `checkBriefFloor` | R11.6. Today the check refuses mixed homes. After the change, code splits the record by home instead of asking the orchestrator to. |
| Signals, batches (`WorkBatch`, `Signal`, `batchTick`, `signalsMessage`), the long-running orchestrator turn | `master-tools.js`, `pool.js`, `graph-pool.ts` `masterTurn` | R7: "reads batches". The orchestrator is today's master. |
| The worker pool in the server: claim, create agent, prompt, wait, finish, release, stall and outage handling, level models and limits | `graph-pool.ts` | R7. No ruling touches how threads are run. |
| `PendingWrite` and `approvePending` / `rejectPending` | `write.js` | Proposed pieces need a queue for a person to approve (R2, R11.7). This is that queue. |
| Questions a thread raises, and answering them | `worker-pool.js` `raiseQuestion`, `answerQuestions` | These carry over as Held questions to the recorder (R2) and as requests to the orchestrator (R10). Both are addressed by who they go to (see New). |
| `standingOf`: the recorder as they stand now | `data-entry.js` | R11.7: the recorder's authority counts. Owned by the sources stream. I use it, I don't edit it. |
| Needs as the asker's questions, meetings, sharing (`needs.js`, `requests.js` apart from the claim parts) | | R9: "questions stay as one kind of need." Nothing in filing changes them. |

## What changes

| What | Where | Change | Ruling |
|---|---|---|---|
| The brief | `worker-pool.js` `sectionForBrief`, `pool.js` `taskBrief` | Claims, subjects, prior state and `unresolved_names` go. The brief holds: the record's sections at this worker's home; the document title only if this audience can see it (it takes the strictest home among the sections, R11.13); the class tree visible from the home; connected instances visible from the home; dependency edges only where both ends are visible (R11.8); and how each visible source is committed to. | R2, R7, R11.6, R11.8, R11.13 |
| The audience check | `pool.js` `checkBriefFloor` | It checks every item in the brief against the home, not only prior claims: sections, title, classes, instances, edges, sources. It throws naming the kind of item and never quoting it. | R7 |
| Worker reads | `server.js` `beyond` on `search_graph`, `about_thing`, `read_document` for the worker role; `graph-roles.ts` worker sources line | `beyond: true` goes for workers. A worker "sees only its audience" (R11.6), so it has no way to read above it. That also settles "an agent cannot write lower than what it read" (R11.13) for workers. This is a shared hunk in `server.js` (F14). | R11.6, R11.13 |
| The worker's tools | `worker-tools.js` | `confirm_claim`, `record_conflict`, `resolve_subject` (claim path), `enter_data` (claim-based) and `mark_need_met` (by claim) go with claims. The new filing tools are listed under New. | R2 |
| The orchestrator | `master-tools.js`, `instructions/master.ts`, `graph-pool.ts` | It is renamed in what people and models see ("Graph orchestrator"). The internal role kind stays `master`, so the shared `GraphRole` type isn't touched (F13). It reads batches in full, because it is the most privileged agent. It decides classes, starts workers per record (code splits each record by home), answers worker requests, re-files Kept pieces and checks workers' accounts. `decide_proposal` goes: the orchestrator never approves (R11.7). The triage levels in `start_worker` go with triage (R4). The model `level` stays as the orchestrator's choice of model. | R4, R7, R10, R11.4, R11.7 |
| What a batch shows the orchestrator | `master-tools.js` `sectionForMaster`, `pool.js` `signalsMessage` | It stops being a claim shape and becomes the records themselves: each section's text, home, recorder and check status, plus any Kept pieces since the last batch. The old rule against titles and text guarded the master's own briefs to workers, and the orchestrator writes no briefs. | R7 |
| Finishing a worker | `worker-pool.js` `finishThread` | A worker is done only after it has given its account (`give_account`). A turn that ends without one is resumed once and asked for it. If there is still none, the thread is marked failed, and the pieces it did file stay in the log. `recordTriageOutcome` and `draftFromSurvey` are called from here today. Both calls go: triage goes with R4, and the survey belongs to discovery. | R4, R10 |
| Approving a Proposed piece | `write.js` `approvePending`, `master-tools.js` handler and liaison tools | For a filing proposal, the approver must be a person, approving as themselves, who holds authority for the piece's class under the map. The orchestrator, a handler "on the operator's word", or the liaison is refused. Approval appends a Filed entry to the log, and the Proposed entry stays (F6). | R11.7 |
| Worker and orchestrator instructions | `instructions/worker.ts`, `master.ts`, `graph-roles.ts` | Rewritten for filing: the four outcomes, low and high stakes, requests kept few, the account, nothing negotiated about classes in the record. | R2, R5, R10, R11.1, R11.2 |
| Pool status | `worker-pool.js` `workerStatus`, `masterStatus` | Triage, conflicts, audit counts and `awaiting_grading` go. Counts by outcome from the filing log, open requests and open Held questions come in. | R4, R9 |
| State answers to questions | `requests.js` `answerFromState`, `claimWords`; `needs.js` `parseStateQuestion`, `namesOnly`, `needAsCommitment` | These read claims, and claims go. Questions then fall to the embedding meeting, as any other question already does. The contract step may already be removing this. If not, I remove the smallest hunk and say so. | R2, R9 |

## What is removed in my area

If the contract step hasn't already removed these, I do it with the smallest hunks and name them in my report.

- Claims in the worker: `shapeClaim`, `claimsOfSection`, `claimById`, `claimsOnAttribute`, `priorState`, `CLAIMS` and `ClaimConflict` DDL in `ensureWorkerSchema`, `labelFor` by claims (R2).
- Triage: `triage.js` imports, `RECONCILE_CHANGES`, `recordTriageOutcome`, triage levels (R4).
- Linker use: `jobMentions`, `seenThing`, `thingLookup`, `resolveSubjectStub`, `confirmedClassesFor` over `CommitmentClass` status `confirmed`, and the "mentions" job (R4, R5).
- Audit nodes: `ensureAuditSchema`, `ensureSourceRef`, `referTo`, `AuditEvent` counts. Source writes go into the filing log (R9).
- The person gate on classes, through `status = 'confirmed'` reads in the worker (R5).
- The derived-floor `held` lift on worker writes. Once workers see only their audience, it has nothing to catch (R11.6, R11.13).
- The orchestrator's `decide_proposal`, and approving filing proposals through a handler or the liaison (R11.7).

## What is new

### The filing log (R9, R11.1)

There is one log outside the knowledge graph. Each entry is one piece: whatever the
worker decides one entry covers (R11.1). Nothing is stored on a section to divide it.

The entry shape, unless the contract fixes another:

```
id, at, record (document id), sections [ids], home, job, worker agent,
outcome: Filed | Proposed | Held | Kept,
class (id) | null, instances [ids], source (connection) | null, key | null,
write: { fields, before, after } | null,      // source writes are in the log (R9)
authority: { recorder, position, holds: true|false, map_entry: present|missing },
question: { to: recorder, text, answered_at, answer } | null,   // Held
proposal: PendingWrite id | null,             // Proposed
supersedes: entry id | null,                  // re-filing, approval, an answered Held
account: the worker's words for this piece,
check: { by: orchestrator, verdict: agrees | disagrees | unchecked, source_read, note } 
```

The log is append-only. A later outcome for the same piece is a new entry that
supersedes the old one, and the old one stays. That keeps "nothing Kept is deleted"
(R11.4) true for every outcome. Storage: a document type with no edges, never
embedded or searched, which no graph read returns (F1).

### How a piece gets its outcome (R2, R3, R6, R11.2, R11.7)

The worker proposes what to do. Code decides Filed or Proposed from facts. The model
never names those two outcomes.

| The worker asks to… | Code checks | Outcome |
|---|---|---|
| Write fields to a row (`file_to_source`) | The class's map entry is missing | **Proposed** (R11.7) |
| | The source is declared not writable | **Proposed** (R2) |
| | The source is unreachable when it is read | **Held**, asking the recorder (R3) |
| | The recorder, as they stand now, holds no authority for the class | **Proposed** (R2, R11.7) |
| | The row already holds a different, non-empty value in a field being written | Nothing written. It becomes a request to the orchestrator, as a conflict with the source (R11.2, F4) |
| | Otherwise | Written through the sources stream's commit adapter, before and after logged: **Filed** |
| Hold a piece (`hold_piece`): unclear which record, or the source disagrees | A recorder exists on the record | **Held**, with the question addressed to the recorder. Nothing is written (R2) |
| Keep a piece (`keep_piece`): no system holds it | The record is linked to the instances named | **Kept**, the document is the source (R2) |

"Has authority" is the recorder's, never the agent's (R11.7). It is read from the class
map. Where a class has several parents, the strictest rule wins (R9). The map function
comes from the classes stream.

### Worker tools (R3, R7, R10, R11.2)

Every tool reads and writes only within the worker's audience. That is enforced from
the job's home, never taken from the model.

- `resolve_name`: look a name up against the source through the sources stream's read adapter, and against visible instances. Read-only (R3, R4).
- `create_instance`: a lasting individual under an existing visible class (R3, R7). If the class says its rows do not become nodes, this is refused, except through `state_dependency` (R3).
- `relate_section`: relate a section to a visible instance (R2). For a transactional row, `section_key` stores the key on the section and makes no node (R3).
- `state_dependency`: a dependency edge between two instances, stated by the record or by the agent (R1). When an end is a transactional row, the row earns its node here, referring back by key (R3).
- `file_to_source`, `hold_piece`, `keep_piece`: the three ways a piece ends (above). Each writes one log entry.
- `request`: to the orchestrator, only for high-stakes matters, which are a new class or subclass, or a conflict with a source (R10, R11.2). The worker stops on that piece until the answer comes.
- `give_account`: the worker's account of each piece it filed, required before the thread is done (R10).

No tool lets a worker create or change a class (R5, R7).

### Orchestrator tools (R5, R7, R10, R11.2, R11.3, R11.4)

- `start_worker(record)`: code splits the record by home and starts one worker per home (R4, R11.6).
- `create_class` / `add_parent`: through the classes stream (R5, R7). The class's home follows R11.9.
- `answer_request(request, decision)`: answers are structured, not free text: use class X, class X created, keep, hold. Code checks that any class named is visible from the worker's home. A free-text answer could carry what the worker's audience can't see, so there is none (F7).
- `list_kept` and `refile(kept entries)`: in a later batch, when a fitting class or source appears. The orchestrator judges recurrence, with no fixed number. A re-filed piece gets a new entry that supersedes the Kept one, and the Kept entry stays (R11.4).
- `check_account(job)`: for each entry, the account, the log entry, and the source row read fresh through the read adapter, plus code's comparison. The orchestrator records `agrees` or `disagrees` with a note (R10, R11.2). A disagreement flags the entry and changes no outcome (F8).
- No tool approves a Proposed piece (R11.7).

Every record gets a worker (R4). If a batch's record still has no worker when the
orchestrator's turn ends, code starts it (F9).

### Held questions to the recorder (R2)

A Held piece's question is a `WorkerQuestion` addressed to the recorder, not to the
admin (F3). An answer appends a new entry that supersedes the Held one, through the
same worker if it is still open, or through the orchestrator in a later batch.
How the recorder sees and answers the question in the web or chat is not built in
the first version (proposal B leaves the web out). The question and its answer
endpoint exist in graph-rag (F10).

### Gates that filing checks (R4, R11.5, R11.11, R11.12)

- A worker is claimed only for sections that are on record and whose typed check has an answer. An unchecked section is admin-only (R11.11), and a worker briefed at admin-only could then write next to a section that later drops lower (F11).
- Off-record content never reaches a worker: the job refuses a record that isn't on record (R11.12). The record stream owns the flag. Filing only checks it.
- Nodes come only from workers and the orchestrator (R7). If the contract doesn't gate this, I add a role check at the mint path, as a shared hunk named in the report (F12).

## How it will be tested

Every behaviour gets a test that fails before the change and passes after. Fakes never
choose an outcome: a fake worker calls a tool with facts (class, row, fields), and the
code's answer is what the test checks.

- **Unit (graph-rag `npm test`):**
  - The brief holds only what the audience can see. Each item kind gets a marker above the home, and the test asserts that the brief either refuses or leaves it out.
  - The outcome table, row by row, over a stub source and a stub map.
  - The log is append-only: entries supersede and are never deleted.
  - The orchestrator's tools refuse approval.
  - Approval is refused for anyone but a person with authority.
  - A finish without an account is refused.
  - A record with two homes is split into two jobs.
  - Structured answers naming a class the worker can't see are refused.
- **Server (vitest):**
  - `graph-pool.test.ts`: an account is required before finish, and the orchestrator is renamed where people see it.
  - The instructions name only tools that exist.
- **Replay (`graph-rag/e2e/e2e.sh`):** a filing scenario file over the fake DAB source, with a scripted worker. Rows changed must match Filed entries and nothing else may change, the leak scan of proposal B runs, and Kept is re-filed after a class appears.

## Interfaces I need from other streams

| From | What |
|---|---|
| Contract | The filing log type and outcome enum. The instance and dependency edge types. The record and section fields: recorder, position, on-record flag, check status, home. |
| Classes | The class tree read by home. The map: whether a recorder has authority for a class, with the strictest parent winning. The class settings: whether rows become nodes, and the source table. Creating a class and adding a parent. |
| Sources | Each source's declaration (how it is committed to, whether writable, the connection's home). The read adapter (row by key, find by name, reachable or not). The commit adapter (write fields, returning before and after). `standingOf`. |
| Record | When a record's sections are checked and ready to file, and which batch they join. |

## Needs a ruling

Each of these is the smallest reversible option I will build. Each is marked
`NEEDS RULING (Fn)` in the code, and none is stated as decided.

| Id | The question | What I'll build | Rulings it sits between |
|---|---|---|---|
| F1 | Where does the filing log live, "outside the knowledge graph"? | A document type in the same database with no edges, never embedded or searched, and excluded from every graph read. A separate database is the alternative. | R9 |
| F2 | Is an outcome final, or can it change? | An append-only log. A later outcome is a new entry that supersedes the old one. Nothing is overwritten or deleted. | R2, R11.4 |
| F3 | How does a Held question reach "whoever put it on record"? | A `WorkerQuestion` addressed to the recorder rather than the admin. A need was the other candidate, since "questions stay as one kind of need", but a need is the asker's question to the organization, not a question to one person. | R2, R9 |
| F4 | A record states a value and the row holds a different one. Is that an update (Filed) or a disagreement (Held, and a request)? | Nothing is written. It becomes a request to the orchestrator as a conflict with the source, which is the safer reading. This may make requests less few than R10 wants. Measured in the first run. | R2, R10, R11.2 |
| F5 | Is creating an instance low or high stakes? It isn't in R11.2's list. R7 lets workers do it. | Workers create instances directly when the instance is a lasting individual under an existing class. With a source key, the row is checked through the read adapter first. Without one, the document is its source (Kept). | R3, R7, R11.2 |
| F6 | What does approving a Proposed piece record? | A new Filed entry that supersedes the Proposed one, approved by the person as themselves. | R2, R11.7 |
| F7 | Can the orchestrator's answers to workers carry free text? | No. Answers are structured, and any class named must be visible from the worker's home. A free note could carry what the worker's audience can't see. | R7, R11.6 |
| F8 | What happens when the orchestrator's check disagrees with an account? | The entry is flagged `disagrees` with a note, for a person. No automatic undo, and no change of outcome. Undoing a source write is itself a write. | R10, R11.2 |
| F9 | If the orchestrator leaves a record without a worker, who starts one? | Code does, at the end of the orchestrator's turn, so that every record gets a worker. | R4, R7 |
| F10 | Where does the recorder see and answer Held questions? | Not built in the first version. A graph-rag endpoint lists a person's Held questions and takes answers. | R2, proposal B |
| F11 | Does a worker wait for the typed check, or file at admin-only meanwhile? | It waits. Filing at admin-only and then dropping lower would leak what it read. | R4, R11.11 |
| F12 | Who gates minting to workers and the orchestrator? | If the contract doesn't, a role check at the mint path, as a shared hunk. | R7 |
| F13 | Is "master" renamed "orchestrator" everywhere? | Only where people and models see it. The internal role kind stays `master`, so the shared types are untouched. | R7 |
| F14 | Which sources may a worker read? The rulings say a worker sees only its audience. A table's class takes its connection's home. | Source reads go only through graph-rag's tools (the read adapter), restricted to connections whose home the audience can see. The worker's direct read-only connection tools are dropped from its profile. The `beyond` removal in `server.js` is a shared hunk. | R11.6, R11.9 |
| F15 | Are the handler and the liaison kept? No ruling names them. | Kept for questions and explanations. Neither can approve a filing proposal. | R11.7 |
| F16 | Who sees the filing log? | The admin and the orchestrator. A recorder sees their own Held questions. | R9, R6 |
| F17 | Can a worker close a need, as `mark_need_met` does today by claim? | Not in the first version: the tool goes with claims, and needs are left as they are. | R2, R9 |

## Out of scope

- The continuous briefing agent (R7, after the first real batch).
- Re-homing (R6). Proposal B leaves it out of the smallest version.
- The survey brief and discovery runs, apart from what the orchestrator's tools share.
- The web interface.
- Which database and models the first real run uses (R11.15, open).

---

# Phase 1: what was built

Built on the contract at `build-base` ba583bc, against `docs/BUILD.md`'s file map. Every behaviour below has a
test that fails without it; the fakes hand the code facts (a DAB row, a class row, a person's standing), never
an outcome.

| What | Where | Rulings | Tests |
|---|---|---|---|
| The filing log, append-only: a later outcome is a new entry pointing back (`refiled_from`) | `src/filing.js` (`arcadeStore`, `FilingEntry`, `WorkerRequest`) | R2, R9, R11.1, R11.4 | `test/filing.test.js` |
| Filed or Proposed decided in code: the row as read, the class map, the recorder as they stand now (through `data-entry.js enterData`) | `filing.js fileToSource` | R2, R6, R11.7 | Filed, Proposed (no authority, class missing from the map, read-only source) |
| Held: unreachable source (R3), no such row, the recorder gone; the question goes to whoever put it on record, nothing is overwritten | `filing.js holdEntry`, `askRecorder` | R2, R3 | Held cases; e2e |
| A disagreement with the source decided in one function, R12 in force: `model/filing.js onDisagreement`, `DISAGREEMENT_RULE` | `model/filing.js`, `filing.js` | R2, R12 | both rules, unit and in `fileToSource`; e2e (R12) |
| Kept, and re-filing Kept pieces in a later batch; nothing Kept is deleted | `filing.js keepPiece`, `keptPieces`; `orchestrator.js refileKept` | R2, R11.4 | Kept, re-filing |
| Requests of the orchestrator (class, conflict, other), at most three open; structured answers only, a named class visible to the worker's audience | `filing.js requestOrchestrator`, `answerRequest`; `model/filing.js normalizeAnswer` | R10, R11.2, R11.6 | requests |
| The account: every entry needs one; a thread ending without it is asked once, then fails | `filing.js giveAccount`, `accountGiven`; `worker-pool.js finishThread` | R10 | account |
| The orchestrator's check against the source itself, and its verdict (changes no outcome) | `filing.js accountEvidence`, `recordVerdict`; `model/filing.js suggestVerdict` | R10, R11.2 | check; e2e |
| Approval: a Proposed piece names no thread; an approval appends a Filed entry; no agent approves or rejects one on anyone's word | `filing.js settleProposals`; `master-tools.js assertNotFilingProposal`; `decide_proposal` and `answer_worker` gone | R11.7 | approvals; e2e |
| Instances under existing visible classes; a class whose rows stay in the source refuses; a row earns a node only through a dependency; keys on sections | `filing.js createInstance`, `relateSection`, `sectionKey`, `stateDependency` | R3, R7 | instance |
| The worker's tools | `src/worker-tools.js` | R7, R10 | `test/pool.test.js`, server `graph-worker-tools.test.ts` |
| One job per record and home; off-record and unchecked sections never reach a worker | `worker-pool.js filingJob`, `claimThreads` | R4, R11.6, R11.11, R11.12 | gates |
| The brief: record, sections, class tree, connected instances, dependencies seen at both ends, how each source is committed to; scoped and checked by the contract's `scopeBrief` and `assertBrief` | `worker-pool.js composeFilingBrief`, `pool.js taskBrief` | R7, R11.6, R11.8, R11.13 | marker leak test |
| The orchestrator: batches by record in full, a worker per record and home, every record gets one, its filing tools | `src/orchestrator.js`, `master-tools.js batchTick`, `pool.js signalsMessage` | R4, R7, R11.6 | orchestrator tests, inbox test |
| Instructions: worker, orchestrator, handler, liaison. A worker's instructions name no `beyond` and no `query_graph`: it reads only its audience (R11.6; the integrator removed both from its tools) | `packages/server/src/agents/instructions/*.ts` | R2, R5, R10, R11 | server tests |
| The orchestrator's name where people see it; the filing counts in the worker panel | `graph-pool.ts`, `GraphWorkerPanel.svelte` | R7 | `graph-pool.test.ts` |

## Requests to the integrator (shared files)

1. `server.js`: drop `beyond` for the worker role on `search_graph`, `about_thing` and `read_document` (and the
   `readScope` branch that honours it). A worker sees only its audience (R11.6). Test: a worker token's
   `tools/list` schema for `search_graph` has no `beyond`.
2. `routes.js`: `registerFilingRoutes(app, { resolveIdentity, personOf, isRoot })` from `filing.js`, for
   `GET /api/filing/held` (a person's own Held questions), `POST /api/filing/held/:id/answer`, and
   `GET /api/filing/log` (root only). Test: an answer by someone other than the recorder is refused.
3. Contract, `model/filing.js` and `model/schema.js` `FilingEntry`: a `before` on `target` (the row's values a
   Filed write replaced; today it rides in `reason`), and a ruling or a field on whether `refiled_from` is the
   one back-pointer for every later outcome (re-filed Kept, approved Proposed, answered Held). R9, R11.4.
4. `scaffold.ts` or `manager.ts`: a worker's direct read-only connection tools, dropped from its MCP config, so
   source reads go only through graph-rag's tools (F14). Until then a worker can still read a connection whose
   home is above its audience.
5. `packages/web/src/lib/api.ts`: `filing`, `open_requests` and `open_held_questions` on `GraphWorkerView`
   (the panel reads them as an extension today), and `triage` removed.

## For other streams

- **Sources:** `enterData` keeps deciding Filed or Proposed at integration; nothing moves into `fileToSource`. On
  `claude/build-sources-000b53` (c1eaf39) it decides with `filedOrProposed` and the class index (R9, BUILD.md 6)
  and the declaration's `writable`, and writes through `filing.js sourceJournal`. On `build-base` it still
  decides without the index (fails safe: a subclass with no entry of its own is Proposed). The filing stream's
  `findSourceRows` stands in for the read adapter's `findRows` and should be replaced by it. Filing only updates
  rows: a piece that needs a new row has no tool yet.
- **Classes:** the orchestrator's class tools (create a class, add a parent) are expected from the classes
  stream and registered for the `master` role; `answer_request` names their keys. Filing reads classes as
  contract rows (`_kind = 'class'`, `SUBCLASS_OF`) and instances as `_kind = 'thing'` with `INSTANCE_OF`.
- **Record:** a section is held back from filing while `_ungraded` is set (the grader's mark). When the typed
  check replaces the grader, `worker-pool.js filingJob` should read its mark instead.

## Choices that need a ruling

F1 to F17 stand as phase 0 set them, except where noted. Each is marked `NEEDS A RULING` in the code.

| Id | The choice built | Where |
|---|---|---|
| F1 | The log is the contract's `FilingEntry` document (BUILD.md 8) | `model/filing.js`, `filing.js` |
| F2 | Append-only; a later outcome points back with `refiled_from` | `filing.js` |
| F3 | A Held question is a `WorkerQuestion` with `asked_of` the recorder; the admin's lists leave it out | `filing.js askRecorder`, `worker-pool.js` |
| F4 | Ruled: R12. `update_when_changed` is in force; `hold_and_request` stays as the other value, tested | `model/filing.js onDisagreement` |
| F5 | Workers create instances directly under existing classes | `filing.js createInstance` |
| F6 | An approval appends a Filed entry; a rejection leaves Proposed | `filing.js settleProposals` |
| F7 | Answers to workers are structured; the orchestrator's free-text `answer_worker` is gone | `model/filing.js normalizeAnswer`, `master-tools.js` |
| F8 | A `differs` verdict flags the entry; nothing is undone | `filing.js recordVerdict` |
| F9 | A batch's record with no worker gets one once the batch has waited `batchMinutes` | `orchestrator.js startUnstarted` |
| F10 | The recorder's Held questions: graph-rag functions and routes only, no web or chat yet | `filing.js` |
| F11 | A section with `_ungraded` set waits | `worker-pool.js filingJob` |
| F12 | Not needed in this build: no path other than the filing tools mints an instance | |
| F13 | The role kind stays `master`; people and models see "orchestrator" | `orchestrator.js`, `graph-pool.ts` |
| F14 | Every connected source is listed in a brief (no source declares a home yet); see request 4 | `worker-pool.js composeFilingBrief` |
| F15 | The handler and the liaison stay, and can't apply or reject a Proposed piece | `master-tools.js` |
| F16 | The log is for the admin and the orchestrator; a recorder sees their own Held questions | `filing.js` |
| F17 | No worker closes a need | |
| F18 (new) | A write whose connection broke and whose row couldn't be read back is Held, for the orchestrator's check | `filing.js fileToSource` |
| F19 (new) | A worker's request to the orchestrator doesn't stop its other pieces; the thread waits only while a request is open at the end | `filing.js`, `worker-pool.js finishThread` |
| BUILD.md 9 | Verdicts are `matches`, `differs`, `unverifiable` | contract |
| BUILD.md 10 | Superseded by R12: a disagreeing state is Held with no request; a stated change is filed | contract |
| BUILD.md 12 | A recorder who left or moved: Held, asking them | `filing.js fileToSource` |

## Follow-up: ruling 12 and the review of ba583bc

- **R12 (was F4).** `model/filing.js DISAGREEMENT_RULE` is `update_when_changed`: a record that says something
  changed is filed given the recorder's authority (Proposed without it) and checked by the orchestrator after; a
  record describing the state that disagrees with the source is Held, asking the recorder, with no request. The
  conservative `hold_and_request` stays as the other value of the same function, and both are tested (unit, and
  the orchestrator's `update` answer under it). The e2e scenario runs R12.
- **B1 (blocking), `model/brief.js`.** A record with no home counts as the root. A brief's record is its id,
  title, description and the title's home only (`RECORD_FIELDS`); `assertBrief` refuses a record carrying
  sections or anything else. The reviewer's probe is `test/model-brief.test.js` (both B1 tests fail on the old
  logic). The brief text no longer names who put the record on record, its reason or its position.
- **Non-blocking 4, `normalizeEntry`.** A Filed entry names its class and carries its account; a Kept entry is
  linked to at least one instance. So `file_to_source` takes the worker's account with the piece (`said`), and
  `keep_piece` needs an instance.
- **Non-blocking 1, the approval seam.** `filing.js` exports `sourceJournal` (and `makeJournal(env)`), the
  journal the sources stream's write adapter writes through (`claude/build-sources-000b53` 50d0eff: `begin`
  before a write, `settle` after). An attempt is a `FilingAttempt` document. A write settled `written` whose
  `piece` carries `pending_id` (what `applyProposedEntry` passes on approval) appends the Filed entry superseding
  the Proposed one, once. Until that adapter is merged, approvals write through today's `applyProposedEntry`, and
  the worker loop's `settleProposals` files them; both paths are idempotent with each other. **The seam:** filing
  owns the Filed entry on approval, written from `sourceJournal.settle`; sources owns calling it; the integrator's
  `write.js` only routes the approval. `fileToSource` now passes `before` (what the worker read) and `piece` to
  `enterData`, as the adapter asks.
- **Non-blocking 10, agents relaying approvals: needs a ruling.** F15, which stood as the default, already
  refuses a Proposed piece (a `data_entry` proposal) approved or rejected by the handler or the liaison on a
  person's word (`master-tools.js assertNotFilingProposal`), so today only a person approving as themselves, in
  Approvals, writes one. Whether an agent may relay a person's approval is still the user's to rule. Removing the
  two calls to `assertNotFilingProposal` undoes it.

### More requests to the integrator

6. `model/schema.js`: a `FilingAttempt` TYPES entry (`id`, `system`, `source_table`, `row_key`, `action`,
   `fields`, `row_before`, `piece`, `status`, `detail`, `at`, `settled_at`, all STRING; unique index on `id`).
   `table`, `key` and `before` are ArcadeDB SQL keywords (`before` checked against a running instance), so they
   are stored renamed.
   `filing.js ensureFilingSchema` declares it until then. R9.
7. Nothing for the sources branch: its `enterData` (c1eaf39) still decides Filed or Proposed, now with the class
   index and the declaration's `writable`, takes `before` and `piece`, and writes through `sourceJournal`. Its new
   `held` answer (a write that didn't land: unreachable, moved, not_found, refused, unknown) is filed as Held, asking
   the recorder; `status: "already"` is Filed with nothing written.
8. `e2e/run.mjs`, the built-in scenario "a model with a limit gets no more threads than it serves": its four
   review jobs point at a plain note that belongs to no record, and a filing worker now gets only a record on
   record (`worker-pool.js filingJob`: R4, R11.12), so the claim returns none and the scenario fails. The fix is
   in the scenario, not the gate: make its jobs' `rid` a section of a document with `_on_record = true` (as
   `scenarios-filing.mjs record()` does). This is the one red check on this branch.

## The review of b0e8ca7

- **F-B1 (blocking), source reads ignored the audience.** Every source read a worker makes now goes through
  `filing.js assertTableReadable` before anything is read: `resolve_name` with a table, `file_to_source`,
  `create_instance` and `section_key` by key, and a dependency's row. A table is readable when the audience sees
  the home of every class pointing at it and, once the sources stream's declarations give it, the home of the
  connection that reads it (`env.connectionHome`, undefined today). A table no class points at, with no connection
  home, counts as the root's (NEEDS A RULING F22). `file_to_source` refuses a key outside its class's own table.
  The reviewer's probe is `test/filing.test.js` ("F-B1: a worker reads no table above its audience"), and it
  fails with the gate turned off. **Still to do:** the connection-home half, when the sources branch is merged:
  `connectionHome(system)` from its declaration's `read.home`, null meaning the root.
- **Non-blocking 1, a hidden instance reused.** An instance holding the key that the audience can't see is
  refused, not reused, and a same-named one it can't see is passed over. This stands until filing's tools call the
  classes stream's `relateInstance` and `addDependency` (the seam below).
- **Non-blocking 2, the orchestrator's `update` answer.** It stays dormant under R12, which raises no conflict
  request. This is now said in the code.
- **Non-blocking 3 and 4, unmarked choices.** Now marked: the cap of three open requests (F20), and an empty
  column filled without asking (F21).
- **The seam with the integrator: BriefLog.** `worker-pool.js logBrief` writes one row per brief in
  `claimThreads`, after the brief is composed and checked and before it goes out. Fields: `id`, `record`,
  `audience`, `worker` (the job), `brief`, `dropped`, `at`. `brief` is the scoped brief as sent, plus the
  dependencies and the pieces to re-file that go out with it. A row that can't be written refuses the brief, as
  an `assertBrief` failure does. The type is the integrator's (`model/schema.js` on its branch), so this branch
  declares none: on this branch alone, before that merge, every brief would be refused for want of the type.
- **The seam with classes.** The classes stream's `relateInstance`, `addDependency` and `findInstance` become the
  one implementation, and filing's `create_instance` and `state_dependency` call them. Proposed rule, sent to
  classes: a new node's home is the strictest of its evidence home (a key's connection, else the notes, which for
  a worker is its own section, else the root) and the writer's floor (a worker's audience home; none for
  discovery or the orchestrator). Relating the section then adds the worker's home (R11.8). **Still to do:** this
  waits on the classes branch being on this one.

| Id | The choice built | Where |
|---|---|---|
| F20 (new) | At most three open requests per worker | `filing.js requestOrchestrator` |
| F21 (new) | An empty source column taking a value is no disagreement, so it is filled | `model/filing.js disagreeingColumns` |
| F22 (new) | A class above the audience pointing at a table refuses it to the worker, even when the connection's own home is visible (the strictest wins); a table no class points at goes by the connection's home | `filing.js assertTableReadable` |

## The sources branch merged (15ce278)

- **F-B1, finished.** A worker's every source read now goes through the sources stream's read adapter with the
  worker's audience (`getRow`, `findRows` given `{ audience, positions }`), which refuses a connection whose home
  the audience can't see. `assertTableReadable` also checks that home up front, from the declaration's
  `read.home` (none, or an unknown system: the root), along with the classes pointing at the table. The
  orchestrator reads with no audience. Tests: the reviewer's probe, and a connection above the audience refusing
  a table a floor class vouches for, before anything is read.
- **The seam with sources, as the sources stream proposed:** `liveEnv` builds the env and hands `enterData` its
  own journal (`makeJournal(env)`) and the class index; the test fakes store a declaration list with the guard and
  serve the guard's identity view. Filing's own DAB reads (`clientFor`, `mcpToolCall`) are gone.
- **Found by the e2e run, not the unit fakes:** `before` is an ArcadeDB SQL keyword, so every journal `begin`
  failed and every write was Held. The column is `row_before` now, and a unit test checks the stored names.
- **Still waiting:** the classes branch, for `create_instance` and `state_dependency` to call its `relateInstance`
  and `addDependency`.
- **BriefLog holds the message as sent.** At the integrator's request, `brief` also carries `why` and the rendered
  `message`, computed before the row is written, so the leak scan covers everything the worker receives. `why` is
  set only by code (`refileKept`'s fixed text); no orchestrator tool passes free text into it.

## The classes branch merged (c1323a3)

- **One implementation for instances and dependencies (review C-B7).** `create_instance` and `state_dependency`
  call the classes stream's `relateInstance` and `addDependency` (`instances.js`) with the worker's audience as
  the scope, the worker as the actor (its identity for the write floor), and `{ home: the section's home }`.
  Filing's own minting (`existingInstance`, `mintInstance`, `dependencyEnd`) is gone. Filing still reads a key's
  row first (R3, through the audience gate of F-B1) and relates the section to the instance and to both ends
  after (R11.8).
- **The homing rule, as classes built it and the coordinator accepted:** a new node's home is the caller's
  `opts.home` (a worker's section home), else its evidence (a key's connection home), else the writer's home. It is
  never below the writer's derived floor (R11.13), and an edge to existing nodes that would be seen lower than that
  floor is refused. One node per key across the graph: one held where the worker can't see it is refused without
  naming it. Names are deduplicated under the class, among what the worker sees. Since a worker can read no
  connection above its audience (F-B1), a key's connection home never sits above the section's home it is given.
- **Tests:** `test/filing.test.js` checks what filing hands the classes stream (the scope, the home, the
  identity), that no node is made without its row, and that filing writes no vertex or instance or dependency edge
  itself. The e2e scenarios make instances through the real `relateInstance`.

## After 7f8bf0c: the brief's sources as declared

- The brief lists each source as its declaration allows it (`model/sources.js briefSource`): whether it takes
  writes, its actions and its tables, and only the sources whose read home the worker's audience sees (no home:
  the root). It no longer tells every worker "update, any table". The text names the tables ("takes update writes
  on dbo_Job only") and says a piece for another table is Proposed. F14 is settled by the sources stream's
  declarations: the mark is gone.

## After ee2e37e: links carry a home (classes 525581b merged)

- INSTANCE_OF and DEPENDS_ON edges now carry their own `home` (the coordinator's decision from R11.8 and R11.9,
  pending the user). The brief's two reads of them check it against the audience, a missing home counting as the
  root: an instance's classes are only those by links the audience sees, and a dependency needs both ends and its
  link seen. Filing's calls already fit: with the section's home as `opts.home`, the link is homed at the section.
