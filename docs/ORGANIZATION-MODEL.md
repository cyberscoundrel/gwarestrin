# The organization model

Status: design, 2026-11-05. Nothing below is built. It supersedes the
activity model drafted on 2026-11-04 (which stopped one level too low: it
declared activity types per organization instead of deriving them) and
records the direction settled in discussion, the contract the first piece of
work must produce, how the work is split across sessions, and the decisions
that are still open with the default each session takes until the user says
otherwise. Line numbers are against main at 0e48d84.

The demo instance (tag `demo-2026-11`, compose project `gwdemo`, snapshot on
the host, [DEMO.md](DEMO.md)) is frozen and off limits to all of this work. It
shares no data source with the development instance and stays down until a
demo. Everything here lands in the development instance only.

## Why

Three weeks of graph-worker batches ([GRAPH-WORKER-RELIABILITY.md](GRAPH-WORKER-RELIABILITY.md))
converged on the mechanics (outages, placement, unfinished turns) and did not
converge on the content: which things to mint, what a note is about, how
sensitive it is, whether it changes something already known. Each of those is
answered today by a model reading prose, per note, with no structure to map
onto:

| Question | Answered today by |
|---|---|
| What is this note about? | the linker's open model call per note (`things.js` `mentionsPrompt`) |
| Does it need work; does it change or contradict something? | triage's decision-model call per note (`decisions.js`) |
| Who may see it? | the grader's model call per write (`grading.js`) |
| How long is it true? | the same grader call (`extent.js`) |
| What is the current state of X? | a search, then an agent reading the hits |

The fixes show the cost: things minted for schedules and time clocks, a name
linked to the wrong same-named person for a week, a note about quantities
restricted because it reads like money, hidden titles copied from a master's
brief into floor notes. They are one gap. The graph holds nouns and prose and
knows nothing about the shape of the work the prose describes, so every
reading is a guess, and every input that reaches an agent outside the tracked
read channel (a brief, a pasted message) is a leak waiting to happen.

The input model is the other half of the problem. Every batch seeds sparse,
context-free sentences, and the standing instructions tell every agent to
save pasted text first. That is how injected content and half-thoughts enter
the graph, why the grader has to defend against "this is public" inside a
note, and why the graph fills with nodes that do not earn their place.

## What the graph holds now (as built)

Grounding, from `graph-rag/src/server.js` unless noted. Nothing in this
section changes until a stream below changes it.

- **Entries**: `Entity` vertices keyed by `(name, _origin)`, facet texts and
  embeddings (identity, location, state, temporal, relations, custom),
  `_home`, `_origin`, `_grade`, `_written_by`, `_valid_until`/`_valid_by`,
  `_placed_by`, `_kind` (null = assertion, or need, document, section, task,
  thing), `updated_at`. `written_at` is a write argument, not stored.
- **Things**: entries with `_kind: 'thing'`, a flat `_thing_type` from a
  list of ten, `_alias_norms`, `_keys` (connected-system keys such as
  `mssql:dbo_Customer:TORO`), `_homes`, `embed_thing`.
- **Edges**: `ABOUT` (entry → thing, with `role`), `RELATES` (thing → thing,
  with `rel`, `evidence`, `job`, `at`), `NEAR`/`ALSO` (needs),
  `PART_OF`/`NEXT`/`SOURCED_FROM` (documents, sections, extracted facts;
  `documents.js`).
- **Time**: `_valid_until` only. No valid-from, no event time.
- **Connected systems**: rows are never imported. The survey (`pool.js`
  `surveyBrief`) writes one entry per main table and seeds master-data tables
  as things with keys. Agents get a digest of table and key-column names
  (`packages/server/src/agents/connection-digest.ts`).
- **Visibility**: positions tree, grants, person shares, the derived-data
  floor (`recordReads`, `derivedFloor`, `workerLift`, `workerWriteFloor`),
  grading on closed topics (`policy.restrictedTopics`), proposals where a
  write exceeds the writer's level ([DATA-SCOPING.md](DATA-SCOPING.md)).
- **Triage outcomes**: each decision is a `Triage` row with the verdict's
  probabilities and what the worker then changed. This is the pattern for
  tuning any threshold from outcomes.

