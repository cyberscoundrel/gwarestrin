// The classes and discovery stream's scenarios (SCENARIOS.md). The scenario plays the orchestrator's part
// with plain tool calls; every assertion is on what the code enforces (homes worked out from evidence,
// tools a discovery run is refused, corrections respected, edges hidden from who can't see both ends),
// never on a name the caller chose.

const P = "e2e-classes";
const say = (r, what) => {
  if (r?.error) throw new Error(`${what}: ${String(r.error).slice(0, 300)}`);
  return r;
};

/** tools/list for a token: the names */
async function toolNames(ctx, token) {
  const r = await fetch(`${ctx.GRAPH}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  return (JSON.parse(line ? line.slice(5) : t).result?.tools ?? []).map((x) => x.name);
}

/** an /api call as anyone */
async function http(ctx, who, path, init = {}) {
  const r = await fetch(`${ctx.GRAPH}${path}`, { ...init, headers: { authorization: `Bearer ${ctx.TOKENS[who] ?? who}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await r.text();
  try {
    return { status: r.status, ...JSON.parse(body) };
  } catch {
    return { status: r.status, text: body };
  }
}

/**
 * An entry seen from the production floor, as evidence: bob's note, unless what bob read earlier in the run
 * raised it (the derived floor), then any entry that is at the floor.
 */
async function floorEntry(ctx, name, text) {
  await ctx.save("bob", name, text);
  const mine = await ctx.entry(name);
  if (mine?._home === ctx.POS.floor) return mine;
  const any = (await ctx.sql(`SELECT @rid AS rid, name, _home FROM Entity WHERE _home = '${ctx.POS.floor}' AND _kind IS NULL LIMIT 1`))[0];
  ctx.check(any, "an entry at the floor to use as evidence");
  return { ...any, rid: String(any.rid) };
}

/** the class keys an instance has INSTANCE_OF edges to */
async function classKeysOf(ctx, rid) {
  const ends = (await ctx.sql(`SELECT @in AS c FROM INSTANCE_OF WHERE @out = ${rid}`)).map((r) => String(r.c));
  return ends.length ? (await ctx.sql(`SELECT _class_key FROM [${ends.join(",")}]`)).map((r) => r._class_key) : [];
}

const master = (ctx, claims = {}) => ctx.delegated({ r: "master", ...claims });
let run = null;
/** a discovery run started by the admin, and the orchestrator's token for it */
async function discovery(ctx) {
  if (!run) {
    const r = await http(ctx, "admin", "/api/classes/discovery", { method: "POST", body: JSON.stringify({ focus: "e2e" }) });
    ctx.check(r.status === 200 && /^run-/.test(r.run ?? ""), `no run: ${JSON.stringify(r).slice(0, 200)}`);
    ctx.check(/read-only to you/.test(r.brief), "the brief says the run is read-only");
    run = r.run;
  }
  return { run, token: master(ctx, { d: run }) };
}
const classes = async (ctx, token) => say(await ctx.tool(token, "list_classes", {}), "list_classes").classes;
const classNamed = async (ctx, token, name) => (await classes(ctx, token)).find((c) => c.name === name);

export default [
  {
    name: "an empty graph starts with the four primitives, and decision and action under event (R1)",
    run: async (ctx) => {
      const list = await classes(ctx, master(ctx));
      for (const p of ["agent", "commitment", "event", "resource"]) ctx.check(list.find((c) => c.name === p)?.parents.length === 0, `${p} is a root`);
      for (const s of ["decision", "action"]) ctx.check(JSON.stringify(list.find((c) => c.name === s)?.parents) === '["event"]', `${s} under event`);
    },
  },
  {
    name: "a discovery run has read tools, the class tree and instances only: nothing that writes to a source or files a record (R11)",
    run: async (ctx) => {
      const { token } = await discovery(ctx);
      const names = await toolNames(ctx, token);
      for (const t of ["search_graph", "list_classes", "create_class", "relate_instance", "read_history", "record_examined"]) ctx.check(names.includes(t), `listed: ${t}`);
      for (const t of ["upsert_entities", "execute_graph", "set_home", "start_worker", "decide_proposal", "query_graph", "ingest_document"]) ctx.check(!names.includes(t), `not listed: ${t}`);
      const r = await ctx.tool(token, "upsert_entities", { entities: [{ name: `${P}-write`, facets: { identity: "x" } }] });
      ctx.check(r.error, "a write tool a discovery run lacks can't be called");
      ctx.check(!(await ctx.entry(`${P}-write`)), "nothing was written");
      // the orchestrator outside a run keeps its own tools
      ctx.check((await toolNames(ctx, master(ctx))).includes("start_worker"), "the orchestrator outside discovery is unchanged");
    },
  },
  {
    name: "a person's chat agent and a worker can't make a class: only the orchestrator does (R5, R7)",
    run: async (ctx) => {
      const chat = await toolNames(ctx, ctx.TOKENS.alice);
      ctx.check(!chat.some((t) => /class|instance|dependenc/.test(t)), `a chat token lists no class tools: ${chat.filter((t) => /class/.test(t))}`);
      const w = ctx.workerToken((await ctx.save("bob", `${P}-worker-entry`, "a note for a worker")).rid ?? (await ctx.entry(`${P}-worker-entry`)).rid);
      const names = await toolNames(ctx, w);
      ctx.check(names.includes("relate_instance") && !names.includes("create_class"), "a worker relates, never creates");
    },
  },
  {
    name: "a class's home is worked out from its evidence and its parents, never given by the caller (R11, R9)",
    run: async (ctx) => {
      const { token } = await discovery(ctx);
      // a table on a connection with no home: the root, whatever home the caller sends
      const t = say(await ctx.tool(token, "create_class", { name: `${P} ledger`, parents: ["commitment"], evidence: [{ kind: "table", ref: "e2econn:dbo_Ledger" }], record_table: "e2econn:dbo_Ledger", home: "everyone" }), "create from a table");
      ctx.check(t.class.home === (await classNamed(ctx, master(ctx), `${P} ledger`)).home, "stored as shown");
      const top = await http(ctx, "admin", "/api/classes");
      ctx.check(top.classes.find((c) => c.name === `${P} ledger`)?.home !== "Everyone", "the caller's home is ignored");
      // notes: an entry on the floor is evidence seen from the floor
      const note = await floorEntry(ctx, `${P}-floor-note`, "the forklift is serviced every quarter");
      say(await ctx.tool(token, "create_class", { name: `${P} forklift`, parents: ["resource"], evidence: [{ kind: "notes", ref: note.rid }] }), "create from a note");
      const bob = await http(ctx, "bob", "/api/classes");
      ctx.check(bob.classes.some((c) => c.name === `${P} forklift`), "bob, on the floor, sees the class his note supports");
      ctx.check(!bob.classes.some((c) => c.name === `${P} ledger`), "bob doesn't see the class homed at the root");
      // a subclass under a stricter parent is no wider than it: strictest wins
      say(await ctx.tool(token, "create_class", { name: `${P} reach truck`, parents: [`${P} forklift`, `${P} ledger`], evidence: [{ kind: "notes", ref: note.rid }] }), "create under two parents");
      const bob2 = await http(ctx, "bob", "/api/classes");
      ctx.check(!bob2.classes.some((c) => c.name === `${P} reach truck`), "a class under a root-homed parent isn't seen from the floor");
    },
  },
  {
    name: "a person's correction is stored, moves homes down the tree, and a rerun respects it (R11)",
    run: async (ctx) => {
      const { token } = await discovery(ctx);
      const note = await floorEntry(ctx, `${P}-floor-note-2`, "pallets are counted at shift change");
      say(await ctx.tool(token, "create_class", { name: `${P} pallet`, parents: ["resource"], evidence: [{ kind: "notes", ref: note.rid }] }), "parent");
      say(await ctx.tool(token, "create_class", { name: `${P} euro pallet`, parents: [`${P} pallet`], evidence: [{ kind: "notes", ref: note.rid }] }), "child");
      ctx.check((await http(ctx, "bob", "/api/classes")).classes.some((c) => c.name === `${P} euro pallet`), "bob sees both at first");
      // a person tightens the parent: the child follows
      const fix = await http(ctx, "admin", `/api/classes/${encodeURIComponent(`${P} pallet`)}/corrections`, { method: "POST", body: JSON.stringify({ kind: "home", value: ctx.POS.ops, reason: "pallet counts are a manager's" }) });
      ctx.check(fix.status === 200, `corrected: ${JSON.stringify(fix).slice(0, 200)}`);
      const bob = await http(ctx, "bob", "/api/classes");
      ctx.check(!bob.classes.some((c) => c.name === `${P} pallet` || c.name === `${P} euro pallet`), "neither is seen from the floor now");
      ctx.check((await http(ctx, "alice", "/api/classes")).classes.some((c) => c.name === `${P} euro pallet`), "alice, at operations, sees the child");
      // the orchestrator can't change what the person pinned
      ctx.check((await ctx.tool(token, "update_class", { name: `${P} pallet`, add_evidence: [{ kind: "table", ref: "e2econn:dbo_Pallet" }] })).class, "adding evidence is still allowed");
      ctx.check((await http(ctx, "bob", "/api/classes")).classes.every((c) => c.name !== `${P} pallet`), "the pinned home holds against new evidence");
      // retired: never made again, by name or by its table
      await http(ctx, "admin", `/api/classes/${encodeURIComponent(`${P} ledger`)}/corrections`, { method: "POST", body: JSON.stringify({ kind: "retire" }) });
      const again = await ctx.tool(token, "create_class", { name: `${P} Ledger`, parents: ["commitment"], evidence: [{ kind: "table", ref: "e2econn:dbo_Ledger" }] });
      ctx.check(/retired by a person/.test(again.error ?? ""), `a retired class doesn't return: ${JSON.stringify(again).slice(0, 200)}`);
      const byTable = await ctx.tool(token, "create_class", { name: `${P} accounts`, parents: ["commitment"], evidence: [{ kind: "table", ref: "e2econn:dbo_Ledger" }], record_table: "e2econn:dbo_Ledger" });
      ctx.check(/retired by a person/.test(byTable.error ?? ""), "nor under another name for the same table");
      // a renamed class's old name can't be made again
      await http(ctx, "admin", `/api/classes/${encodeURIComponent(`${P} forklift`)}/corrections`, { method: "POST", body: JSON.stringify({ kind: "rename", value: `${P} lift truck` }) });
      const old = await ctx.tool(token, "create_class", { name: `${P} forklift`, parents: ["resource"], evidence: [{ kind: "notes", note: "again" }] });
      ctx.check(/renamed/.test(old.error ?? ""), "a renamed class's old name points at its new one");
      // only a person at the root corrects
      const nope = await http(ctx, "alice", `/api/classes/${encodeURIComponent(`${P} pallet`)}/corrections`, { method: "POST", body: JSON.stringify({ kind: "retire" }) });
      ctx.check(nope.status === 403, "alice can't correct a class");
    },
  },
  {
    name: "a transactional row gets a node only for what its source can't hold, and an instance is related by an edge (R3, R1)",
    run: async (ctx) => {
      const { token } = await discovery(ctx);
      say(await ctx.tool(token, "create_class", { name: `${P} invoice`, parents: ["commitment"], evidence: [{ kind: "table", ref: "e2econn:dbo_Invoice" }], record_table: "e2econn:dbo_Invoice", rows_are_nodes: false }), "rows stay");
      say(await ctx.tool(token, "create_class", { name: `${P} truck`, parents: ["resource"], evidence: [{ kind: "table", ref: "e2econn:dbo_Truck" }], record_table: "e2econn:dbo_Truck", rows_are_nodes: true }), "rows are nodes");
      const refused = await ctx.tool(token, "relate_instance", { class: `${P} invoice`, key: "e2econn:dbo_Invoice:1001" });
      ctx.check(/rows stay in/.test(refused.error ?? ""), `an invoice row is not a node: ${JSON.stringify(refused).slice(0, 200)}`);
      const truck = say(await ctx.tool(token, "relate_instance", { class: `${P} truck`, key: "e2econn:dbo_Truck:T7", name: `${P} truck T7` }), "a truck");
      ctx.check(truck.created && truck.related, "made and related");
      const again = say(await ctx.tool(token, "relate_instance", { class: `${P} truck`, key: "e2econn:dbo_Truck:T7" }), "again");
      ctx.check(again.instance === truck.instance && !again.created && !again.related, "found by its key, related once");
      const edges = await ctx.sql(`SELECT count(*) AS n FROM INSTANCE_OF WHERE @out = ${truck.instance}`);
      ctx.check(Number(edges[0]?.n) === 1, "one instance edge");
      const why = say(await ctx.tool(token, "relate_instance", { class: `${P} invoice`, key: "e2econn:dbo_Invoice:1002", reason: "the graph must say it waits on a permit" }), "with a reason");
      ctx.check(why.created, "a row's node with a stated reason");
    },
  },
  {
    name: "a dependency edge is seen only by someone who sees both ends (R11)",
    run: async (ctx) => {
      const m = master(ctx);
      const note = await floorEntry(ctx, `${P}-dep-note`, "the lift needs its inspection before the season");
      say(await ctx.tool(m, "create_class", { name: `${P} inspection`, parents: ["event"], evidence: [{ kind: "notes", ref: note.rid }] }), "class on the floor");
      const lift = say(await ctx.tool(m, "relate_instance", { class: `${P} inspection`, name: `${P} lift L1`, notes: [note.rid] }), "floor instance");
      const insp = say(await ctx.tool(m, "relate_instance", { class: `${P} inspection`, name: `${P} spring inspection`, notes: [note.rid] }), "floor instance 2");
      const secret = say(await ctx.tool(m, "relate_instance", { class: `${P} inspection`, name: `${P} insurer audit` }), "root instance");
      say(await ctx.tool(m, "add_dependency", { from: lift.instance, to: insp.instance, stated_as: "record", source: note.rid, valid_from: "2026-03-01" }), "both on the floor");
      say(await ctx.tool(m, "add_dependency", { from: lift.instance, to: secret.instance, stated_as: "agent" }), "one end at the root");
      const top = say(await ctx.tool(m, "read_dependencies", { instance: lift.instance }), "read as the orchestrator");
      ctx.check(top.depends_on.length === 2, "the orchestrator sees both");
      const w = ctx.workerToken(note.rid);
      const floor = say(await ctx.tool(w, "read_dependencies", { instance: lift.instance }), "read as a floor worker");
      ctx.check(floor.depends_on.length === 1 && floor.depends_on[0].to === insp.instance, `the floor sees only the edge whose ends it sees: ${JSON.stringify(floor).slice(0, 300)}`);
      ctx.check(!JSON.stringify(floor).includes("insurer"), "nor the name at the other end");
      const blind = await ctx.tool(w, "add_dependency", { from: lift.instance, to: secret.instance });
      ctx.check(blind.error, "a worker can't state a dependency on what it can't see");
    },
  },
  {
    name: "a discovery run records what it examined, and a rerun reads only new tables (R9)",
    run: async (ctx) => {
      const { token } = await discovery(ctx);
      say(await ctx.tool(token, "record_examined", { system: "e2econn", tables: ["dbo_Ledger", "dbo_Status"] }), "record");
      const fresh = say(await ctx.tool(token, "new_tables", { system: "e2econn", tables: ["dbo_Ledger", "dbo_Status", "dbo_Lease"] }), "new tables");
      ctx.check(JSON.stringify(fresh.new) === '["dbo_Lease"]', `only the new table: ${JSON.stringify(fresh)}`);
      const outside = await ctx.tool(master(ctx), "record_examined", { system: "e2econn", tables: ["dbo_X"] });
      ctx.check(/only in a discovery run/.test(outside.error ?? ""), "outside a run there is nothing to record");
    },
  },
  {
    name: "a worker on a part of a discovery run is held to the discovery tools (R11)",
    run: async (ctx) => {
      const { token, run: id } = await discovery(ctx);
      const r = say(await ctx.tool(token, "start_discovery_worker", { part: "read the tables dbo_Lease and dbo_Site", connection: "e2econn" }), "start a part");
      ctx.check(r.run === id, "the part belongs to the run");
      const rows = await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE _kind = 'task' AND _discovery_run = '${id}' ORDER BY @rid DESC LIMIT 1`);
      ctx.check(rows.length === 1, "the task entry is marked with its run");
      const w = ctx.workerToken(String(rows[0].rid));
      const wrote = await ctx.tool(w, "upsert_entities", { entities: [{ name: `${P}-part-write`, facets: { identity: "x" } }] });
      ctx.check(/discovery is read-only/.test(wrote.error ?? ""), `refused at the call: ${JSON.stringify(wrote).slice(0, 200)}`);
      ctx.check(!(await ctx.entry(`${P}-part-write`)), "nothing written");
      ctx.check(!(await ctx.tool(w, "list_classes", {})).error, "it reads the classes");
    },
  },
  {
    name: "stages are refused on a class not under commitment (R11; the reviewer's item 5)",
    run: async (ctx) => {
      const r = await ctx.tool(master(ctx), "create_class", { name: `${P} crane`, parents: ["resource"], evidence: [{ kind: "notes", note: "cranes" }], stages: ["idle", "lifting"] });
      ctx.check(/only a class under commitment has stages/.test(r.error ?? ""), `refused: ${JSON.stringify(r).slice(0, 200)}`);
      ctx.check(!(await classNamed(ctx, master(ctx), `${P} crane`)), "not made");
      say(await ctx.tool(master(ctx), "create_class", { name: `${P} rental`, parents: ["commitment", "resource"], evidence: [{ kind: "notes", note: "rentals" }], stages: ["booked", "returned"] }), "one parent under commitment is enough");
    },
  },
  {
    name: "a class name is taken per home: the same name at a home the writer can't see blocks nothing and is never named (the reviewer's item 11)",
    run: async (ctx) => {
      const m = master(ctx);
      const note = await floorEntry(ctx, `${P}-depot-note`, "the depot opens at six");
      say(await ctx.tool(m, "create_class", { name: `${P} depot`, parents: ["resource"], evidence: [{ kind: "table", ref: "e2econn:dbo_Depot" }] }), "at the root");
      say(await ctx.tool(m, "create_class", { name: `${P} Depot`, parents: ["resource"], evidence: [{ kind: "notes", ref: note.rid }] }), "the same name at the floor is another class");
      const bob = (await http(ctx, "bob", "/api/classes")).classes.filter((c) => c.name.toLowerCase().startsWith(`${P} depot`));
      ctx.check(bob.length === 1 && bob[0].name === `${P} Depot`, `bob sees one depot, named plainly, nothing about the other: ${JSON.stringify(bob)}`);
      const both = (await classes(ctx, m)).filter((c) => c.name.toLowerCase().startsWith(`${P} depot`));
      ctx.check(both.length === 2 && both.every((c) => c.name.includes("@")), `the orchestrator sees both, each with its home: ${both.map((c) => c.name)}`);
      const which = await ctx.tool(m, "update_class", { name: `${P} depot`, description: "x" });
      ctx.check(/say which/.test(which.error ?? ""), "an ambiguous name is refused, naming only what the caller sees");
      say(await ctx.tool(m, "update_class", { name: `${P} depot@${ctx.POS.floor}`, description: "the floor's depot" }), "a ref with its home");
      const again = await ctx.tool(m, "create_class", { name: `${P} depot`, parents: ["resource"], evidence: [{ kind: "table", ref: "e2econn:dbo_Depot2" }] });
      ctx.check(/exists already at that home/.test(again.error ?? ""), "the same name at the same home is refused");
    },
  },
  {
    name: "positions are mirrored as classes under agent with people as instances, and the AI agents are instances under agent (R6, R1)",
    run: async (ctx) => {
      const m = master(ctx);
      const list = await classes(ctx, m);
      const mirrored = list.filter((c) => c.mirrors);
      ctx.check(mirrored.length === 3, `one class per test position: ${mirrored.map((c) => c.name)}`);
      const top = mirrored.find((c) => JSON.stringify(c.parents) === '["agent"]');
      ctx.check(top, "the root position's class sits under agent");
      ctx.check(mirrored.filter((c) => c !== top).every((c) => mirrored.some((p) => c.parents.includes(p.name))), "the others under their parent position's class");
      const bobRow = (await ctx.sql("SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND _keys CONTAINS 'authentik:user:bob'"))[0];
      ctx.check(bobRow, "bob is an instance");
      const of = await classKeysOf(ctx, bobRow.rid);
      ctx.check(of.length === 1 && mirrored.some((c) => c.name.toLowerCase().replace(/[^a-z0-9]+/g, "_") === of[0]), `bob is an instance of his one position's class: ${JSON.stringify(of)}`);
      for (const key of ["graph-rag:agent:orchestrator", "graph-rag:agent:graph-worker"]) {
        const a = (await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND _keys CONTAINS '${key}'`))[0];
        ctx.check(a, `${key} is an instance`);
        const c = await classKeysOf(ctx, a.rid);
        ctx.check(JSON.stringify(c) === '["agent"]', `${key} is an instance of agent: ${JSON.stringify(c)}`);
      }
      const upd = await ctx.tool(m, "update_class", { name: top.name, description: "x" });
      ctx.check(/mirrors a position/.test(upd.error ?? ""), "the orchestrator can't change a mirrored class");
      const rel = await ctx.tool(m, "relate_instance", { class: top.name, name: `${P} someone` });
      ctx.check(/mirrors a position/.test(rel.error ?? ""), "nor add people to it: they come from authentik");
    },
  },
  {
    name: "the tree report lists each class under its parents with home, evidence and instance count (R5)",
    run: async (ctx) => {
      const r = await http(ctx, "admin", "/api/classes/report");
      ctx.check(r.status === 200 && /^- agent/m.test(r.text ?? ""), "a report");
      ctx.check(new RegExp(`- ${P} truck \\(home: [^;]+; table e2econn:dbo_Truck, rows are nodes; 1 instance\\)`).test(r.text), `the truck class line: ${r.text?.split("\n").filter((l) => l.includes("truck")).join(" | ")}`);
      ctx.check(/Retired by a person:/.test(r.text), "retired classes listed apart");
      ctx.check((await http(ctx, "alice", "/api/classes/report")).status === 403, "only for a person at the root");
    },
  },
];
