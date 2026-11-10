/**
 * HTTP: the MCP endpoint and the JSON API behind the people-facing UI (queue, positions, policy, worker, grants,
 * requests, entities).
 */
import express from "express";
import { EVERYONE, heldPositions, homeName, visibleHomes } from "./positions.js";
import { liveClause } from "./extent.js";
import { firstJob, handlerBrief, signalsMessage, poolSettings, surveyBrief } from "./pool.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { EMBED_MODEL, GRADER_MODEL, LITELLM_API_KEY, LITELLM_BASE_URL, log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, knownIndexes, likeTerm, RID_RE } from "./db.js";
import { homeFilter, homeLabel, peopleView, personOf, positionMap, resolveIdentity, SCOPED, scopeOf } from "./scope.js";
import { approvePending, listPending, rejectPending } from "./write.js";
import { confirmProposal, declineProposal, grantAccess, listGrants, proposalStatus, revokeGrant } from "./sharing.js";
import { answerRequest, askerRequest, ASSERTIONS, confirmRequest, dismissRequest, incomingRequests, withdrawRequest } from "./requests.js";
import { answerQuestions, claimThreads, createTask, enqueue, finishThread, JOB_ID_RE, listProposals, listQuestions, setWorker, threadAgent, worker, workerModel, workerStatus } from "./worker-pool.js";
import { decideProposal, masterStatus } from "./master-tools.js";
import { pruneExpired, prunePreview } from "./pruning.js";
import { canEditPolicy, policy, policyDefaults, policyMeta, savePolicy } from "./org-policy.js";
import { tighteningRunning } from "./tightening.js";
import { createServer } from "./server.js";
import { isOffRecord, OFF_RECORD_REFUSAL } from "./record-state.js";
import { registerClassRoutes } from "./routes-classes.js";
import { withDiscoveryRole } from "./classes.js";

/** ---- http ---- */
export const app = express();
app.use(express.json({ limit: "2mb" }));
// an off-record chat agent's token changes nothing over HTTP, whichever route is added here (/mcp is decided per tool)
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.path === "/mcp") return next();
  const identity = resolveIdentity(req.headers.authorization);
  if (identity && isOffRecord(identity)) return res.status(403).json({ error: OFF_RECORD_REFUSAL });
  next();
});

// a graph worker's token reads nothing over HTTP: every /api route resolves an identity's own scope, which for a
// worker is the delegating admin's whole view, and a worker sees only its audience (R11). Its tools (/mcp) are
// scoped to that audience (server.js readScope); the workspace drives the pool with its own token, never a worker's.
app.use("/api", (req, res, next) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (identity?.role?.kind === "worker") return res.status(403).json({ error: "a graph worker reads only through its tools, which see only its audience" });
  next();
});

app.post("/mcp", async (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthenticated" }, id: null });
    return;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: each POST is self-contained
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  try {
    await withDiscoveryRole(identity); // a discovery part's worker is held to its run's tools (classes.js)
    await createServer(identity).connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null });
    }
  }
});

app.get("/mcp", (_req, res) => res.status(405).json({ error: "POST only (stateless)" }));
app.get("/health", (_req, res) => res.json({ ok: true, facets_indexed: [...knownIndexes] }));
registerClassRoutes(app);

/** write-approval queue HTTP (for review UIs); approve-capability required */
function queueIdentity(req) {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity || identity.caps.approve !== true) return null;
  return identity;
}
app.get("/api/queue", (req, res) => {
  const identity = queueIdentity(req);
  if (!identity) return res.status(403).json({ error: "requires approve capability" });
  void listPending(identity).then(
    (pending) => res.json({ pending }),
    (err) => res.status(500).json({ error: String(err).slice(0, 200) }),
  );
});
app.post("/api/queue/:id/approve", (req, res) => {
  const identity = queueIdentity(req);
  if (!identity) return res.status(403).json({ error: "requires approve capability" });
  void approvePending(req.params.id, identity).then(
    (result) => res.json({ result }),
    (err) => res.status(400).json({ error: String(err).slice(0, 200) }),
  );
});
app.post("/api/queue/:id/reject", (req, res) => {
  const identity = queueIdentity(req);
  if (!identity) return res.status(403).json({ error: "requires approve capability" });
  void rejectPending(req.params.id, identity).then(
    (result) => res.json({ result }),
    (err) => res.status(400).json({ error: String(err).slice(0, 200) }),
  );
});

