/**
 * The master (pool.master), its handlers and the liaison: batches, signals, starting and settling workers, and
 * the MCP registration of their tools.
 */
import { randomUUID } from "node:crypto";
import { EVERYONE, homeName, moveKind } from "./positions.js";
import { z } from "zod";
import { log } from "./context.js";
import { adbCommand, adbQuery, RID_RE } from "./db.js";
import { positionMap } from "./scope.js";
import { approvePending, rejectPending } from "./write.js";
import { answerQuestions, createTask, JOB_ID_RE, listProposals, listQuestions, proposalLands, resumeThread, worker } from "./worker-pool.js";

/**
 * ---- the master (pool.master): a long-running thread plans batches of saved
 * entries and starts workers; graph-rag keeps its inbox (Signal), the batches
 * (Batch) and the handlers (Job kind "handler": one stopped worker each, which
 * the operator settles). Workers started by the master have parent MASTER.
 */
export const MASTER = "master";

export async function ensureMasterSchema() {
  // (BATCH is a reserved word in ArcadeDB SQL: the type is WorkBatch)
  for (const type of ["Signal", "WorkBatch"]) await adbCommand(`CREATE DOCUMENT TYPE ${type} IF NOT EXISTS`).catch(() => {});
  for (const prop of ["id", "kind", "job_id", "batch_id", "data", "status", "created_at"]) await adbCommand(`CREATE PROPERTY Signal.${prop} IF NOT EXISTS STRING`).catch(() => {});
  for (const prop of ["id", "entries", "status", "created_at"]) await adbCommand(`CREATE PROPERTY WorkBatch.${prop} IF NOT EXISTS STRING`).catch(() => {});
  await adbCommand("CREATE INDEX IF NOT EXISTS ON Signal (status) NOTUNIQUE").catch(() => {});
}

export async function emitSignal(kind, { job_id = null, batch_id = null, data = {} } = {}) {
  await adbCommand("INSERT INTO Signal SET id = :id, kind = :k, job_id = :j, batch_id = :b, data = :d, status = 'new', created_at = :now", "sql", {
    id: randomUUID(),
    k: kind,
    j: job_id,
    b: batch_id,
    d: JSON.stringify(data),
    now: new Date().toISOString(),
  });
}

/** a stopped worker's open questions and undecided proposals */
export async function openItems(jobId) {
  const questions = await adbQuery("SELECT id, question, options FROM WorkerQuestion WHERE job_id = :id AND status = 'open'", { id: jobId }).catch(() => []);
  const proposals = await adbQuery("SELECT id, kind, note, payload FROM PendingWrite WHERE job_id = :id AND status = 'pending'", { id: jobId }).catch(() => []);
  return {
    questions: questions.map((q) => ({ id: q.id, question: q.question, options: JSON.parse(q.options || "[]") })),
    proposals: await Promise.all(proposals.map(async (p) => ({ id: p.id, kind: p.kind, lands: await proposalLands(p.kind, p.payload), reason: p.note ?? "" }))),
  };
}

