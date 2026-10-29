/**
 * The graph worker pool, run by the admin's workspace: one agent thread per
 * queue entry. graph-rag holds the queue (review jobs); this claims what the
 * pool has room for, makes each thread an agent under the Graph worker
 * profile (or wakes the one it had), sends it its brief, waits for its turn
 * to end, reports back and stops it. Threads stay in the rail (an admin can
 * open one and talk to it) until they're deleted after the pool's keepDays.
 *
 * Only a workspace graph-rag accepts as the organization's root gets
 * anything from the claim endpoint, so other workspaces just idle.
 */
import type { AgentRecord, GraphRole } from "@gwarestrin/shared";
import { instanceSettings, modelRefusal } from "../instance/settings.js";
import { scoped } from "../util/log.js";
import type { AgentManager } from "./manager.js";

const log = scoped("graph-pool");

export type GraphCall = (path: string, init?: { method?: "GET" | "PUT" | "POST"; body?: unknown }) => Promise<{ status: number; body: unknown } | null>;

export interface ClaimedThread {
  job: string;
  /** the level of work the master gave it (1 quick check, 2 investigation, 3 broad): picks its model */
  level?: number | undefined;
  entry: string;
  name: string;
  agent_id: string | null;
  minutes: number;
  message: string;
}

interface PoolStatus {
  pool?: { poolSize: number; keepDays: number };
  open_questions?: number;
  open_proposals?: number;
  master?: { on: boolean; halted: boolean; handlers: number; signals: number } | null;
}

interface ClaimedHandler {
  job: string;
  worker: string;
  title: string;
  message: string;
}

/** a thread's agent name: readable in the rail, unique */
export const threadName = (title: string, job: string): string => `graph · ${title.replace(/\s+/g, " ").trim().slice(0, 48)} · ${job.slice(0, 4)}`;
export const LIAISON_NAME = "Graph liaison";
export const MASTER_NAME = "Graph master";
/** a handler's agent name: in the rail, for the operator to open */
export const handlerName = (title: string, job: string): string => `handler · ${title.replace(/\s+/g, " ").trim().slice(0, 44)} · ${job.slice(0, 4)}`;
const MASTER_IDLE_MS = 10 * 60_000;
const MASTER_TURN_MS = 60 * 60_000;
/** a master turn with no event this long is a stalled request: aborted, and the master told to carry on */
const MASTER_STALL_MS = 5 * 60_000;
const MASTER_NUDGES = 2;
const CARRY_ON =
  "Your last request stalled and was stopped. Carry on with the signals above from where you were: check what you already started (worker_status) before starting anything again.";
const HANDLER_TURN_MS = 20 * 60_000;

