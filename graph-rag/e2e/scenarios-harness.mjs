// The Test harness stream's own scenarios (SCENARIOS.md is the contract this file follows): the record path
// under a live derived floor. The conversation batch and its landing bar went with atomic claims (R2) and the
// 62-note oracle stopping being the acceptance standard (R9); the integrator builds the real-model evaluation.
const RECORD_TOOL = "record_document"; // record-tools.js is not imported: it needs zod, and the runner has no node_modules
const q = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** a person's chat agent with its thread switched on record, as the person's instance does (manager.ts): a fresh agent has read nothing */
async function onRecordAgent(ctx, person, position) {
  const agent = ctx.randomUUID();
  const r = await fetch(`${ctx.GRAPH}/api/thread-record`, { method: "PUT", headers: { authorization: `Bearer ${ctx.TOKENS[person]}`, "content-type": "application/json" }, body: JSON.stringify({ agent, on: true }) });
  ctx.check(r.ok, `${person}'s agent on record: ${r.status}`);
  return ctx.delegated({ u: person, a: agent, p: [position] });
}

/** a record the rule proposed is approved by the admin: the designed flow, not a rescue */
async function approveIfProposed(ctx, r) {
  const pending = r.pendingId ?? (r.queued ? r.id : null);
  if (!pending) return { proposed: false };
  const ok = await ctx.api(`/api/queue/${pending}/approve`, { method: "POST", body: "{}" });
  return { proposed: true, approved: Boolean(ok.result?.approved || ok.approved), reply: ok };
}

/** query_graph as the admin, throwing on an error (ctx.sql reads an error as no rows, which would hide a drift) */
const strictQuery = (ctx) => async (query) => {
  const r = await ctx.tool("admin", "query_graph", { query, language: "sql" });
  if (r.error) throw new Error(String(r.error));
  return r.rows ?? [];
};

