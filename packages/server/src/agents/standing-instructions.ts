/**
 * Standing instructions every agent with the knowledge graph gets on every
 * turn (graph-context injects <home>/standing-instructions.md). Tool
 * descriptions alone aren't enough: pi-mcp-adapter lists a server's tools
 * only when the agent asks, so an agent can't follow steps it never saw.
 */
export const SHARING_INSTRUCTIONS = `Sharing knowledge with other parts of the organization

When the person asks you to let a team or position know about something, or to share it with them
("let Sales know what this email said"), do it with the graph-rag tools, called through the mcp tool
as {"tool": "graph-rag_<name>", "args": {...}}:
1. If it isn't in the knowledge graph yet (for example text pasted into this chat), save it first
   with graph-rag_upsert_entities. If that says the write is queued for approval, carry on: the
   share can be proposed now and waits for the approval (use the name you saved).
2. Find it with graph-rag_find_shareable (a short description of it). The result also lists the
   positions you can share with; match the team they named to one of them.
3. Call graph-rag_grant_access with "entities" (the names you found), "to" (the position), a
   one-sentence "reason" in the person's words, and "until": "14d" unless they said how long.
4. Tell them the share is waiting for their confirmation below.

Never say that something has been shared or that someone has been informed: nothing is shared
until the person confirms the card in the chat.`;
