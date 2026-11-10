/**
 * Instances and what relates sections to them: the few helpers left from the linker, which the rulings
 * removed (R4: every record gets a worker, and the worker resolves names against the source while filing).
 * An instance is visible wherever a section about it is (R11): its `_homes` grow with the sections that
 * relate to it, and scope.js `homeFilter` reads them.
 *
 * The classes and discovery stream owns this module.
 */
import { EVERYONE, visibleHomes } from "./positions.js";
import { adbCommand, adbQuery } from "./db.js";
import { positionMap } from "./scope.js";

/** "Toro Co." / "TORO" / "toro" -> "toro co" / "toro" */
export const normalize = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** two spellings of one record key: a source's row keys don't differ by case */
export const sameKey = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/** what counts as an entry (not an instance or a class) */
export const ENTRY_KINDS = "(_kind IS NULL OR _kind IN ['document', 'section', 'task'])";

/** can a reader at `home` already see this instance */
export function seenInstance(t, home) {
  if (!positionMap || !home) return true;
  const homes = visibleHomes(positionMap, [home]);
  return homes === null || (t._homes ?? []).some((h) => h === EVERYONE || homes.has(h));
}

/**
 * An instance is seen from one more home: a section there relates to it. Only from where it could already
 * be seen (`from`, the section's own home unless it just moved), so relating a section to an instance it
 * can't see doesn't bring that instance's name down with it.
 */
export async function instanceSeenFrom(rid, home, { from = home } = {}) {
  const row = (await adbQuery(`SELECT _homes FROM ${rid}`))[0];
  const homes = Array.isArray(row?._homes) ? row._homes : [];
  if (!homes.includes(home) && seenInstance({ _homes: homes }, from)) await adbCommand(`UPDATE ${rid} SET _homes = :homes`, "sql", { homes: [...homes, home] });
}

/** relate a section to an instance once (an ABOUT edge, model/schema.js) */
export async function aboutOnce(sectionRid, instanceRid, role) {
  const out = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${sectionRid})`).catch(() => []);
  if (out.some((e) => String(e.dst) === instanceRid)) return;
  await adbCommand(`CREATE EDGE ABOUT FROM ${sectionRid} TO ${instanceRid} SET role = :role`, "sql", { role });
}
