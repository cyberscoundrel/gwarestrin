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
import { instanceSettings } from "../instance/settings.js";
import { scoped } from "../util/log.js";
import type { AgentManager } from "./manager.js";

const log = scoped("graph-pool");

export type GraphCall = (path: string, init?: { method?: "GET" | "PUT" | "POST"; body?: unknown }) => Promise<{ status: number; body: unknown } | null>;

export interface ClaimedThread {
  job: string;
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
}

/** a thread's agent name: readable in the rail, unique */
export const threadName = (title: string, job: string): string => `graph · ${title.replace(/\s+/g, " ").trim().slice(0, 48)} · ${job.slice(0, 4)}`;
export const LIAISON_NAME = "Graph liaison";

export class GraphPool {
  private readonly active = new Set<string>();
  private ticking = false;
  private lastCleanup = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly manager: AgentManager,
    private readonly call: GraphCall,
    private readonly maxAgents: () => number = () => instanceSettings().maxAgents ?? 2,
  ) {}

  start(intervalMs = 15_000): void {
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
      if ((status.open_questions ?? 0) + (status.open_proposals ?? 0) > 0) await this.ensureLiaison(profile.id);
      if (Date.now() - this.lastCleanup > 3_600_000) {
        this.lastCleanup = Date.now();
        await this.cleanup(status.pool?.keepDays ?? 14).catch((e) => log.warn(`cleanup: ${e instanceof Error ? e.message : String(e)}`));
      }
      const room = Math.min(size - this.active.size, this.maxAgents() - this.manager.runningCount());
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
        const record = await this.manager.createAgent({ name: threadName(t.name, t.job), profileId }, { graphRole: role });
        agentId = record.id;
        await this.call(`/api/worker/threads/${t.job}/agent`, { method: "POST", body: { agent_id: agentId } });
      }
      if (!this.manager.getRunning(agentId)) await this.manager.start(agentId);
      const settled = this.manager.waitSettled(agentId, t.minutes * 60_000);
      settled.catch(() => undefined); // awaited below; never unhandled
      await this.manager.promptAgent(agentId, t.message);
      await settled;
      const summary = await this.manager.lastAssistantText(agentId);
      await this.call(`/api/worker/threads/${t.job}/finish`, { method: "POST", body: { status: "done", summary } });
      log.info(`thread ${t.job.slice(0, 8)} (${t.name}) finished`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`thread ${t.job.slice(0, 8)} (${t.name}) failed: ${message}`);
      if (agentId) await this.manager.abortAgent(agentId);
      await this.call(`/api/worker/threads/${t.job}/finish`, { method: "POST", body: { status: "failed", summary: message } }).catch(() => null);
    } finally {
      if (agentId && this.manager.getRunning(agentId)) await this.manager.stop(agentId).catch(() => undefined);
      this.active.delete(t.job);
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
    if (removed) log.info(`removed ${removed} finished thread(s) older than ${keepDays} days`);
    return removed;
  }
}
