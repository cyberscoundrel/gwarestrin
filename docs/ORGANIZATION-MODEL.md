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

## The instance rule

Ruled by the user on 2026-11-09: **an instance is an entity that has an
instance relationship to a class.** The relationship is an `INSTANCE_OF` edge
from the entity to a `Class` vertex, and that edge is the only record of what
the entity is: `_class` and `_thing_type` stop being written, and the classes
shown on an instance are read from the edge. Classes are of anything, not only
commitments: they form one tree under the four primitives, each class a subclass
of exactly one parent ("leased building", then "warehouse", then one street
address as an instance). Everything below the four primitives is discovered and
confirmed by a person. No class, no instance: a subject that cannot be related to
a confirmed class is never minted, and stays a value on its claim until a class or
an instance exists for it. That gate replaces every test of how a name reads or
how often it has come up. Who may mint is unchanged: a record key, a person or a
worker.

The contract is under [Classes and instances](#classes-and-instances) and in
`graph-rag/src/model/schema.js`. As of 2026-11-09 only the contract exists; the
writers and readers have not moved. What the rule assumes is in [Decisions
still open](#decisions-still-open), 6 to 19, and what it does to the open review
findings is in [What the rule changes in the
review](#what-the-rule-changes-in-the-review).

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

In the user's words, on 2026-11-04:

> over time as the actions satisfy the needs of the organization classes of
> things crystalize, there might be employees and contractors and volunteers,
> there might be software or capital resources they have relationships to,
> instances of these classes would be individual employees or individual
> company owned vehicles or individual software resources, relationships
> between instances and classes form the hierarchical structure of an
> organization while classes represent the relevant internal symbols

and that agents "create the necessary nodes in the graph and their
relationships to classes and instances".

A **class** is a kind of thing the organization recognizes, of anything: a
pattern of commitment that recurs, a kind of worker, software, a capital asset,
a kind of building. Classes are the organization's internal symbols. An
**instance** is one of them, an entity with an `INSTANCE_OF` edge to its class.
Classes form a tree: "leased building" is a class, "warehouse" is a subclass of
it, and one street-address location is an instance of warehouse. Relationships
between instances and classes are the hierarchical structure of the
organization, and the four primitives are the roots of the tree.

Classes are **discovered, not declared**. The organization met mid-life
hands over its fossil record: ERP tables are classes that crystallized years
ago, rows are instances, and the notes are the same process still running.
So the model instantiates two ways, from a snapshot (tables → classes,
rows → instances, no history) and from a stream (recorded claims →
commitments and events), and these are the same model at different times.

Discovery is an upfront, agentic cost over the connected systems and a
sample of the corpus, incremental afterwards (a new table, or a recurring
pattern the graph has not seen, is a discovery event, not a re-run). A
discovered class is **confirmed by a person before anything maps onto it**. A
wrong name at this layer poisons every later mapping.

**The class vertex** (`Class`, in `schema.js`) replaces `CommitmentClass` and
the flat lists `ACTOR_TYPES` and `THING_TYPES`. Every class has a unique `name`,
a `status` (proposed, confirmed or retired), a `record_table` (`system:table`,
or null when no source system records it), and optional `stages` and
`attributes`. What primitive a class belongs to is the root it sits under, read
from the tree (`schema.primitiveOf`) and never stored, so moving a class cannot
leave it disagreeing.

**The tree** (`SUBCLASS_OF`, from a class to its parent):

- The four primitives are the only built-in roots. They exist from the start,
  are confirmed by nobody (`confirmed_by` is `built-in`), have no parent, and hold
  no instances directly. Everything under them is discovered and confirmed by a
  person, including each subclass link.
- Every other class has exactly one confirmed parent. A link has its own
  `status`. A move is a `proposed` link that a person's confirmation swaps for the
  confirmed one, in one transaction. A unique index on `(child, status)` holds a
  class to one confirmed parent and one proposed one.
- A tree is confirmed from the top: a link needs a confirmed parent
  (`schema.assertSubclassLink`). A class whose chain doesn't reach a root through
  confirmed classes is not in the tree, whatever its own status says, so a cycle or
  a dangling parent makes nothing an instance. Cycles are refused at the link, and
  `SUBCLASS_OF` has no way to express two parents.
- A class with confirmed subclasses cannot be retired until they are moved.

Read the link through its edge, `outE('SUBCLASS_OF')[status = 'confirmed'].inV()`:
`out('SUBCLASS_OF')[status = 'confirmed']` filters on the class's own status, and
returned the wrong parent when tried on ArcadeDB.

**Inheritance.** A rule, stage list or attribute on a class applies to its
subclasses and their instances, and the nearest class up the chain wins
(`classChain`, `effectiveStages`, `effectiveAttributes`, `effectiveRecordTable`):
a subclass with no stage list takes the nearest one, and with no record table
shares its parent's. A `stage` claim needs a stage list in force; a class with none
up its chain takes no `stage` claim. A query on a class includes the instances of
its subclasses (`classAndSubclasses`), by
`out('INSTANCE_OF')[status = 'confirmed'].name CONTAINSANY :names`. Authority is
under [the authority section](#authority-the-hierarchy-read-the-other-way).

**The edge** (`INSTANCE_OF`) runs from the entity to a class:

- An entity may have several, one per class. Taking the subclass implies the
  parent, so an instance points at the most specific class that fits it.
- A unique index on `(instance, class_rid)` holds it to one edge per class.
- A mint writes the entity and its first edge in one transaction and takes the
  rid from what it created. It never looks the entity up afterwards by name.
- Nothing stores a class name beside it. `_kind: 'thing'` stays as what kind of
  row the vertex is, but it is not what makes the row an instance: an entity with
  no edge is not one. A confirm that renames a draft cannot strand anything, because
  the edge holds the vertex and not the name.
- A class in `confirmed` or `retired` makes an instance. A retired class admits
  no new one and takes none away. An edge to a `proposed` class is **held**: see
  the migration below.

**The gate** (`schema.instanceClass`). Resolving a subject keeps the order
`resolve.js` has now: key, class and name, alias, embedding last, only against
what the reader's home can see and only among instances. If that finds one, the
subject is related to a class already and nothing else is asked. If it finds
none, the gate decides whether one could exist, from the subject and the confirmed
classes alone:

1. A key belongs to the confirmed class whose record table holds it, or to the
   subclass of it the subject names. The record table is the only thing that gives
   a key a class.
2. A class stated for the subject itself, if it is confirmed and is not a
   primitive. A class with a record table in force needs the row: a name alone
   comes back `no-row` (PO 78912).
3. Anything else comes back `no-class`.

A claim's `class` is what the claim bears on and is not the subject's class: a
pay claim about Tomas is `hires`/`pay`, and Tomas is whatever a person confirmed
employees to be. Nothing defaults one from the other, so a bare name on a claim
of a confirmed class is not an instance of that class. Who may mint is a separate
question, unchanged: a key mints on its own; a name needs a person or a worker;
the linker alone mints nothing but by key. A document on the record path acts for
the person who put it on record.

**A person mentioned before any class is confirmed** is a value on the claim,
like anything else with no class: the section is stored and searchable, the claim
keeps the name, and no node is made. Nobody is exempt, since there is no built-in
"person". Once a person confirms a class those claims can move to, they move.

**A claim whose subject is not an instance** stays a value on that claim. The
edge points back at its section, as today, and carries `subject` (JSON, as
written, including any class it stated), `subject_norm`, and `unresolved`:
`no-class`, `no-row` or `ambiguous`. A subject class that isn't confirmed doesn't
refuse the document; it is what makes the subject a value. Search finds it and a
worker can settle it, but nothing is minted.

- When a person confirms a class, the claims that stated it mint their instance
  in that step (decision 17), one per name, and move to it.
- When an instance comes to exist any other way, the claims waiting under its
  name move to it, on three conditions: an exact name or alias match, exactly one
  instance of that name visible from the claim's own `_home`, and the instance's
  classes include the one the claim stated, if it stated one.
- `ambiguous` claims stay for a person or a worker.
- A subject that is the class itself (`scope: "class"`) has its claim point at
  the `Class` vertex, and no placeholder is minted for it.

**How a survey proposes classes and subclasses.** The first survey maps the
connection and drafts; it seeds nothing, and `resolve_subject` refuses a row whose
table has no confirmed class, saying so. Each draft says what it is and where it
goes:

- A table is a draft class with that table as its record table. Transaction
  tables go under `commitment`; `discovery.js`'s master nouns go under `actor` or
  `resource` by the role it already assigns; the master-noun rule against drafting
  a class goes.
- A parent other than a root is proposed when the data shows one: a table whose
  key is another table's key (`dbo_Contractor` on `dbo_Employee`) is a subclass of
  it; tables that are obviously kinds of one thing get a drafted parent with no
  table (employees, contractors and volunteers under people); a column that sorts
  a table's rows into kinds (`CustomerType`) yields drafts with no table, under the
  table's class.
- The survey reports these as a `[subclass: warehouse of leased_building; because:
  ...]` tag, and `propose_class` takes `parent` and the reason. Discovery's
  deterministic pass only ever proposes a root as parent; anything deeper needs a
  survey's or a worker's reason.
- A person confirms each class and each link, parents first, and can move a class
  as they confirm it. After that the admin starts a survey with a focus on the
  tables worth seeding. A row left unseeded is minted from its key the first time a
  record names it, as today.

**Visibility.** Neither edge has a home and neither confers one.

- An instance is seen exactly as it is now, by `_homes`.
- From a class to its instances, a read returns only the instances the reader
  sees, and a query covering subclasses filters every one the same way.
- From an instance to its classes, a read gives only the classes that pass
  `authority.visible` for the reader. A hidden class is therefore not disclosed by a
  visible instance. An instance of a class with an authority rule is named
  `label (instance)` at mint so the class doesn't travel in the `name` column.
- Class vertices have no `_homes`, and nothing adds one.
- Re-homing changes `_home`/`_homes` as it does now and doesn't touch the edge.
- The gate takes the subject and the class list and looks no instance up, so it
  cannot say a hidden instance exists.
- The class list stays as it is today, readable by anyone authenticated
  (decision 15).

**Migration** (`schema.planInstanceMigration`), at boot, idempotent, on a
development graph. In order: the DDL (`statements()`), the roots
(`rootClassStatements()`), then the plan over every `_kind = 'thing'` row and every
`CommitmentClass` row:

1. `CommitmentClass` rows are copied to `Class`, status kept, under `commitment`.
   Their link is confirmed because a person confirmed them as commitments.
2. Each thing with no edge gets one to the first of: the class whose record
   table holds one of its keys; a `_thing_type` that was an actor type; `_class` if
   it has a key; any other `_thing_type`; `_class`. `_class` comes low because it
   was stamped from a claim's class: Tomas stamped `hires` is not a hire, and a
   machine a worker made under a job claim is a machine.
3. A name in that list with no class gets a `proposed` class under the root that
   fits it. The migration never confirms anything, so an edge to it is held.
4. A `_thing_type` of `class` is a placeholder for class-scope claims: its claims
   move to the `Class` vertex and it gets no edge.
5. A thing with nothing to go on is left, and listed for a person.

With no built-ins, this means every person and customer on a development graph is
held until someone confirms a class for them. A held entity keeps its row, claims
and `ABOUT` edges, shows no class and is not a resolution candidate. When a person
confirms the class it becomes an instance, with no write to the entity. The `_class`
and `_thing_type` columns are left in place and unread. The plan reports every signal
it discarded.

**Where the oracle's flat labels go** (the implementation's job). The oracle's 50
class labels get a place in the tree in a fixture, each with a snake_case name the
real confirm route accepts and a parent, and the batch's classes go through that
route, parents first. Labels that are kinds of one another nest: `sample order`
under `customer order`, `service quote` and `supplier quote` under `quote`; the
rest go under a root or a shared parent. A label seen in one note stays a draft, as
decision 2 and the one-occurrence rule say, so those notes are stored with no claim.
Each expected subject states its class or its key, and a bare name is expected to
stay a value. The bar is restated in those terms.

**Other places this document still narrows classes** (listed, not changed):

- "Four primitives": a resource is "what changes hands or is consumed", which
  leaves out a company-owned vehicle, a building or software, all of which the user
  named.
- The components table's Policy row ("commitment classes and attributes"), and the
  Authority stream ("one rule over commitment classes").
- `claims.js`'s error text, "a claim about an actor must name the commitment class
  it bears on".
- The survey brief and `discovery.js` wording ("Draft the commitment classes",
  "seeded as things"), which the implementation changes.
- The hierarchy of people as classes: decision 19.

### Authority: the hierarchy read the other way

The positions tree says who sees what. Read the other way it says who may
commit the organization to what: a floor worker can promise a shift swap,
not a price. That is one rule, **authority over a class**, and three existing
subsystems are special cases of it:

- **Visibility**: a claim is seen by those whose authority covers its class
  (today: positions, grants, the derived floor).
- **Proposals**: an agent proposes when it lacks authority to commit (today:
  `queueWrite` in ~15 places deciding direct-or-propose by level).
- **Grading**: a note is restricted when its content commits or reveals
  above the writer's authority (today: the grader on closed topics).

The policy an admin edits becomes a map from classes and attributes (pay, dismissal, price, margin) to the position that holds
authority over them. The grader runs only on the residue: free text that
maps to no class.

**Against the class tree.** A rule on a class applies to its subclasses and
their instances. The map stays keyed by class name; `authorityOf` walks the chain
(`schema.authorityInChain`), the most specific rule first and the nearest class
winning on each level: an attribute rule on the class or any ancestor, then
`policy.attributes`, then a class-wide authority on the class or any ancestor,
then `policy.default`. An attribute rule high up beats a class-wide rule lower
down, so a rule on a parent can't be undone by accident beneath it.

`decide(identity, class, attribute, policy, positions)` applies that to the
claim's class and to every class of its subject instance, and takes the strictest
(`positions.commonAncestor`): a claim on an instance under several classes is held
to the strictest of them. Visibility is the same reading.

A class moved to a new parent takes the new chain at once, because `decide` reads
it live. The structured reads follow immediately. What was stored does not:
`_home` on existing claims and sections was set at write and is never lowered, so
a move under a looser parent widens nothing. A move under a stricter parent is
tightening, and its section-text residual is B6's, not decided here. The confirm
route reports how many instances and claims a move affects before a person accepts
it.

### Needs are commitments with the sign flipped

A question is a request for an information-delivery event nobody has
promised yet. An unfulfilled need and an open question are one node, and in
a document-first graph the answer is a section that meets it. This part of
the current design (`needs.js`) stays.

### Node admission

A node earns its place by being an instance of a confirmed class (the gate
above), and every class below the four primitives was confirmed by a person. Nothing about its name or how often it is mentioned earns it one: the
three-rule test that was here, the second-mention rule included, is gone, along
with the head-noun lists that patched it.

Everything else is content inside a document section or a row behind a key.
A holiday schedule, a bench, a part number inside a job, a topic: attributes
or values on a claim, unless a person has confirmed a class they are instances
of. Things are minted by a record key, by a person, or by a worker's explicit
judgement, never by the linker alone.

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
      subject: instance, class, or a value when it is neither,
      class, attribute, value,
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
| Survey (`pool.js` `surveyBrief`) | seeds master data as things, writes patterns | the first discovery pass: drafts a class for every transaction and master-data table, and subclasses where the data shows them, for a person to confirm; seeds nothing until they have |
| Chat agent (`standing-instructions.ts`) | saves pasted text first | on/off record per thread; condenses on-record sections into documents with claims |
| Linker (`things.js`) | one open call: names and types | resolve by key and by confirmed class first; one closed call for the residue (which instance, which attribute); mint nothing on its own; the gate decides what could be an instance |
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
   - ArcadeDB types and edges for class, instance (an entity with an
     `INSTANCE_OF` edge to its class, and a record key when a source system
     holds it), claim (`CLAIMS` edge from a section or entry to its
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

## What the rule changes in the review

Against `~/reviews/integration-2a1a12f.md`. "Closes" means the rule removes the
route; the implementation still has to prove it with a test.

| Finding | What the rule does | What is left |
|---|---|---|
| **NB4** first mentions have no thing | Mostly closes. A subject with a confirmed class mints on its first mention, so counting mentions is gone. A waiting claim moves when its class is confirmed or its instance appears. | A subject with no class still waits, and `poolSize: 0` still means no worker runs. With no built-in classes that now includes every person until someone confirms a class for them (decision 8). Rack C1 needs a confirmed rack class and both notes stating it. |
| **B14** second mention mints | Closes. The second-mention rule is deleted, so "holiday schedule" has no route to a node without a confirmed class it belongs to. The head-noun lists on `claude/fix-resolve-734b26` are deleted with it if they land first. | Nothing structural. If a person confirms a `notices` class, a notice is an instance, by that person's decision. |
| **B17** PO 78912 | Name route closes: a class with a record table in force needs the key, so `record_document` by name is `no-row`, including under a subclass that shares its parent's table. | Key route is unchanged: a key in a bound table still mints with no row check. That is decision 14. B19's remainder is the same thing. |
| **B24** class drafting | The contradiction is settled: Discovery's master-noun rule gives way. All 16 claims' classes (`customer` 4, `work center` 8, `equipment` 3, `customer contact` 1) are drafted under `actor` or `resource`. There is no built-in shortcut, so each needs a person's confirmation like any other. | The 34 claims in 32 one-note classes are unchanged: decision 2 stores those sections with no claim. "The oracle's 100 claims" stops being the number; the oracle and the 62-note bar get restated against the rule when the writers move. |
| **B16** class route | Closes. `_class` stamps are gone and a claim's class never marks a person, so nothing distinguishes one Diep C from another except a key. Both are then `ambiguous`. | None. |
| **NB2** read-back binds a hidden thing | The read-back goes: a mint takes the rid it created. | Whether a floor mint beside a hidden same-named thing is right stays with B9's name scoping. |
| **B22** raw UPSERT classes | Closes when the batch's classes go through the real confirm route, as this requires. | The rest of B22 is unaffected. |

**B8, B9**: the edge is a new route to the same harm, covered by the visibility
rules above. Their existing remainders are unchanged. **B6** is unaffected, and
tightening a class's authority rule is forward-only for the `name` column too.

## Decisions still open

Each has a default. Sessions take the default until the user changes it
here. Decisions 6 to 10 are the assumptions the rule was specified under, with
8 as the user corrected it; 11 to 19 arose in writing it.

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
6. **The relationship is a real edge and the only source of truth.** Default:
   `INSTANCE_OF` from the entity to the `Class` vertex; `_class` stops being
   written; anything that needs a class name reads the edge.
7. **It applies to every instance.** Default: yes. One `Class` vertex type, in one
   tree; `CommitmentClass` generalizes into it; `ACTOR_TYPES` and `THING_TYPES`
   go.
8. **The four primitives are the only built-in classes.** Default: yes, as the
   user corrected on 2026-11-09, and an earlier assumption that person and customer
   would be built in is withdrawn. Until a person confirms a class for people, every
   person named is a value on a claim, including on a development graph after the
   migration (decision 16).
9. **Discovery drafts classes for master-data tables.** Default: yes, since rows
   there are instances too.
10. **No class, no instance.** Default: the gate replaces name-based admission,
    and what it makes redundant is deleted: the second-mention rule, and
    `NEVER_HEADS`, `TOPIC_HEADS` and `RECORD_WORDS` if they land. Who may mint is
    unchanged.
11. **One parent per class.** Default: exactly one confirmed parent, held by the
    database. An assumption: a class that is naturally a kind of two things takes
    one parent and is related to the other by what its instances are.
12. **An instance may have several classes.** Default: yes, one edge per class,
    with a class's name shown only to readers who pass for that class, and the
    strictest authority applying to its claims. Taking a subclass implies its
    ancestors, so one edge usually does.
13. **A subject's class must be stated for the subject.** Default: yes. A claim's
    class never stands in for it, so a bare name on a claim of a confirmed class
    stays a value until an instance of that name exists. The condenser has to
    state a subject's class, and the oracle's 63 name-only claims need restating.
    The alternative, defaulting to the claim's class, mints Tomas Reyes as an
    instance of `training`.
14. **A row check when a key mints.** Default: yes in the implementation, where a
    source is reachable, because the class gate does not stop a phantom key in a
    bound table (B17, B19). A source that cannot be reached leaves the claim a
    value instead of minting, matching how a key miss fails closed (B15).
15. **Whether the confirmed class list is itself restricted.** Default: unchanged,
    readable by anyone authenticated. The edge hides a class from a reader who
    cannot see it on an instance; the list still names every class.
16. **Things held by the migration.** Default: a thing whose class is unconfirmed
    keeps its row but shows no class and is not resolved to until a person
    confirms that class. The alternatives are to confirm classes in the migration,
    which breaks "only a person confirms", or to delete those things.
17. **Confirming a class mints the instances its waiting claims stated.** Default:
    yes, one per name, because each such claim was already put on record by a person
    who named that class. The alternative leaves them values until a worker or a
    person mints each one.
18. **Stages on any class.** Default: stages are optional on every class,
    commitment or not, and a `stage` claim needs a list in force up the chain. The
    confirm route's "a class has at least one stage" goes.
19. **Whether positions become classes.** The design says the hierarchy of people
    is made of classes and the user said instance-class relationships form the
    organization's hierarchy; today's positions tree in authentik is separate.
    Default: nothing is restructured. Position vertices can mirror the tree as
    classes under `actor`, with people as instances, while authentik stays what
    grants access, and that is the recommended next step because it makes the model
    true without moving authorization. Making them the source of authorization would
    change visibility in three ways: `_homes` would hold class names and a reader's
    positions would be read from edges instead of the token, so authorization would
    depend on the graph being up; a person holding two positions would already be
    the multi-class case and the tree walk would be `classChain`; and a
    confirmed-link write would change who sees what, so only an admin could make
    one, and a moved position would be subject to the same forward-only rule as a
    moved class.
