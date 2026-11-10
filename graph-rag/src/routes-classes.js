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
import { EVERYONE, homeName } from "./positions.js";
import { positionMap, resolveIdentity, scopeOf } from "./scope.js";
import { canEditPolicy } from "./org-policy.js";
import { allClasses, correctClass, createClass, createPartTask, discoveryPartOf, examinedTables, instanceCounts, partScope, recordExamined, runOf, startRun, treeIndex, updateClass, visibleClasses, visibleEvidence } from "./classes.js";
import { recordReads } from "./floor.js";
import { addDependency, readDependencies, relateInstance } from "./instances.js";
import { connectionHome, discoveryBrief, discoveryPartBrief, loadHistory, newTables, readHistory } from "./discovery.js";
import { treeReport } from "./model/classes.js";

const text = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });

/** a class as a tool shows it: no record ids, no corrections' authors, and only the evidence the reader sees (review C-B6) */
async function show(c, scope) {
  return {
    name: c.name,
    parents: c.parent_names ?? c.parents,
    home: homeName(positionMap, c.home),
    description: c.description,
    record_table: c.record_table,
    rows_are_nodes: c.rows_are_nodes,
    stages: c.stages,
    evidence: await visibleEvidence(c.evidence, scope),
    ...(c.status === "retired" ? { retired: true } : {}),
    ...(c.mirror ? { mirrors: c.mirror.startsWith("position:") ? "a position (authentik)" : "an AI agent" } : {}),
    ...(c.corrections?.length ? { corrected_by_a_person: [...new Set(c.corrections.map((x) => x.kind))] } : {}),
  };
}
const showAll = (list, scope) => Promise.all(list.map((c) => show(c, scope)));
/** the orchestrator and an admin see every home */
const ALL = { homes: null, root: true };

const evidenceArg = z.array(z.object({ kind: z.enum(["table", "columns", "rows", "notes"]), ref: z.string().max(200).optional(), note: z.string().max(600).optional() })).max(40);
const endArg = z.union([z.string().min(1).max(200), z.object({ instance: z.string().max(40).optional(), key: z.string().max(300).optional(), name: z.string().max(200).optional() })]);

/**
 * The tools. `ctx`: { identity, scope, need, readScope } as server.js has them (readScope: a worker reads as its
 * audience). Registers nothing for a person's chat agent (R5).
 *
 *   every worker and the orchestrator   list_classes, read_dependencies: reads, scoped, counted as read (R11.13)
 *   the orchestrator                    create_class, update_class; relate_instance, add_dependency; in a run,
 *                                       read_history, new_tables, record_examined, start_discovery_worker
 *   a discovery part's worker           relate_instance, add_dependency, read_history, new_tables,
 *   (the token's discovery claim)       record_examined, all read as the part's home (R11.6)
 *
 * A filing worker gets no instance or dependency tool here: filing's create_instance and state_dependency are
 * its tools, and they call relateInstance and addDependency (instances.js), the one implementation.
 */
