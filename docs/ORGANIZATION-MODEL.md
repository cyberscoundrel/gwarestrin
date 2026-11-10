# The organization model

Rewritten 2026-11-09 from the user's rulings. No code has been written against this
version, and none will be until the user has read it. After that, the smallest version
that can run on real models is built.

**How to read it.** Every decided statement is the user's: quoted, or marked with
its ruling, R1 to R11 (`~/reviews/design-rulings.md`). "Earlier" marks the rulings
that came before R1, listed at the top of the same file. R11 statements are answers
the assistant recommended to fourteen open questions, which the user accepted with
"They stand". The one question left is in [Open](#open) and is not decided. The two
[proposals](#proposals-from-the-assistant-not-rulings) at the end are the assistant's.

## What an organization is

> "if you generalize an organization or a business down to the least concepts
> required to describe it, it could be described as a series of asynchronous
> decisions and actions, some of which are dependent on others"

Four primary primitives are the roots: **agent**, **commitment**, **event** and
**resource** (R1).

- A commitment is an obligation one agent has to another to do or deliver something by
  some time. An event is something that happened at a time (R11).
- Decisions and actions are subclasses of event (R1).
- Agent is the user's word, replacing actor. The AI agents are instances under it (R1).
- Resource is anything of value the organization controls: vehicles, buildings,
  software (R1).
- Organizational needs are unfulfilled commitments with dependency edges. Questions
  stay as one kind of need (R9).

## Classes, subclasses and instances

> "instances should be an entity that has an instance relationship to a class"

> "a class name would be something like leased building and warehouse is a subclass
> and then xxxx abc street location would be an instance of warehouse"

> "there might be employees and contractors and volunteers, there might be software
> or capital resources they have relationships to, instances of these classes would
> be individual employees or individual company owned vehicles or individual software
> resources, relationships between instances and classes form the hierarchical
> structure of an organization while classes represent the relevant internal symbols"

- Classes can be of anything and form a tree with subclasses (earlier).
- A class may have several parents. Where parents conflict, the strictest rule wins (R9).
- A class is scoped by home like any other node (earlier).
- A class holds its name, parents, home, description, evidence, whether its rows become
  nodes, its source table if any, and, for commitment classes, optional stages. Other
  attributes stay in the source (R11).
- There is no person gate on classes. People can correct afterwards (R5).
- A class is never negotiated in a record or a conversation. The chat agent and the
  condenser deal in text, not class vocabulary (R5).
- The orchestrator makes the broad decisions about classes and subclasses. Workers
  create instances and relate them to existing classes. Nothing mints except these
  two (R5, R7).
- The goal is to see how well models handle this, so tree quality is measured on real
  models early (R5).

> "over time as the actions satisfy the needs of the organization classes of things
> crystalize"

## Dependency and timeline

> "an generic organization begins as no infrastructure and timeline of actions, a
> business does not generally start with a warehouse it has to be acquired and legally
> purchased or leased"

Instances can be joined by a dependency edge, stated by a person, a record or an
agent. A timeline is read from times plus dependency (R1).

## What earns a node

> "naively recording notes into the graph pollutes it with nodes that are not useful
> enough to justify being nodes"

- Lasting individuals (employees, vehicles, buildings, machines, customers, software)
  are instances with nodes (R3).
- Transactional rows (order lines, operations, invoices, time punches) stay in the
  source. The class points at its table and a section stores the key. There are no
  per-row reference nodes (R3).
- A row earns a node when the graph must say something the source cannot hold, for
  example a dependency. The worker creates it, and it refers back by key (R3).
- Each class carries this as a setting, set by discovery from evidence and correctable
  by a person. There are no word lists (R3).

## On record, off record and condensing

> "first considering explicitly whether a thread is intended to be on record or off
> record, and if you want the content of a conversation on record, the agent condenses
> whole sections a conversation into a summary document with relevant context rather
> than atomic data, and then you barely need intermediate language model calls"

- The condensed document and its sections are the record. Sections relate to
  instances. The user does not need model-free answers from the graph (R2).
- The pipeline is: condense, one typed check per section, worker files (R4).
- The person chooses on or off record in the chat, and threads default to off record.
  Nothing from an off-record thread reaches the graph or any source, enforced by the
  tools. A file uploaded on record is a record and gets a worker (R11).

## How workers file a record

> "this necessitates a worker has tool access to those data sources for data entry to
> act on a summary document"

Workers are responsible for filing incoming records. Information is committed to its
relevant source by whatever means that source takes; for SQL Server, a write. Each
source declares how it is committed to (R2).

Each piece of a record ends in one outcome on record (R2). A piece is whatever one
filing-log entry covers. The worker decides the split while filing, and nothing is
stored to divide sections (R11). For example, a section saying a job moved machines and
a customer wants fifty more parts by Friday is two entries, because they go to two
places.

| Outcome | Meaning |
|---|---|
| **Filed** | Source and record are clear and the person has authority. It is written, and the section references the row. |
| **Proposed** | Clear, but there is no authority or the source is not writable. |
| **Held** | A source exists, but it is unclear which record, or the source disagrees. The worker asks whoever put it on record and never overwrites. |
| **Kept** | No system holds it. The document is the source, linked to instances. |

**Data with no source.** R2 raised this as its open part and settled the outcome: it is
Kept, and recurring Kept is a signal for a discovered class. When a fitting class or
source appears, the orchestrator re-files the matching Kept pieces in a later batch. It
judges what counts as recurring; there is no fixed number. Nothing Kept is deleted (R11).

**Who authorizes.** The authority that counts is the recorder's, never the agent's. A
class missing from the map means Proposed. A person with authority for that class
approves a Proposed piece; the orchestrator never approves (R11).

Workers resolve names against the source with read tools. If the source is
unreachable, the piece is Held (R3).

One filing log outside the knowledge graph holds every filing outcome, including
source writes. There are no audit nodes (R9).

## The orchestrator, workers and briefs

> "the orchestrator and the workers start with the relevant information to behave
> properly when they need to create the necessary nodes in the graph and their
> relationships to classes and instances"

- The orchestrator is the most privileged agent. It reads batches, makes the broad
  class decisions and starts workers (R7).
- Every record gets a worker (R4). Workers create instances, relate them to existing
  classes and commit to sources (R7).
- A worker starts with a brief: the record, the relevant class tree, connected
  instances, and how each source is committed to (R7).
- A brief contains only what the record audience can see, enforced in code (R7).
- A record with sections at different homes is split by home: one worker per home, each
  seeing only its own audience (R11).
- The continuous briefing agent per profile comes after the first real batch. Briefing
  content is treated as data and sanitized (R7).

> "the workers will make low stakes decisions and minimally make requests of the
> orchestrator instead of resolving, and when it does resolve the record to storage in
> whatever media the orchestrator can evaluate what it said about what it did"

- Workers decide low-stakes matters themselves. Beyond that, they make requests of the
  orchestrator instead of resolving, and keep those requests few (R10).
- When a worker resolves a record to storage, in any medium, it gives an account of
  what it did, and the orchestrator evaluates that account (R10).
- So when no existing class fits, the worker requests one from the orchestrator and
  does not resolve that piece itself (R10).
- Low stakes is anything reversible and confined to its own record: relating to existing
  instances, Kept, and Held questions to the recorder. High stakes is new classes or
  subclasses, and conflicts with a source. The orchestrator checks a worker's account
  against the source itself (R11).

## Discovery

> "a discovery process that evaluates a corpus of information and historical records
> that have to be evaluated agentically as an upfront cost"

> "in a discovery phase since its building from scratch doesnt rely on human input so
> long as its a read only process"

- The new version starts on an empty graph, and discovery builds from the connected
  systems (R8).
- Discovery is the orchestrator running with read tools only, plus workers it starts
  for parts of it (R11).
- Discovery seeds only what organizational structure needs (R3).
- Reruns and new tables count as discovery (R9).
- The old development notes are read-only history for discovery, with restrictions
  respected through home from evidence (R8).
- A class found in a table gets the home of the connection that can read that table. A
  class found in notes gets the strictest home among those notes. Either is wider only
  if wider evidence independently supports it (R11).
- A person corrects in the admin panel or by telling the orchestrator. Corrections are
  stored and reruns respect them. A retired class never returns on its own (R11).
- The development volume is snapshotted first, only when the user says so. The demo
  instance is unaffected (R8).

## Visibility, and the map that chooses Filed or Proposed

- Visibility is the section's position home plus the restrict-only check (R6).
- A section starts at the position of the person who put it on record, and the check
  can only raise it (R11).
- An instance is visible wherever a section about it is. A dependency edge is visible
  only to someone who can see both ends (R11).
- A document's title takes the strictest home among its sections (R11).
- An agent cannot write lower than what it read, but a person's own notes do not raise
  their level (R11).
- A map from classes to positions is used only to choose Filed or Proposed (R6).
- Positions are mirrored as classes under agent, with people as instances. The sync
  is one-way from authentik, which keeps granting access (R6).
- When a class map entry tightens, sections related to instances of that class move
  to the stricter home (R6). The user's words: "Re-home sections".

## The restrict-only check

One write-time sensitivity check stays. It is independent of the agents that read the
content, for trust and timing. It runs once per section, can only restrict, uses
closed categories, and is a typed decision model with real probabilities, so
uncertainty holds the section higher (R4).

It starts with the nine categories already in code, which an admin can edit. An
uncertain answer holds the section one level higher and flags it. No answer keeps the
section admin-only until it is checked (R11).

A locally served decision model for on-prem is unproven and should be tested in the
first real batch (R4).

## What is removed

| Removed | Ruling |
|---|---|
| Atomic claims | R2 |
| The linker and triage: every record gets a worker instead | R4 |
| The language-model fallback for the sensitivity check | R4 |
| The person gate on classes | R5 |
| The single authority-over-a-class rule | R6 |
| Any migration of the existing graph | R8 |
| Per-row reference nodes and word lists | R3 |
| Audit nodes | R9 |
| One parent per class | R9 |
| The 62-note oracle as the acceptance standard. Its notes stay as test input, and the first real run is judged on filing outcomes and tree quality | R9 |
| The oracle's need ux-t07, which falls away with claims | R11 |

## Open

**The first run's data and models (R11).** Which database the first real-model run
copies, and which models may see that copy (see proposal B). A copy of real records
would reach whichever models run it. The host runs two containers, `mssql-server` and
`tcmautomation`, and neither has been inspected.

## Proposals from the assistant (not rulings)

### A. What happens to `integration` at a26e90b

Read from the code at that commit: each module's exports, function sizes and importers,
not line by line. Sizes are rough line counts.

| Area | Lines | Carries | Changes | Deleted | Main point |
|---|--:|--:|--:|--:|---|
| Identity, positions, scope, sharing, plumbing | 2,000 | 1,900 | 100 | 0 | Read filters must cover classes |
| On/off record and documents | 1,700 | 1,200 | 250 | 250 | Claims leave `ingest.js`; class list leaves the condenser |
| Linker, triage, name rules | 1,300 | 150 | 0 | 1,150 | A few lookups survive |
| Claims and state queries | 850 | 100 | 0 | 750 | Date helpers and open needs survive |
| Grader, floor, re-homing, authority rule | 1,200 | 450 | 350 | 400 | Decision model is re-aimed; re-homing follows class, instances, sections |
| Search, write path, tools, routes | 2,000 | 1,500 | 400 | 100 | |
| Orchestrator and workers | 2,400 | 1,500 | 800 | 100 | Queue and threads carry; worker tools and briefs are rewritten |
| Source writes | 1,050 | 500 | 250 | 300 | `data-entry.js` carries; audit nodes and source references go |
| Discovery | 1,250 | 250 | 600 | 400 | Noun tables and the confirm route go |
| Needs and questions | 900 | 800 | 100 | 0 | |
| Contract (`model/schema.js`) | 200 | 0 | 200 | 0 | |
| **Source total** | **14,850** | **8,350** | **3,050** | **3,450** | |
| Unit tests and replay scenarios | 11,450 | 1,700 | 5,750 | 4,000 | The replay suite is rebuilt around filing |

Not in the table, because it does not exist yet: classes with several parents, the
instance edge, dependency edges and timeline, filing tools and log, each source's
declaration, the typed check per section, the positions mirror, and corrections.
A guess of 2,000 to 3,000 lines plus tests, with less behind it than the table.

More than half of the source carries, but the parts that change decide behaviour, and
everything reviewed in those parts has to be reviewed again.

### B. The smallest version that runs on real models

**It answers:** "basically what i want to see is how well models can handle this" (R5).

**Built:** class nodes with several parents, the instance edge, the orchestrator's class
decisions, a worker that files a record with the four outcomes, the worker's account of
what it did, the orchestrator checking that account against the source (R10), the filing
log, briefs, the typed check, and a discovery run. **Left out:** the web interface, the authentik
sync (test positions are seeded), re-homing, and the continuous briefing agent.

**Input:** the 62 notes as test records (R9), after a discovery run over the test database.

**Test database, source side.** A new SQL Server 2022 container, on its own Docker
network with no published port, holding a restored copy under a new name. Only the test
run points at it.

1. The user, or whoever holds the ERP login, takes a copy-only backup and puts the file
   on the host. No assistant handles that password.
2. A script restores it, then creates a read login and a write login limited to create
   and update on chosen tables.
3. Two new Data API builder containers, one per login, reach only that container.
4. Before starting, the run asks the write connection which server and database it
   holds, and stops unless they are the test names.

**Test database, graph side.** An empty, throwaway ArcadeDB container, as the replay
harness starts today. Neither the development volume nor the demo is touched. Each run
starts from a fresh restore and an empty graph, so runs can be compared.

**How to judge it.** A setup is one choice of orchestrator and worker models. Try at
least two, and run each three times to see variation.

| Measure | How |
|---|---|
| Filing outcomes | Compare the log with an outcome labelled by hand for each piece. Compare the copy with the backup: every changed row must match a Filed entry, and nothing else may change. |
| Tree quality | The user reads a one-page tree: each class, its parents, its evidence, its instance count, marked right, wrong or missing. Also how much of the tree survives across the three runs. |
| Duplicate classes | Name similarity and shared tables suggest pairs; a person confirms them. Reported as a share of all classes, and after a rerun. |
| Wrong placements | A sample of instances under each primitive, and every instance with several classes, checked against the source row. Sections related to the wrong instance are counted the same way. |
| Leaks through briefs | Restricted sections and classes carry unique marker words. Every brief, and everything a worker writes, is scanned for a marker above the record's audience. |
| The typed check | Hosted and locally served decision models on the same sections: agreement, how often each is unsure, and repeat stability (R4). |
| Workers' accounts | How often a worker's account of what it did disagrees with what actually changed in the source, found by comparing the copy with the backup. Also how often the orchestrator's check caught it (R10). |

No pass mark is proposed, since this run is to find out what happens. The exceptions
are zero tolerance: any brief leak, and any source row changed without a Filed entry.

**To answer first:** the one question under [Open](#open).
