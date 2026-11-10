/**
 * MCP tools and HTTP routes for the class tree, instances, dependency and discovery (the classes and
 * discovery stream). The integrator wires `registerClassTools(server, ctx)` into server.js's tool table,
 * `gateDiscoveryTools` (discovery.js) around the server for discovery identities, and
 * `registerClassRoutes(app)` into routes.js.
 *
 * Who gets what (R5, R7, R11):
 *   the orchestrator (role master)   the class tree: list, create, update; instances; dependency; and in a
 *                                    discovery run, the history, new tables and workers for parts of it
 *   a worker (role worker)           list the classes its audience sees; instances; dependency. Never a
 *                                    class: it asks the orchestrator for one (the filing stream's request)
 *   a person's chat agent            nothing: "the chat agent and condenser deal in text, not class vocabulary"
 *   a person at the root (HTTP)      the tree, its report, corrections; starting a discovery run
 */
import { z } from "zod";
import { homeName } from "./positions.js";
import { positionMap, resolveIdentity, scopeOf } from "./scope.js";
import { canEditPolicy } from "./org-policy.js";
import { allClasses, treeIndex, correctClass, createClass, examinedTables, instanceCounts, markDiscoveryEntry, recordExamined, runOf, startRun, updateClass, visibleClasses } from "./classes.js";
import { addDependency, readDependencies, relateInstance } from "./instances.js";
import { connectionHome, discoveryBrief, discoveryPartBrief, loadHistory, newTables, readHistory } from "./discovery.js";
import { treeReport } from "./model/classes.js";

const text = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });

/** a class as a tool shows it: no record ids, no corrections' authors */
const show = (c) => ({
  name: c.ref ?? c.name,
  parents: c.parents,
  home: homeName(positionMap, c.home),
  description: c.description,
  record_table: c.record_table,
  rows_are_nodes: c.rows_are_nodes,
  stages: c.stages,
  evidence: c.evidence,
  ...(c.status === "retired" ? { retired: true } : {}),
  ...(c.mirror ? { mirrors: c.mirror.startsWith("position:") ? "a position (authentik)" : "an AI agent" } : {}),
  ...(c.corrections?.length ? { corrected_by_a_person: [...new Set(c.corrections.map((x) => x.kind))] } : {}),
});

const evidenceArg = z.array(z.object({ kind: z.enum(["table", "columns", "rows", "notes"]), ref: z.string().max(200).optional(), note: z.string().max(600).optional() })).max(40);
const endArg = z.union([z.string().min(1).max(200), z.object({ instance: z.string().max(40).optional(), key: z.string().max(300).optional(), name: z.string().max(200).optional() })]);

/**
 * The tools. `ctx`: { identity, scope, need, readScope } as server.js has them (readScope: a worker reads as
 * its audience). Registers nothing for a person's chat agent (R5).
 */