export function registerClassTools(server, { identity, scope, need, readScope = async () => scope }) {
  const role = identity.role?.kind;
  if (role !== "master" && role !== "worker") return;
  const orchestrator = role === "master";
  const part = role === "worker" && identity.role.discovery === true;
  // a discovery part reads as its home; anyone else as the server says (a worker: its record's audience)
  const readAs = async (args) => {
    if (role === "worker") {
      const p = await discoveryPartOf(identity.role.entry);
      if (p) return partScope(p.home);
    }
    return readScope(args);
  };
  // the orchestrator writes the tree by role (its token has no write capability: it never writes to a source);
  // a worker writes instances as any graph write, with its capability
  const writer = async () => {
    if (!orchestrator) need("write");
    return { user: identity.user, agent: identity.agent ?? null, run: await runOf(identity), identity };
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
      const s = await readAs(args);
      const classes = await visibleClasses(s);
      recordReads(identity, classes.map((c) => c.home));
      return text({ classes: await showAll(classes, s) });
    },
  );
  server.tool(
    "read_dependencies",
    "What an instance depends on and what depends on it, both ends ones you can see.",
    { instance: z.string().min(1).max(40) },
    async (args) => {
      need("read");
      return text(await readDependencies(args, await readAs(args), identity));
    },
  );

  if (orchestrator) {
    server.tool(
      "create_class",
      `Create a class: under one or more parents (class names), with the evidence it rests on (tables as system:table, row keys as
system:table:row, note ids, or a note). You don't choose its home: it is worked out from the evidence and its parents. For a class
with a table, say whether its rows become instance nodes (lasting individuals do; transactional rows stay in the source). Only a
class under commitment has stages. A name is taken once in the organization; a class a person retired or renamed can't be made again.`,
      {
        name: z.string().min(1).max(80),
        parents: z.array(z.string().min(1).max(80)).min(1).max(8),
        description: z.string().max(1000).optional(),
        evidence: evidenceArg.min(1),
        record_table: z.string().max(200).optional(),
        rows_are_nodes: z.boolean().optional(),
        stages: z.array(z.string().min(1).max(60)).max(30).optional(),
      },
      async (args) => text({ class: await show(await createClass(args, await writer()), ALL) }),
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
        return text({ class: await show(r.class, ALL), homes_moved: r.moved.length });
      },
    );
  }

  if (orchestrator || part) {
    server.tool(
      "relate_instance",
      `Relate an instance to a class that exists, making the instance when it doesn't: by its record key (system:table:row), its record
id, or its name. A row of a class whose rows stay in the source gets a node only when the graph must say something the source can't:
give that reason. An instance a person took out of a class isn't put back. A new instance never lands lower than what you have read;
the relation is seen where the record that states it is (source: its id), else where you write from.`,
      {
        class: z.string().min(1).max(80),
        key: z.string().max(300).optional(),
        instance: z.string().max(40).optional(),
        name: z.string().max(200).optional(),
        reason: z.string().max(600).optional(),
        notes: z.array(z.string().max(120)).max(20).optional(),
        source: z.string().max(40).optional(),
      },
      async (args) => text(await relateInstance(args, await readAs(args), await writer())),
    );
    server.tool(
      "add_dependency",
      `State that one instance depends on another (from depends on to): each by record id, record key or name, both ones you can see. A
row of a source table gets its node for this. Say where it was stated (source: a record or section id) and, when known, from and until
when it holds. Refused when you have read what someone who sees both ends can't.`,
      {
        from: endArg,
        to: endArg,
        stated_as: z.enum(["person", "record", "agent"]).optional(),
        source: z.string().max(200).optional(),
        note: z.string().max(600).optional(),
        valid_from: z.string().max(40).optional(),
        valid_until: z.string().max(40).optional(),
      },
      async (args) => text(await addDependency(args, await readAs(args), await writer())),
    );
    server.tool(
      "read_history",
      "In a discovery run: the old development notes, read-only, those your part's home may see, matching every word of query.",
      { query: z.string().max(200).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional() },
      async (args) => {
        await inRun();
        const s = await readAs(args);
        const r = readHistory(args, { positions: positionMap, homes: s.homes });
        recordReads(identity, r.notes.map((n) => n.home));
        return text(r);
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
  }

  if (orchestrator) {
    server.tool(
      "start_discovery_worker",
      `In a discovery run: give a part of it to a worker (some tables of one connection, or a stretch of the history seen from one
home). It reads as the people of that home see (the connection's home, or the home you give for notes), relates instances to classes
that exist, and asks you for any class it needs.`,
      { part: z.string().min(10).max(3000), connection: z.string().max(40).optional(), notes: z.string().max(300).optional(), home: z.string().max(80).optional(), minutes: z.number().int().min(5).max(180).optional() },
      async (args) => {
        const run = await inRun();
        if (!args.connection === !args.home) throw new Error("a part is one connection, or notes read as one home: give connection or home");
        if (args.home && args.home !== EVERYONE && !positionMap.positions[args.home]) throw new Error(`unknown home: ${args.home}`);
        // one worker per evidence home (R11.6): a connection's part reads as the connection's home (none: the root's)
        const home = args.connection ? connectionHome(args.connection) ?? positionMap.root : args.home;
        const title = `Discovery ${run}: ${args.connection ? `${args.connection}, ` : `notes at ${home}, `}${args.part.slice(0, 60)}`;
        const r = await createPartTask({ title, brief: discoveryPartBrief({ run, ...args }), minutes: args.minutes ?? 60, by: identity.user, run, home });
        return text({ task: r.task, job: r.job, run, reads_as: homeName(positionMap, home) });
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
    const scope = scopeOf(identity);
    void visibleClasses(scope, { retired })
      .then((classes) => showAll(classes, scope))
      .then((classes) => res.json({ classes, canCorrect: canEditPolicy(identity, scope) }), (e) => httpError(res, e));
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
    void correctClass(String(req.params.name ?? ""), req.body ?? {}, identity.user)
      .then(async (r) => ({ class: await show(r.class, ALL), correction: r.correction, homes_moved: r.moved }))
      .then((r) => res.json(r), (e) => httpError(res, e));
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
