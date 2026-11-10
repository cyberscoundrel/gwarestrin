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

export default [
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
