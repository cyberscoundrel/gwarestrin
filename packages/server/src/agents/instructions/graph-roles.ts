/**
 * The standing instructions of a graph role (worker, master, handler,
 * liaison): its sources, read-only everywhere but the graph, then the role's
 * own preamble, then the organization's guidance from the Graph worker
 * profile.
 */
import type { SourceInfo } from "./types.js";
import { HANDLER_INSTRUCTIONS } from "./handler.js";
import { LIAISON_INSTRUCTIONS } from "./liaison.js";
import { MASTER_INSTRUCTIONS } from "./master.js";
import { WORKER_INSTRUCTIONS } from "./worker.js";

export type GraphRoleKind = "worker" | "liaison" | "master" | "handler";

export function buildGraphRoleInstructions({
  graph,
  connections,
  profileInstructions,
  graphRole,
}: {
  graph: boolean;
  connections: SourceInfo[];
  profileInstructions?: string | undefined;
  graphRole: GraphRoleKind;
}): string {
  const src = ["Your sources", ""];
  if (graph) {
    src.push(
      graphRole === "worker"
        ? "- The knowledge graph (graph-rag): as the people who see your sections see it, and nothing above it."
        : "- The knowledge graph (graph-rag): the whole organization's, in full.",
    );
  }
  for (const c of connections) {
    src.push(`- ${c.name} (read-only): ${c.description ?? "(your organization hasn't described this connection; its tools say what they do)"}`);
    if (c.digest) src.push(`  What it holds:\n${c.digest.split("\n").map((l) => `  ${l}`).join("\n")}`);
  }
  if (connections.length) src.push("  Look up what you need directly, with a filter. Never read a whole table.");
  return [
    src.join("\n"),
    graphRole === "liaison" ? LIAISON_INSTRUCTIONS : graphRole === "master" ? MASTER_INSTRUCTIONS : graphRole === "handler" ? HANDLER_INSTRUCTIONS : WORKER_INSTRUCTIONS,
    ...(profileInstructions?.trim() ? [`The organization's guidance for graph work (from the Graph worker profile)\n\n${profileInstructions.trim()}`] : []),
  ].join("\n\n");
}
