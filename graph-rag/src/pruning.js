/**
 * Pruning (see prune.js): expired entries leave for good after a window.
 */
import { createSink, ledgerLine, preview as prunePreviewDays, pruneCutoff, pruneRecord } from "./prune.js";
import { log, PRUNE_SINK } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { refreshGrants } from "./sharing.js";
import { docStore } from "./ingest.js";
import { policy } from "./server.js";

/** ---- pruning (see prune.js): expired entries leave for good after a window ---- */

export const pruneSink = createSink(PRUNE_SINK);
let pruneRunning = false;

export async function ensurePruneSchema() {
  await adbCommand("CREATE DOCUMENT TYPE PruneRecord IF NOT EXISTS").catch(() => {});
  for (const prop of ["name", "home", "kind", "valid_until", "pruned_at", "sink"]) {
    await adbCommand(`CREATE PROPERTY PruneRecord.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
}

/** one batch: hand expired entries to the sink, delete what it accepted, leave a line each */
export async function pruneExpired(limit = 100) {
  const cutoff = pruneCutoff(policy.pruneAfterDays);
  if (!cutoff || !pruneSink || pruneRunning) return { pruned: 0 };
  pruneRunning = true;
  try {
    // only entries with a definite end date; lasting ones never come here
    const rows = await adbQuery(`SELECT FROM ${ENTITY_LABEL} WHERE _valid_until IS NOT NULL AND _valid_until < :cutoff LIMIT ${Math.max(1, Math.min(500, limit))}`, { cutoff });
    if (rows.length === 0) return { pruned: 0 };
    const records = [];
    for (const row of rows) {
      const rid = String(row["@rid"]);
      if (!RID_RE.test(rid)) continue;
      const raw = await adbQuery(`SELECT @type AS type, @out AS src, @in AS dst FROM (SELECT expand(bothE()) FROM ${rid}) LIMIT 200`).catch(() => []);
      const others = [...new Set(raw.map((e) => String(String(e.src) === rid ? e.dst : e.src)).filter((r) => RID_RE.test(r)))];
      const names = new Map(others.length ? (await adbQuery(`SELECT @rid AS rid, name FROM [${others.join(",")}]`).catch(() => [])).map((n) => [String(n.rid), n.name]) : []);
      const edges = raw.map((e) => {
        const out = String(e.src) === rid;
        const other = String(out ? e.dst : e.src);
        return { type: e.type, direction: out ? "out" : "in", other: names.get(other) ?? other };
      });
      const grants = await adbQuery("SELECT id, to_pos, to_user, expires_at FROM AccessGrant WHERE target = :rid AND status = 'active'", { rid }).catch(() => []);
      records.push(pruneRecord(row, edges, grants));
    }
    const accepted = new Set(await pruneSink.archive(records));
    let pruned = 0;
    const now = new Date().toISOString();
    for (const rec of records) {
      if (!accepted.has(rec.rid)) continue;
      // still expired? (an owner may have extended it since the batch was read)
      const gone = await adbCommand(`DELETE FROM ${ENTITY_LABEL} WHERE @rid = ${rec.rid} AND _valid_until < :cutoff`, "sql", { cutoff });
      if (Number(gone?.[0]?.count ?? 0) !== 1) continue;
      pruned++;
      if (rec.properties?._kind === "document" && rec.properties._doc_id && docStore) await docStore.remove(rec.properties._doc_id).catch(() => {});
      await adbCommand("UPDATE AccessGrant SET status = 'revoked', revoked_at = :now, revoked_by = 'graph-rag: entry pruned' WHERE target = :rid AND status = 'active'", "sql", { now, rid: rec.rid }).catch(() => {});
      const line = ledgerLine(rec, pruneSink);
      await adbCommand(
        "INSERT INTO PruneRecord SET name = :name, home = :home, kind = :kind, valid_until = :valid_until, pruned_at = :pruned_at, sink = :sink, kept = :kept",
        "sql",
        line,
      ).catch((e) => log.warn(`prune record for ${rec.name}: ${String(e).slice(0, 120)}`));
    }
    if (pruned) {
      await refreshGrants();
      log.info(`pruned ${pruned} expired entr${pruned === 1 ? "y" : "ies"} (ended before ${cutoff.slice(0, 10)}; sink ${pruneSink.name}${pruneSink.keeps ? "" : ": nothing kept"})`);
    }
    return { pruned };
  } finally {
    pruneRunning = false;
  }
}

/** for Organization settings: what's waiting to be pruned, and when */
export async function prunePreview() {
  const rows = await adbQuery(`SELECT _valid_until AS valid_until FROM ${ENTITY_LABEL} WHERE _valid_until IS NOT NULL AND _valid_until <= :now LIMIT 100000`, { now: new Date().toISOString() }).catch(() => []);
  return { ...prunePreviewDays(rows, policy.pruneAfterDays), sink: pruneSink ? { name: pruneSink.name, keeps: pruneSink.keeps } : { name: PRUNE_SINK, unknown: true } };
}
