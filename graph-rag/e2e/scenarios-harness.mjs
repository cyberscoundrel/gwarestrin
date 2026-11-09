// The Test harness stream's own scenarios (SCENARIOS.md is the contract this
// file follows, like every stream's): the conversation batch generated from
// the oracle, and the clean-batch bar over claims in a real ArcadeDB.
//
// Until the Condenser's ingest route is on main, the end-to-end scenario is
// skipped with its reason and the batch is stored directly in the contract's
// shape (src/model/README.md: a document entry with the on-record marker,
// sections PART_OF it, CLAIMS edges from each section to its subject) so the
// bar is exercised against the graph today. When a tool matching
// CONDENSE_TOOL_RE appears in tools/list, the last scenario runs for real.
import { readFileSync } from "node:fs";
import { normalizeDocument } from "../src/model/claims.js";
import { statements } from "../src/model/schema.js";
import { sectionName } from "../src/documents.js";
import { bar, checkBatch, collectRows, subjectLabel, verdictLine } from "./conversations.mjs";

export const CONDENSE_TOOL_RE = /condens|on_record|record_document|record_conversation/i;
const BATCH = new URL("../test/fixtures/conversations/oracle-sixty.batch.json", import.meta.url);
const loadBatch = () => JSON.parse(readFileSync(BATCH, "utf8"));
const q = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** the MCP tools this graph-rag offers the admin (tools/list) */
async function toolNames(ctx) {
  const r = await fetch(`${ctx.GRAPH}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.TOKENS.admin}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  const msg = JSON.parse(line ? line.slice(5) : t);
  return (msg.result?.tools ?? []).map((x) => x.name);
}
const condenseTool = async (ctx) => (await toolNames(ctx)).find((n) => CONDENSE_TOOL_RE.test(n)) ?? null;

/**
 * One conversation stored as the contract says, by hand, through the
 * admin's raw SQL: what the Condenser's ingest path will do. Claims carry
 * their expected home (the authority rule's answer); subjects become things
 * keyed by their record key or named.
 */
async function storeAsContract(ctx, c, prefix) {
  const d = c.expected.document;
  const x = c.expected;
  const exec = async (command) => {
    const r = await ctx.tool("admin", "execute_graph", { language: "sql", command });
    if (r.error) throw new Error(`${command.slice(0, 120)}: ${r.error}`);
    return r;
  };
  const docId = `${prefix}-${c.id}`;
  await exec(`CREATE VERTEX Entity SET name = '${q(d.title)}', _kind = 'document', _home = '${x.document_home}', _origin = '${x.document_home}', _written_by = '${q(d.recorded_by)}', _doc_id = '${docId}', _doc_status = 'ready', text_identity = '${q(`${d.title}: ${d.description}`)}', _on_record = true, _recorded_by = '${q(d.recorded_by)}', _recorded_at = '${d.recorded_at}', _record_position = '${d.position}', _record_reason = '${q(d.reason)}'`);
  for (const [i, s] of d.sections.entries()) {
    const es = x.sections[i];
    await exec(`CREATE VERTEX Entity SET name = '${q(sectionName(d.title, i, s.heading))}', _kind = 'section', _home = '${es.home}', _origin = '${x.document_home}', _written_by = '${q(d.recorded_by)}', _doc_id = '${docId}', _doc_title = '${q(d.title)}', _section = ${i}, text_identity = '${q(s.text)}'`);
    await exec(`CREATE EDGE PART_OF FROM (SELECT FROM Entity WHERE _kind = 'section' AND _doc_id = '${docId}' AND _section = ${i}) TO (SELECT FROM Entity WHERE _kind = 'document' AND _doc_id = '${docId}')`);
    for (const cl of s.claims) {
      const pl = x.placements.find((p) => p.id === cl.id);
      const subject = typeof cl.subject === "string" ? cl.subject : (cl.subject.key ?? cl.subject.name ?? cl.subject.class);
      const label = subjectLabel(cl.subject);
      const key = typeof cl.subject === "string" && cl.subject.split(":").length === 3 ? cl.subject : null;
      const thingName = `${prefix} ${label}`;
      const have = await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND name = '${q(thingName)}'`);
      if (!have.length) await exec(`CREATE VERTEX Entity SET name = '${q(thingName)}', _kind = 'thing', _home = '${x.document_home}', _origin = '${x.document_home}', _thing_type = 'other', label = '${q(label)}'${key ? `, _keys = ['${q(key)}']` : ""}`);
      await exec(
        `CREATE EDGE CLAIMS FROM (SELECT FROM Entity WHERE _kind = 'section' AND _doc_id = '${docId}' AND _section = ${i}) TO (SELECT FROM Entity WHERE _kind = 'thing' AND name = '${q(thingName)}') SET id = '${q(cl.id)}', kind = '${q(cl.kind)}', class = '${q(cl.class)}', attribute = '${q(cl.attribute)}', value = '${q(String(cl.value))}', recorded_at = '${d.recorded_at}', recorded_by = '${q(d.recorded_by)}', _home = '${pl.home}'`,
      );
      void subject;
    }
  }
}

