# Data scoping

Status: design, not built. Last discussed 2026-10-06.

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

## Open questions
1. **Do ancestors always see down?** Default yes; but e.g. a complaint about a
   manager must not be visible to that manager. Per-item "not visible to
   ancestors X", or a separate compartment hung off the root?
2. **Items that belong to several positions** (an order touching Sales and
   Production): home at the lowest common ancestor (strict) or several homes
   (wider)?
3. **Standing vs temporary grants**: "Sales always sees Engineering's release
   notes" vs "for this deal". Both, with standing grants admin-only?
4. **Per-organization defaults**: which of the above are settings per client?

## Prerequisites (independent of the model)
Today graph-rag scopes per instance token only, and nothing stops a raw query.
These need closing first:
- graph-rag fails *open* when its token map is missing or unreadable at boot;
- ArcadeDB's HTTP API/Studio is published on host port 2480 with root login,
  and its built-in MCP accepts any user;
- raw `query_graph` / `execute_graph` are available to every reader/writer;
- approving a queued upsert/backfill sends JSON to ArcadeDB as SQL (bug);
- the context engine gets every graph tool, including writes;
- DAB runs in development mode (Simulator auth, `anonymous: *`): fine only
  once each DAB's SQL login is the real boundary.
