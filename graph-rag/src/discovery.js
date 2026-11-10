// Discovery helpers (R3, R5, R8, R11). Discovery is the orchestrator running with read tools only, plus
// workers it starts for parts of it (R11); it builds the class tree from the connected systems with no person
// gate (R5), sets each class's home and its rows-become-nodes setting from evidence (R3, R8), and seeds only
// what organizational structure needs (R3). Reruns and new tables count as discovery (R9).
//
// Gone with the rulings: the noun tables (TRANSACTION_NOUNS, MASTER_NOUNS) and every word test that classified
// a table by its name (R3: no word lists), drafts waiting for a person to confirm (R5: no person gate), and the
// CommitmentClass store (a class is an Entity scoped by home: model/classes.js).
//
// What stays are pure readers of what a survey saw. The classes and discovery stream owns this module.

export const DISCOVERY = "discovery";

/**
 * The connection digest an agent gets (connection-digest.ts), back into
 * tables. Three line shapes:
 *   Tables (12, all named dbo_…): Customer, Job, Order
 *   dbo_Job columns: JobID, CustomerID, Status, DueDate
 *   - dbo_Customer: Customer, Name, Status, …
 * plus, when the survey counted or read a status column:
 *   dbo_Job rows: 4471
 *   dbo_Job Status values: Planned, Running, Paused, Done
 * Anything else is ignored. `system` is the connection's name (the first
 * part of every key).
 */
export function parseDigest(text, system) {
  const tables = new Map();
  const at = (name) => {
    const n = String(name).trim();
    if (!tables.has(n)) tables.set(n, { name: n, columns: [] });
    return tables.get(n);
  };
  const list = (s) =>
    String(s)
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x && x !== "…" && x !== "...");
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m = /^Tables \((\d+)(?:, all named ([A-Za-z0-9_]+)…?)?\): (.+)$/.exec(line);
    if (m) {
      const prefix = m[2] ?? "";
      for (const n of list(m[3])) at(`${prefix}${n}`);
      continue;
    }
    m = /^([A-Za-z0-9_.]+) columns: (.+)$/.exec(line);
    if (m) {
      at(m[1]).columns = list(m[2]);
      continue;
    }
    m = /^([A-Za-z0-9_.]+) rows: ([\d,]+)$/.exec(line);
    if (m) {
      at(m[1]).rows = Number(m[2].replace(/,/g, ""));
      continue;
    }
    m = /^([A-Za-z0-9_.]+) ([A-Za-z0-9_]+) values: (.+)$/.exec(line);
    if (m) {
      const t = at(m[1]);
      t.status_values = { ...(t.status_values ?? {}), [m[2]]: list(m[3]) };
      if (!t.columns.includes(m[2])) t.columns.push(m[2]);
      continue;
    }
    m = /^- ([A-Za-z0-9_.]+)(?:: (.+))?$/.exec(line);
    if (m && !/^… and \d+ more$/.test(m[1])) {
      const t = at(m[1]);
      if (m[2]) t.columns = list(m[2]);
    }
  }
  return { system: String(system ?? "").trim(), tables: [...tables.values()] };
}

/**
 * The lines of a survey's report that describe a table in the digest's own
 * grammar (parseDigest): columns, row count, a status column's values. Only
 * those: a report's free bullets ("- Jobs: 31k open") would read as tables.
 */
const REPORT_TABLE_LINE = /^[A-Za-z0-9_.]+ (?:columns: .+|rows: [\d,]+|[A-Za-z0-9_]+ values: .+)$/;
export function reportDigest(report) {
  return String(report ?? "")
    .split("\n")
    .map((l) => l.trim().replace(/^[-*]\s+/, "").replace(/`/g, "").trim())
    .filter((l) => REPORT_TABLE_LINE.test(l))
    .join("\n");
}