export function registerClassTools(server, { identity, scope, need, readScope = async () => scope }) {
  const role = identity.role?.kind;
  if (role !== "master" && role !== "worker") return;
  const orchestrator = role === "master";
  // the orchestrator writes the tree by role (its token has no write capability: it never writes to a source);
  // a worker writes instances as any graph write, with its capability
  const writer = async () => {
    if (!orchestrator) need("write");
    return { user: identity.user, agent: identity.agent ?? null, run: await runOf(identity) };
  };
  const inRun = async () => {
    const run = await runOf(identity);
    if (!run) throw new Error("only in a discovery run");
    return run;
  };

  server.tool(
    "list_classes",
    `The class tree as ${orchestrator ? "it stands" : "your record's people see it"}: each class with its parents, home, description, record table,
whether its rows become instance nodes, stages and evidence. Four roots: agent, commitment, event, resource; decision and action
sit under event.`,
    {},
    async (args) => {
      need("read");
      return text({ classes: (await visibleClasses(await readScope(args))).map(show) });
    },
  );

  if (orchestrator) {
    server.tool(
      "create_class",
      `Create a class: under one or more parents (class names), with the evidence it rests on (tables as system:table, row keys as
system:table:row, note ids, or a note). You don't choose its home: it is worked out from the evidence and its parents. For a class
with a table, say whether its rows become instance nodes (lasting individuals do; transactional rows stay in the source). Only a
class under commitment has stages. A class a person retired or renamed can't be made again.`,
      {
        name: z.string().min(1).max(80),
        parents: z.array(z.string().min(1).max(80)).min(1).max(8),
        description: z.string().max(1000).optional(),
        evidence: evidenceArg.min(1),
        record_table: z.string().max(200).optional(),
        rows_are_nodes: z.boolean().optional(),
        stages: z.array(z.string().min(1).max(60)).max(30).optional(),
      },
      async (args) => text({ class: show(await createClass(args, await writer())) }),
    );
    server.tool(
      "update_class",
      `Change a class you made: add parents or evidence, or set its description, record table, stages or whether its rows become nodes.
What a person corrected stays as they set it, and a retired class can't be changed.`,
      {
        name: z.string().min(1).max(80),
        add_parents: z.array(z.string().min(1).max(80)).max(8).optional(),
        add_evidence: evidenceArg.optional(),
        description: z.string().max(1000).optional(),
        record_table: z.string().max(200).nullable().optional(),
        rows_are_nodes: z.boolean().optional(),
        stages: z.array(z.string().min(1).max(60)).max(30).optional(),
      },
      async ({ name, ...patch }) => {
        const r = await updateClass(name, patch, await writer());
        return text({ class: show(r.class), homes_moved: r.moved.length });
      },
    );
  }

  server.tool(
    "relate_instance",
    `Relate an instance to a class that exists, making the instance when it doesn't: by its record key (system:table:row), its record
id, or its name. A row of a class whose rows stay in the source gets a node only when the graph must say something the source can't:
give that reason. An instance a person took out of a class isn't put back.`,
    {
      class: z.string().min(1).max(80),
      key: z.string().max(300).optional(),
      instance: z.string().max(40).optional(),
      name: z.string().max(200).optional(),
      reason: z.string().max(600).optional(),
      notes: z.array(z.string().max(120)).max(20).optional(),
    },
    async (args) => text(await relateInstance(args, await readScope(args), await writer())),
  );
  server.tool(
    "add_dependency",
    `State that one instance depends on another (from depends on to): each by record id, record key or name, both ones you can see. A
row of a source table gets its node for this. Say where it was stated (source: a record or section id) and, when known, from and until
when it holds.`,
    {
      from: endArg,
      to: endArg,
      stated_as: z.enum(["person", "record", "agent"]).optional(),
      source: z.string().max(200).optional(),
      note: z.string().max(600).optional(),
      valid_from: z.string().max(40).optional(),
      valid_until: z.string().max(40).optional(),
    },
    async (args) => text(await addDependency(args, await readScope(args), await writer())),
  );
  server.tool(
    "read_dependencies",
    "What an instance depends on and what depends on it, both ends ones you can see.",
    { instance: z.string().min(1).max(40) },
    async (args) => {
      need("read");
      return text(await readDependencies(args, await readScope(args)));
    },
  );

  server.tool(
    "read_history",
    "In a discovery run: the old development notes, read-only, those your audience may see, matching every word of query.",
    { query: z.string().max(200).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional() },
    async (args) => {
      await inRun();
      const s = await readScope(args);
      return text(readHistory(args, { positions: positionMap, homes: s.homes }));
    },
  );
  server.tool(
    "new_tables",
    "In a discovery run: which of these tables of a connection no run has examined yet.",
    { system: z.string().min(1).max(40), tables: z.array(z.string().min(1).max(120)).min(1).max(500) },
    async (args) => {
      await inRun();
      const fresh = newTables({ system: args.system, tables: args.tables.map((name) => ({ name })) }, await examinedTables());
      return text({ new: fresh.map((t) => t.name), examined_before: args.tables.length - fresh.length });
    },
  );
  server.tool(
    "record_examined",
    "In a discovery run: record the tables of a connection you examined, whether or not they became classes, so a later run looks only at new ones.",
    { system: z.string().min(1).max(40), tables: z.array(z.string().min(1).max(120)).min(1).max(500) },
    async (args) => text(await recordExamined(await inRun(), args.system, args.tables)),
  );

  if (orchestrator) {
    server.tool(
      "start_discovery_worker",
      `In a discovery run: give a part of it to a worker (some tables of one connection, or a stretch of the history). It reads with read
tools only, relates instances to classes that exist, and asks you for any class it needs. One connection or one home's notes per worker.`,
      { part: z.string().min(10).max(3000), connection: z.string().max(40).optional(), notes: z.string().max(300).optional(), minutes: z.number().int().min(5).max(180).optional() },
      async (args) => {
        const run = await inRun();
        const { createTask } = await import("./worker-pool.js"); // lazily: worker-pool reaches the MCP server
        const title = `Discovery ${run}: ${args.connection ? `${args.connection}, ` : ""}${args.part.slice(0, 60)}`;
        // NEEDS A RULING (splitting discovery among workers): one worker per evidence home, so a part reads as
        // the people of its connection's home see; a connection with no home is the root's.
        const home = args.connection ? connectionHome(args.connection) : null;
        const r = await createTask({ title, brief: discoveryPartBrief({ run, ...args }), minutes: args.minutes ?? 60, by: identity.user, audience: home === "everyone" ? "everyone" : undefined, level: 2 });
        const { adbQuery } = await import("./db.js");
        const rid = (await adbQuery("SELECT @rid AS rid FROM Entity WHERE _kind = 'task' AND name = :n ORDER BY @rid DESC LIMIT 1", { n: r.task }))[0]?.rid;
        if (rid) await markDiscoveryEntry(String(rid), run);
        return text({ ...r, run });
      },
    );
  }
}

