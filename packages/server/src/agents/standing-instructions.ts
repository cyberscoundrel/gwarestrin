/**
 * Standing instructions every agent with the knowledge graph gets on every
 * turn (graph-context injects <home>/standing-instructions.md). Tool
 * descriptions alone aren't enough: pi-mcp-adapter lists a server's tools
 * only when the agent asks, so an agent can't follow steps it never saw.
 *
 * One module per role under ./instructions/: the chat agent (chat.ts) and
 * the graph roles (worker, master, handler, liaison; graph-roles.ts builds
 * their preamble). This file re-exports them and picks the builder.
 */
import { buildChatInstructions } from "./instructions/chat.js";
import { buildGraphRoleInstructions, type GraphRoleKind } from "./instructions/graph-roles.js";
import type { SourceInfo } from "./instructions/types.js";

export { SHARING_INSTRUCTIONS, buildChatInstructions } from "./instructions/chat.js";
export { WORKER_INSTRUCTIONS } from "./instructions/worker.js";
export { MASTER_INSTRUCTIONS } from "./instructions/master.js";
export { HANDLER_INSTRUCTIONS } from "./instructions/handler.js";
export { LIAISON_INSTRUCTIONS } from "./instructions/liaison.js";
export { buildGraphRoleInstructions, type GraphRoleKind } from "./instructions/graph-roles.js";
export type { SourceInfo } from "./instructions/types.js";

/**
 * The agent's standing instructions: a graph role's (its own preamble,
 * read-only sources) or a chat agent's (its sources in order, its profile,
 * the knowledge-graph procedures).
 */
export function buildStandingInstructions({
  graph,
  connections,
  profileInstructions,
  graphRole,
}: {
  graph: boolean;
  connections: SourceInfo[];
  profileInstructions?: string | undefined;
  /** a graph worker agent (its profile is the Graph worker): its own preamble, read-only sources */
  graphRole?: GraphRoleKind | undefined;
}): string {
  if (graphRole) return buildGraphRoleInstructions({ graph, connections, profileInstructions, graphRole });
  return buildChatInstructions({ graph, connections, profileInstructions });
}