export default [
  {
    name: "conversation batch: the oracle's sixty-two as on-record conversations, every expected document validating",
    run: async (ctx) => {
      const batch = loadBatch();
      const problems = checkBatch(batch);
      ctx.check(problems.length === 0, `batch problems: ${problems.slice(0, 5).join("; ")}`);
      ctx.check(batch.conversations.length >= 62, `${batch.conversations.length} conversations`);
      const claims = batch.conversations.reduce((a, c) => a + c.expected.placements.length, 0);
      ctx.check(claims >= 100, `${claims} claims (the oracle's 100)`);
      ctx.check(batch.conversations.every((c) => c.turns.length >= 5 && c.turns[0].role === "person"), "a few turns each, the person opening");
      // every expected document is what the condenser must emit: the contract's own validator accepts it
      for (const c of batch.conversations) {
        const doc = normalizeDocument(c.expected.document, { now: c.recorded_at });
        ctx.check(doc.on_record && doc.recorded_by === c.person && doc.position === c.position, `${c.id}: on record by its person at their position`);
      }
      // the three positions the batches use, in the tree e2e.sh runs
      const pos = await ctx.api("/api/positions");
      for (const id of new Set(batch.conversations.flatMap((c) => c.expected.placements.map((p) => p.home)))) ctx.check((pos.tree ?? []).some((p) => p.id === id), `expected home ${id} exists in the harness tree`);
    },
  },
  {
    name: "the clean-batch bar reads claims from the graph: a batch stored as the contract says is clean; a rescue, a misplacement, lost text and a hidden title each fail it",
    run: async (ctx) => {
      const full = loadBatch();
      const pick = ["ux-m01", "ux-al04", "ux-aa11"]; // one authority, two authorities, the residue
      const batch = { ...full, conversations: full.conversations.filter((c) => pick.includes(c.note)) };
      ctx.check(batch.conversations.length === 3, "the three picked conversations are in the batch");
      // the model's DDL is idempotent; the harness runs it since nothing on main does yet
      for (const ddl of statements()) {
        const r = await ctx.tool("admin", "execute_graph", { language: "sql", command: ddl });
        ctx.check(!r.error || /already exists/i.test(r.error), `${ddl}: ${r.error ?? "ok"}`);
      }
      const prefix = `e2e-harness-${ctx.randomUUID().slice(0, 8)}`;
      for (const c of batch.conversations) await storeAsContract(ctx, c, prefix);
      const rows = await collectRows(batch, ctx.sql);
      ctx.check(rows.documents.length === 3 && rows.sections.length === 4 && rows.claims.length === 5, `read back 3 documents, 4 sections, 5 claims: ${rows.documents.length}/${rows.sections.length}/${rows.claims.length}`);
      const clean = bar(batch, rows);
      ctx.check(clean.ok, `clean as stored: ${verdictLine(batch, clean)} ${JSON.stringify(clean.findings)}`);
      // a person rescues the owners' section down to Operations: a rescue and a misplacement
      const al04 = batch.conversations.find((c) => c.note === "ux-al04");
      const ownersSection = sectionName(al04.expected.document.title, 1, al04.expected.document.sections[1].heading);
      const opsSection = sectionName(al04.expected.document.title, 0, al04.expected.document.sections[0].heading);
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Entity SET _home = 'ops', _placed_by = 'admin' WHERE name = '${q(ownersSection)}' AND _kind = 'section'` });
      // the lower section names the owners' section's heading: a hidden title
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Entity SET text_identity = text_identity.append(' (see ${q(al04.expected.document.sections[1].heading)})') WHERE name = '${q(opsSection)}' AND _kind = 'section'` });
      // the residue's section is gone: lost text
      const aa11 = batch.conversations.find((c) => c.note === "ux-aa11");
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `DELETE FROM Entity WHERE _kind = 'section' AND _doc_title = '${q(aa11.expected.document.title)}'` });
      const broken = bar(batch, await collectRows(batch, ctx.sql));
      ctx.check(!broken.ok, "not clean any more");
      const f = broken.findings;
      ctx.check(f.rescues.length === 1 && /placed the section/.test(f.rescues[0]), `one rescue: ${JSON.stringify(f.rescues)}`);
      ctx.check(f.misplaced.length === 1 && /§2: seen from ops, expected org/.test(f.misplaced[0]), `one misplaced section (the claim edge keeps its home): ${JSON.stringify(f.misplaced)}`);
      ctx.check(f.lost.length === 1 && /conv-ux-aa11 §1: no section stored/.test(f.lost[0]), `one lost section: ${JSON.stringify(f.lost)}`);
      // the owners' section now sits at ops, so its heading is no longer above the ops section; the hidden title shows once it is back up
      ctx.check(f.hidden.length === 0, `no hidden title while both sections are at ops: ${JSON.stringify(f.hidden)}`);
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Entity SET _home = 'org' WHERE name = '${q(ownersSection)}' AND _kind = 'section'` });
      const hidden = bar(batch, await collectRows(batch, ctx.sql));
      ctx.check(hidden.findings.hidden.length === 1 && /names ".*the owners part" \(seen from org\)/.test(hidden.findings.hidden[0]), `one hidden title: ${JSON.stringify(hidden.findings.hidden)}`);
      ctx.check(/^NOT CLEAN oracle-sixty: 3\/3 documents, 5\/5 claims; rescues 1, misplaced 0, lost 1, hidden titles 1$/.test(verdictLine(batch, hidden)), `the verdict line: ${verdictLine(batch, hidden)}`);
    },
  },
  {
    name: "a conversation batch end to end through the fakes: condensed documents in, claims placed, the bar clean",
    // switch: this runs once the Condenser stream's ingest tool is on main (CONDENSE_TOOL_RE names it)
    skip: async (ctx) => ((await condenseTool(ctx)) ? null : "the Condenser's ingest route is not on main yet: the batch's shape and the bar are covered above; this runs once a tool matching /condens|on_record|record_document/ is in tools/list"),
    run: async (ctx) => {
      const tool = await condenseTool(ctx);
      const full = loadBatch();
      const batch = { ...full, conversations: full.conversations.filter((c) => ["ux-m01", "ux-al04", "ux-aa11", "ux-aq01", "ux-ak06"].includes(c.note)) };
      for (const c of batch.conversations) {
        const r = await ctx.tool(c.person, tool, { ...c.expected.document, conversation: c.turns });
        ctx.check(!r.error, `${c.id} posted by ${c.person} through ${tool}: ${JSON.stringify(r).slice(0, 200)}`);
      }
      await ctx.until("the batch's sections are stored", async () => (await collectRows(batch, ctx.sql)).sections.length >= batch.conversations.reduce((a, c) => a + c.expected.sections.length, 0));
      const result = bar(batch, await collectRows(batch, ctx.sql));
      ctx.check(result.ok, `${verdictLine(batch, result)} ${JSON.stringify(result.findings).slice(0, 400)}`);
      const calls = await (await fetch(`${ctx.MODELS}/__calls`)).json();
      ctx.check((calls["grader:claimed"] ?? 0) === 0, `the grader was never asked about a section with claims: ${calls["grader:claimed"]}`);
    },
  },
];
