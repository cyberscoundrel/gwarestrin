/**
 * HTTP: discovered commitment classes (docs/ORGANIZATION-MODEL.md, "Classes
 * and instances"; the Discovery stream). Drafts come from the survey (a
 * thread files CommitmentClass vertices, pool.js surveyBrief), from the
 * digest loader here, or from a discovery event (a new table, a class a
 * worker filed); a person with the admin capability confirms, renames or
 * retires them; confirmed classes are what every later mapping uses.
 *
 * The integrator wires `registerDiscoveryRoutes(app)` into routes.js and
 * `ensureDiscoverySchema()` into boot (the routes also ensure it lazily, so
 * the group works before boot is wired).
 *
 *   GET  /api/discovery/classes[?status=]     every class (drafts, confirmed, retired) and whether the caller may confirm
 *   GET  /api/discovery/resolve?key=          the confirmed class a record key or table maps to (null until confirmed)
 *   POST /api/discovery/draft                 the loader: { system, digest (text or { tables }), patterns? } -> files drafts    admin
 *   POST /api/discovery/event                 incremental: { system, table } or { filed, by } -> one draft or why not       admin
 *   POST /api/discovery/classes/:name/confirm { name?, description?, stages?, record_table? } by the caller                admin
 *   POST /api/discovery/classes/:name/retire  { reason? }                                                                    admin
 *
 * "admin" is the same gate as policy edits: `canEditPolicy` (org-policy.js),
 * a person at the root, never an agent.
 */
import { log } from "./context.js";
import { adbCommand, adbQuery } from "./db.js";
import { canEditPolicy } from "./org-policy.js";
import { resolveIdentity, scopeOf } from "./scope.js";
import { CLASS_STATUSES, parseTable, statements, TYPES } from "./model/schema.js";
import { classFor, className, classList, discoverIncremental, draftClasses, EXTRA_CLASS_PROPERTIES, fileDraftSql, parseDigest, sqlLiteral, stageName } from "./discovery.js";

const NAME_RE = /^[a-z][a-z0-9_]{0,59}$/;
const COLUMNS = [...Object.keys(TYPES.CommitmentClass.properties), ...Object.keys(EXTRA_CLASS_PROPERTIES)];

/** the class vertex as the contract declares it, plus this stream's two list properties; idempotent */
export async function ensureDiscoverySchema() {
  for (const sql of statements({ CommitmentClass: TYPES.CommitmentClass })) await adbCommand(sql).catch((e) => log.warn(`discovery schema: ${String(e).slice(0, 120)}`));
  for (const [prop, type] of Object.entries(EXTRA_CLASS_PROPERTIES)) await adbCommand(`CREATE PROPERTY CommitmentClass.${prop} IF NOT EXISTS ${type}`).catch(() => {});
}
let ready = null;
const ensure = () => (ready ??= ensureDiscoverySchema().catch((e) => {
  ready = null;
  throw e;
}));

/** a stored row as the API shows it: lists are lists, nulls are nulls */
function shape(r) {
  const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v.startsWith("[") ? JSON.parse(v) : []);
  return {
    name: r.name,
    description: r.description ?? null,
    stages: list(r.stages),
    record_table: r.record_table ?? null,
    status: r.status,
    proposed_by: r.proposed_by ?? null,
    confirmed_by: r.confirmed_by ?? null,
    confirmed_at: r.confirmed_at ?? null,
    attributes: list(r.attributes),
    reasons: list(r.reasons),
  };
}

/** every class, or those of one status */
export async function listClasses(status = null) {
  await ensure();
  const where = status ? ` WHERE status = ${sqlLiteral(status)}` : "";
  return (await adbQuery(`SELECT ${COLUMNS.join(", ")} FROM CommitmentClass${where} ORDER BY name`)).map(shape);
}

/** the confirmed classes, the shape `model/claims.js classIndex` takes: what claims, policy and the linker may map onto */
export const confirmedClasses = () => listClasses("confirmed");

async function classNamed(name) {
  await ensure();
  const r = (await adbQuery(`SELECT ${COLUMNS.join(", ")} FROM CommitmentClass WHERE name = ${sqlLiteral(name)} LIMIT 1`))[0];
  return r ? shape(r) : null;
}

/**
 * File drafts as `proposed` rows, each checked against what exists the way a
 * discovery event is (a known name or record table is not drafted twice).
 */