const openHandlers = async () => Number((await adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'handler' AND status IN ['pending', 'running', 'waiting']").catch(() => []))[0]?.n ?? 0);

/** the master's status: halted when too many stopped workers wait on the operator */
export async function masterStatus() {
  const handlers = await openHandlers();
  const intake = Number((await adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'intake' AND status = 'pending'").catch(() => []))[0]?.n ?? 0);
  const signals = Number((await adbQuery("SELECT count(*) AS n FROM Signal WHERE status = 'new'").catch(() => []))[0]?.n ?? 0);
  return { on: !!worker.pool.master && worker.pool.poolSize > 0, handlers, maxHandlers: worker.pool.maxHandlers, halted: handlers >= worker.pool.maxHandlers, intake, signals };
}

/** a batch closes at batchSize entries or when its oldest has waited batchMinutes; not while halted */
export async function batchTick() {
  const st = await masterStatus();
  if (!st.on || st.halted || !st.intake) return;
  const rows = await adbQuery("SELECT id, payload, created_at FROM Job WHERE kind = 'intake' AND status = 'pending' ORDER BY created_at ASC LIMIT " + Math.floor(worker.pool.batchSize));
  const oldest = Date.parse(rows[0]?.created_at ?? "");
  if (rows.length < worker.pool.batchSize && !(Date.now() - oldest >= worker.pool.batchMinutes * 60_000)) return;
  const batch = randomUUID();
  const entries = [];
  const taken = [];
  for (const r of rows) {
    const p = JSON.parse(r.payload || "{}");
    const row = RID_RE.test(String(p.rid)) ? (await adbQuery(`SELECT name, _home FROM ${p.rid}`).catch(() => []))[0] : null;
    taken.push(r.id);
    if (!row?.name) continue; // gone since it was saved
    const edges = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${p.rid})`).catch(() => []);
    const dsts = edges.map((e) => String(e.dst)).filter((x) => RID_RE.test(x));
    const things = dsts.length ? await adbQuery(`SELECT label, _thing_type FROM [${dsts.join(",")}]`).catch(() => []) : [];
    entries.push({ name: row.name, home: homeName(positionMap, row._home), links: things.map((t) => `${t.label} (${t._thing_type})`), unsure: p.unsure ?? [], fresh: p.fresh ?? [], ...(p.triage ? { triage: p.triage } : {}) });
  }
  // the batch and its signal first: entries leave the intake only once the master will hear of them
  if (entries.length) {
    await adbCommand("INSERT INTO WorkBatch SET id = :id, entries = :e, status = 'open', created_at = :now", "sql", { id: batch, e: JSON.stringify(entries.map((e) => e.name)), now: new Date().toISOString() });
    await emitSignal("batch", { batch_id: batch, data: { entries } });
  }
  for (const id of taken) await adbCommand("UPDATE Job SET status = 'done', summary = :b, updated_at = :now WHERE id = :id AND status = 'pending'", "sql", { b: `batch ${batch}`, now: new Date().toISOString(), id });
  if (!entries.length) return;
  log.info(`batch ${batch.slice(0, 8)}: ${entries.length} entries for the master`);
}

/** the master starts a worker: a task (a brief, the entries it's about), run by the pool */
async function masterStartWorker(args, identity) {
  const names = (args.entries ?? []).slice(0, 25);
  const brief = [String(args.brief), ...(names.length ? ["", `The entries this is about: ${names.map((n) => `"${n}"`).join(", ")} (read them in the graph).`] : [])].join("\n");
  // its level of work (which model runs it): the master's call, else the highest triage level among its entries, else an investigation
  let level = Number(args.level) || 0;
  if (!level && names.length) {
    for (const n of names) {
      const t = (await adbQuery("SELECT level FROM Triage WHERE name = :n ORDER BY created_at DESC LIMIT 1", { n }).catch(() => []))[0];
      level = Math.max(level, Number(t?.level ?? 0));
    }
  }
  const r = await createTask({ title: args.title, brief, minutes: args.minutes, parent: MASTER, by: identity.user, audience: args.audience === "everyone" ? EVERYONE : undefined, entries: names, level: level || 2 });
  return { ...r, note: "Started: you'll get a signal when it's done or stopped." };
}

/** one worker's situation, for the master or its handler */
async function workerSituation(jobId) {
  if (!JOB_ID_RE.test(String(jobId))) throw new Error("which worker (its job id)");
  const job = (await adbQuery("SELECT status, payload, summary, changes, agent_id, updated_at FROM Job WHERE id = :id AND kind = 'review'", { id: jobId }))[0];
  if (!job) throw new Error(`no worker ${jobId}`);
  const p = JSON.parse(job.payload || "{}");
  return {
    job: jobId,
    title: p.task?.title ?? null,
    status: job.status,
    brief: String(p.task?.brief ?? "").slice(0, 3000),
    report: String(job.summary ?? "").slice(0, 3000),
    changes: JSON.parse(job.changes || "[]").slice(-30),
    ...(await openItems(jobId)),
  };
}

/** the master (or a handler, on the operator's word) answers a stopped worker: it resumes with the message */
async function answerWorker(jobId, answer, by) {
  const items = await openItems(jobId);
  if (items.questions.length) await answerQuestions(items.questions.map((q) => q.id), { answer, quiet: true }, by);
  await resumeThread(jobId, { message: String(answer).slice(0, 3000), answered_by: by });
  return { resumed: true, answered: items.questions.length };
}

/** raw commands and widening who sees something are the operator's, whatever the master thinks */
async function needsOperator(id) {
  const rec = (await adbQuery("SELECT kind, payload FROM PendingWrite WHERE id = :id", { id }))[0];
  if (!rec) return null;
  if (rec.kind === "command") return "a raw command";
  if (rec.kind === "rehome") {
    const m = JSON.parse(rec.payload);
    if (moveKind(positionMap, m.from, m.to) === "widen") return "widening who sees something";
  }
  return null;
}

/** the master closes a worker it won't pursue: questions dismissed, proposals rejected, no resume */
async function closeWorker(jobId, summary, identity) {
  await adbCommand("UPDATE Job SET status = 'closed', summary = :s, updated_at = :now WHERE id = :id AND kind = 'review'", "sql", { s: String(summary ?? "closed by the master").slice(0, 2000), now: new Date().toISOString(), id: jobId });
  const items = await openItems(jobId);
  if (items.questions.length) await answerQuestions(items.questions.map((q) => q.id), { answer: "", dismiss: true }, identity.user);
  for (const p of items.proposals) await rejectPending(p.id, identity, "closed by the master").catch(() => {});
  return { closed: true };
}

/** the master hands a stop it can't decide to a handler, who settles it with the operator */
async function startHandler(jobId, description, identity) {
  const sit = await workerSituation(jobId);
  if (sit.status !== "waiting") throw new Error(`worker ${jobId} isn't waiting (${sit.status})`);
  const st = await masterStatus();
  if (st.halted) throw new Error(`${st.handlers} handlers already wait on the operator (at most ${st.maxHandlers}): settle what you can, the rest waits`);
  const id = randomUUID();
  const now = new Date().toISOString();
  await adbCommand(
    "INSERT INTO Job SET id = :id, kind = 'handler', job_key = :k, payload = :p, status = 'pending', attempts = 0, priority = 9, run_after = :now, created_at = :now, updated_at = :now",
    "sql",
    { id, k: `handler:${jobId}:${id.slice(0, 8)}`, p: JSON.stringify({ for_job: jobId, title: sit.title, description: String(description).slice(0, 3000), by: identity.user }), now },
  );
  return { handler: id, note: "Handed to the operator: you'll get a signal when it's resolved." };
}

/** the handler records the operator's decision: answers, applies or rejects proposals; the worker resumes; the master hears */
async function handlerDecide(args, identity) {
  const h = (await adbQuery("SELECT payload, status FROM Job WHERE id = :id AND kind = 'handler'", { id: identity.role.job }))[0];
  if (!h) throw new Error("no such handler");
  if (h.status === "done") throw new Error("already decided");
  const { for_job } = JSON.parse(h.payload || "{}");
  const items = await openItems(for_job);
  // checked before anything is applied: an empty call or an id that isn't open was taken as
  // "carry on", closing the handler with the operator's decision unrecorded
  const open = items.proposals.map((p) => p.id);
  // the worker's own first; else any pending proposal the operator named (the grader's moves, say):
  // otherwise their decision on one the worker didn't raise came back as yet another handler
  const pending = (await adbQuery("SELECT id FROM PendingWrite WHERE status = 'pending'").catch(() => [])).map((p) => String(p.id));
  const match = (list, id) => list.filter((p) => p === id || (String(id).length >= 8 && p.startsWith(String(id))));
  const resolve = (id) => {
    const own = match(open, id);
    const hits = own.length ? own : match(pending, id);
    if (hits.length !== 1) throw new Error(`${id} is not one pending proposal (this worker's open ones: ${open.join(", ") || "none"}): nothing was recorded`);
    return hits[0];
  };
  const approve = (args.approve ?? []).map(resolve);
  const reject = (args.reject ?? []).map((r) => ({ ...r, id: resolve(r.id) }));
  if (!args.answer?.trim() && !approve.length && !reject.length) throw new Error("Nothing to record: give the operator's answer, or the proposals to apply or reject. Nothing was recorded.");
  const by = `${identity.user} (on the operator's word)`;
  const done = [];
  for (const id of approve) {
    await approvePending(id, { ...identity, user: by }, "", { quiet: true }).then(() => done.push(`applied ${id.slice(0, 8)}`), (e) => done.push(`couldn't apply ${id.slice(0, 8)}: ${String(e.message ?? e).slice(0, 120)}`));
  }
  for (const r of reject) {
    await rejectPending(r.id, { ...identity, user: by }, r.reason ?? "", { quiet: true }).then(() => done.push(`rejected ${r.id.slice(0, 8)}`));
  }
  if (items.questions.length && args.answer) await answerQuestions(items.questions.map((q) => q.id), { answer: args.answer, quiet: true }, by);
  const decision = [args.answer ? `The operator: ${args.answer}` : "", ...done].filter(Boolean).join("; ");
  await resumeThread(for_job, { message: decision || "The operator looked at it: carry on.", answered_by: by });
  await adbCommand("UPDATE Job SET status = 'done', summary = :s, updated_at = :now WHERE id = :id", "sql", { s: decision.slice(0, 2000), now: new Date().toISOString(), id: identity.role.job });
  await emitSignal("resolved", { job_id: for_job, data: { decision } });
  return { decided: true, worker_resumes: for_job, note: "Recorded: the worker resumes and the master knows. Tell the operator what you recorded." };
}

/** the admin's decision on a worker's proposal (through the liaison or Approvals); rejected = the thread decides again */
export async function decideProposal(id, approve, reason, identity) {
  const rec = (await adbQuery("SELECT id FROM PendingWrite WHERE id = :id AND status = 'pending' AND job_id IS NOT NULL", { id }))[0];
  if (!rec) throw new Error(`no pending proposal ${id}`);
  // either way the waiting thread resumes with the decision (see approvePending, rejectPending)
  return approve ? approvePending(id, identity, reason) : rejectPending(id, identity, reason);
}

/** the tools of a master thread, registered on the MCP server built for that identity (see createServer) */
export function registerMasterTools(server, { identity }) {
  server.tool(
    "start_worker",
    `Start a worker on a piece of work: a title, a precise brief (what to do, which entries, what a good
result is) and the entries it's about (by name: the worker reads them). Group entries that belong
together into one worker. audience "everyone" lets it write for Everyone (only for organization-wide
knowledge). level picks the model it runs on: 1 a quick check, 2 an investigation, 3 a broad or
structural matter (default: the highest triage level among its entries). You get a signal when it's
done or stopped. The brief names no entry its entries' people can't see: the worker writes for them.`,
    {
      title: z.string().min(4).max(120),
      brief: z.string().min(20).max(6000),
      entries: z.array(z.string().max(200)).max(25).optional(),
      minutes: z.number().int().min(5).max(180).optional(),
      audience: z.enum(["everyone", "default"]).optional(),
      level: z.number().int().min(1).max(3).optional(),
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await masterStartWorker(args, identity)) }] }),
  );
  server.tool(
    "worker_status",
    "A worker's situation: its status, brief, report, changes, and the questions and proposals it's waiting on.",
    { job: z.string() },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await workerSituation(args.job)) }] }),
  );
  server.tool(
    "answer_worker",
    `Settle a stopped worker yourself when you can: your answer to its questions, or what to do next. It
resumes in its own conversation.`,
    { job: z.string(), answer: z.string().min(2).max(3000) },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await answerWorker(args.job, args.answer, identity.user)) }] }),
  );
  server.tool(
    "decide_proposal",
    `Apply or reject a worker's proposal yourself (its worker resumes with your decision). Raw commands and
widening who sees something are the operator's: hand those to a handler, once they're queued (the
handler applies them on the operator's word; asking first means a second handler to apply them).`,
    { id: z.string(), approve: z.boolean(), reason: z.string().max(1000).optional() },
    async (args) => {
      const why = await needsOperator(args.id);
      if (why) throw new Error(`${why} is the operator's decision: start a handler for this worker`);
      return { content: [{ type: "text", text: JSON.stringify(await decideProposal(args.id, args.approve, args.reason ?? "", identity)) }] };
    },
  );
  server.tool(
    "close_worker",
    "Close a worker you won't pursue (its questions dismissed, its proposals rejected). Say why.",
    { job: z.string(), summary: z.string().min(3).max(2000) },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await closeWorker(args.job, args.summary, identity)) }] }),
  );
  server.tool(
    "start_handler",
    `Hand a stopped worker you can't decide for to the operator: a handler thread explains it to them and
records their decision. Describe what's going on and what needs deciding, plainly.`,
    { job: z.string(), description: z.string().min(10).max(3000) },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await startHandler(args.job, args.description, identity)) }] }),
  );
  server.tool(
    "pool_status",
    "How the pool stands: workers by status, handlers waiting on the operator (and whether that halts new batches), entries waiting for the next batch.",
    {},
    async () => {
      const counts = await adbQuery("SELECT status, count(*) AS n FROM Job WHERE kind = 'review' GROUP BY status").catch(() => []);
      return { content: [{ type: "text", text: JSON.stringify({ workers: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])), ...(await masterStatus()) }) }] };
    },
  );
}

