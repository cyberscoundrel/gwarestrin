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