export async function fileDrafts(drafts) {
  const existing = await listClasses();
  const filed = [];
  const skipped = [];
  for (const d of drafts) {
    const r = discoverIncremental(existing, { filed: { ...d, reasons: d.reasons }, by: d.proposed_by });
    if (!r.draft) {
      skipped.push({ name: d.name, reason: r.reason, ...(r.existing ? { existing: r.existing } : {}) });
      continue;
    }
    // the event's normalization keeps the draft's own description and reasons
    const draft = { ...r.draft, description: d.description ?? r.draft.description, reasons: d.reasons?.length ? d.reasons : r.draft.reasons, proposed_by: d.proposed_by ?? r.draft.proposed_by };
    await adbCommand(fileDraftSql(draft), "sql");
    existing.push(draft);
    filed.push(draft);
  }
  return { filed, skipped };
}

/** the loader: a connection's digest (text, or parsed tables) and the survey's pattern entries -> drafts filed */
export async function draftFromDigest({ system, digest, patterns = [], by }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(String(system ?? ""))) throw Object.assign(new Error("which connection (its name, the first part of every key)"), { status: 400 });
  const parsed = typeof digest === "string" ? parseDigest(digest, system) : { system, tables: Array.isArray(digest?.tables) ? digest.tables : [] };
  if (!parsed.tables.length) throw Object.assign(new Error("the digest names no tables"), { status: 400 });
  const { drafts, skipped } = draftClasses(parsed, patterns, { proposed_by: by ? `discovery:${by}` : undefined });
  const r = await fileDrafts(drafts);
  return { drafted: r.filed, not_drafted: r.skipped, tables_skipped: skipped };
}

