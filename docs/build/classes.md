# Classes and discovery: phase 0 plan

The classes-and-discovery stream's reading of the rulings (`~/reviews/design-rulings.md`,
R1 to R11) against the code on `build-base` at 5c6626a, before any code is written. The
file map in `docs/BUILD.md`, when it lands, overrides the file names here.

Read: the rulings, the user's messages (`~/reviews/user-messages.md`),
`docs/ORGANIZATION-MODEL.md`, and in code `graph-rag/src/discovery.js`,
`routes-discovery.js`, `pool.js` (`surveyBrief`), `model/` (schema, claims, authority,
README), `scope.js` and `positions.js` (read only), `packages/server/src/agents/connection-digest.ts`,
and where they are called from (`worker-pool.js` `draftFromSurvey`, `routes.js`
`/api/worker/survey`, `server.js` tool registration, `scaffold.ts` read-only tools).

Items marked **NEEDS A RULING** are choices the rulings don't make. For each one I name
the smallest reversible option I will build unless someone rules otherwise, and the code
will carry the same mark.

## What the current code does

- `discovery.js` reads a connection digest. It sorts tables into "class", "master" or
  "lookup" with three word lists (`TRANSACTION_NOUNS`, `MASTER_NOUNS`, `LOOKUP_RE`),
  drafts one `proposed` CommitmentClass per transaction table, pluralizes names, and maps
  record keys only to `confirmed` classes.
- `routes-discovery.js` stores drafts as `CommitmentClass` vertices (a separate type, not
  scoped by home). Its routes let a person confirm, rename or retire a draft. Its
  `propose_class` tool is registered for workers and for a person's chat agent, and a
  class needs two sections before it can be confirmed.
- `surveyBrief` sends a worker thread over one connection. The thread seeds master data
  as things, and its report's table lines and `[class: …]` tags become drafts.
- `connection-digest.ts` gives an agent each connection's table names and some column
  names, never row values. `readToolsFrom` limits graph agents to the read-only tools on
  every connection except the graph.

## What carries

| Code | Why it carries | Ruling |
|---|---|---|
| `schema.parseTable`, `parseKey`, `recordKey` (`system:table:row`) | Classes point at their table and instances refer back by key | R3 |
| `connection-digest.ts` (digest, `readToolsFrom`, `readTools`) | Discovery reads connected systems; read-only toward sources is enforced by tool lists, and graph agents already get only read tools on every connection | R11.3, R8 |
| `discovery.parseDigest`, `stageName` | Reading the digest; turning a status column's distinct values into stage names | R11.14 (optional stages) |
| The "a retired class is not drafted again" checks in `discoverIncremental` | Become the correction check | R11.10 |
| "A new table since the last pass" (`discoverIncremental` with `table`) | New tables count as discovery | R9 |
| `positions.commonAncestor`, `effectiveHome`, `visibleHomes` | "Strictest home" is the common ancestor; unknown homes fail upward to the root | R11.9, R9 |
| `scope.homeFilter`, including the `_homes` clause for things | Covers classes once classes are `Entity` rows with `_home`. The `_homes` clause already says "an instance is seen wherever a statement about it is" | R11.8, earlier ruling (classes scoped by home) |
| `createTask`, and the task thread as the unit of a discovery part | Workers the orchestrator starts for parts of discovery | R11.3 |

## What changes