/**
 * The part of the position tree the caller can reach (its positions and
 * everything below): what a tenant may place its agents at.
 */
app.get("/api/positions", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!SCOPED) return res.json({ scoped: false, held: [], positions: [] });
  if (!positionMap) return res.status(503).json({ error: "position map not loaded" });
  const held = heldPositions(positionMap, identity.positions);
  const reach = visibleHomes(positionMap, held);
  const positions = Object.entries(positionMap.positions)
    .filter(([id]) => reach === null || reach.has(id))
    .map(([id, p]) => ({ id, name: homeName(positionMap, id), parent: p.parent, ...(p.description ? { description: p.description } : {}) }));
  // the whole tree's names: grants may go to positions outside the caller's
  // reach (that is their point); this says nothing about anyone's data
  const tree = Object.entries(positionMap.positions).map(([id, p]) => ({ id, name: homeName(positionMap, id), parent: p.parent }));
  res.json({ scoped: true, root: positionMap.root, everyone: { id: EVERYONE, name: "Everyone" }, held, positions, tree, people: peopleView(personOf(identity.user)), canGrantStanding: reach === null && !identity.agent && policy.standingGrants === "root" });
});

app.get("/api/policy", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  const scope = scopeOf(identity);
  void Promise.all([
    adbQuery("SELECT changed_at, changed_by, prev_json, next_json, rehome_status, rehome_moved FROM PolicyChange WHERE rehome_status IS NULL OR rehome_status <> 'baseline' ORDER BY changed_at DESC LIMIT 10").catch(() => []),
    canEditPolicy(identity, scope) ? prunePreview() : null,
  ])
    .then(([history, pruning]) =>
      res.json({
        policy,
        defaults: policyDefaults,
        ...policyMeta,
        canEdit: canEditPolicy(identity, scope),
        history: canEditPolicy(identity, scope) ? history : [],
        ...(canEditPolicy(identity, scope) ? { pruning } : {}),
        // set at deploy, not here
        infra: {
          scoped: SCOPED,
          positions: positionMap ? Object.keys(positionMap.positions).length : 0,
          graderModel: GRADER_MODEL || null,
          embedModel: EMBED_MODEL,
        },
      }),
    );
});