/** one discovery event: a new table, or a class a worker filed */
export async function fileEvent(event) {
  const existing = await listClasses();
  const r = discoverIncremental(existing, event);
  if (!r.draft) return { draft: null, reason: r.reason, ...(r.existing ? { existing: r.existing } : {}), ...(r.skipped ? { skipped: r.skipped } : {}) };
  await adbCommand(fileDraftSql(r.draft), "sql");
  return { draft: r.draft };
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * A person confirms a draft, correcting its name, description, stages or
 * record table as they confirm. The class becomes what claims and policy map
 * onto; the confirmer and the time are recorded on it.
 */
export async function confirmClass(name, input, identity) {
  const cur = await classNamed(name);
  if (!cur) throw fail(`no class "${name}"`, 404);
  const next = {
    name: input?.name !== undefined && input.name !== null && String(input.name).trim() ? className(String(input.name)) : cur.name,
    description: input?.description !== undefined ? (input.description === null ? null : String(input.description).replace(/\s+/g, " ").trim().slice(0, 400) || null) : cur.description,
    stages: input?.stages !== undefined ? (Array.isArray(input.stages) ? input.stages : String(input.stages).split(",")).map(stageName).filter(Boolean) : cur.stages,
    record_table: input?.record_table !== undefined ? (input.record_table === null || String(input.record_table).trim() === "" ? null : String(input.record_table).trim()) : cur.record_table,
  };
  if (!NAME_RE.test(next.name)) throw fail("a class name is snake_case: orders, purchase_orders");
  next.stages = next.stages.filter((s, i, a) => a.indexOf(s) === i).slice(0, 20);
  if (!next.stages.length) throw fail("a class has at least one stage (stage is the attribute every class has)");
  if (next.record_table !== null && !parseTable(next.record_table)) throw fail("a record table is system:table (mssql:dbo_Order), or empty when no source system records the class");
  const others = (await listClasses()).filter((c) => c.name !== cur.name);
  if (others.some((c) => c.name === next.name)) throw fail(`a class called "${next.name}" exists already`, 409);
  if (next.record_table && others.some((c) => c.record_table === next.record_table && c.status !== "retired")) throw fail(`${next.record_table} is already the record table of "${others.find((c) => c.record_table === next.record_table).name}"`, 409);
  const now = new Date().toISOString();
  const attributes = cur.attributes.includes("stage") ? cur.attributes : ["stage", ...cur.attributes];
  await adbCommand(
    `UPDATE CommitmentClass SET name = ${sqlLiteral(next.name)}, description = ${sqlLiteral(next.description)}, stages = ${sqlLiteral(next.stages)}, record_table = ${sqlLiteral(next.record_table)}, attributes = ${sqlLiteral(attributes)}, status = 'confirmed', confirmed_by = ${sqlLiteral(identity.user)}, confirmed_at = ${sqlLiteral(now)} WHERE name = ${sqlLiteral(cur.name)}`,
    "sql",
  );
  log.info(`class "${cur.name}" confirmed${next.name !== cur.name ? ` as "${next.name}"` : ""} by ${identity.user}: stages ${next.stages.join(" > ")}, table ${next.record_table ?? "none"}`);
  return { class: { ...cur, ...next, attributes, status: "confirmed", confirmed_by: identity.user, confirmed_at: now } };
}

/** a person retires a class: a wrong draft, or a confirmed class no longer in use; nothing maps onto it from then on */
export async function retireClass(name, reason, identity) {
  const cur = await classNamed(name);
  if (!cur) throw fail(`no class "${name}"`, 404);
  if (cur.status === "retired") return { class: cur };
  const note = `retired by ${identity.user} on ${new Date().toISOString().slice(0, 10)}${reason ? `: ${String(reason).replace(/\s+/g, " ").trim().slice(0, 300)}` : ""}`;
  const reasons = [...cur.reasons, note].slice(-12);
  await adbCommand(`UPDATE CommitmentClass SET status = 'retired', reasons = ${sqlLiteral(reasons)} WHERE name = ${sqlLiteral(cur.name)}`, "sql");
  log.info(`class "${cur.name}" ${note}`);
  return { class: { ...cur, status: "retired", reasons } };
}

/** ---- the express routes ---- */
const httpError = (res, e) => res.status(Number(e?.status) || 500).json({ error: String(e?.message ?? e).slice(0, 300) });

/** anyone authenticated reads classes (confirmed ones are what mapping uses); the admin gate is for changes */
const reader = (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return void res.status(401).json({ error: "unauthenticated" });
  return identity;
};
/** the gate policy edits use: a person at the root (canEditPolicy, org-policy.js) */
const admin = (req, res) => {
  const identity = reader(req, res);
  if (!identity) return null;
  if (!canEditPolicy(identity, scopeOf(identity))) return void res.status(403).json({ error: "only a person at the organization's root confirms or retires classes" });
  return identity;
};
const nameParam = (req, res) => {
  const name = String(req.params.name ?? "");
  if (!NAME_RE.test(name)) return void res.status(400).json({ error: "a class name is snake_case" });
  return name;
};

export function registerDiscoveryRoutes(app) {
  app.get("/api/discovery/classes", (req, res) => {
    const identity = reader(req, res);
    if (!identity) return;
    const status = CLASS_STATUSES.includes(String(req.query.status)) ? String(req.query.status) : null;
    void listClasses(status).then((classes) => res.json({ classes, canConfirm: canEditPolicy(identity, scopeOf(identity)) }), (e) => httpError(res, e));
  });
  app.get("/api/discovery/resolve", (req, res) => {
    if (!reader(req, res)) return;
    const key = String(req.query.key ?? "").slice(0, 300);
    void confirmedClasses().then((classes) => res.json({ key, class: classFor(key, classList(classes)) }), (e) => httpError(res, e));
  });
  app.post("/api/discovery/draft", (req, res) => {
    const identity = admin(req, res);
    if (!identity) return;
    const b = req.body ?? {};
    void draftFromDigest({ system: b.system, digest: b.digest, patterns: Array.isArray(b.patterns) ? b.patterns.slice(0, 200) : [], by: identity.user }).then((r) => res.json(r), (e) => httpError(res, e));
  });
  app.post("/api/discovery/event", (req, res) => {
    const identity = admin(req, res);
    if (!identity) return;
    const b = req.body ?? {};
    const event = b.filed ? { filed: b.filed, by: typeof b.by === "string" ? b.by.slice(0, 120) : identity.user } : { system: b.system, table: b.table, patterns: Array.isArray(b.patterns) ? b.patterns.slice(0, 200) : [], by: identity.user };
    void fileEvent(event).then((r) => res.json(r), (e) => httpError(res, e));
  });
  app.post("/api/discovery/classes/:name/confirm", (req, res) => {
    const identity = admin(req, res);
    if (!identity) return;
    const name = nameParam(req, res);
    if (!name) return;
    void confirmClass(name, req.body ?? {}, identity).then((r) => res.json(r), (e) => httpError(res, e));
  });
  app.post("/api/discovery/classes/:name/retire", (req, res) => {
    const identity = admin(req, res);
    if (!identity) return;
    const name = nameParam(req, res);
    if (!name) return;
    void retireClass(name, req.body?.reason, identity).then((r) => res.json(r), (e) => httpError(res, e));
  });
}