## The model

### Four primitives

An organization is a set of **actors** making **commitments** that
**events** fulfil or break, moving **resources** between them. This is as
low as the model goes while a note still maps to a closed question:

- **Actor**: a person, a position, an organization (customer, supplier), or
  an agent acting for one of these.
- **Commitment**: something owed. An order is a commitment to deliver; a
  quote a conditional one; a shift swap, a hire, a maintenance booking, a
  purchase of saw blades, all commitments. A commitment has a party that
  owes, a party owed, what is owed, and when it was made.
- **Event**: something that happened at a point in time. Most events bear on
  a commitment: fulfil it, break it, change its terms, or are an observation
  that matters to it (blades arrived; invoice paid; Tomas was late).
- **Resource**: what changes hands or is consumed: money, parts, machine
  time, a person's time.

"Decision" and "action" are below this level and untyped; a decision is an
event that creates or changes a commitment. Dependency is restricted to
commitment fulfilment ("this cannot be fulfilled until that is"), which is
structural and detectable. General causality is not inferred from text.

The same quartet appears independently in REA accounting, DEMO's transaction
pattern, and event sourcing. The convergence is why the level is trusted.

### Classes and instances

A **class** is a commitment pattern that recurs (every order goes quote, PO,
produce, ship, invoice, pay). An **instance** is one occurrence (job 4471,
the Corvane quote). Classes are the organization's own symbols; the
hierarchy of its people and the schema of its ERP are both made of them.

Classes are **discovered, not declared**. The organization met mid-life
hands over its fossil record: ERP tables are classes that crystallized years
ago, rows are instances, and the notes are the same process still running.
So the model instantiates two ways, from a snapshot (tables → classes,
rows → instances, no history) and from a stream (recorded claims →
commitments and events), and these are the same model at different times.

Discovery is an upfront, agentic cost over the connected systems and a
sample of the corpus, incremental afterwards (a new table, or a recurring
commitment sequence the graph has not seen, is a discovery event, not a
re-run). A discovered class is **confirmed by a person before anything maps
onto it**. A wrong name at this layer poisons every later mapping.

### Authority: the hierarchy read the other way

The positions tree says who sees what. Read the other way it says who may
commit the organization to what: a floor worker can promise a shift swap,
not a price. That is one rule, **authority over a class of commitment**, and
three existing subsystems are special cases of it:

- **Visibility**: a claim is seen by those whose authority covers its class
  (today: positions, grants, the derived floor).
- **Proposals**: an agent proposes when it lacks authority to commit (today:
  `queueWrite` in ~15 places deciding direct-or-propose by level).
- **Grading**: a note is restricted when its content commits or reveals
  above the writer's authority (today: the grader on closed topics).

The policy an admin edits becomes a map from commitment classes and
attributes (pay, dismissal, price, margin) to the position that holds
authority over them. The grader runs only on the residue: free text that
maps to no class.

### Needs are commitments with the sign flipped

A question is a request for an information-delivery event nobody has
promised yet. An unfulfilled need and an open question are one node, and in
a document-first graph the answer is a section that meets it. This part of
the current design (`needs.js`) stays.

### Node admission

A node earns its place when **at least one** holds:

1. it has an identity that outlives any one document (a person, customer,
   machine, instance);
2. it is referenced from more than one place;
3. it is a commitment, decision or judgement that no source system records.

Everything else is content inside a document section or a row behind a key.
A holiday schedule, a bench, a part number inside a job, a topic: attributes
or values on a claim, never nodes. Things are minted by a record key, by a
person, or by a worker's explicit judgement, never by the linker alone.

### Reference, never copy

The ERP is authoritative for rows, so the graph holds no copy of a row: a
**source reference** by key (`mssql:dbo_Job:4471`) and whatever the ERP
cannot hold, which is context, commitments, judgement and provenance. This
extends the DATA-SCOPING principle (the database's login is the boundary;
gwarestrin only decides reachability) to the graph's own contents.

Writes into source systems go the other way through the same authority
rule: direct if the person the agent acts for could do it, proposed
otherwise, through a write-capable DAB instance. The graph **does** hold the
event of such a write (row referenced, who authorized, when), because the
ERP will not record what an agent did to it. The graph becomes the audit
trail of agent actions on source systems.

