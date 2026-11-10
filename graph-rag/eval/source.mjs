// The source side of the evaluation (docs/build/integrate.md, 2.2 and 2.8): the row diff between two dumps,
// the gate that every changed row has a Filed entry, and workers' accounts against what changed. Pure.
//
// A dump: { table: { primaryKey: [col], rows: [row] } }, as fake-dab-core.mjs holds a source and
// dumpSource() (scripts/source-dump.mjs) reads one.
import { SYSTEM, rowKey } from "./s0.mjs";

const same = (a, b) => {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return a == b; // eslint-disable-line eqeqeq
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b) && String(a).trim() !== "" && String(b).trim() !== "";
  return String(a) === String(b);
};

/** every created, updated and deleted row: [{ key, table, kind, columns, before, after }] */
export function diffDumps(before, after, { system = SYSTEM } = {}) {
  const out = [];
  const tables = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const table of [...tables].sort()) {
    const b = before?.[table] ?? { primaryKey: after[table].primaryKey, rows: [] };
    const a = after?.[table] ?? { primaryKey: b.primaryKey, rows: [] };
    const pk = a.primaryKey ?? b.primaryKey;
    const index = (rows) => new Map(rows.map((r) => [rowKey(table, pk, r).replace(/^[^:]+:/, `${system}:`), r]));
    const bi = index(b.rows);
    const ai = index(a.rows);
    for (const [key, row] of ai) {
      const old = bi.get(key);
      if (!old) {
        out.push({ key, table: `${system}:${table}`, kind: "created", columns: Object.keys(row).filter((c) => row[c] !== null && row[c] !== undefined && !pk.includes(c)), before: null, after: row });
        continue;
      }
      const columns = [...new Set([...Object.keys(old), ...Object.keys(row)])].filter((c) => !same(old[c], row[c]));
      if (columns.length) out.push({ key, table: `${system}:${table}`, kind: "updated", columns, before: old, after: row });
    }
    for (const [key, row] of bi) if (!ai.has(key)) out.push({ key, table: `${system}:${table}`, kind: "deleted", columns: Object.keys(row), before: row, after: null });
  }
  return out;
}

/**
 * The gate (zero tolerance): every changed row has a Filed entry naming that table and key, and the changed
 * columns are among the columns the entry names. A deleted row always fails (a write may never delete).
 * Returns { ok, violations: [{ key, kind, why }] }.
 */
export function rowGate(changes, entries) {
  const filed = entries.filter((e) => e.outcome === "filed" && e.target?.key);
  const violations = [];
  for (const ch of changes) {
    if (ch.kind === "deleted") {
      violations.push({ key: ch.key, kind: ch.kind, why: "a row was deleted" });
      continue;
    }
    const mine = filed.filter((e) => e.target.key === ch.key);
    if (!mine.length) {
      violations.push({ key: ch.key, kind: ch.kind, why: "no Filed entry names this row" });
      continue;
    }
    const named = new Set(mine.flatMap((e) => Object.keys(e.target.fields ?? {})));
    const extra = ch.columns.filter((c) => !named.has(c));
    if (extra.length) violations.push({ key: ch.key, kind: ch.kind, why: `changed columns no Filed entry names: ${extra.join(", ")}` });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Workers' accounts against the source (2.8). For each entry that says it wrote (Filed with fields): true,
 * false-claim (the row didn't change), or wrong-values (it changed to something else). Changes no entry
 * accounts for are `omitted`. Then the orchestrator's verdicts: caught (a bad account it marked differs),
 * missed (a bad account it marked matches), false-alarm (a true account it marked differs), unverifiable,
 * and unchecked (no verdict).
 */
export function accountResults(changes, entries) {
  const byKey = new Map(changes.map((c) => [c.key, c]));
  const items = [];
  for (const e of entries) {
    if (e.outcome !== "filed" || !e.target?.key) continue;
    const ch = byKey.get(e.target.key);
    const fields = e.target.fields ?? {};
    let result;
    if (!ch) result = Object.keys(fields).length ? "false-claim" : "true";
    else {
      const wrong = Object.entries(fields).filter(([c, v]) => !same(ch.after?.[c], v));
      result = wrong.length ? "wrong-values" : "true";
    }
    const verdict = e.verdict?.result ?? null;
    const bad = result !== "true";
    const check = !verdict ? "unchecked" : verdict === "unverifiable" ? "unverifiable" : bad ? (verdict === "differs" ? "caught" : "missed") : verdict === "differs" ? "false-alarm" : "agreed";
    items.push({ entry: e.id, record: e.record, key: e.target.key, result, verdict, check, said: e.account?.said ?? null });
  }
  const accounted = new Set(entries.filter((e) => e.outcome === "filed").map((e) => e.target?.key));
  const omitted = changes.filter((c) => !accounted.has(c.key)).map((c) => c.key);
  const count = (k, v) => items.filter((i) => i[k] === v).length;
  return {
    items,
    omitted,
    totals: {
      accounts: items.length,
      true: count("result", "true"),
      falseClaim: count("result", "false-claim"),
      wrongValues: count("result", "wrong-values"),
      omitted: omitted.length,
      caught: count("check", "caught"),
      missed: count("check", "missed"),
      falseAlarm: count("check", "false-alarm"),
      unverifiable: count("check", "unverifiable"),
      unchecked: count("check", "unchecked"),
    },
  };
}