export default [
  {
    name: "the fake test source serves S0 on two endpoints, and the evaluation's own dump and row gate catch a change no Filed entry names",
    run: async (ctx) => {
      const { check } = ctx;
      const { connectionIdentity, guardTestSource, mcpClient, dumpSource } = await import(ctx.evalUrl("dump.mjs"));
      const { diffDumps, rowGate } = await import(ctx.evalUrl("source.mjs"));
      const read = mcpClient(ctx.SOURCE.read);
      const write = mcpClient(ctx.SOURCE.write);
      const keys = { dbo_Vendor: ["Vendor"], dbo_Material: ["Material"] };
      // the guard first: nothing is read until the connection names the expected test server and database
      await guardTestSource(() => connectionIdentity(read), { server: "gr-e2e-fake", database: "S0Fake" });
      let refusedGuard = null;
      await guardTestSource(() => connectionIdentity(read), { server: "gwsynth-sql", database: "GwSynthMfg" }).catch((e) => (refusedGuard = e.message));
      check(/refusing to run/.test(refusedGuard ?? ""), `another server's names are refused: ${refusedGuard}`);
      const before = await dumpSource(read, { keys });
      check(before.dbo_Employee.rows.some((r) => r.Employee === "NGDT" && r.Status === "Inactive"), "the synthetic database's inactive Diep is there");
      let refused = null;
      await read("update_record", { entity: "dbo_Job", keys: { Job: 4471 }, fields: { Status: "Rush" } }).catch((e) => (refused = String(e.message)));
      check(/Permission denied/.test(refused ?? ""), `the read endpoint refuses a write: ${refused}`);
      check((await dumpSource(read, { keys })).dbo_Job.rows.find((r) => r.Job === 4471).Status === "Active", "nothing changed");
      // a write nobody logged: the gate must fail it
      await write("update_record", { entity: "dbo_Job", keys: { Job: 4471 }, fields: { Status: "Rush" } });
      const changes = diffDumps(before, await dumpSource(read, { keys }));
      check(changes.length === 1 && changes[0].key === "mssql:dbo_Job:4471" && changes[0].columns.join() === "Status", `one change: ${JSON.stringify(changes)}`);
      check(!rowGate(changes, []).ok, "no Filed entry: the gate fails");
      const filed = { id: "e", outcome: "filed", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:4471", fields: { Status: "Rush" } } };
      check(rowGate(changes, [filed]).ok, "a Filed entry naming the row and its column: the gate passes");
      check((await ctx.sourceDump()).dbo_Job.rows.find((r) => r.Job === 4471).Status === "Rush", "the control route's dump agrees");
      await ctx.source("/__reset", {});
      check(diffDumps(before, await dumpSource(read, { keys })).length === 0, "reset: back to S0");
    },
  },
  {
    name: "graph-rag reports its write sources' live guard to the root's admin only, and the seeder's check accepts the harness's fake source only as such",
    run: async (ctx) => {
      const { check } = ctx;
      const { assertSeedTarget, HARNESS_FAKE } = await import(ctx.evalUrl("dump.mjs"));
      const get = (token) => fetch(`${ctx.GRAPH}/api/sources/guard`, { headers: { authorization: `Bearer ${token}` } });
      const r = await get(ctx.TOKENS.admin);
      const report = await r.json();
      check(r.ok, `the admin reads it: ${r.status} ${JSON.stringify(report).slice(0, 200)}`);
      const mssql = (report.sources ?? []).find((x) => x.system === "mssql");
      check(mssql?.writable && mssql.live?.ok, `the fake source's guard passes, live: ${JSON.stringify(mssql)}`);
      check(mssql.live.server === HARNESS_FAKE.server && mssql.live.database === HARNESS_FAKE.database && mssql.live.login === HARNESS_FAKE.login, `read through the write connection: ${JSON.stringify(mssql.live)}`);
      check(assertSeedTarget(report, { harness: true }).length === 1, "the seeder's check accepts it as the harness's fake");
      let refused = null;
      try {
        assertSeedTarget(report);
      } catch (e) {
        refused = e.message;
      }
      check(/not the synthetic test database/.test(refused ?? ""), `and refuses it as a real run's target: ${refused}`);
      for (const who of ["alice", "bob"]) check((await get(ctx.TOKENS[who])).status === 403, `${who} is refused`);
      check((await get(ctx.workerToken("#1:0"))).status === 403, "a worker is refused");
    },
  },
  {
    name: "the evaluation's snapshot reads run against the contract's schema, find a marker record where it landed, and the leak scan flags it only above its home",
    run: async (ctx) => {
      const { check, POS, until } = ctx;
      const { collectGraph } = await import(ctx.evalUrl("collect.mjs"));
      const { markerRecords } = await import(ctx.evalUrl("records.mjs"));
      const { markerHomes, scanLeaks, sectionItems } = await import(ctx.evalUrl("leaks.mjs"));
      const { POSITIONS } = await import(ctx.evalUrl("s0.mjs"));
      const query = strictQuery(ctx);
      const empty = await collectGraph(query);
      for (const k of ["entries", "requests", "briefs", "documents", "sections", "classes", "instances"]) check(Array.isArray(empty[k]), `${k} read`);
      // the reader meets the writer: the filing stream's scenarios (run before this file) left FilingEntry rows, and
      // the capacity scenario's claims left BriefLog rows; each parses into the shape the report scores
      const { OUTCOMES, normalizeEntry } = await import(ctx.srcUrl("model/filing.js"));
      // this scenario writes an entry of its own through the filing stream's tool (a Held piece from a floor filing job,
      // made as that stream's scenarios make one), so the check stands when only this file runs
      const fdoc = `e2e-seam-${ctx.randomUUID().slice(0, 8)}`;
      const fnow = new Date().toISOString();
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = '${fdoc} title', _kind = 'document', _doc_id = '${fdoc}', _home = 'floor', _origin = 'floor', _on_record = true, _recorded_by = 'bob', _record_position = 'floor', _record_reason = 'e2e', updated_at = '${fnow}'` });
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE VERTEX Entity SET name = '${fdoc} §1', _kind = 'section', _doc_id = '${fdoc}', _section = 0, _home = 'floor', _origin = 'floor', _written_by = 'bob', text_identity = 'A job shipped; which one?', updated_at = '${fnow}'` });
      const fsec = String((await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE name = '${fdoc} §1' AND _kind = 'section'`))[0].rid);
      const fjob = ctx.randomUUID();
      const fpayload = JSON.stringify({ rid: fsec, sections: [fsec], record: fdoc, home: "floor", parent: "master", label: "e2e seam" }).replace(/'/g, "\\'");
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `INSERT INTO Job SET id = '${fjob}', kind = 'review', job_key = 'file:${fdoc}:floor', payload = '${fpayload}', status = 'running', attempts = 0, priority = 0, created_at = '${fnow}', updated_at = '${fnow}'` });
      const held = await ctx.tool(ctx.workerToken(fsec, fjob), "hold_piece", { section: fsec, piece: "a job shipped", question: "Which job shipped?", table: "mssql:dbo_Job" });
      check(held.outcome === "held" && typeof held.entry === "string", `the filing tool wrote a Held entry: ${JSON.stringify(held).slice(0, 200)}`);
      const read = await collectGraph(query);
      empty.entries = read.entries;
      if (!empty.briefs.length) empty.briefs = read.briefs;
      check(empty.entries.some((e) => e.id === held.entry && e.record === fdoc), `the reader finds it by its document id: ${JSON.stringify(empty.entries.slice(-2)).slice(0, 300)}`);
      for (const e of empty.entries) {
        check(OUTCOMES.includes(e.outcome) && Array.isArray(e.instances), `entry ${e.id}: ${JSON.stringify(e).slice(0, 200)}`);
        if (e.outcome !== "kept") check(e.target && typeof e.target === "object" && e.target.table, `entry ${e.id} has its target parsed: ${JSON.stringify(e.target)}`);
        if (e.outcome === "filed") check(typeof e.account?.said === "string", `a Filed entry ${e.id} has its account: ${JSON.stringify(e.account)}`);
        normalizeEntry(e); // as the contract takes it, or this throws naming the field
      }
      check(empty.briefs.length > 0, "the brief log has briefs to scan");
      for (const b of empty.briefs) {
        const sent = JSON.parse(b.text);
        check(b.audience && sent.audience === b.audience && typeof sent.message === "string" && sent.message.length > 0, `brief ${b.id} holds its audience and the message as sent: ${String(b.text).slice(0, 200)}`);
      }
      // marker-3: alice's Operations matter; recorded through the record path as her on-record agent
      const seed = Number.parseInt(ctx.randomUUID().slice(0, 6), 16);
      const { records, markers } = markerRecords(seed);
      const rec = records.find((r) => r.note === "marker-3");
      rec.document.title = `${rec.document.title} ${seed}`;
      const agent = await onRecordAgent(ctx, "alice", POS.ops);
      const r = await ctx.tool(agent, RECORD_TOOL, { document: rec.document });
      check(!r.error, `recorded: ${JSON.stringify(r).slice(0, 300)}`);
      await approveIfProposed(ctx, r);
      const word = markers.find((m) => m.record === "marker-3").word;
      const snap = await until("the marker's section is readable", async () => {
        const s = await collectGraph(query, { records: [rec] });
        return s.sections.some((x) => x.text.includes(word)) && s.recordIds["marker-3"] ? s : null;
      });
      const homes = markerHomes([{ word, record: "marker-3", recordId: snap.recordIds["marker-3"], floor: rec.document.position }], snap.sections, POSITIONS);
      // the expected home is the label's (alice's position); the system stored it there, not lower
      check(homes[0].home === POS.ops && homes[0].stored === POS.ops && !homes[0].misplaced && !homes[0].untested, `stored at its recorder's position: ${JSON.stringify(homes)}`);
      const clean = scanLeaks(sectionItems(snap.sections), homes, POSITIONS);
      check(clean.ok, `no section above its audience holds it: ${JSON.stringify(clean.leaks)}`);
      // what bob's search returns is what a floor brief could carry: the marker must not be in it
      // (only the results: the reply also echoes the query, which names the marker)
      const seen = await ctx.tool("bob", "search_graph", { query: `${word} Metals bar stock` });
      check(Array.isArray(seen.results), `bob searched: ${JSON.stringify(seen).slice(0, 200)}`);
      const bobs = scanLeaks([{ where: "search:bob", audience: POS.floor, text: JSON.stringify(seen.results) }], homes, POSITIONS);
      // alice, at the marker's own home, does find it: the search could have shown it, so bob's clean scan means something
      const hers = await ctx.tool("alice", "search_graph", { query: `${word} Metals bar stock` });
      check(JSON.stringify(hers.results ?? []).includes(word), `alice's search finds it: ${JSON.stringify(hers).slice(0, 300)}`);
      check(bobs.ok, `the floor's search doesn't carry it: ${JSON.stringify(bobs.leaks)}`);
      // the gate's teeth: the same words in something the floor sees
      const planted = scanLeaks([{ where: "brief:planted", audience: POS.floor, text: `context: ${word.toUpperCase()} metals` }], homes, POSITIONS);
      check(!planted.ok && planted.leaks[0].where === "brief:planted", "a planted floor brief with the marker is a leak");
    },
  },
  {
    name: "the record path under the live derived floor: what an agent read above its position holds its record there, and an agent that read nothing lands at its own",
    run: async (ctx) => {
      const { POS, check, tool, sql, until, api } = ctx;
      const policy = (await api("/api/policy")).policy;
      check(policy.derivedWindowHours > 0, `the window is on: ${policy.derivedWindowHours}`);
      const prefix = `e2e-floor-${ctx.randomUUID().slice(0, 8)}`;
      // another person's note at the top: a read of it is a read from above
      const secret = `${prefix} quenchwort budget`;
      await ctx.save("admin", secret, "The quenchwort fixture budget is 9,000. [admins]");
      check((await ctx.entry(secret))?._home === POS.org, "the note is at the top");
      const document = (title) => ({ title, recorded_by: "alice", position: POS.ops, reason: "e2e", sections: [{ heading: `${title} section`, text: `${title}: the quenchwort cell is running.` }] });
      const reader = await onRecordAgent(ctx, "alice", POS.ops);
      const granted = await tool("admin", "grant_access", { entities: [{ name: secret }], person: "alice", reason: "e2e: a read from above" });
      check(!granted.error, `granted: ${JSON.stringify(granted).slice(0, 300)}`);
      const seen = (await tool(reader, "search_graph", { query: "quenchwort fixture budget 9,000" })).results ?? [];
      check(seen.some((r) => r.name === secret), `the agent read the note: ${JSON.stringify(seen.map((r) => r.name)).slice(0, 200)}`);
      const held = `${prefix} held`;
      const plain = `${prefix} plain`;
      for (const [who, title] of [
        [reader, held],
        [await onRecordAgent(ctx, "alice", POS.ops), plain],
      ]) {
        const r = await tool(who, RECORD_TOOL, { document: document(title) });
        check(!r.error, `${title} recorded: ${JSON.stringify(r).slice(0, 300)}`);
        const a = await approveIfProposed(ctx, r);
        check(!a.proposed || a.approved, `${title} approved: ${String(JSON.stringify(a.reply)).slice(0, 300)}`);
      }
      const landed = async (title) => {
        const doc = (await sql(`SELECT _home, _doc_status FROM Entity WHERE _kind = 'document' AND name = '${q(title)}'`))[0];
        const section = (await sql(`SELECT _home FROM Entity WHERE _kind = 'section' AND _doc_title = '${q(title)}'`))[0];
        return { doc: doc?._home, section: section?._home, status: doc?._doc_status };
      };
      for (const title of [held, plain]) await until(`${title} ingested`, async () => (await landed(title)).status === "ready");
      const h = await landed(held);
      check(h.doc === POS.org && h.section === POS.org, `held at what it read: ${JSON.stringify(h)}`);
      const p = await landed(plain);
      check(p.doc === POS.ops && p.section === POS.ops, `an agent that read nothing lands at its own: ${JSON.stringify(p)}`);
    },
  },
];