app.get("/api/worker", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sees the graph worker" });
  void workerStatus().then((r) => res.json(r), (e) => httpError(res, e));
});
app.put("/api/worker", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sets the graph worker" });
  const b = req.body ?? {};
  const next = {
    enabled: typeof b.enabled === "boolean" ? b.enabled : worker.enabled,
    model: typeof b.model === "string" ? b.model.slice(0, 300) : worker.model,
    instructions: typeof b.instructions === "string" ? b.instructions.slice(0, 4000) : worker.instructions,
    profile: typeof b.profile === "string" ? b.profile.slice(0, 120) : b.profile === null ? null : worker.profile,
    pool: worker.pool,
  };
  try {
    if (b.pool !== undefined) next.pool = poolSettings(b.pool, worker.pool);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const now = new Date().toISOString();
  void (async () => {
    const json = JSON.stringify(next);
    const done = await adbCommand("UPDATE OrgPolicy SET json = :json, updated_by = :u, updated_at = :now WHERE scope = 'worker'", "sql", { json, u: identity.user, now });
    if (Number(done?.[0]?.count ?? 0) === 0) await adbCommand("INSERT INTO OrgPolicy SET scope = 'worker', json = :json, updated_by = :u, updated_at = :now", "sql", { json, u: identity.user, now });
    setWorker({ ...next, updated_by: identity.user, updated_at: now });
    log.info(`graph worker set by ${identity.user}: ${next.enabled ? `on, ${workerModel() || "no model"}` : "off"}${next.profile ? ` (profile ${next.profile})` : ""}`);
    return workerStatus();
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
/** the models graph-rag reaches through litellm (what a Graph worker profile can pick) */
app.get("/api/worker/models", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sets the graph worker" });
  void fetch(`${LITELLM_BASE_URL.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${LITELLM_API_KEY}` }, signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json())
    .then((j) => res.json({ models: (j.data ?? []).map((m) => m.id).filter((id) => typeof id === "string" && !/embed/i.test(id)).sort() }))
    .catch((e) => httpError(res, e));
});
/** the worker pool's endpoints: the admin's workspace runs the threads; root only */
const rootOnly = (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return void res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return void res.status(403).json({ error: "only the organization's root runs graph worker threads" });
  return identity;
};
app.post("/api/worker/threads/claim", (req, res) => {
  if (!rootOnly(req, res)) return;
  void claimThreads(req.body?.limit, req.body?.groups).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/worker/threads/:id/agent", (req, res) => {
  if (!rootOnly(req, res)) return;
  void threadAgent(req.params.id, req.body?.agent_id).then((r) => res.json(r), (e) => httpError(res, e));
});
/** a claimed thread the workspace couldn't start yet (its model is at its limit): pending again in a minute, its tries kept */
app.post("/api/worker/threads/:id/release", (req, res) => {
  if (!rootOnly(req, res)) return;
  if (!JOB_ID_RE.test(String(req.params.id))) return res.status(400).json({ error: "invalid job" });
  const now = new Date();
  void adbCommand("UPDATE Job SET status = 'pending', lease_until = null, run_after = :ra, updated_at = :now WHERE id = :id AND kind = 'review' AND status = 'running'", "sql", {
    ra: new Date(now.getTime() + 60_000).toISOString(),
    now: now.toISOString(),
    id: req.params.id,
  }).then((r) => res.json({ released: Number(r?.[0]?.count ?? 0) === 1 }), (e) => httpError(res, e));
});
app.post("/api/worker/threads/:id/finish", (req, res) => {
  if (!rootOnly(req, res)) return;
  void finishThread(req.params.id, req.body ?? {}).then((r) => res.json(r), (e) => httpError(res, e));
});
/** the master's inbox: new signals (the workspace delivers them to the master thread) */
app.get("/api/worker/signals", (req, res) => {
  if (!rootOnly(req, res)) return;
  void (async () => {
    const rows = await adbQuery("SELECT id, kind, job_id, batch_id, data, created_at FROM Signal WHERE status = 'new' ORDER BY created_at ASC LIMIT 50");
    const signals = rows.map((r) => ({ ...r, data: JSON.parse(r.data || "{}") }));
    const status = await masterStatus();
    return { signals, status, message: signals.length ? signalsMessage(signals, status) : "" };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/worker/signals/ack", (req, res) => {
  if (!rootOnly(req, res)) return;
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((i) => JOB_ID_RE.test(String(i))).slice(0, 100);
  void (async () => {
    for (const id of ids) await adbCommand("UPDATE Signal SET status = 'delivered' WHERE id = :id", "sql", { id });
    return { acked: ids.length };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
/** handlers to start (not limited by the pool: they wait on the operator) */
app.post("/api/worker/handlers/claim", (req, res) => {
  if (!rootOnly(req, res)) return;
  void (async () => {
    const rows = await adbQuery("SELECT id, payload FROM Job WHERE kind = 'handler' AND status = 'pending' ORDER BY created_at ASC LIMIT 10");
    const out = [];
    for (const r of rows) {
      const ok = await adbCommand("UPDATE Job SET status = 'running', updated_at = :now WHERE id = :id AND status = 'pending'", "sql", { now: new Date().toISOString(), id: r.id });
      if (Number(ok?.[0]?.count ?? 0) !== 1) continue;
      const p = JSON.parse(r.payload || "{}");
      out.push({ job: r.id, worker: p.for_job, title: p.title ?? "a stopped worker", message: handlerBrief({ worker: { job: p.for_job, title: p.title ?? "" }, description: p.description }) });
    }
    return { handlers: out };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
/** a handler's thread asked the operator: it waits (it stays in the rail) */
app.post("/api/worker/handlers/:id/waiting", (req, res) => {
  if (!rootOnly(req, res)) return;
  void adbCommand("UPDATE Job SET status = 'waiting', agent_id = :a, updated_at = :now WHERE id = :id AND kind = 'handler' AND status IN ['running', 'pending']", "sql", {
    a: typeof req.body?.agent_id === "string" ? req.body.agent_id.slice(0, 80) : null,
    now: new Date().toISOString(),
    id: req.params.id,
  }).then(() => res.json({ ok: true }), (e) => httpError(res, e));
});
app.get("/api/worker/handlers", (req, res) => {
  if (!rootOnly(req, res)) return;
  void (async () => {
    const rows = await adbQuery("SELECT id, payload, status, agent_id, summary, created_at, updated_at FROM Job WHERE kind = 'handler' ORDER BY created_at DESC LIMIT 100");
    return { handlers: rows.map((r) => ({ id: r.id, ...JSON.parse(r.payload || "{}"), status: r.status, agent_id: r.agent_id ?? null, decision: r.summary ?? "", created_at: r.created_at, updated_at: r.updated_at })) };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});

/** recent threads: which entry, how it went, its agent (for the audit view and clean-up) */
app.get("/api/worker/threads", (req, res) => {
  if (!rootOnly(req, res)) return;
  void (async () => {
    const rows = await adbQuery("SELECT id, payload, status, agent_id, summary, error, attempts, changes, created_at, updated_at, claimed_at FROM Job WHERE kind = 'review' ORDER BY updated_at DESC LIMIT 200");
    const out = [];
    for (const r of rows) {
      const p = JSON.parse(r.payload || "{}");
      const name = RID_RE.test(String(p.rid)) ? (await adbQuery(`SELECT name FROM ${p.rid}`).catch(() => []))[0]?.name : null;
      out.push({
        id: r.id,
        entry: name ?? null,
        why: p.why ?? "",
        ...(p.level ? { level: p.level } : {}),
        status: r.status,
        agent_id: r.agent_id ?? null,
        summary: r.summary ?? "",
        // what it changed without asking (the audit trail for the small things)
        changes: JSON.parse(r.changes || "[]"),
        error: r.error ?? null,
        attempts: Number(r.attempts ?? 0),
        created_at: r.created_at,
        updated_at: r.updated_at,
      });
    }
    return { threads: out };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});
/** the admin starts a survey of a connection: a task thread maps it, seeds its records, relates them */
app.post("/api/worker/survey", (req, res) => {
  const identity = rootOnly(req, res);
  if (!identity) return;
  const connection = String(req.body?.connection ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(connection)) return res.status(400).json({ error: "which connection (its name)" });
  const focus = typeof req.body?.focus === "string" ? req.body.focus.slice(0, 1000) : "";
  // who sees what the survey builds: everyone (the default: it's the organization's map) or the admin only
  const audience = req.body?.audience === "admin" ? "admin" : EVERYONE;
  void createTask({ title: `Survey: ${connection}`, brief: surveyBrief(connection, focus, audience), minutes: Number(req.body?.minutes) || 60, by: identity.user, audience, level: 3 }).then(
    (r) => res.json(r),
    (e) => httpError(res, e),
  );
});
app.get("/api/worker/questions", (req, res) => {
  if (!rootOnly(req, res)) return;
  const status = ["open", "answered", "dismissed"].includes(String(req.query.status)) ? String(req.query.status) : "open";
  void listQuestions(status).then((questions) => res.json({ questions }), (e) => httpError(res, e));
});
app.post("/api/worker/questions/answer", (req, res) => {
  const identity = rootOnly(req, res);
  if (!identity) return;
  const b = req.body ?? {};
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 100) : [];
  if (!b.dismiss && !(typeof b.answer === "string" && b.answer.trim())) return res.status(400).json({ error: "an answer, or dismiss" });
  void answerQuestions(ids, { answer: b.answer ?? "", dismiss: b.dismiss === true }, identity.user).then((r) => res.json(r), (e) => httpError(res, e));
});
app.get("/api/worker/proposals", (req, res) => {
  if (!rootOnly(req, res)) return;
  void listProposals().then((proposals) => res.json({ proposals }), (e) => httpError(res, e));
});
app.post("/api/worker/proposals/:id", (req, res) => {
  const identity = rootOnly(req, res);
  if (!identity) return;
  void decideProposal(req.params.id, req.body?.approve === true, typeof req.body?.reason === "string" ? req.body.reason.slice(0, 1000) : "", identity).then((r) => res.json(r), (e) => httpError(res, e));
});

/** queue the entries saved before the worker existed (newest first; demand still goes first) */
app.post("/api/worker/backfill", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root runs a backfill" });
  void (async () => {
    const kind = firstJob(worker.pool);
    if (!kind) return { queued: 0, note: "the pool has no threads" };
    const rows = await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE _reviewed_at IS NULL AND embed_identity IS NOT NULL${ASSERTIONS}${liveClause()} ORDER BY updated_at DESC LIMIT 500`);
    for (const r of rows) await enqueue(kind, { rid: String(r.rid) }, { key: `${kind}:${r.rid}` });
    return { queued: rows.length };
  })().then((r) => res.json(r), (e) => httpError(res, e));
});

/** the pruning record: what was removed, when (names only, never content; the root only) */
/**
 * Which database each declared write source holds, read live through graph-rag's own guard (data-entry.js
 * checkGuard: the write connection's identity view). For the root's admin only. A script that drives writes (the
 * evaluation's seeder) asks this before anything, so it checks the connection graph-rag will actually write
 * through, not one it was told about. It reads one identity row per source and writes nothing.
 */
app.get("/api/sources/guard", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sees the sources' guard" });
  void (async () => {
    const [{ loadSources }, { checkGuard }] = await Promise.all([import("./sources.js"), import("./data-entry.js")]);
    const out = [];
    for (const decl of Object.values(await loadSources(undefined, { ttlMs: 0 }))) {
      if (!decl || decl.commit?.via === "none") {
        out.push({ system: decl?.system ?? null, writable: false });
        continue;
      }
      const g = decl.commit.guard ?? null;
      const live = await checkGuard(decl).catch((e) => ({ ok: false, why: String(e?.message ?? e).slice(0, 300) }));
      out.push({
        system: decl.system,
        writable: true,
        declared: g ? { server: g.server ?? null, database: g.database ?? null, login: g.login ?? null } : null,
        live: { ok: Boolean(live.ok), status: live.status ?? null, server: live.server ?? null, database: live.database ?? null, login: live.login ?? null, why: live.why ?? null },
      });
    }
    res.json({ sources: out });
  })().catch((e) => res.status(500).json({ error: String(e?.message ?? e).slice(0, 300) }));
});

app.get("/api/pruned", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root sees what was pruned" });
  void adbQuery("SELECT name, home, kind, valid_until, pruned_at, sink, kept FROM PruneRecord ORDER BY pruned_at DESC LIMIT 100")
    .catch(() => [])
    .then((rows) => res.json({ pruned: rows.map((r) => ({ ...r, home: r.home ? homeLabel(r.home)?.name ?? r.home : null })) }));
});
/** prune what's due now instead of at the next sweep (the root only) */
app.post("/api/pruned/run", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root prunes" });
  void pruneExpired(500).then(async (r) => res.json({ ...r, preview: await prunePreview() }), (e) => httpError(res, e));
});
app.put("/api/policy", (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return res.status(401).json({ error: "unauthenticated" });
  if (!canEditPolicy(identity, scopeOf(identity))) return res.status(403).json({ error: "only the organization's root can change these settings" });
  void savePolicy(req.body, identity).then(
    (p) => res.json({ policy: p, ...policyMeta, rehoming: tighteningRunning() }),
    (e) => res.status(400).json({ error: String(e instanceof Error ? e.message : e).slice(0, 300) }),
  );
});

/** ---- grants + owned-entity search over HTTP (the people-facing UI) ---- */
function httpScope(req, res) {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
  if (!SCOPED || !positionMap) {
    res.status(409).json({ error: "the knowledge graph isn't divided into positions" });
    return null;
  }
  return { identity, scope: scopeOf(identity) };
}
const httpError = (res, err) => res.status(400).json({ error: String(err instanceof Error ? err.message : err).slice(0, 300) });

app.get("/api/grants", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) res.json({ ...listGrants(ctx.scope), canGrantStanding: ctx.scope.root && !ctx.identity.agent && policy.standingGrants === "root" });
});
app.post("/api/grants", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  if (ctx.identity.caps.write === "deny") return res.status(403).json({ error: "graph writes are denied for this identity" });
  const b = req.body ?? {};
  const args = {
    ...(Array.isArray(b.entities) ? { entities: b.entities.slice(0, 32).map((e) => ({ name: String(e?.name ?? ""), ...(e?.home ? { home: String(e.home) } : {}) })) } : {}),
    ...(typeof b.subtree === "string" ? { subtree: b.subtree } : {}),
    ...(typeof b.to === "string" && b.to ? { to: b.to } : {}),
    ...(typeof b.person === "string" && b.person ? { person: b.person } : {}),
    reason: String(b.reason ?? ""),
    ...(typeof b.until === "string" && b.until ? { until: b.until } : {}),
  };
  if (args.reason.trim().length < 3) return httpError(res, "give a reason");
  void grantAccess(args, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/grants/:id/revoke", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void revokeGrant({ id: req.params.id }, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
/** shares proposed by this person's agents: status, confirm, decline (the chat card) */
app.get("/api/grants/proposals/:id", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void proposalStatus(req.params.id, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/grants/proposals/:id/confirm", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  const b = req.body ?? {};
  const changes = {
    ...(typeof b.until === "string" && b.until ? { until: b.until } : {}),
    ...(typeof b.to === "string" && b.to ? { to: b.to } : {}),
    ...(typeof b.person === "string" && b.person ? { person: b.person } : {}),
  };
  void confirmProposal(req.params.id, changes, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/grants/proposals/:id/decline", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void declineProposal(req.params.id, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});

/** access requests: the asker's card (their own) and the owners' side (routed to them) */
app.get("/api/requests", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void incomingRequests(ctx.identity).then((r) => res.json(r), (e) => httpError(res, e));
});
app.get("/api/requests/:id", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void askerRequest(req.params.id, ctx.identity).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/requests/:id/confirm", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void confirmRequest(req.params.id, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/requests/:id/withdraw", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void withdrawRequest(req.params.id, ctx.identity).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/requests/:id/answer", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  if (ctx.identity.caps.write === "deny") return res.status(403).json({ error: "graph writes are denied for this identity" });
  const b = req.body ?? {};
  const args = {
    entries: Array.isArray(b.entries) ? b.entries.slice(0, 32).map(String) : [],
    ...(typeof b.until === "string" && b.until ? { until: b.until } : {}),
  };
  void answerRequest(req.params.id, args, ctx.identity, ctx.scope).then((r) => res.json(r), (e) => httpError(res, e));
});
app.post("/api/requests/:id/dismiss", (req, res) => {
  const ctx = httpScope(req, res);
  if (ctx) void dismissRequest(req.params.id, ctx.identity).then((r) => res.json(r), (e) => httpError(res, e));
});

/** entities the caller owns (by home), for picking what to grant */
app.get("/api/entities", (req, res) => {
  const ctx = httpScope(req, res);
  if (!ctx) return;
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  // case-insensitive: people type "thinkcentre" for "ThinkCentre"
  const match = q ? ` AND (name ILIKE '%${likeTerm(q)}%' OR text_identity ILIKE '%${likeTerm(q)}%')` : "";
  void adbQuery(`SELECT name, _home FROM ${ENTITY_LABEL} WHERE name IS NOT NULL${match}${homeFilter(ctx.scope, { own: true })}${liveClause()}${ASSERTIONS} ORDER BY name LIMIT 25`).then(
    (rows) => res.json({ entities: rows.map((r) => ({ name: r.name, home: homeLabel(r._home) })) }),
    (e) => httpError(res, e),
  );
});
