/**
 * Which threads are on record (docs/ORGANIZATION-MODEL.md, "On record is a deliberate act"), where the tools
 * are. "Off-record content never reaches the graph" is enforced here, not in a prompt: a person's chat agent
 * (a delegated token with no graph role) has no write tool unless its current thread is on record, and that is
 * only ever set by the person's own instance (PUT /api/thread-record, with the instance's token; an agent's
 * token is refused). Anything unknown is off record: an agent never heard of, a state that couldn't be read.
 * Worker, master, handler and liaison tokens are not conversations and are not gated; a person's own token
 * isn't an agent's.
 */
import { log } from "./context.js";
import { adbCommand, adbQuery } from "./db.js";
import { resolveIdentity } from "./scope.js";

/** agent token's identity.key -> { on, thread } (delegation.js: `${user}/agent:${agent}`); read at every tool listing and call */
const threads = new Map();

const keyOf = (user, agent) => `${user}/agent:${agent}`;

/** a person's chat agent: the identities the record applies to */
export const isChatAgent = (identity) => Boolean(identity?.agent) && !identity.role;

/** true when this identity is a chat agent whose current thread is not on record */
export const isOffRecord = (identity) => isChatAgent(identity) && threads.get(identity.key)?.on !== true;

/** the refusal a gated tool answers with (the agent passes it on: the person can switch the thread on) */
export const OFF_RECORD_REFUSAL = "this conversation is off record, so nothing from it can be written to the knowledge graph; the person can switch it on record";

/** the state as this process knows it; exported for tests */
export function applyThreadRecord(user, agent, { on, thread = null }) {
  threads.set(keyOf(user, agent), { on: on === true, thread });
}

/**
 * The person's instance sets a thread's state. Persisted so a restart doesn't drop an on-record thread back
 * to refused or, worse, forget one that was switched off: off takes effect in memory first and is then stored,
 * on is stored first and only then takes effect, so a failed store never leaves a thread more open than it was.
 */
export async function setThreadRecord(identity, { agent, thread = null, on }) {
  const key = keyOf(identity.user, agent);
  if (on !== true) threads.set(key, { on: false, thread });
  const now = new Date().toISOString();
  const params = { r_key: key, r_agent: agent, r_thread: thread, r_on: on === true, r_by: identity.user, r_now: now };
  const done = await adbCommand("UPDATE ThreadRecord SET agent = :r_agent, thread = :r_thread, on_record = :r_on, set_by = :r_by, set_at = :r_now WHERE agent_key = :r_key", "sql", params);
  if (Number(done?.[0]?.count ?? 0) === 0) await adbCommand("INSERT INTO ThreadRecord SET agent_key = :r_key, agent = :r_agent, thread = :r_thread, on_record = :r_on, set_by = :r_by, set_at = :r_now", "sql", params);
  if (on === true) threads.set(key, { on: true, thread });
  log.info(`thread record: ${key} ${on === true ? "on" : "off"} record${thread ? ` (thread ${thread})` : ""}`);
  return { agent, thread, on: on === true };
}

/** boot: every thread that was on record before a restart. Unreadable means empty: everything is off record. */
export async function loadThreadRecords() {
  await adbCommand("CREATE DOCUMENT TYPE ThreadRecord IF NOT EXISTS").catch(() => {});
  for (const prop of ["agent_key", "agent", "thread", "set_by", "set_at"]) await adbCommand(`CREATE PROPERTY ThreadRecord.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand("CREATE PROPERTY ThreadRecord.on_record IF NOT EXISTS BOOLEAN").catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON ThreadRecord (agent_key) UNIQUE").catch(() => {});
  try {
    const rows = await adbQuery("SELECT agent_key, thread FROM ThreadRecord WHERE on_record = true LIMIT 5000");
    threads.clear();
    for (const r of rows) threads.set(String(r.agent_key), { on: true, thread: r.thread ?? null });
    log.info(`thread records: ${rows.length} on record`);
  } catch (e) {
    threads.clear();
    log.warn(`thread records unreadable, every chat agent is off record until they're set again: ${String(e).slice(0, 160)}`);
  }
}

/** PUT /api/thread-record { agent, thread?, on }: the instance tells graph-rag what a thread is; an agent can't, whatever it's told */
export function registerThreadRecordRoute(app) {
  app.put("/api/thread-record", (req, res) => {
    const identity = resolveIdentity(req.headers.authorization);
    if (!identity) return res.status(401).json({ error: "unauthenticated" });
    if (identity.agent) return res.status(403).json({ error: "an agent can't change whether a conversation is on record: that's the person's switch" });
    const { agent, thread, on } = req.body ?? {};
    if (typeof agent !== "string" || !agent || agent.length > 120) return res.status(400).json({ error: "agent: the agent's id" });
    if (typeof on !== "boolean") return res.status(400).json({ error: "on: true or false" });
    if (thread !== undefined && thread !== null && typeof thread !== "string") return res.status(400).json({ error: "thread: the thread's id" });
    void setThreadRecord(identity, { agent, thread: thread ?? null, on }).then(
      (r) => res.json(r),
      (e) => res.status(500).json({ error: String(e instanceof Error ? e.message : e).slice(0, 300) }),
    );
  });
}
