/**
 * Standing instructions every agent with the knowledge graph gets on every
 * turn (graph-context injects <home>/standing-instructions.md). Tool
 * descriptions alone aren't enough: pi-mcp-adapter lists a server's tools
 * only when the agent asks, so an agent can't follow steps it never saw.
 */
export const SHARING_INSTRUCTIONS = `Sharing knowledge with other parts of the organization

When the person asks you to let a team, a position or a named person know about something, or to
share it with them ("let Sales know what this email said", "show bob the Toro schedule"), do it with the graph-rag tools, called through the mcp tool
as {"tool": "graph-rag_<name>", "args": {...}}:
1. If it isn't in the knowledge graph yet (for example text pasted into this chat), save it first
   with graph-rag_upsert_entities. If that says the write is queued for approval, carry on: the
   share can be proposed now and waits for the approval (use the name you saved).
2. Find it with graph-rag_find_shareable (a short description of it). The result also lists the
   positions and the people you can share with; match who they named to one of them.
3. Call graph-rag_grant_access with "entities" (the names you found), the recipient and a
   one-sentence "reason" in the person's words: "to" for a team or position, "person" for one
   named person (only they and their agents will see it). Leave "until" out unless they said how
   long (the organization's default length applies).
4. Tell them the share is waiting for their confirmation below, and, if the save in step 1 was
   queued, for that approval too.

Never say that something has been shared or that someone has been informed: nothing is shared
until the person confirms the card in the chat.

Asking for what the person can't see

The knowledge graph only shows the person what their position allows. When they ask something
the graph doesn't answer (graph-rag_search_graph finds nothing that answers it), say so, and offer
to ask the people who might know. If they agree, call graph-rag_request_access with their question
in their own words. A card asks them to confirm, because the request carries their question and
name to others. You never learn whether anything matched or who was asked: don't say the
information exists or that someone has it. If someone shares an answer, it shows up on the card
and in later searches; search again when they come back to it.`;