/** the tools of a handler thread, registered on the MCP server built for that identity (see createServer) */
export function registerHandlerTools(server, { identity }) {
  server.tool(
    "worker_status",
    "The stopped worker you handle: its brief, report, changes, and the questions and proposals it waits on.",
    {},
    async () => {
      const h = (await adbQuery("SELECT payload FROM Job WHERE id = :id AND kind = 'handler'", { id: identity.role.job }))[0];
      return { content: [{ type: "text", text: JSON.stringify(await workerSituation(JSON.parse(h?.payload || "{}").for_job)) }] };
    },
  );
  server.tool(
    "decide_for_worker",
    `Record the operator's decision, only on their word: their answer to the worker's questions, which
proposals to apply, which to reject (with their reason). Proposals are this worker's, or any other pending
one the operator's decision covers (by id: the grader's moves, another worker's duplicate), so one decision
settles it. The worker resumes and the master is told.`,
    {
      answer: z.string().max(3000).optional(),
      approve: z.array(z.string()).max(20).optional(),
      reject: z.array(z.object({ id: z.string(), reason: z.string().max(600).optional() })).max(20).optional(),
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await handlerDecide(args, identity)) }] }),
  );
}

/** the tools of a liaison thread, registered on the MCP server built for that identity (see createServer) */
export function registerLiaisonTools(server, { identity }) {
  server.tool(
    "list_worker_questions",
    "The questions graph worker threads are waiting on, oldest first: which entry, the question, its options, and why the thread asks.",
    {},
    async () => ({ content: [{ type: "text", text: JSON.stringify({ questions: await listQuestions("open") }) }] }),
  );
  server.tool(
    "answer_worker_questions",
    `Record the admin's answer to one or more questions (several threads asking the same thing can share one
answer). Each thread resumes with it. Only answer with what the admin said: never decide for them.
dismiss: true closes the questions without an answer (the threads finish as they are).`,
    { ids: z.array(z.string()).min(1).max(100), answer: z.string().max(2000).optional(), dismiss: z.boolean().optional() },
    async (args) => {
      if (!args.dismiss && !args.answer?.trim()) throw new Error("an answer, or dismiss: true");
      return { content: [{ type: "text", text: JSON.stringify(await answerQuestions(args.ids, { answer: args.answer ?? "", dismiss: args.dismiss === true }, `${identity.user} (for the admin)`)) }] };
    },
  );
  server.tool(
    "list_worker_proposals",
    "Changes graph worker threads proposed (to entries that aren't theirs, merges, raw commands), with each thread's reason.",
    {},
    async () => ({ content: [{ type: "text", text: JSON.stringify({ proposals: await listProposals() }) }] }),
  );
  server.tool(
    "decide_worker_proposal",
    `Apply or reject a worker's proposal, as the admin decided. Only on the admin's say-so. A rejection (and
an approval with a reason) resumes the thread with the reason.`,
    { id: z.string(), approve: z.boolean(), reason: z.string().max(1000).optional() },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await decideProposal(args.id, args.approve, args.reason ?? "", identity)) }] }),
  );
}