| Now | Becomes | Ruling |
|---|---|---|
| `CommitmentClass`, a separate vertex type, not scoped | A class is an `Entity` with `_kind: 'class'` and a `_home`, so every read filter that covers entities covers classes. It holds name, description, evidence, `rows_become_nodes`, `source_table`, and optional `stages`. Parents are edges | Earlier ruling, R11.14 |
| One class per transaction table, chosen by word lists | The orchestrator decides classes and subclasses from what it reads. The code holds no word lists and no table-kind sorting | R3, R5, R7 |
| `proposed` / `confirmed` / `retired`; nothing maps until a person confirms | No person gate. A class is live when the orchestrator creates it. The one remaining status is retired, kept as a correction | R5, R11.10 |
| Plural snake_case names (`purchase_orders`) | The name as the orchestrator gives it ("leased building", "warehouse"), trimmed and length-checked | R5 (the user's own example) |
| `propose_class` for workers and chat agents | Removed from chat agents and from the condenser's instructions. A worker that finds no fitting class *requests* one from the orchestrator (an orchestrator signal) and does not resolve that piece | R5, R10 |
| `confirmClass` / `retireClass` routes | Admin correction routes. A correction is stored, and every later run checks it | R11.10 |
| `surveyBrief`: a worker per connection that seeds master data and drafts | The discovery brief for the orchestrator. It has read tools only on sources, starts on an empty graph, seeds only what organizational structure needs, decides classes, and starts workers for parts | R11.3, R3, R8 |
| `draftFromSurvey` parses the report's tags into drafts | Removed. The orchestrator's class decisions are tool calls, and the code sets the home | R5, R11.9 |
| The two-sections count before a class can be confirmed (`occurrences`) | Removed. The orchestrator judges recurrence, with no fixed number | R11.4 |
| `attributes`, `reasons` on the class | `attributes` goes, because other attributes stay in the source. `reasons` becomes `evidence` | R11.14 |
| `classFor(key)`: confirmed classes only | Any class that isn't retired, visible to the caller | R5 |

## What is removed

The word lists and `classifyTable`, `draftClasses`, `patternClasses` and the `[class: …]`
tag grammar, `makeDraft`, `fileDraftSql` with its string-built SQL (parameterized queries
take its place), `reportDigest`, `countOccurrence`, the confirm route, and chat-agent
`propose_class` (R3, R5). The contract session removes what the rulings remove across the
repository. Of this list I own only what sits in my files.

Outside my files, these still call what goes and need their owners' attention:
`packages/web/src/components/ClassConfirmPanel.svelte` and the proxies in
`packages/server/src/http/knowledge.ts` (the web panels are out of scope for the first
run), the class instruction at `packages/server/src/agents/condenser.ts:113` (R5), and
`confirmedClasses` in `ingest.js`, `resolve.js` and `linker.js` (R4 removes the linker).

## What is new

1. **Seed** (R1, R11.14, R3). Four root classes, `agent`, `commitment`, `event` and
   `resource`, and `decision` and `action` with parent `event`. Seeding is idempotent and
   creates nothing else. Every other class must reach a root through its parents.
2. **Several parents** (R9). A `SUBCLASS_OF` edge from a class to each parent. Cycles are
   refused. `stages` are allowed only on a class with `commitment` among its ancestors
   (R11.14).
3. **Home from evidence, computed in code** (R11.9). Each evidence item is `{ kind:
   table | notes | section, ref, home }`. For a table, the home is the home of the
   connection that reads it. For a group of notes, it is the strictest home among them.
   The class's home is computed from its evidence groups. The model never chooses it.
4. **Instances** (R1, R3). An `INSTANCE_OF` edge from an instance (a `thing`, keyed
   `system:table:row` when it has a row) to a class. An instance may have several classes.
   Creating an instance of a class whose rows don't become nodes is refused unless the
   graph must hold something the source can't (see the needs-a-ruling list).
5. **Dependency edges** (R1, R11.8). `DEPENDS_ON` from one instance to another, with
   `stated_by` (a person, a record or an agent), `stated_kind`, `stated_at` and optional
   `valid_from` / `valid_until`. Every read that returns one checks that the caller sees
   both ends.
6. **Timeline** (R1). A pure function that orders instances by their times and their
   dependency edges, over what the caller sees. (Whose file the query lives in is for
   BUILD.md.)
7. **Class tree for a brief** (R7). `classTreeFor(scope)` returns the classes the audience
   sees, with their parents and settings. The filing stream's briefs call it, and nothing
   above the audience is in it.
8. **Discovery role, read-only by tools** (R11.3, R8). The graph MCP server registers
   only read tools, the class tools and the instance tools for a discovery token. It has
   no `enter_data`, no record or ingest tools and no raw writes. On the server side, the
   orchestrator's agent gets only the read tools of every connection (the existing
   `readToolsFrom`). Workers the orchestrator starts for parts of discovery get the same
   read-only source tools and may create instances. They request classes and never create
   one (R7, R10).
