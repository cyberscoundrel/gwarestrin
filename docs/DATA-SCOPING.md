# Data scoping

Status: the position tree, homes, filtered reads, set_home, per-agent
positions from profiles and grants are built (2026-10-06); semantic grading
and derived-data labels are not yet. Last discussed 2026-10-06.

An agent is untrusted: prompt injection can make it ask for anything. So who
may see what is enforced by the data source, against an identity the agent
never sees or chooses; never by the prompt or by which tools an agent is shown.

## Relational data (mssql through DAB): the database's own permissions

A modern RDBMS already has a mature permission system, and an ERP/CRM schema is
rigid and owned by its application, not by agents. So gwarestrin adds no
privilege model inside SQL:

- **One DAB instance per access level**, each with its own SQL login whose
  grants a DBA scopes in the database's own tools (tables/views, read-only
  where appropriate). The login is the boundary.
- **gwarestrin decides reachability only**: which positions (below) get which
  DAB instances. Discovery is filtered per tenant, and OpenShell's sandbox
  policy gives an agent no network path to the others. A leaked URL still only
  reaches what that login's grants allow.

## The knowledge graph: positions, homes, grants

Agents read from and write to the knowledge graph freely and its schema is
open-ended, so it needs its own model. Categories differ per organization, so
nothing below hard-codes them.

### Positions
The organization is a tree of **positions** (owner at the root; e.g. Ops
manager, Production floor, Sales, Engineering). People hold one or more
positions; the tree lives in authentik's group hierarchy and is mirrored into
the graph. Each position carries a plain-language description of what its
work covers, which semantic grading uses.

### Homes
Every item in the graph has a **home**: the position it belongs to. A position
sees items homed at itself and below it. Siblings at the same depth see
different things (Sales and Engineering), and lower positions don't see
what's homed above them, however related it is: an order email homed at the Ops
manager is invisible to the Production floor even though it concerns
production.

### Grants
"Sometimes" is an explicit **grant**: an edge from an item or a subtree to a
position, with an expiry, a reason and who granted it. Only someone who can
see the data may grant it; grants are revocable and audited. Agents may
*propose* grants; a human approves them in the review queue.

### Semantic grading
At ingestion an LLM grades each item against the position tree:

1. **Provenance sets the home; semantics never widens it.** An email received
   by the Ops manager is homed there. Grading may move an item *higher*
   (more restricted) on its own, but releasing it lower or elsewhere needs a
   person's approval or an admin-written rule.
2. **Uncertainty fails upward**: a low-confidence grade homes the item closer
   to the root and queues it for review. A misgrade can hide data, never leak it.

### Derived data
A summary, briefing or agent write built from several items is visible only to
positions that can see *all* of its sources. Profile briefings (the
continuously updated system prompts) are built only from what their viewer
can see.

### Agents
An agent acts for a person and never sees more than that person. Its profile
*positions* it in the tree (a "floor assistant" works at the Production floor
even when the Ops manager runs it), so a profile can be handed down without
leaking its author's view. A profile can only be placed at or below the people
allowed to use it; otherwise defining a profile would escalate privileges.

### Enforcement
- **Stores**: separate ArcadeDB databases for broad domains, gated by ArcadeDB
  users per database (to verify: per-database groups with per-type rights) and
  by sandbox network policy.
- **Within a store**: graph-rag filters every read path (search, traversal,
  lexical fallback, approvals) by the caller's visible positions plus grants;
  writes are homed at the writer's position. Raw Cypher/SQL tools stay
  root-only. The caller is identified per agent (person + profile position),
  injected as an OpenShell provider credential the agent never sees.

## As built (graph-rag)
- **Positions** are authentik groups with `attributes.gw_position: true` (and an
  optional `attributes.description`); the root is the `org` group
  (`ORG_ROOT_GROUP`). A position's parent is its one parent group that is a
  position; none or several hangs it off the root. Members hold the position;
  admin-tier tenants hold the root. The provisioner writes
  `graph-rag-config/position-map.json` and each tenant's positions into its
  token entry; graph-rag reloads both and fails closed while either is missing.
- **Homes**: graph-rag stamps `_home` on every write; callers can't set it.
  An entity is (name, home), so a write never touches a same-named entity at a
  home the writer can't write. Default home = the writer's deepest position;
  `upsert_entities.home` may name one of its positions or one above (restrict).
- **Reads**: search (vector + lexical) and the 1-hop traversal only return
  entities homed at the caller's positions or below; edges to hidden
  entities are dropped. Raw query tools need the root position.
- **Moves**: `set_home` restricts directly (direct writers) and queues every
  widening for a person; approvers only see queued writes they can see.
- **Legacy data** (no `_home`) is root-only until released with `set_home`.
- **Grants** (`grant_access`, `list_grants`, `revoke_grant`): named entities
  or a whole subtree, shown to a receiving position (its holders and those
  above it) as if also homed there. Only owners grant (they see the data by
  home, not through a grant, so nothing is re-shared); people with direct
  write rights grant at once, agents and queued writers propose and a person
  approves. Non-root grants expire within 90 days; only the root grants
  standing access. Revoking (grantor or any owner) applies at once; expiry is
  checked at query time. Granted results carry `via: "grant"`; granted data
  can't be moved or granted onward. Verified live: 24/24 checks.
- **Review queue**: an approval claims the queued write before running it, so
  it runs once; approved and rejected writes leave the queue.
- **Agents** each have their own graph token, signed by their instance with a
  provisioner-issued delegation key (`values.graph.delegationKey`, never
  substituted into agent config) and naming their profile's positions
  (`positions` on the agent profile; empty = where the user stands).
  graph-rag drops positions outside what the instance's user reaches and
  never lets an agent approve or run raw queries; writes are attributed to
  `<user>/agent:<id>`. On OpenShell the token is the agent's own provider
  credential. The profile editor's *Knowledge access* section picks the
  positions from the part of the tree the user reaches.
- Verified live with the test tree org > Operations (alice) > Production floor
  (bob): 20/20 checks (manager's email invisible to the floor, same-name
  entities kept apart, edges to hidden entities dropped, moves).

## Open questions
1. **Do ancestors always see down?** Default yes; but e.g. a complaint about a
   manager must not be visible to that manager. Per-item "not visible to
   ancestors X", or a separate compartment hung off the root?
2. **Items that belong to several positions** (an order touching Sales and
   Production): home at the lowest common ancestor (strict) or several homes
   (wider)?
3. ~~Standing vs temporary grants~~: built as both; standing grants are
   root-only, everyone else's expire within 90 days.
4. **Per-organization defaults**: which of the above are settings per client?

## Prerequisites (closed 2026-10-06)
- graph-rag fails closed: a configured token map that is missing or unreadable
  denies everyone; open mode needs `GRAPH_RAG_OPEN_MODE=1` and no token map.
- ArcadeDB's HTTP API/Studio is bound to the docker host's loopback (SSH
  tunnel for Studio); its built-in MCP is disabled.
- Raw `query_graph` / `execute_graph` need the `raw` capability (admin tier
  only) and are not even listed for other identities.
- Approving a queued upsert/backfill runs its handler (it used to send the
  JSON payload to ArcadeDB as SQL); a write is only reported queued once the
  queue record exists.
- The context engine is offered read tools only (search, schema, and raw
  query for raw-capable identities).
- Still open: DAB runs in development mode (Simulator auth, `anonymous: *`),
  acceptable only once each DAB's SQL login is the real boundary.