## Inputs: on record, condensed, per claim

### On record is a deliberate act

Every thread is explicitly on record or off record, chosen by the person
whose agent it is. Off-record content never reaches the graph. On-record
content is recorded under that person's authority: the write carries intent,
the position, and a reason, so most of the defensive machinery around
unattributed writes goes away. The instruction "save pasted text first"
goes with it.

### Condensation changes the input unit, not the storage unit

The conversation's own agent condenses whole sections of an on-record
thread into a **summary document with context**, not atomic sentences. It is
the right condenser: it was in the conversation, acts for a person, knows
what was meant to go on record, and has the confirmed classes in front of it.

The document is stored the way ingested manuals already are
(`documents.js`): a document entry, sections, and **claims** extracted from
each section, `SOURCED_FROM` it and homed no lower than it. A claim is one
of the four primitives bound to an instance, with an interval:

```
claim(kind: commitment|event|state|observation,
      subject: instance or actor, class, attribute, value,
      valid_from, valid_until, recorded_at, recorded_by, section)
```

The atomic claim does not disappear. It stops being what a person types and
becomes what the condenser extracts, once, with full context, rather than
what three cold models (linker, triage, grader) each reconstruct per note.
Everything built for placement, visibility, the derived floor and expiry
keeps working per claim, because a summary mixing a raise, a quote and a
delivery is three claims at three sensitivities, not one blob.

### The worker's job

Reconcile the recorded claims against the source systems and prior state:
resolve instances by key, enter data where it has authority, propose where
it does not, mark a need met when a claim meets it. That is narrower and
better specified than "read this note and work out what it means", and it
is the part that needs an agent. The master's job shrinks to dispatch.

Every input to an agent is a read, including its brief. A brief composed at
the root and handed to a worker homed lower is the leak found in ux-av; under
this model a brief is a read recorded like any other, and its floor applies.

## What each component becomes

| Component | Today | With the model |
|---|---|---|
| Survey (`pool.js` `surveyBrief`) | seeds master data as things, writes patterns | the first discovery pass: drafts classes, stages and record tables from the connected systems for a person to confirm |
| Chat agent (`standing-instructions.ts`) | saves pasted text first | on/off record per thread; condenses on-record sections into documents with claims |
| Linker (`things.js`) | one open call: names and types | resolve by key and by confirmed class first; one closed call for the residue (which instance, which attribute); mint nothing on its own |
| Triage (`decisions.js`) | level, reason, contradiction, candidate | level and reason only; contradiction is two claims on one attribute with overlapping intervals, a query |
| Grader (`grading.js`) | every write | claims that map to no class |
| Policy (`policy.js`) | restricted topics by name | commitment classes and attributes with the position holding authority |
| Proposals (`queueWrite` sites) | per-site level test | one `decideWrite(identity, class, ...)` applying the authority rule |
| Worker | read, judge, link, edit, propose | reconcile claims against sources and prior state; data entry; propose |
| Needs (`needs.js`) | question meets nearby entry by embedding | a question on an attribute is a state query when the state exists; embedding match stays for the rest |
| Search | hits plus `temporal_filter` | adds current state and `as_of` for an instance |
| Documents (`documents.js`) | sections and extracted facts | the storage shape for everything on record; facts become claims with intervals |
| Batches (`~/ux-live` on the host) | sparse notes | on-record conversations that get condensed |

Model calls per recorded section go from three open ones per note to one
condensation by an agent that was present, plus closed calls on the residue.

A consequence to accept: the ux batch suite tests the input model this
rejects. Part of its flaky list (duplicate things, stale facets, grader
wobbles on context-free sentences) is an artifact of that input and should
retire without a fix once batches are conversations.

## The contract (serial step one)

One session produces the contract and nothing else. It is the shared ground
every stream starts from, so it lands before any stream starts.

1. **The sixty-note oracle.** Sixty notes from the ux batches already run
   (the development instance holds 418; the seed scripts are in `~/ux-live`
   on the host), each hand-classified as actor, commitment, event, resource
   or residue, with its instance and class, and its expected claims. If
   every note fits, the primitives hold and discovery is a data problem. If a
   meaningful fraction does not, the residue names the fifth primitive and
   this document changes before anything is built. The oracle is a fixture
   file in the repo and every stream must handle all sixty.