9. **History** (R8). A read tool over the old development notes, each note with its
   home. It serves notes as evidence and files nothing as a record.
10. **Corrections** (R11.10). The stored corrections are rename, re-parent, retire,
    re-home, the rows-become-nodes setting, and removing an instance from a class. They
    are entered through admin routes. Every create and update path checks them, so a
    rerun neither overwrites a corrected field nor brings back a retired class or a
    removed relation.
11. **Reruns and new tables** (R9). A run tag on everything a run writes, and a diff of the
    digest against the tables each earlier run examined.
12. **Tree report** (R5). A plain one-page listing of each class with its parents,
    evidence, home and instance count, for the user to mark when judging tree quality on
    real models.

## Tests

Each behaviour gets a unit test in `graph-rag/test/` that fails before the change and
passes after it. Each also gets an e2e scenario in `graph-rag/e2e/scenarios-discovery.mjs`,
rewritten. The fake orchestrator in the scenarios reads the digest through its tools and
creates a class for whatever it finds, with no names scripted in. The assertions are on
what the code enforces, never on the names the fake chose:

- the home of each class is computed from its evidence;
- a discovery token has no write tool on any source, and a write attempt is refused;
- a retired class stays retired across a rerun;
- a dependency edge is hidden from someone who sees only one end;
- a brief's class tree holds nothing above its audience;
- a chat agent token has no class tools.

## Unclear in the rulings

1. **NEEDS A RULING: what "read tools only" covers (R11.3).** Discovery must still build
   the graph: "discovery builds from the connected systems" (R8), "builds unattended if
   read-only" (earlier). I read it as read-only toward every source and the history, with
   graph writes limited to the class tree and instances through dedicated tools, and every
   write tagged with the run so that a run can be undone whole. The literal alternative
   gives the orchestrator no graph-writing tool at all: it emits its decisions as a typed
   report, and code applies the report after the run.
2. **NEEDS A RULING: where a connection's home comes from (R11.9).** No connection
   carries a home today. Option: a `home` field on the connection's registry entry (a
   position id). A connection without one counts as the root, failing upward as
   `effectiveHome` does.
3. **NEEDS A RULING: "wider only if wider evidence independently supports it" when
   evidence homes sit on different branches (R11.9).** Option: each table, and each group
   of notes cited together, is one independent group. If the group homes lie on one chain,
   the widest one (the deepest position, or `everyone`) wins. If they lie on different
   branches, neither is wider, and their common ancestor wins.
4. **NEEDS A RULING: what "the strictest rule wins" applies to across several parents
   (R9).** Option: a class's effective home is the strictest of its own home and every
   ancestor's, so a class is never seen where its parent is not, and no edge in the tree
   points at something hidden. The rows-become-nodes setting is the class's own and is
   not inherited. When a class has no class-map entry, the strictest entry among its
   ancestors applies; the filing stream would call this function.
5. **NEEDS A RULING: the home of the seeded roots (R1, R3).** Option: `everyone`. The roots
   are the words of the design itself and say nothing about the organization, and every
   brief's class tree needs them. The alternative is the root position (fail upward), but
   then a non-root audience sees classes whose parents it can't see.
