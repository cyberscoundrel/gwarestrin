/**
 * Which threads are on record (docs/ORGANIZATION-MODEL.md, "On record is a deliberate act"), where the tools
 * are. "Off-record content never reaches the graph" is enforced here, not in a prompt: every tool call from a
 * person's chat agent (a delegated token with no graph role) is refused unless its tool only reads or the
 * agent's current thread is on record, and that is only ever set by the person's own instance
 * (PUT /api/thread-record, with the instance's token; an agent's token is refused). Refused at the call, not by
 * leaving the tool off the list: the agent's MCP client keeps the list it fetched when it connected, so a list
 * that changed with the switch would leave a thread just switched on record with no write tool. Anything
 * unknown is off record: an agent never heard of, a state that couldn't be read. Worker, master, handler and
 * liaison tokens are not conversations and are not gated; a person's own token isn't an agent's.
 */
import { log } from "./context.js";
import { adbCommand, adbQuery } from "./db.js";
import { resolveIdentity } from "./scope.js";

/** agent token's identity.key -> { on, thread } (delegation.js: `${user}/agent:${agent}`); read at every tool call */
const threads = new Map();

const keyOf = (user, agent) => `${user}/agent:${agent}`;

/** a person's chat agent: the identities the record applies to */
export const isChatAgent = (identity) => Boolean(identity?.agent) && !identity.role;

/** true when this identity is a chat agent whose current thread is not on record */
export const isOffRecord = (identity) => isChatAgent(identity) && threads.get(identity.key)?.on !== true;

/** the refusal a gated tool answers with (the agent passes it on: the person can switch the thread on) */
export const OFF_RECORD_REFUSAL = "this conversation is off record, so nothing from it can be written to the knowledge graph; the person can switch it on record";

// NEEDS A RULING (record 6): R11.12 says nothing from an off-record thread reaches the graph or any source; reads stay
// open off record (a query carries the conversation's words to the graph service, nothing is stored), reading
// "reaches" as "is stored in or written to".
/**
 * What an off-record chat agent may call: the tools that only read and carry nothing of the conversation into the
 * graph. Everything else is refused, so a tool added later is closed until someone decides it belongs here.
 */
export const OFF_RECORD_TOOLS = new Set(["search_graph", "schema_graph", "query_graph", "about_thing", "read_document", "find_shareable", "list_grants", "list_pending_writes", "open_needs"]);

/** every tool registered on this server from here on refuses an off-record chat agent at the call, before its handler */
export function gateOffRecordTools(server, identity) {
  if (!isChatAgent(identity)) return server;
  const register = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    if (OFF_RECORD_TOOLS.has(name)) return register(name, ...rest);
    const handler = rest.pop();
    return register(name, ...rest, async (...args) => {
      if (isOffRecord(identity)) throw new Error(OFF_RECORD_REFUSAL);
      return handler(...args);
    });
  };
  return server;
}

/** the state as this process knows it; exported for tests */
export function applyThreadRecord(user, agent, { on, thread = null, position = null }) {
  threads.set(keyOf(user, agent), { on: on === true, thread, position: typeof position === "string" && position ? position : null });
}

/**
 * The position the person chose when they put the agent's current thread on record (R11.5: a section starts at
 * the position of the person who put it on record), or null when the thread is off record or none was given.
 */
export const threadPosition = (identity) => (isChatAgent(identity) ? (threads.get(identity.key)?.on === true ? (threads.get(identity.key)?.position ?? null) : null) : null);

/**
 * The person's instance sets a thread's state. Persisted so a restart doesn't drop an on-record thread back
 * to refused or, worse, forget one that was switched off: off takes effect in memory first and is then stored,
 * on is stored first and only then takes effect, so a failed store never leaves a thread more open than it was.
 */
export async function setThreadRecord(identity, { agent, thread = null, on, position = null }) {
  const key = keyOf(identity.user, agent);
  const pos = typeof position === "string" && position ? position : null;
  if (on !== true) threads.set(key, { on: false, thread, position: null });
  const now = new Date().toISOString();
  const params = { r_key: key, r_agent: agent, r_thread: thread, r_on: on === true, r_by: identity.user, r_now: now, r_pos: on === true ? pos : null };
  const done = await adbCommand("UPDATE ThreadRecord SET agent = :r_agent, thread = :r_thread, on_record = :r_on, position = :r_pos, set_by = :r_by, set_at = :r_now WHERE agent_key = :r_key", "sql", params);
  if (Number(done?.[0]?.count ?? 0) === 0) await adbCommand("INSERT INTO ThreadRecord SET agent_key = :r_key, agent = :r_agent, thread = :r_thread, on_record = :r_on, position = :r_pos, set_by = :r_by, set_at = :r_now", "sql", params);
  if (on === true) threads.set(key, { on: true, thread, position: pos });
  log.info(`thread record: ${key} ${on === true ? "on" : "off"} record${thread ? ` (thread ${thread})` : ""}${on === true && pos ? ` under ${pos}` : ""}`);
  return { agent, thread, on: on === true, ...(on === true && pos ? { position: pos } : {}) };
}

/** boot: every thread that was on record before a restart. Unreadable means empty: everything is off record. */
export async function loadThreadRecords() {
  await adbCommand("CREATE DOCUMENT TYPE ThreadRecord IF NOT EXISTS").catch(() => {});
  for (const prop of ["agent_key", "agent", "thread", "position", "set_by", "set_at"]) await adbCommand(`CREATE PROPERTY ThreadRecord.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand("CREATE PROPERTY ThreadRecord.on_record IF NOT EXISTS BOOLEAN").catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON ThreadRecord (agent_key) UNIQUE").catch(() => {});
  try {
    const rows = await adbQuery("SELECT agent_key, thread, position FROM ThreadRecord WHERE on_record = true LIMIT 5000");
    threads.clear();
    for (const r of rows) threads.set(String(r.agent_key), { on: true, thread: r.thread ?? null, position: r.position ?? null });
    log.info(`thread records: ${rows.length} on record`);
  } catch (e) {
    threads.clear();
    log.warn(`thread records unreadable, every chat agent is off record until they're set again: ${String(e).slice(0, 160)}`);
  }
}

/** PUT /api/thread-record { agent, thread?, on, position? }: the instance tells graph-rag what a thread is; an agent can't, whatever it's told */
export function registerThreadRecordRoute(app) {
  app.put("/api/thread-record", (req, res) => {
    const identity = resolveIdentity(req.headers.authorization);
    if (!identity) return res.status(401).json({ error: "unauthenticated" });
    if (identity.agent) return res.status(403).json({ error: "an agent can't change whether a conversation is on record: that's the person's switch" });
    const { agent, thread, on, position } = req.body ?? {};
    if (typeof agent !== "string" || !agent || agent.length > 120) return res.status(400).json({ error: "agent: the agent's id" });
    if (typeof on !== "boolean") return res.status(400).json({ error: "on: true or false" });
    if (thread !== undefined && thread !== null && typeof thread !== "string") return res.status(400).json({ error: "thread: the thread's id" });
    if (position !== undefined && position !== null && (typeof position !== "string" || position.length > 120)) return res.status(400).json({ error: "position: the position it was put on record under" });
    void setThreadRecord(identity, { agent, thread: thread ?? null, on, position: position ?? null }).then(
      (r) => res.json(r),
      (e) => res.status(500).json({ error: String(e instanceof Error ? e.message : e).slice(0, 300) }),
    );
  });
}
