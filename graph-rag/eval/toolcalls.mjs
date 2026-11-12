// A run's tool calls, from its driver.log (one JSON line per event; a tool call is { agent, tool, error, errorText? }),
// with the errors split three ways (I-43), so "tool errors" isn't read as models failing to call tools:
//   malformed  the call didn't fit the tool: a schema validation failure, or a tool that doesn't exist
//   source     a connection's own tool (mssql_read_records and the like) refused a well-formed call
//   graph_rag  a graph-rag tool refused a well-formed call (its rules, a wrong reference, an audience)
// Pure: the caller reads the file.

export const MALFORMED = /Input validation error|MCP error -32602|^error: no tool /;

/** "malformed", "source" or "graph_rag" for one errored call */
export function errorKind(call) {
  if (MALFORMED.test(String(call.errorText ?? ""))) return "malformed";
  return String(call.tool ?? "").startsWith("graph-rag_") ? "graph_rag" : "source";
}

// corrections: file_to_source answered not_filed (I-50: a value not in the record's words, told once). Not an error
const blank = () => ({ calls: 0, errors: 0, malformed: 0, source: 0, graph_rag: 0, corrections: 0 });

/** counts in all and per agent role (discovery, orchestrator, worker, part): { all, byRole, filing } */
export function toolCallCounts(events) {
  const all = blank();
  const byRole = {};
  for (const e of events) {
    if (!e || typeof e.tool !== "string") continue;
    const r = (byRole[e.agent ?? "unknown"] ??= blank());
    for (const x of [all, r]) {
      x.calls++;
      if (!e.error && e.outcome === "not_filed") x.corrections++;
      if (e.error) {
        x.errors++;
        x[errorKind(e)]++;
      }
    }
  }
  // filing: everything but discovery and its parts
  const filing = blank();
  for (const [role, x] of Object.entries(byRole)) if (role !== "discovery" && role !== "part") for (const k of Object.keys(filing)) filing[k] += x[k];
  return { all, byRole, filing };
}

/** the lines of a driver.log as events (a line that isn't JSON is skipped) */
export function parseLog(text) {
  return String(text ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
