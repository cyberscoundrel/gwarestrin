// The Test harness stream's own scenarios (SCENARIOS.md is the contract this
// file follows, like every stream's): the conversation batch generated from
// the oracle, all sixty-two of its notes end to end through the record tool
// and held to the landing bar (docs/ORGANIZATION-MODEL.md: "any stream that
// cannot handle all sixty oracle notes has not met the contract"), the bar's
// own teeth against rows in a real ArcadeDB, and the record path under a live
// derived floor.
//
// What the batch does not stand in for: a real condenser. The chat agent is a
// model and none runs here, so each person's agent posts the document the
// oracle says it should have condensed. Everything after that call is the real
// path. The policy is test/fixtures/policy-oracle.json, written by hand;
// nothing here computes a rule from the expected placements.
import { readFileSync } from "node:fs";
import { claimsSettle } from "../src/placement.js";
import { normalizeDocument } from "../src/model/claims.js";
import { statements } from "../src/model/schema.js";
import { sectionName } from "../src/documents.js";
const RECORD_TOOL = "record_document"; // record-tools.js is not imported: it needs zod, and the runner has no node_modules
import { bar, checkBatch, collectRows, expectedClaims, failingNotes, prefixed, subjectLabel, verdictLine } from "./conversations.mjs";

const BATCH = new URL("../test/fixtures/conversations/oracle-sixty.batch.json", import.meta.url);
const loadBatch = () => JSON.parse(readFileSync(BATCH, "utf8"));
const q = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** a person's confirmation of the classes a batch's claims name, stood in for by raw SQL (the confirm route takes snake_case names and at least one stage; the oracle's classes have neither) */
async function confirmClasses(ctx, names) {
  for (const name of names) {
    const r = await ctx.tool("admin", "execute_graph", {
      language: "sql",
      command: `UPDATE CommitmentClass SET name = '${q(name)}', description = '${q(`${name}: confirmed for the conversation batch`)}', stages = [], record_table = null, status = 'confirmed', proposed_by = 'e2e-harness', confirmed_by = 'admin', confirmed_at = '2026-11-01T09:00:00.000Z' UPSERT WHERE name = '${q(name)}'`,
    });
    ctx.check(!r.error, `class ${name} confirmed: ${JSON.stringify(r).slice(0, 200)}`);
  }
}

/** a person's chat agent with its thread switched on record, as the person's instance does (manager.ts): a fresh agent has read nothing */
async function onRecordAgent(ctx, person, position) {
  const agent = ctx.randomUUID();
  const r = await fetch(`${ctx.GRAPH}/api/thread-record`, { method: "PUT", headers: { authorization: `Bearer ${ctx.TOKENS[person]}`, "content-type": "application/json" }, body: JSON.stringify({ agent, on: true }) });
  ctx.check(r.ok, `${person}'s agent on record: ${r.status}`);
  return ctx.delegated({ u: person, a: agent, p: [position] });
}

/** a record the rule proposed is approved by the person holding the authority: the designed flow, not a rescue */
async function approveIfProposed(ctx, r) {
  const pending = r.pendingId ?? (r.queued ? r.id : null);
  if (!pending) return { proposed: false };
  const ok = await ctx.api(`/api/queue/${pending}/approve`, { method: "POST", body: "{}" });
  return { proposed: true, approved: Boolean(ok.result?.approved || ok.approved), reply: ok };
}

/**
 * One conversation stored as the contract says, by hand, through the admin's
 * raw SQL: rows for the bar's own scenario, which is about the bar and not
 * about the ingest path.
 */
async function storeAsContract(ctx, c, prefix, wanted) {
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
      const want = wanted.get(cl.id);
      const key = want.subject.key;
      const label = want.subject.name ?? subjectLabel(cl.subject);
      const thingName = `${prefix} ${label}`;
      const have = await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND name = '${q(thingName)}'`);
      if (!have.length) await exec(`CREATE VERTEX Entity SET name = '${q(thingName)}', _kind = 'thing', _home = '${x.document_home}', _origin = '${x.document_home}', _thing_type = 'other', label = '${q(label)}'${key ? `, _keys = ['${q(key)}']` : ""}`);
      await exec(
        `CREATE EDGE CLAIMS FROM (SELECT FROM Entity WHERE _kind = 'section' AND _doc_id = '${docId}' AND _section = ${i}) TO (SELECT FROM Entity WHERE _kind = 'thing' AND name = '${q(thingName)}') SET id = '${q(cl.id)}', kind = '${q(want.kind)}', class = '${q(want.class)}', attribute = '${q(want.attribute)}', value = '${q(want.value)}', valid_from = '${want.valid_from}'${want.valid_until ? `, valid_until = '${want.valid_until}'` : ""}, recorded_at = '${want.recorded_at}', recorded_by = '${q(want.recorded_by)}', _home = '${pl.home}'`,
      );
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
    name: "the landing bar: all sixty-two oracle notes through record_document as each person's own agent, under the hand-written policy with the derived window live; every landed claim says what the oracle says",
    run: async (ctx) => {
      const batch = loadBatch();
      ctx.check(batch.conversations.length === 62, `all sixty-two, no subset: ${batch.conversations.length}`);
      await confirmClasses(ctx, [...new Set(batch.conversations.flatMap((c) => c.expected.document.sections.flatMap((s) => (s.claims ?? []).map((cl) => cl.class))))]);
      // the organization's policy as a person wrote it (a file, not computed from the placements below); the derived window is left as shipped
      const before = (await ctx.api("/api/policy")).policy ?? {};
      const authorityMap = ctx.fixtures.read("policy-oracle.json");
      const set = await ctx.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap }) });
      ctx.check(set.policy?.authorityMap, `the authority map is a policy setting: ${JSON.stringify(set).slice(0, 300)}`);
      ctx.check(set.policy.derivedWindowHours > 0, `the derived-data window is live: ${set.policy.derivedWindowHours}`);
      const failures = [];
      try {
        // each conversation is its own person's chat agent: a fresh agent has read nothing, so what earlier scenarios
        // had people read lifts nothing here, with the window on. An agent records as the person it acts for
        const refused = new Set();
        const proposed = [];
        const startedAt = Date.now();
        for (const c of batch.conversations) {
          const agent = await onRecordAgent(ctx, c.person, c.position);
          const r = await ctx.tool(agent, RECORD_TOOL, { document: c.expected.document });
          if (r.error) {
            refused.add(c.id);
            failures.push(`${c.note}: refused by ${RECORD_TOOL}: ${String(r.error).slice(0, 200)}`);
            continue;
          }
          const a = await approveIfProposed(ctx, r);
          if (a.proposed) proposed.push(c.id);
          if (a.proposed && !a.approved) failures.push(`${c.note}: the admin could not approve the proposed record: ${JSON.stringify(a.reply).slice(0, 200)}`);
        }
        // the authority rule proposes exactly the records with a claim above the recorder's position
        const expectedProposed = batch.conversations.filter((c) => c.expected.placements.some((p) => p.home !== c.position) && !refused.has(c.id)).map((c) => c.id);
        for (const id of proposed) if (!expectedProposed.includes(id)) failures.push(`${id}: proposed, but none of its claims lies above the recorder`);
        for (const id of expectedProposed) if (!proposed.includes(id)) failures.push(`${id}: a claim lies above the recorder, and it was not proposed`);

        // ingests run one at a time: wait for every accepted document to finish (ready or failed), then judge what is there
        const accepted = batch.conversations.filter((c) => !refused.has(c.id));
        const finished = async () => (await ctx.sql(`SELECT count(*) AS n FROM Entity WHERE _kind = 'document' AND _doc_status IN ['ready', 'failed'] AND name IN [${accepted.map((c) => `'${q(c.expected.document.title)}'`).join(", ")}]`))[0]?.n >= accepted.length;
        await ctx.until("every accepted record has finished ingesting", finished, 420_000).catch((e) => failures.push(String(e.message ?? e)));
        const rows = await collectRows(batch, ctx.sql);
        const result = bar(batch, rows, batch.tree, { recordedSince: startedAt });

        // the grader judges what no rule settles: always a section with no claims, never one whose claims settle it
        // (placement.js claimsSettle, over the text the grader would have been shown, as stored)
        const graded = new Set((await (await fetch(`${ctx.MODELS}/__graded`)).json()).graded);
        const wanted = expectedClaims(batch, (title) => rows.documents.find((d) => d.name === title)?._recorded_at ?? null);
        for (const c of accepted)
          for (const [i, s] of c.expected.document.sections.entries()) {
            const name = sectionName(c.expected.document.title, i, s.heading);
            const claims = (s.claims ?? []).map((cl) => wanted.get(cl.id));
            const stored = rows.sections.find((x) => x.name === name);
            if (!claims.length && !graded.has(name)) failures.push(`${c.note}: "${name}" has no claims and the grader never saw it`);
            if (claims.length && stored && claimsSettle({ claims, facets: { identity: stored.text } }, authorityMap) && graded.has(name)) failures.push(`${c.note}: "${name}" is settled by its claims and the grader was asked about it`);
          }

        // decision 3 is a read: ad15 changes what ac13 said a rack holds, so a reader sees ac13's claim closed where ad15's starts (its recording, the server's stamp)
        const history = await ctx.tool("admin", "state_history", { subject: "rack C1", attribute: "holds" });
        const steps = history.things?.[0]?.history ?? [];
        const ad15 = batch.conversations.find((c) => c.note === "ux-ad15");
        const titanium = steps.find((h) => h.value === "titanium");
        const ad15At = rows.documents.find((d) => d.name === ad15.expected.document.title)?._recorded_at;
        if (!titanium || Date.parse(titanium.valid_until) !== Date.parse(ad15At)) failures.push(`ux-ad15: the rack's earlier claim is not closed where this one starts: ${JSON.stringify(history).slice(0, 300)}`);

        // the report: every failing note and why, so a red run names them all
        for (const [note, list] of failingNotes(batch, result)) console.log(`  BAR ${note}\n${list.map((f) => `      ${f}`).join("\n")}`);
        for (const f of failures) console.log(`  BAR ${f}`);
        const bad = new Set([...failingNotes(batch, result).keys(), ...failures.map((f) => f.split(":")[0])]);
        console.log(`  ${verdictLine(batch, result)}; ${bad.size} of 62 notes failing${failures.length ? `, ${failures.length} route failure${failures.length === 1 ? "" : "s"}` : ""}`);
        ctx.check(result.ok && failures.length === 0, `${verdictLine(batch, result)}; route failures ${failures.length}; ${bad.size} of 62 notes failing: ${[...bad].join(", ")}`);
      } finally {
        await ctx.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: before.authorityMap ?? { classes: {}, attributes: {} } }) });
      }
    },
  },
  {
    name: "the bar's teeth, on rows read back from a real graph: a batch stored as the contract says is clean; a rescue, a misplacement, lost text, a hidden title and a wrong claim field each fail it",
    run: async (ctx) => {
      const full = loadBatch();
      const pick = ["ux-m01", "ux-al04", "ux-aa11"]; // one authority, two authorities, the residue
      const prefix = `e2e-bar-${ctx.randomUUID().slice(0, 8)}`;
      // under a prefix of its own: the landing bar above records these same conversations through the real path
      const batch = prefixed({ ...full, conversations: full.conversations.filter((c) => pick.includes(c.note)) }, prefix);
      ctx.check(batch.conversations.length === 3, "the three picked conversations are in the batch");
      // the model's DDL is idempotent; the harness runs it since nothing on main does yet
      for (const ddl of statements()) {
        const r = await ctx.tool("admin", "execute_graph", { language: "sql", command: ddl });
        ctx.check(!r.error || /already exists/i.test(r.error), `${ddl}: ${r.error ?? "ok"}`);
      }
      const wanted = expectedClaims(batch);
      for (const c of batch.conversations) await storeAsContract(ctx, c, prefix, wanted);
      const rows = await collectRows(batch, ctx.sql);
      ctx.check(rows.documents.length === 3 && rows.sections.length === 4 && rows.claims.length === 5, `read back 3 documents, 4 sections, 5 claims: ${rows.documents.length}/${rows.sections.length}/${rows.claims.length}`);
      ctx.check(rows.things.length === 3, `the claims' subjects read back: ${JSON.stringify(rows.things)}`);
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
      ctx.check(/^NOT CLEAN oracle-sixty: 3\/3 documents, 5\/5 claims; rescues 1, misplaced 0, lost 1, hidden titles 1, wrong content 0$/.test(verdictLine(batch, hidden)), `the verdict line: ${verdictLine(batch, hidden)}`);
      // one row corrupted on every field the bar reads, in the graph, read back through the same query: each is named
      const m01 = batch.conversations.find((c) => c.note === "ux-m01");
      const target = m01.expected.placements[0].id;
      const corrupt = await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE CLAIMS SET kind = 'event', class = 'not the class', attribute = 'not_the_attribute', value = 'not the value', valid_from = '2001-01-01T00:00:00.000Z', valid_until = '2001-01-02T00:00:00.000Z', recorded_at = '2001-01-01T00:00:00.000Z', recorded_by = 'mallory' WHERE id = '${q(target)}'` });
      ctx.check(!corrupt.error, `corrupted: ${JSON.stringify(corrupt).slice(0, 200)}`);
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Entity SET _keys = ['mssql:dbo_Work_Center:NOT-THIS-ONE'] WHERE name = '${q(`${prefix} INSPECT-2`)}' AND _kind = 'thing'` });
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Entity SET _home = 'org', _recorded_by = 'mallory' WHERE _kind = 'document' AND name = '${q(m01.expected.document.title)}'` });
      const wrong = bar(batch, await collectRows(batch, ctx.sql));
      ctx.check(!wrong.ok, "not clean with a wrong row");
      const about = (field) => wrong.findings.content.some((x) => x.includes(target) && x.includes(`: ${field}`));
      for (const field of ["kind", "class", "attribute", "value", "valid_from", "valid_until", "recorded_at", "recorded_by", "subject"]) ctx.check(about(field), `the wrong ${field} is named: ${JSON.stringify(wrong.findings.content)}`);
      ctx.check(wrong.findings.misplaced.some((x) => /the document seen from org, expected ops/.test(x)), `the document's home is compared: ${JSON.stringify(wrong.findings.misplaced)}`);
      ctx.check(wrong.findings.content.some((x) => /the document recorded by "mallory"/.test(x)), `the document's recorder is compared: ${JSON.stringify(wrong.findings.content)}`);
    },
  },
  {
    name: "the record path under the live derived floor: what an agent read above its position holds its record there, and an agent that read nothing lands at its own",
    run: async (ctx) => {
      const { POS, check, tool, sql, until, api } = ctx;
      const policy = (await api("/api/policy")).policy;
      check(policy.derivedWindowHours > 0, `the window is on: ${policy.derivedWindowHours}`);
      await confirmClasses(ctx, ["work center"]);
      const prefix = `e2e-floor-${ctx.randomUUID().slice(0, 8)}`;
      // another person's note at the top: a read of it is a read from above (a writer's own note, decision 1, is not what this checks)
      const secret = `${prefix} quenchwort budget`;
      await ctx.save("admin", secret, "The quenchwort fixture budget is 9,000. [admins]");
      check((await ctx.entry(secret))?._home === POS.org, "the note is at the top");
      const document = (title) => ({ title, recorded_by: "alice", position: POS.ops, reason: "e2e", sections: [{ heading: `${title} section`, text: `${title}: the quenchwort cell is running.`, claims: [{ kind: "state", subject: `${title} cell`, class: "work center", attribute: "e2e_running", value: "yes" }] }] });
      const reader = await onRecordAgent(ctx, "alice", POS.ops);
      // the top's note, shared with alice by the admin: a read the rule lets her agent have, of something above her position
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
        const section = (await sql(`SELECT @rid AS rid, _home FROM Entity WHERE _kind = 'section' AND _doc_title = '${q(title)}'`))[0];
        const claim = section ? (await sql(`SELECT _home FROM (SELECT expand(outE('CLAIMS')) FROM ${section.rid})`))[0] : null;
        return { doc: doc?._home, section: section?._home, claim: claim?._home, status: doc?._doc_status };
      };
      for (const title of [held, plain]) await until(`${title} ingested`, async () => (await landed(title)).status === "ready" && (await landed(title)).claim);
      const h = await landed(held);
      check(h.doc === POS.org && h.section === POS.org && h.claim === POS.org, `held at what it read: ${JSON.stringify(h)}`);
      const p = await landed(plain);
      check(p.doc === POS.ops && p.section === POS.ops && p.claim === POS.ops, `an agent that read nothing lands at its own: ${JSON.stringify(p)}`);
    },
  },
];