/** ---- HTTP ---- */
const httpError = (res, e) => res.status(Number(e?.status) || 500).json({ error: String(e?.message ?? e).slice(0, 300), ...(e?.field ? { field: e.field } : {}) });
const reader = (req, res) => {
  const identity = resolveIdentity(req.headers.authorization);
  if (!identity) return void res.status(401).json({ error: "unauthenticated" });
  return identity;
};
/** a person at the organization's root: the gate policy edits use (canEditPolicy: never an agent) */
const admin = (req, res) => {
  const identity = reader(req, res);
  if (!identity) return null;
  if (!canEditPolicy(identity, scopeOf(identity))) return void res.status(403).json({ error: "only a person at the organization's root corrects classes or starts discovery" });
  return identity;
};

export function registerClassRoutes(app) {
  /** the tree a caller sees */
  app.get("/api/classes", (req, res) => {
    const identity = reader(req, res);
    if (!identity) return;
    const retired = req.query.retired === "1";
    void visibleClasses(scopeOf(identity), { retired }).then((classes) => res.json({ classes: classes.map(show), canCorrect: canEditPolicy(identity, scopeOf(identity)) }), (e) => httpError(res, e));
  });
  /** one page for a person to judge the tree by (R5) */
  app.get("/api/classes/report", (req, res) => {
    if (!admin(req, res)) return;
    void (async () => {
      const all = await allClasses();
      return treeReport(treeIndex(all), { counts: await instanceCounts(), homeName: (h) => homeName(positionMap, h) });
    })().then((report) => res.type("text/plain").send(report), (e) => httpError(res, e));
  });
  /** a person's correction (R11): { kind, value?, instance?, reason? } */
  app.post("/api/classes/:name/corrections", (req, res) => {
    const identity = admin(req, res);
    if (!identity) return;
    void correctClass(String(req.params.name ?? ""), req.body ?? {}, identity.user).then((r) => res.json({ class: show(r.class), correction: r.correction, homes_moved: r.moved }), (e) => httpError(res, e));
  });
  /**
   * Start a discovery run: its id, and the brief the orchestrator starts from. `connections`: [{ name, digest }]
   * (the server's connection digests). Running the orchestrator on it is the orchestrator's (filing stream).
   */
  app.post("/api/classes/discovery", (req, res) => {
    const identity = admin(req, res);
    if (!identity) return;
    const b = req.body ?? {};
    const connections = (Array.isArray(b.connections) ? b.connections : []).slice(0, 20).filter((c) => typeof c?.name === "string").map((c) => {
      const home = connectionHome(c.name);
      return { name: c.name, digest: typeof c.digest === "string" ? c.digest : null, home_name: home ? homeName(positionMap, home) : null };
    });
    void (async () => {
      const run = await startRun(identity.user, b.focus ?? "");
      const examined = (await examinedTables()).size;
      return { run, brief: discoveryBrief({ run, connections, history: loadHistory().length, examined, focus: b.focus ?? "" }) };
    })().then((r) => res.json(r), (e) => httpError(res, e));
  });
}
