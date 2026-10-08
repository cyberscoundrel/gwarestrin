// Pruning: entries past their end date (see extent.js) are removed for good
// once a retention window has passed. Before anything is deleted, the batch
// goes to a *sink*; only what the sink accepts is deleted. The one built-in
// sink, "discard", keeps nothing: pruning is permanent removal. Cold storage
// later is another sink (a file, object storage, a database) chosen with
// PRUNE_SINK; the pruner doesn't change.
//
// Only entries with a definite end date are ever pruned: lasting ones never.
// What's left of a pruned entry is one line in the pruning record (name,
// home, kind, dates; root only), never its content.

const DAY = 86_400_000;

/** entries that ended before this instant are due (null: pruning is off) */
export function pruneCutoff(afterDays, now = Date.now()) {
  if (!Number.isFinite(afterDays) || afterDays <= 0) return null;
  return new Date(now - afterDays * DAY).toISOString();
}

/** when an entry that ends at `validUntil` will be pruned */
export const pruneDate = (validUntil, afterDays) => new Date(Date.parse(validUntil) + afterDays * DAY).toISOString();

/**
 * Sinks: { name, keeps, archive(records) -> Promise<ids accepted> }.
 * `keeps` says whether anything survives pruning (shown to the admin).
 */
export const SINKS = {
  discard: () => ({
    name: "discard",
    keeps: false,
    // nothing is kept: every record may go
    archive: async (records) => records.map((r) => r.rid),
  }),
};

/** the configured sink; unknown names disable pruning rather than lose data meant for storage */
export function createSink(name = "discard") {
  const make = SINKS[String(name || "discard").toLowerCase()];
  return make ? make() : null;
}

/** what a sink receives for one entry: everything needed to restore it */
export function pruneRecord(row, edges = [], grants = []) {
  const properties = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("embed_") || k.startsWith("@")) continue; // vectors are recomputable
    properties[k] = v;
  }
  return {
    rid: String(row["@rid"]),
    name: row.name,
    type: row["@type"] ?? null,
    home: row._home ?? null,
    origin: row._origin ?? null,
    valid_until: row._valid_until ?? null,
    properties,
    edges: edges.map((e) => ({ type: e.type, direction: e.direction, other: e.other })),
    grants: grants.map((g) => ({ id: g.id, to_pos: g.to_pos ?? null, to_user: g.to_user ?? null, expires_at: g.expires_at ?? null })),
  };
}

/** the line that stays behind: no content, root only */
export function ledgerLine(record, sink, now = Date.now()) {
  return {
    name: String(record.name ?? "").slice(0, 300),
    home: record.home,
    kind: record.type,
    valid_until: record.valid_until,
    pruned_at: new Date(now).toISOString(),
    sink: sink.name,
    kept: sink.keeps,
  };
}

/**
 * What's coming, for Organization settings: expired entries (still in the
 * graph, out of reads) grouped by the day they'll be pruned.
 * `expired`: [{ valid_until }] of entries already past their end date.
 */
export function preview(expired, afterDays, now = Date.now()) {
  if (!Number.isFinite(afterDays) || afterDays <= 0) return { enabled: false, waiting: expired.length, days: [] };
  const byDay = new Map();
  let due = 0;
  for (const e of expired) {
    const at = Date.parse(pruneDate(e.valid_until, afterDays));
    if (at <= now) due++;
    const day = new Date(Math.max(at, now)).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const days = [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count }));
  return { enabled: true, waiting: expired.length, due, days };
}
