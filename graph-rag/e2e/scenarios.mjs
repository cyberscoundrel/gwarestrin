// The scenario loader: finds every `scenarios-<stream>.mjs` next to run.mjs,
// imports it, and hands back its scenarios in a uniform shape, so run.mjs
// runs its own 22 and every stream's as one suite (SCENARIOS.md is the
// contract a scenario file follows). Pure over the file system: nothing here
// talks to the graph. Tested in test/harness-loader.test.js.
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export const FILE_RE = /^scenarios-([a-z0-9][a-z0-9-]*)\.mjs$/i;

/** the scenario files in `dir`, sorted by name (a stable order across runs) */
export function discoverScenarioFiles(dir) {
  return readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** the stream a file belongs to: scenarios-condenser.mjs -> condenser */
export const streamOf = (file) => FILE_RE.exec(basename(file))?.[1] ?? basename(file);

/**
 * What a module exports, as a list of scenarios: the default export when it
 * is an array, else `scenarios`. Each item must be `{ name, run }`; `skip`
 * (a string reason, true, or a function of the context returning one) is
 * optional. Throws with the file and the item's index when the shape is
 * wrong, so a mistake fails the suite instead of silently running nothing.
 */
export function scenariosOf(mod, file) {
  const list = Array.isArray(mod?.default) ? mod.default : Array.isArray(mod?.scenarios) ? mod.scenarios : null;
  if (!list) throw new Error(`${basename(file)}: must export an array of { name, run } as default or as \`scenarios\``);
  if (list.length === 0) throw new Error(`${basename(file)}: exports no scenarios`);
  return list.map((s, i) => {
    if (!s || typeof s !== "object") throw new Error(`${basename(file)}[${i}]: not an object`);
    if (typeof s.name !== "string" || !s.name.trim()) throw new Error(`${basename(file)}[${i}]: needs a name`);
    if (typeof s.run !== "function") throw new Error(`${basename(file)}[${i}] "${s.name}": needs a run(context) function`);
    if (s.skip !== undefined && !["string", "boolean", "function"].includes(typeof s.skip)) throw new Error(`${basename(file)}[${i}] "${s.name}": skip must be a reason, true, or a function`);
    return { name: s.name.trim(), run: s.run, skip: s.skip, file: basename(file), stream: streamOf(file) };
  });
}

/**
 * Import every file; a file that fails to import or has the wrong shape
 * comes back as one failed scenario named after it (`load scenarios-x.mjs`),
 * so the summary line counts it and the rest of the suite still runs.
 */
export async function loadScenarioFiles(files) {
  const out = [];
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(file).href);
      out.push(...scenariosOf(mod, file));
    } catch (e) {
      const error = e;
      out.push({
        name: `load ${basename(file)}`,
        file: basename(file),
        stream: streamOf(file),
        run: async () => {
          throw error;
        },
      });
    }
  }
  return out;
}

/**
 * The ONLY filter (`ONLY=condenser` or `ONLY=rack,coolant`): a scenario runs
 * when its name, file or stream contains one of the comma-separated terms
 * (case-insensitive). Empty or unset: everything runs.
 */
export function selected(scenario, only = process.env.ONLY) {
  const terms = String(only ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (terms.length === 0) return true;
  const hay = `${scenario.name} ${scenario.file ?? ""} ${scenario.stream ?? ""}`.toLowerCase();
  return terms.some((t) => hay.includes(t));
}

/** the reason a scenario is skipped (a string), or null to run it */
export async function skipReason(scenario, context) {
  const s = scenario.skip;
  if (s === undefined || s === null || s === false) return null;
  const r = typeof s === "function" ? await s(context) : s;
  if (r === undefined || r === null || r === false) return null;
  return typeof r === "string" && r.trim() ? r.trim() : "skipped";
}

/** the one summary line: `20/22 scenarios passed` (`, 1 skipped` when any were) */
export function summaryLine(results) {
  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.ok).length;
  const skipped = results.length - ran.length;
  return `${passed}/${ran.length} scenarios passed${skipped ? ` (${skipped} skipped)` : ""}`;
}
