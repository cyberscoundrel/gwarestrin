// An approved raw command must say whether it changed anything: a MATCH that
// matches nothing runs "fine" and returns nothing, and the proposal would be
// recorded as applied while the graph stayed as it was.

const COUNTED = "changed";

/**
 * The command as run, made to report how many records it changed: a Cypher
 * MATCH … SET/REMOVE/DELETE with no RETURN gets `RETURN count(*) AS changed`.
 * SQL UPDATE/DELETE report a count already. Anything else runs as written.
 */
export function countingCommand(command, language = "sql") {
  const c = String(command).trim().replace(/;\s*$/, "");
  if (language !== "cypher") return c;
  if (/^MATCH\b/i.test(c) && /\b(SET|REMOVE|DELETE)\b/i.test(c) && !/\bRETURN\b/i.test(c)) return `${c} RETURN count(*) AS ${COUNTED}`;
  return c;
}

/**
 * How many records the command changed, or null when it can't be told (a
 * CREATE, a command with its own RETURN, schema changes).
 */
export function changedCount(command, language, result) {
  const row = Array.isArray(result) && result.length === 1 ? result[0] : null;
  if (!row) return null;
  if (language === "cypher") return countingCommand(command, language) !== String(command).trim().replace(/;\s*$/, "") && Number.isFinite(Number(row[COUNTED])) ? Number(row[COUNTED]) : null;
  if (/^\s*(UPDATE|DELETE)\b/i.test(command) && Number.isFinite(Number(row.count))) return Number(row.count);
  return null;
}

/** why a command that changed nothing isn't applied (with the usual cause, for Cypher) */
export function changedNothing(language) {
  return `the command matched nothing, so no record changed and it is not applied.${
    language === "cypher" ? " In Cypher, CONTAINS tests text: to find a value in a list property use 'value' IN n.list." : ""
  } Read the records it should change, then propose a corrected command.`;
}