6. **NEEDS A RULING: where an instance created by discovery is visible (R11.8).** "An
   instance is visible wherever a section about it is", but on an empty graph, an instance
   seeded from a table has no section yet. Option: it is visible from its evidence home
   (the connection's), plus wherever sections about it are, through the existing `_homes`.
7. **NEEDS A RULING: when a row of a class whose rows don't become nodes may get a node
   (R3).** "For example a dependency": a dependency is one case among others. Option: the
   dependency tool creates the row's node by key automatically, and a direct create needs
   a stated `reason` of what the graph must hold.
8. **NEEDS A RULING: what the times on a dependency edge mean (R1).** Option: `stated_at`
   required; `valid_from` / `valid_until` optional, for when the dependency held.
9. **NEEDS A RULING: how class names are unique when classes are scoped (earlier ruling,
   R5).** A global unique name would leak a hidden class's existence through a
   name-taken error. Option: classes are identified by id, names are unique per home, and
   the orchestrator, which sees everything, avoids duplicates; duplicates are measured
   (proposal B), not prevented.
10. **NEEDS A RULING: the AI agents as instances (R1).** Option: one instance under `agent`
    for the orchestrator and one per agent profile (the Graph worker profile), not one
    per thread, since threads don't last. No "AI agent" subclass is seeded; making one is
    the orchestrator's decision.
11. **NEEDS A RULING: how discovery reaches the old development notes (R8).** The rulings
    say they are read-only history, and that the development volume is snapshotted only
    when the user says so. Option: a history source read from a file of notes, each with
    its home, mounted into graph-rag. Tests use the 62 oracle notes with homes (R9). Who
    produces the real file, and from which snapshot, is the user's to say. Nothing in this
    stream touches the development volume.
12. **NEEDS A RULING: how a person "tells the orchestrator" a correction (R11.10).** No
    channel exists from a person to the orchestrator. Option for the first run: the admin
    routes only. The orchestrator's channel waits for a ruling, along with the web panels.
13. **NEEDS A RULING: how a rerun recognizes "the same class" (R11.10).** Option: by its
    normalized name, or by its source table, against retired and corrected classes.
14. **NEEDS A RULING: how discovery work is split among workers.** R11.3 says workers do
    parts; R11.6 splits a record by home. Option: discovery workers are split by evidence
    home too, one worker per connection home or per notes home, each briefed only with
    what that home sees (R7).
15. **NEEDS A RULING: what "examined" means for new-table discovery (R9).** A table the
    orchestrator read and judged not a class would look new on every run. Option: each run
    records the tables it examined on its task entry, and the diff is against those.
16. **Boundaries to confirm in BUILD.md:** I take it that the filing stream owns the
    worker's request-a-class tool and the briefs, the record stream owns sections and the
    timeline query, and I provide the class-tree, instance and dependency functions they
    call. I will follow BUILD.md where it says otherwise.

## Found while reading (not mine to fix)

- `routes.js` `/api/worker/survey` passes `audience` as `surveyBrief`'s third argument,
  which `surveyBrief` ignores. This goes away when the brief is rewritten.

## Phase 1: as built (on the contract at ba583bc)

`docs/BUILD.md` assigns this stream `src/discovery.js`, `src/instances.js` and `src/model/classes.js`, and
reserves `src/classes.js`, `src/routes-classes.js`, `test/classes.test.js` and `e2e/scenarios-classes.mjs` for
it.

| Ruling | Built | Where |
|---|---|---|
| R1, R11.14 | The four roots, plus decision and action under event, are seeded on an empty graph | `model/classes.js seedClasses`, `classes.js allClasses` |
| R1 | The instance edge (INSTANCE_OF) and dependency edges (DEPENDS_ON) with their times; a timeline from times plus dependency, as a pure function | `instances.js`, `model/classes.js timeline` |
| R11.8 | A dependency edge is returned only when the reader sees both ends | `instances.js readDependencies` |
| R11.9 | A class's home is computed from its evidence and is never an argument | `model/classes.js homeFromEvidence`, `classes.js createClass` |
| R9 | Several parents; the strictest home wins down the tree, and homes are settled again after every change | `model/classes.js treeHomes`, `classes.js settleHomes` |
| R3 | `rows_are_nodes` on every class. A transactional row gets a node only for a dependency or a stated reason | `model/classes.js mayMakeNode`, `instances.js relateInstance` |
| R5, R7 | Only the orchestrator creates or changes classes; a worker relates instances; a chat agent gets no class tools | `routes-classes.js registerClassTools` |
| R11.10 | Corrections are kept on the class and pin what they set; reruns can't bring back a retired class or a renamed one's old name; an instance a person took out of a class isn't related again | `model/classes.js` corrections, `classes.js correctClass`, `POST /api/classes/:name/corrections` |
| R11.3, R8 | A discovery identity gets only read tools, the class tree and instances. Other tools are never listed for it, and are refused at the call for a worker on a discovery part. Sources stay read-only through the existing `readToolsFrom` | `discovery.js gateDiscoveryTools`, `DISCOVERY_TOOLS` |
| R8 | The history: old notes from a file, each served only where its home allows | `discovery.js readHistory`, `HISTORY_PATH` |
| R9 | Each run records the tables it examined; a rerun lists only new ones | `classes.js recordExamined`, `discovery.js newTables`, DiscoveryRun |
| R5 | The one-page tree report | `model/classes.js treeReport`, `GET /api/classes/report` |

**Wiring in shared files**, in one commit (`Wiring for the integrator…`):
- `server.js`: the discovery gate, and `registerClassTools`.
- `routes.js`: `registerClassRoutes`.
- `delegation.js`: the `d` claim, with a test in `delegation.test.js`.
- `model/schema.js`: `Entity._corrections`, `_run` and `_discovery_run`, plus the `DiscoveryRun` document type.

**Configuration:**
- `CONNECTION_HOMES` is JSON, `{ "<system>": "<position or everyone>" }`. A connection without an entry
  counts as the root.
- `HISTORY_PATH` points at a JSON list of `{ id, title?, text, home, at? }`.

**Left for other owners:**
- Running the orchestrator on a discovery run belongs to filing, in `graph-pool.ts` and `instructions/master.ts`.
  It means:
  - minting its token with `d: <run>`;
  - starting it with the brief that `POST /api/classes/discovery` returns;
  - giving the connections' digests in that request.
- The worker's `request_class` tool belongs to filing. It is already on the discovery allow-list.
- Re-homing sections when a class-map entry tightens belongs to record.

**Not built:**
- The AI agents as instances under agent (R1; plan item 10).
- A stored time on an instance, so the timeline is a pure function only.
- The orchestrator's channel for a person's corrections (plan item 12).
- The web panel (out of scope for the first run).
- `connection-digest.ts` is unchanged.

## The reviewer's items on ba583bc (`~/reviews/build-build-base-ba583bc.md`)

- **Item 5, stages.** `normalizeClass` now refuses stages on a class that isn't under commitment. It checks
  against the tree it is given, the seeded classes by default. A parent the tree doesn't know is refused,
  since it can't be decided. The store checks against the stored tree. The tests fail on ba583bc's
  `model/classes.js` and pass now.
- **Item 11, names per home.**
  - The `_class_key` index is now NOTUNIQUE; this is in the wiring commit, in `model/schema.js` and
    `model-schema.test.js`.
  - Uniqueness per home is checked in code, against the classes the writer sees only, so a refusal never
    names a hidden class.
  - Two classes of one name are told apart as `name@home`, and only for a reader who sees both.
  - This replaces BUILD.md's choice #1 ("unique in the organization"), which is the integrator's file to
    update.
  - A database made before this keeps its old unique index. R8 starts the new version on an empty graph.
- **Item 7, the mirror under agent.**
  - Each position is a class under agent, nested as the positions are.
  - The token map's people are instances of their positions' classes (`authentik:user:<user>`).
  - The orchestrator and the Graph worker profile are instances of agent.
  - It is a one-way sync, rerun whenever the position map or the token map reloads. A position that
    leaves the map is retired, and a position someone no longer holds loses its edge.
  - The orchestrator and corrections can't change mirrored classes or add people to them.
  - NEEDS A RULING: the mirror is homed at everyone (`MIRROR_HOME`), and the agent instances are the
    smallest set (`AI_AGENTS`).
- **Item 8.** `EVIDENCE_KINDS` and the refusal of a retired parent are now marked NEEDS A RULING.

## The review of 4bd1154 (`~/reviews/build-build-classes-17566f-4bd1154.md`)

Each fix has a test that fails at 4bd1154. The unit tests ran against that commit's source, and the replay
scenarios ran there with and without the race scenario, which otherwise breaks everything after it.

| Finding | Fix |
|---|---|
| C-B1, the seeding race | Seeding runs one at a time, and the unique index on `_class_key` is back. Fixed rows are found by their unique key, and new instance nodes by a token only they have (`_mint`) |
| C-B2, the write floor | The one homing rule in `instances.js` (below), then `writeFloor`: never below what the writer read (`floor.js derivedFloor`) nor below its own record. An INSTANCE_OF or DEPENDS_ON edge to existing nodes is refused when it would be seen lower than that floor. A "note" cited as evidence counts only if it is an entry the writer sees. Reads through the class tools count as reads |
| C-B3, a rerun undoing a re-home | Class names are unique in the organization again (coordinator's decision). A hidden class's name is never repeated in a refusal |
| C-B4, duplicate instances | A new instance with no evidence lives at its writer's home, not the root. Keys are deduplicated across the whole graph; a node for a row held above the writer is refused without naming it (NEEDS A RULING). Names are deduplicated under the class, among what the writer sees |
| C-B5, discovery parts unscoped | Built: each part is created at one home, the connection's (none: the root) or the one the orchestrator gives for notes. Its worker's class tools read as that home (`partScope`), and the gate gives it no graph search tools, which read as a record's audience |
| C-B6, evidence shown above the reader | Only evidence the reader sees is shown (`visibleEvidence`). A free note without a ref is the root's |
| C-B7, the seam with filing | Filing workers get only `list_classes` and `read_dependencies` here. `relateInstance` and `addDependency` are the one implementation, which filing's `create_instance` and `state_dependency` should call, passing the section's home |

**The one homing rule for a new instance:**
1. `opts.home`, when the caller gives it: a filing worker passes its section's home (R11.8).
2. Otherwise, evidence: a key takes its connection's home; notes take the strictest home among those the
   writer sees.
3. Otherwise, the writer's own home: a discovery part's home, or a worker's record's home. The
   orchestrator's is the root.

The write floor then applies to whichever was chosen.

**Also fixed from the review's non-blocking items:**
- 3: the part brief and the gate name filing's `request`.
- 4: a parents correction can't leave stages on a class that is no longer under commitment.
- 5: the tree report keeps a retired class's subclasses and marks the retired class.
- 6: a person who left loses their position edges, and a position whose parent isn't mirrored isn't
  mirrored either.
- 8, partly: a key from another table is refused, `add_evidence` is refused on a retired class, and the
  `_run` text is corrected. Newly marked NEEDS A RULING:
  - a connection with no home;
  - `CORRECTION_KINDS`;
  - the mirror's people at everyone.
- 9: the index and its text agree again.
- 10: the trivial test is replaced.

**Still open from the review:**
- Non-blocking 2: nothing mints the `d` claim yet. `graph-token.ts` belongs to the integrator, and it must
  add `d` for the orchestrator in a run and for part workers, whose entries carry `_discovery_run`.
  Without the claim, a part worker gets only the reads, and the entry check refuses everything else.
- A part worker can still read every connection on the source side. Limiting it to its own connection is
  the server's job (`scaffold.ts`).
- Only a person at the root may correct (non-blocking 8). Still unmarked.