2. **The data contract as code**, in a new `graph-rag/src/model/` with unit
   tests under `graph-rag/test/`, no behavior and no edit to `server.js`:
   - ArcadeDB types and edges for class, instance (a thing with a record
     key and a class), claim (`CLAIMS` edge from a section or entry to its
     subject, carrying kind, class, attribute, value and the interval),
     source reference, audit event (an agent's write to a source system),
     and the on-record marker on a document;
   - the document → section → claim shape as a module that validates and
     normalizes what the condenser emits;
   - the authority rule as a pure function: `(identity, class, attribute) →
     direct | propose | hidden`, over the positions tree and the policy map;
   - fixtures: the oracle's claims, a small confirmed class set, a policy
     map, so every stream tests against the same data.
3. **The five decisions** below, with the defaults confirmed or changed by
   the user, written into this document.

## Serial step two: split `server.js`

`server.js` is 5,320 lines, makes the write-or-propose decision in about
fifteen places, and has no unit tests. Two sessions editing it conflict on
every merge and diverge on semantics. One session cuts it along the areas
already mapped, purely mechanically, no behavior change, gated by the replay
harness (`graph-rag/e2e/e2e.sh`, 22 of 22 today): identity and scope,
search, derived data and placement, write, worker tools, master and handler,
needs, documents, routes and `createServer`. This is what makes exclusive
file ownership possible. It touches nothing in `graph-rag/src/model/`.

Steps one and two are independent of each other and start together.

## The streams (after the contract lands)

Each stream runs in its own worktree session, owns its file set
exclusively, starts from the contract and fixtures, and ships acceptance
scenarios in the replay harness. Cross-cutting needs go through the contract,
never through editing a neighbor's module.

| Stream | Owns | Depends on |
|---|---|---|
| Discovery | survey brief, a discovery module, the admin confirm panel in `packages/web` | contract |
| Condenser | chat-agent on/off record flow, thread → document with claims, the document ingest path | contract |
| Admission and resolution | `things.js` and the linker: mint only by key, person or worker; look up before embedding; source references | contract |
| Authority | `grading.js`, `policy.js`, `placement.js`, proposals: one rule over commitment classes; policy by class | contract |
| Reconciliation and data entry | worker tools, write-capable DAB instance, audit event nodes | authority rule (stubbed until it lands) |
| Queries | current state, `as_of`, needs answered from state | contract; fixtures stand in for claims |
| Test harness | a batch generator producing on-record conversations instead of sparse notes; per-stream scenarios | each stream's acceptance scenarios, written first |

Landing is serial: one integrator merges streams one at a time in dependency
order, runs the harness after each, and bounces anything that drops a
scenario. Every merge gets a review from an agent with no context of the
author's reasoning. Any stream that cannot handle all sixty oracle notes has
not met the contract, whatever its own tests say.

Headcount: one session for the contract, one for the split, seven streams,
one integrator, review subagents per merge.

## Decisions still open

Each has a default. Sessions take the default until the user changes it
here.

1. **Who confirms discovered classes.** Default: a person with admin
   authority confirms in the app; a worker that keeps finding an unconfirmed
   pattern files a proposal naming it, and only a person confirms.
2. **Claims on free text that maps to no class.** Default: store the
   section with no claim (still searchable), run the grader on it, and let
   the condenser propose a class for a person. Never mint a class from one
   occurrence.
3. **Default interval for a state with no dates.** Default: `valid_from =
   recorded_at`, open-ended, closed by the next claim on the same attribute
   of the same instance. The condenser asks the person only when the text
   gives a date range it cannot parse.
4. **Which model answers the closed questions.** Default: a decision model
   (Jev-style, typed output, probabilities, thresholds tuned from `Triage`
   outcomes) for the residue, with the language model as fallback until a
   locally served decision model is proven for the on-prem tier.
5. **Multiple homes per instance** (DATA-SCOPING open question 2). Default:
   unchanged. A claim is seen by whoever sees the section it came from; an
   instance two branches work on has claims in both, each at its own home.
