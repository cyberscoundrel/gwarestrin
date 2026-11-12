/**
 * The source declarations' store: how each connected source is read and committed to (R2, "Each source declares
 * how it is committed to"), normalized by model/sources.js. The sources stream owns this module.
 *
 * Where they come from:
 *   - stored: an OrgPolicy row, scope "sources", holding a list of declarations or an object keyed by system.
 *     The older shape { "<system>": { "read": url, "write": url } } still loads, with no tables named and no
 *     guard, so nothing is written through it until a guard is declared.
 *   - the environment, for a system nothing stored declares: DAB_SYSTEM (default mssql), DAB_READ_URL,
 *     DAB_READ_HOME, DAB_WRITE_URL, DAB_WRITE_TABLES (comma-separated), DAB_WRITE_ACTIONS (comma-separated; default
 *     create,update), DAB_TABLE_SHAPES (JSON: { table: { adds, columns, required, defaults } }, the shapes R18 and R19
 *     read, model/sources.js), DAB_GUARD_SERVER, DAB_GUARD_DATABASE.
 * A stored declaration that doesn't hold leaves its source undeclared. It never falls back to the environment's,
 * which may point somewhere else.
 */
import { log } from "./context.js";
import { adbQuery as realQuery } from "./db.js";
import { normalizeSource } from "./model/sources.js";

const cache = { at: 0, value: null };

/** forget the cached declarations (a test, or a settings change) */
export const forgetSources = () => Object.assign(cache, { at: 0, value: null });

const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** the declaration the environment makes, or null when it names no read endpoint */
export function envDeclaration(env = process.env) {
  const url = env.DAB_READ_URL ?? "http://dab:5000/mcp";
  if (!url) return null;
  const write = env.DAB_WRITE_URL || null;
  const guard = env.DAB_GUARD_SERVER && env.DAB_GUARD_DATABASE ? { server: env.DAB_GUARD_SERVER, database: env.DAB_GUARD_DATABASE } : null;
  const shapes = env.DAB_TABLE_SHAPES ? JSON.parse(env.DAB_TABLE_SHAPES) : {};
  const tables = env.DAB_WRITE_TABLES ? list(env.DAB_WRITE_TABLES).map((t) => (shapes[t] ? { ...shapes[t], name: t } : t)) : null;
  return normalizeSource({
    system: env.DAB_SYSTEM || "mssql",
    read: { via: "dab-mcp", url, home: env.DAB_READ_HOME || null },
    commit: write ? { via: "dab-mcp", url: write, tables, ...(env.DAB_WRITE_ACTIONS ? { actions: list(env.DAB_WRITE_ACTIONS) } : {}), guard } : { via: "none" },
  });
}

/** a stored entry in the older { read, write } shape, as a declaration */
const older = (system, v) => ({ system, read: { via: "dab-mcp", url: v.read }, commit: v.write ? { via: "dab-mcp", url: v.write } : { via: "none" } });

function storedDeclarations(json) {
  const raw = JSON.parse(json);
  const entries = Array.isArray(raw) ? raw.map((d) => [d?.system, d]) : Object.entries(raw ?? {}).map(([system, d]) => [system, typeof d?.read === "string" ? older(system, d) : { system, ...d }]);
  const out = {};
  for (const [system, d] of entries) {
    try {
      const s = normalizeSource(d);
      out[s.system] = s;
    } catch (e) {
      log.warn(`the stored source ${system ?? "?"} doesn't hold, so it is not declared: ${String(e?.message ?? e).slice(0, 160)}`);
      if (system) out[system] = null;
    }
  }
  return out;
}

/**
 * Every declared source by system: the stored declarations, else the environment's. Cached a minute
 * (`ttlMs: 0` reads them as they stand now).
 */
export async function loadSources(db = { adbQuery: realQuery }, { env = process.env, ttlMs = 60_000, now = Date.now() } = {}) {
  if (cache.value && now - cache.at < ttlMs) return cache.value;
  const out = {};
  try {
    const e = envDeclaration(env);
    if (e) out[e.system] = e;
  } catch (e) {
    log.warn(`the environment's source doesn't hold: ${String(e?.message ?? e).slice(0, 160)}`);
  }
  try {
    const row = (await db.adbQuery("SELECT json FROM OrgPolicy WHERE scope = 'sources' LIMIT 1"))[0];
    if (row?.json) Object.assign(out, storedDeclarations(row.json));
  } catch (e) {
    log.warn(`stored sources not read (keeping the environment's): ${String(e).slice(0, 120)}`);
  }
  for (const [k, v] of Object.entries(out)) if (v === null) delete out[k];
  Object.assign(cache, { at: now, value: out });
  return out;
}

/** one source's declaration as it stands now, or null */
export async function sourceFor(system, db, opts = {}) {
  return (await loadSources(db, { ttlMs: 0, ...opts }))[system] ?? null;
}

/**
 * The declaration a test run uses for the synthetic test database (test-sql/README.md). Its home is everyone,
 * in test configuration only, so the first run can file at every level; a declared connection's home is
 * otherwise the root.
 */
export function testDeclaration({ read = "http://dab-read:5000/mcp", write = "http://dab-write:5000/mcp", server = "gwsynth-sql", database = "GwSynthMfg" } = {}) {
  const shapes = TEST_SHAPES;
  return {
    system: "mssql",
    description: "The synthetic test database (invented data)",
    read: { via: "dab-mcp", url: read, home: "everyone" },
    commit: {
      via: "dab-mcp",
      url: write,
      tables: ["dbo_Job", "dbo_Job_Operation", "dbo_Work_Center", "dbo_Sales_Order", "dbo_Purchase_Order", "dbo_Maintenance"].map((t) => (shapes[t] ? { ...shapes[t], name: t } : t)),
      actions: ["create", "update", "delete"],
      guard: { server, database, login: "gwsynth_write" },
    },
  };
}

/**
 * The shapes the synthetic test database declares (R18, R19; test-sql/data.mjs SHAPES makes the same for the harness,
 * and a test in test/sources.test.js holds them equal): which columns are yes/no or take a fixed set of values, and
 * which tables take new rows: Maintenance (aa03, aa05) and Purchase_Order (aq07), the tables a label expects a new row
 * in whose key the source makes (an identity column). Sales_Order and Job_Operation are not: no label adds one, and
 * Sales_Order's key would have to come from the writer.
 */
export const TEST_SHAPES = {
  dbo_Job: { columns: { Certs_Required: "boolean", Status: { values: ["Active", "Hold", "Complete", "Closed"] } } },
  dbo_Job_Operation: { columns: { Status: { values: ["Open", "Active", "Complete"] } } },
  dbo_Work_Center: { columns: { Status: { values: ["Up", "Down"] } } },
  dbo_Sales_Order: { columns: { Status: { values: ["Open", "Shipped", "Closed"] } } },
  dbo_Purchase_Order: { adds: true, columns: { Status: { values: ["Open", "Received", "Closed"] } }, required: ["Vendor", "Description", "Order_Date", "Status"] },
  dbo_Maintenance: { adds: true, columns: { Status: { values: ["Open", "Closed"] } }, required: ["Opened", "Description", "Status"] },
};