export class GraphPool {
  private readonly active = new Set<string>();
  private masterBusy = false;
  private lastMasterTurn = 0;
  private handlersBusy = false;
  private ticking = false;
  private lastCleanup = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly manager: AgentManager,
    private readonly call: GraphCall,
    private readonly maxAgents: () => number = () => instanceSettings().maxAgents ?? 2,
    private readonly stallMs: number = MASTER_STALL_MS,
  ) {}

  /**
   * Graph agents that ran before a restart lost their process but not their
   * sandbox (a microVM keeps its memory while it exists): give those back,
   * keeping their conversations.
   */
  async releaseOrphans(): Promise<number> {
    let n = 0;
    for (const a of this.manager.store.list()) {
      if (!a.graphRole || this.manager.getRunning(a.id)) continue;
      await this.manager.releaseAgent(a.id).then(() => n++, () => undefined);
    }
    if (n) log.info(`gave back ${n} graph agent sandbox(es) left from before the restart`);
    return n;
  }

  /**
   * Running handlers and workers the operator opened hold a slot until given
   * back: a handler once its decision is recorded, any of them after a
   * quarter of an hour idle. (The master gives itself back in its own turn.)
   */
  async releaseIdle(): Promise<void> {
    let decided: Set<string> | null = null;
    for (const a of this.manager.store.list()) {
      const role = a.graphRole;
      if (!role || role.kind === "master" || role.kind === "liaison") continue;
      if (role.kind === "worker" && this.active.has(role.job)) continue; // the pool is running it
      const agent = this.manager.getRunning(a.id);
      if (!agent || agent.busy) continue;
      let release = agent.idleMs() > 15 * 60_000;
      if (!release && role.kind === "handler") {
        if (!decided) {
          const hs = await this.call("/api/worker/handlers");
          decided = new Set(((hs?.status === 200 ? (hs.body as { handlers?: Array<{ id: string; status: string }> }).handlers : []) ?? []).filter((h) => h.status === "done").map((h) => h.id));
        }
        release = decided.has(role.job) && agent.idleMs() > 30_000;
      }
      if (release) await this.manager.releaseAgent(a.id).catch((e) => log.warn(`release ${a.name}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  start(intervalMs = 15_000): void {
    void this.releaseOrphans().catch(() => undefined);
    this.timer = setInterval(() => void this.tick().catch((e) => log.warn(`tick: ${e instanceof Error ? e.message : String(e)}`)), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** one round: claim what there's room for, start those threads, keep the liaison, clean up */
  async tick(): Promise<{ started: number }> {
    if (this.ticking) return { started: 0 };
    this.ticking = true;
    try {
      const profile = this.manager.profiles.graphWorker();
      if (!profile) return { started: 0 };
      const st = await this.call("/api/worker");
      if (st?.status !== 200) return { started: 0 }; // not the organization's root, or no graph
      const status = st.body as PoolStatus;
      const size = status.pool?.poolSize ?? 0;
      await this.releaseIdle().catch((e) => log.warn(`release idle: ${e instanceof Error ? e.message : String(e)}`));
      if (status.master?.on) {
        // the master's inbox and the handlers run alongside the pool (they don't take worker slots)
        void this.masterTurn(profile.id).catch((e) => log.warn(`master: ${e instanceof Error ? e.message : String(e)}`));
        void this.startHandlers(profile.id).catch((e) => log.warn(`handlers: ${e instanceof Error ? e.message : String(e)}`));
      } else if ((status.open_questions ?? 0) + (status.open_proposals ?? 0) > 0) await this.ensureLiaison(profile.id);
      if (Date.now() - this.lastCleanup > 3_600_000) {
        this.lastCleanup = Date.now();
        await this.cleanup(status.pool?.keepDays ?? 14).catch((e) => log.warn(`cleanup: ${e instanceof Error ? e.message : String(e)}`));
      }
      // with a master, workers leave one agent slot free: the master's turns and handlers never starve
      const reserve = status.master?.on ? 1 : 0;
      const room = Math.min(size - this.active.size, this.maxAgents() - this.manager.runningCount() - reserve);
      if (room <= 0) return { started: 0 };
      const claimed = await this.call("/api/worker/threads/claim", { method: "POST", body: { limit: room } });
      const threads = claimed?.status === 200 ? ((claimed.body as { threads?: ClaimedThread[] }).threads ?? []) : [];
      for (const t of threads) void this.run(t, profile.id);
      return { started: threads.length };
    } finally {
      this.ticking = false;
    }
  }

  /** one thread's turn, start to report */
  async run(t: ClaimedThread, profileId: string): Promise<void> {
    this.active.add(t.job);
    let agentId: string | null = t.agent_id && this.manager.store.get(t.agent_id) ? t.agent_id : null;
    try {
      if (!agentId) {
        const role: GraphRole = { kind: "worker", job: t.job, entry: t.entry, title: t.name };
        // the model for its level of work, when the profile names one (else the profile's own)
        const levelModel = this.manager.profiles.graphWorker()?.graphWorker?.levelModels?.[String(t.level) as "1" | "2" | "3"];
        const record = await this.manager.createAgent({ name: threadName(t.name, t.job), profileId, ...(levelModel && !modelRefusal(levelModel.provider, levelModel.modelId) ? { model: levelModel } : {}) }, { graphRole: role });
        agentId = record.id;
        await this.call(`/api/worker/threads/${t.job}/agent`, { method: "POST", body: { agent_id: agentId } });
      }
      if (!this.manager.getRunning(agentId)) await this.manager.start(agentId);
      const settled = this.manager.waitSettled(agentId, t.minutes * 60_000);
      settled.catch(() => undefined); // awaited below; never unhandled
      await this.manager.promptAgent(agentId, t.message);
      await settled;
      // a turn that ended on a model error (after pi's own retries) or a stop hasn't done its work:
      // it goes back for another try, in the same conversation, instead of counting as done
      const turn = await this.manager.lastTurn(agentId);
      if (turn.ended) {
        log.warn(`thread ${t.job.slice(0, 8)} (${t.name}): ${turn.ended}`);
        const summary = turn.text ? `${turn.text}\n\n(${turn.ended})` : turn.ended;
        await this.call(`/api/worker/threads/${t.job}/finish`, { method: "POST", body: { status: "failed", summary } });
      } else {
        await this.call(`/api/worker/threads/${t.job}/finish`, { method: "POST", body: { status: "done", summary: turn.text } });
        log.info(`thread ${t.job.slice(0, 8)} (${t.name}) finished`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`thread ${t.job.slice(0, 8)} (${t.name}) failed: ${message}`);
      if (agentId) await this.manager.abortAgent(agentId);
      await this.call(`/api/worker/threads/${t.job}/finish`, { method: "POST", body: { status: "failed", summary: message } }).catch(() => null);
    } finally {
      // a finished turn gives back its sandbox (a microVM holds memory while it exists); the conversation is kept
      const done = agentId;
      if (done) await this.manager.releaseAgent(done).catch((e) => log.warn(`release ${done.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`));
      this.active.delete(t.job);
    }
  }

  /**
   * The master's turn: when signals wait, wake it (one at a time), give it
   * them as one message, and wait for its turn to end; compact its context
   * after a batch; give back its sandbox when it's been idle a while (its
   * conversation is kept: it runs for a long time, not continuously).
   */
  async masterTurn(profileId: string): Promise<void> {
    if (this.masterBusy) return;
    this.masterBusy = true;
    try {
      const master = await this.ensureMaster(profileId);
      const res = await this.call("/api/worker/signals");
      const body = (res?.status === 200 ? res.body : null) as { signals?: Array<{ id: string; kind: string }>; message?: string } | null;
      const signals = body?.signals ?? [];
      if (!signals.length) {
        if (this.manager.getRunning(master.id) && Date.now() - this.lastMasterTurn > MASTER_IDLE_MS) {
          await this.manager.releaseAgent(master.id).catch((e) => log.warn(`release master: ${e instanceof Error ? e.message : String(e)}`));
        }
        return;
      }
      if (!this.manager.getRunning(master.id)) {
        if (this.manager.runningCount() >= this.maxAgents()) return; // no room right now: next tick
        await this.manager.start(master.id);
      }
      for (let nudge = 0; ; nudge++) {
        const settled = this.manager.waitSettled(master.id, MASTER_TURN_MS);
        settled.catch(() => undefined);
        await this.manager.promptAgent(master.id, nudge === 0 ? (body?.message ?? "") : CARRY_ON);
        if (nudge === 0) await this.call("/api/worker/signals/ack", { method: "POST", body: { ids: signals.map((x) => x.id) } });
        if ((await this.settleOrStall(master.id, settled)) === "settled") break;
        // a stalled request: stop it (that ends the turn) and carry on, a couple of times; then start it afresh next tick
        await this.manager.abortAgent(master.id);
        await settled.catch(() => undefined);
        if (nudge >= MASTER_NUDGES) {
          log.warn("the master stalled again: given back, it starts afresh with its conversation next tick");
          await this.manager.releaseAgent(master.id).catch(() => undefined);
          return;
        }
        log.warn(`the master's request stalled (${Math.round(this.stallMs / 60_000)} min without an event): stopped, told to carry on`);
      }
      this.lastMasterTurn = Date.now();
      // a batch is a lot to keep: compact between batches
      if (signals.some((x) => x.kind === "batch")) await this.manager.compactAgent(master.id).catch((e) => log.warn(`compact master: ${e instanceof Error ? e.message : String(e)}`));
      log.info(`master handled ${signals.length} signal(s)`);
    } finally {
      this.masterBusy = false;
    }
  }

  /** the turn ends, or goes quiet past the stall limit */
  private settleOrStall(id: string, settled: Promise<void>): Promise<"settled" | "stalled"> {
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const agent = this.manager.getRunning(id) as { quietMs?: () => number } | undefined;
        if ((agent?.quietMs?.() ?? 0) > this.stallMs) {
          clearInterval(timer);
          resolve("stalled");
        }
      }, Math.max(10, Math.min(30_000, this.stallMs / 4)));
      settled.then(
        () => (clearInterval(timer), resolve("settled")),
        (e) => (clearInterval(timer), reject(e)),
      );
    });
  }

  async ensureMaster(profileId: string): Promise<AgentRecord> {
    const existing = this.manager.store.list().find((a) => a.graphRole?.kind === "master");
    if (existing) return existing;
    log.info("making the graph master");
    return this.manager.createAgent({ name: MASTER_NAME, profileId }, { graphRole: { kind: "master" } });
  }

  /**
   * Start handlers the master asked for, one at a time: each explains its
   * stopped worker to the operator in its first turn, then waits in the rail
   * (its sandbox given back) until the operator opens it and decides.
   */
  async startHandlers(profileId: string): Promise<void> {
    if (this.handlersBusy || this.manager.runningCount() >= this.maxAgents()) return;
    this.handlersBusy = true;
    try {
      const res = await this.call("/api/worker/handlers/claim", { method: "POST", body: {} });
      const handlers = res?.status === 200 ? ((res.body as { handlers?: ClaimedHandler[] }).handlers ?? []) : [];
      for (const h of handlers) {
        let id: string | null = null;
        try {
          const record = await this.manager.createAgent({ name: handlerName(h.title, h.job), profileId }, { graphRole: { kind: "handler", job: h.job, worker: h.worker, title: h.title } });
          id = record.id;
          await this.manager.start(id);
          const settled = this.manager.waitSettled(id, HANDLER_TURN_MS);
          settled.catch(() => undefined);
          await this.manager.promptAgent(id, h.message);
          await settled;
        } catch (e) {
          log.warn(`handler ${h.job.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          await this.call(`/api/worker/handlers/${h.job}/waiting`, { method: "POST", body: { agent_id: id } }).catch(() => null);
          if (id) await this.manager.releaseAgent(id).catch(() => undefined);
        }
      }
    } finally {
      this.handlersBusy = false;
    }
  }

  /** the liaison exists (stopped until an admin opens it) whenever something waits on the admin */
  async ensureLiaison(profileId: string): Promise<AgentRecord> {
    const existing = this.manager.store.list().find((a) => a.graphRole?.kind === "liaison");
    if (existing) return existing;
    log.info("questions or proposals are waiting: making the liaison");
    return this.manager.createAgent({ name: LIAISON_NAME, profileId }, { graphRole: { kind: "liaison" } });
  }

  /** finished threads go after keepDays (their entry's record stays in graph-rag) */
  async cleanup(keepDays: number): Promise<number> {
    const res = await this.call("/api/worker/threads");
    if (res?.status !== 200) return 0;
    const jobs = new Map(((res.body as { threads?: Array<{ id: string; status: string; updated_at?: string }> }).threads ?? []).map((t) => [t.id, t]));
    const cutoff = Date.now() - keepDays * 86_400_000;
    let removed = 0;
    for (const a of this.manager.store.list()) {
      if (a.graphRole?.kind !== "worker" || this.manager.getRunning(a.id) || this.active.has(a.graphRole.job)) continue;
      const job = jobs.get(a.graphRole.job);
      const finished = !job || job.status === "done" || job.status === "failed";
      const last = Date.parse(job?.updated_at ?? a.createdAt);
      if (finished && Number.isFinite(last) && last < cutoff) {
        await this.manager.deleteAgent(a.id, true).catch((e) => log.warn(`delete ${a.name}: ${e instanceof Error ? e.message : String(e)}`));
        removed++;
      }
    }
    // handlers whose stop was settled a day ago leave the rail
    const hs = await this.call("/api/worker/handlers");
    const handlerJobs = new Map(((hs?.status === 200 ? (hs.body as { handlers?: Array<{ id: string; status: string; updated_at?: string }> }).handlers : []) ?? []).map((h) => [h.id, h]));
    for (const a of this.manager.store.list()) {
      if (a.graphRole?.kind !== "handler" || this.manager.getRunning(a.id)) continue;
      const h = handlerJobs.get(a.graphRole.job);
      if (h?.status === "done" && Date.parse(h.updated_at ?? "") < Date.now() - 86_400_000) {
        await this.manager.deleteAgent(a.id, true).catch(() => undefined);
        removed++;
      }
    }
    if (removed) log.info(`removed ${removed} finished thread(s) older than ${keepDays} days`);
    return removed;
  }
}
