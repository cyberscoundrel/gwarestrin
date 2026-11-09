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
import { normalizeDocument, normalizeName } from "../src/model/claims.js";
import { statements } from "../src/model/schema.js";
import { sectionName } from "../src/documents.js";
const RECORD_TOOL = "record_document"; // record-tools.js is not imported: it needs zod, and the runner has no node_modules
import { bar, checkBatch, collectRows, expectedClaims, failingNotes, graphSnapshot, prefixed, rebaseBatch, subjectLabel, underDefaultMap, verdictLine } from "./conversations.mjs";

const BATCH = new URL("../test/fixtures/conversations/oracle-sixty.batch.json", import.meta.url);
const loadBatch = () => JSON.parse(readFileSync(BATCH, "utf8"));
const q = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/**
 * A person's confirmation of the classes a batch's claims name, stood in for by raw SQL. The confirm route cannot take
 * them: it renames every class to plural snake_case (`need` to `needs`), which 49 of the oracle's 50 names don't
 * survive, and the fiftieth, `equipment`, is a name Discovery forbids. That is the open question about the oracle's
 * class names, not something a harness can settle.
 */
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
    const shown = es.home === x.document_home ? d.title : `Document ${docId.slice(0, 8)}`; // a section below its document's title shows none of it
    await exec(`CREATE VERTEX Entity SET name = '${q(sectionName(shown, i, shown === d.title ? s.heading : s.heading.replace(`${d.title}: `, "")))}', _kind = 'section', _home = '${es.home}', _origin = '${x.document_home}', _written_by = '${q(d.recorded_by)}', _doc_id = '${docId}', _doc_title = '${q(shown)}', _section = ${i}, text_identity = '${q(s.text)}'`);
    await exec(`CREATE EDGE PART_OF FROM (SELECT FROM Entity WHERE _kind = 'section' AND _doc_id = '${docId}' AND _section = ${i}) TO (SELECT FROM Entity WHERE _kind = 'document' AND _doc_id = '${docId}')`);
    for (const cl of s.claims) {
      const pl = x.placements.find((p) => p.id === cl.id);
      const want = wanted.get(cl.id);
      const key = want.subject.key;
      const label = want.subject.name ?? subjectLabel(cl.subject);
      const thingName = `${prefix} ${label}`;
      const have = await ctx.sql(`SELECT @rid AS rid FROM Entity WHERE _kind = 'thing' AND name = '${q(thingName)}'`);
      const homes = [...new Set(x.placements.map((p) => p.home))];
      if (!have.length) await exec(`CREATE VERTEX Entity SET name = '${q(thingName)}', _kind = 'thing', _home = '${x.document_home}', _origin = '${x.document_home}', _thing_type = 'other', label = '${q(label)}', _norm = '${q(normalizeName(label))}', _class = '${q(want.class)}', _homes = ${JSON.stringify(homes)}${key ? `, _keys = ['${q(key)}']` : ""}`);
      await exec(
        `CREATE EDGE CLAIMS FROM (SELECT FROM Entity WHERE _kind = 'section' AND _doc_id = '${docId}' AND _section = ${i}) TO (SELECT FROM Entity WHERE _kind = 'thing' AND name = '${q(thingName)}') SET id = '${q(cl.id)}', kind = '${q(want.kind)}', class = '${q(want.class)}', attribute = '${q(want.attribute)}', value = '${q(want.value)}', valid_from = '${want.valid_from}'${want.valid_until ? `, valid_until = '${want.valid_until}'` : ""}, recorded_at = '${want.recorded_at}', recorded_by = '${q(want.recorded_by)}', _home = '${pl.home}'`,
      );
    }
  }
}

/**
 * All of a batch through the record tool, then the bar and the grader's share of it, with a report naming every
 * failing note. Each conversation is its own person's chat agent: a fresh agent has read nothing, so what earlier
 * scenarios had people read lifts nothing here, with the window on. An agent records as the person it acts for.
 * `expectProposed` says which records the rule should propose. `gradedAll`: every section must have been graded.
 */
async function landBatch(ctx, batch, { authorityMap, expectProposed, gradedAll = false }) {
  const failures = [];
  const refused = new Set();
  const proposed = [];
  const before = await graphSnapshot(ctx.sql);
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
  const wantProposed = batch.conversations.filter((c) => expectProposed(c) && !refused.has(c.id)).map((c) => c.id);
  for (const id of proposed) if (!wantProposed.includes(id)) failures.push(`${id}: proposed, and the rule should not have`);
  for (const id of wantProposed) if (!proposed.includes(id)) failures.push(`${id}: not proposed, and the rule should have`);

  // ingests run one at a time: wait for every accepted document to finish (ready or failed), then judge what is there
  const accepted = batch.conversations.filter((c) => !refused.has(c.id));
  const finished = async () => (await ctx.sql(`SELECT count(*) AS n FROM Entity WHERE _kind = 'document' AND _doc_status IN ['ready', 'failed'] AND name IN [${accepted.map((c) => `'${q(c.expected.document.title)}'`).join(", ")}]`))[0]?.n >= accepted.length;
  await ctx.until("every accepted record has finished ingesting", finished, 420_000).catch((e) => failures.push(String(e.message ?? e)));
  const rows = await collectRows(batch, ctx.sql);
  const result = bar(batch, rows, batch.tree, { recordedSince: startedAt, before });

  // the grader judges what no rule settles: always a section with no claims, never one whose claims settle it
  // (placement.js claimsSettle, over the text the grader would have been shown, as stored)
  const graded = new Set((await (await fetch(`${ctx.MODELS}/__graded`)).json()).graded);
  const wanted = expectedClaims(batch, (title) => rows.documents.find((d) => d.name === title)?._recorded_at ?? null);
  for (const c of accepted)
    for (const [i, s] of c.expected.document.sections.entries()) {
      const name = sectionName(c.expected.document.title, i, s.heading).trim(); // the grader's prompt trims a truncated name
      // the grader sees a section under the name it has while it is placed: no title yet (src/document-home.js)
      const docId = rows.documents.find((d) => d.name === c.expected.document.title)?._doc_id;
      const asked = graded.has(name) || graded.has(sectionName(`Document ${String(docId).slice(0, 8)}`, i, s.heading).trim());
      const claims = (s.claims ?? []).map((cl) => wanted.get(cl.id));
      const stored = rows.sections.find((x) => x._doc_id === docId && Number(x._section) === i);
      if ((gradedAll || !claims.length) && !asked) failures.push(`${c.note}: "${name}" should have gone to the grader and never did`);
      if (claims.length && stored && claimsSettle({ claims, facets: { identity: stored.text } }, authorityMap) && asked) failures.push(`${c.note}: "${name}" is settled by its claims and the grader was asked about it`);
    }

  // a claim with no thing yet (admission: the first mention of a keyless name) waits on a worker; printed so a run says how many
  const waiting = rows.claims.filter((c) => wanted.has(c.id) && String(c.in_rid) === String(c.out_rid));
  console.log(`  first recorded ${rows.documents.map((d) => d._recorded_at).sort()[0]}; ${waiting.length} of ${wanted.size} claims have no thing yet: ${waiting.map((c) => c.id).join(", ")}`);

  // the report: every failing note and why, so a red run names them all
  const notes = failingNotes(batch, result);
  for (const [note, list] of notes) console.log(`  BAR ${note}\n${list.map((f) => `      ${f}`).join("\n")}`);
  const atLarge = result.findings.content.filter((f) => f.startsWith("a claim from outside") || f.startsWith("thing #"));
  for (const f of [...failures, ...atLarge]) console.log(`  BAR ${f}`);
  const bad = new Set([...notes.keys(), ...failures.map((f) => f.split(":")[0])]);
  console.log(`  ${verdictLine(batch, result)}; ${bad.size} of ${batch.conversations.length} notes failing${failures.length ? `, ${failures.length} route failure${failures.length === 1 ? "" : "s"}` : ""}`);
  ctx.check(result.ok && failures.length === 0, `${verdictLine(batch, result)}; route failures ${failures.length}; ${bad.size} notes failing: ${[...bad].join(", ")}`);
}

const classesOf = (batch) => [...new Set(batch.conversations.flatMap((c) => c.expected.document.sections.flatMap((s) => (s.claims ?? []).map((cl) => cl.class))))];

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
      const batch = rebaseBatch(loadBatch(), Date.now());
      ctx.check(batch.conversations.length === 62, `all sixty-two, no subset: ${batch.conversations.length}`);
      await confirmClasses(ctx, classesOf(batch));
      // the organization's policy as a person wrote it (a file, not computed from the placements below); the derived window is left as shipped
      const before = (await ctx.api("/api/policy")).policy ?? {};
      const authorityMap = ctx.fixtures.read("policy-oracle.json");
      const set = await ctx.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap }) });
      ctx.check(set.policy?.authorityMap, `the authority map is a policy setting: ${JSON.stringify(set).slice(0, 300)}`);
      ctx.check(set.policy.derivedWindowHours > 0, `the derived-data window is live: ${set.policy.derivedWindowHours}`);
      try {
        await landBatch(ctx, batch, { authorityMap, expectProposed: (c) => c.expected.placements.some((p) => p.home !== c.position) });
      } finally {
        await ctx.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: before.authorityMap ?? { classes: {}, attributes: {} } }) });
      }
    },
  },
  {
    name: "the landing bar under the shipped default map: with no rule, every note is the grader's to judge and stays at its writer's position, its claims still saying what the oracle says",
    run: async (ctx) => {
      const prefix = `e2e-dflt-${ctx.randomUUID().slice(0, 8)}`;
      const batch = underDefaultMap(prefixed(rebaseBatch(loadBatch(), Date.now()), prefix));
      await confirmClasses(ctx, classesOf(batch));
      const was = await ctx.api("/api/policy");
      const shipped = was.defaults?.authorityMap ?? { classes: {}, attributes: {} };
      const set = await ctx.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: shipped }) });
      ctx.check(!set.error && JSON.stringify(set.policy?.authorityMap?.classes ?? {}) === "{}", `the shipped map is empty: ${JSON.stringify(set).slice(0, 300)}`);
      try {
        await landBatch(ctx, batch, { authorityMap: shipped, expectProposed: () => false, gradedAll: true });
      } finally {
        await ctx.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: was.policy?.authorityMap ?? shipped }) });
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
      const snapshot = await graphSnapshot(ctx.sql);
      for (const c of batch.conversations) await storeAsContract(ctx, c, prefix, wanted);
      const rows = await collectRows(batch, ctx.sql);
      ctx.check(rows.documents.length === 3 && rows.sections.length === 4 && rows.claims.length === 5, `read back 3 documents, 4 sections, 5 claims: ${rows.documents.length}/${rows.sections.length}/${rows.claims.length}`);
      ctx.check(rows.claims.every((c) => rows.things.some((t) => String(t.rid) === String(c.in_rid))), `every claim's subject reads back: ${JSON.stringify(rows.things).slice(0, 300)}`);
      const clean = bar(batch, rows);
      ctx.check(clean.ok, `clean as stored: ${verdictLine(batch, clean)} ${JSON.stringify(clean.findings)}`);
      // a person rescues the owners' section down to Operations: a rescue and a misplacement
      const al04 = batch.conversations.find((c) => c.note === "ux-al04");
      const ownersSection = sectionName(al04.expected.document.title, 1, al04.expected.document.sections[1].heading);
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Entity SET _home = 'ops', _placed_by = 'admin' WHERE name = '${q(ownersSection)}' AND _kind = 'section'` });
      // the lower section names the owners' section's heading: a hidden title
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Entity SET text_identity = text_identity.append(' (see ${q(al04.expected.document.sections[1].heading)})') WHERE _kind = 'section' AND _section = 0 AND _doc_id LIKE '%${al04.id}'` });
      // the residue's section is gone: lost text
      const aa11 = batch.conversations.find((c) => c.note === "ux-aa11");
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `DELETE FROM Entity WHERE _kind = 'section' AND _doc_title = '${q(aa11.expected.document.title)}'` });
      const broken = bar(batch, await collectRows(batch, ctx.sql));
      ctx.check(!broken.ok, "not clean any more");
      const f = broken.findings;
      ctx.check(f.rescues.length === 1 && /placed the section/.test(f.rescues[0]), `one rescue: ${JSON.stringify(f.rescues)}`);
      ctx.check(f.misplaced.length === 1 && /§2: seen from ops, expected org/.test(f.misplaced[0]), `one misplaced section (the claim edge keeps its home): ${JSON.stringify(f.misplaced)}`);
      ctx.check(f.lost.length === 2 && f.lost.some((x) => /conv-ux-aa11 §1: no section stored/.test(x)) && f.lost.some((x) => /conv-ux-al04 §1: stored text differs/.test(x)), `a lost section and the tail appended to another: ${JSON.stringify(f.lost)}`);
      // the owners' section now sits at ops, so its heading is no longer above the ops section; the hidden title shows once it is back up
      // but that heading repeats the document's title, and the title stays above the ops section with its entry
      ctx.check(f.hidden.length === 1 && /names "[^"]*" \(seen from org\)/.test(f.hidden[0]) && !/the owners part/.test(f.hidden[0]), `only the document's title is hidden while both sections are at ops: ${JSON.stringify(f.hidden)}`);
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Entity SET _home = 'org' WHERE name = '${q(ownersSection)}' AND _kind = 'section'` });
      const hidden = bar(batch, await collectRows(batch, ctx.sql));
      ctx.check(hidden.findings.hidden.length === 2 && hidden.findings.hidden.some((x) => /names ".*the owners part" \(seen from org\)/.test(x)), `one hidden title: ${JSON.stringify(hidden.findings.hidden)}`);
      ctx.check(/^NOT CLEAN oracle-sixty: 3\/3 documents, 5\/5 claims; rescues 1, misplaced 0, lost 2, hidden titles 2, wrong content 0$/.test(verdictLine(batch, hidden)), `the verdict line: ${verdictLine(batch, hidden)}`);
      // one row corrupted on every field the bar reads, in the graph, read back through the same query: each is named
      const m01 = batch.conversations.find((c) => c.note === "ux-m01");
      const target = m01.expected.placements[0].id;
      const corrupt = await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE CLAIMS SET kind = 'event', class = 'not the class', attribute = 'not_the_attribute', value = 'not the value', valid_from = '2001-01-01T00:00:00.000Z', valid_until = '2001-01-02T00:00:00.000Z', recorded_at = '2001-01-01T00:00:00.000Z', recorded_by = 'mallory' WHERE id = '${q(target)}'` });
      ctx.check(!corrupt.error, `corrupted: ${JSON.stringify(corrupt).slice(0, 200)}`);
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Entity SET _keys = ['mssql:dbo_Work_Center:NOT-THIS-ONE'] WHERE _kind = 'thing' AND _keys CONTAINS '${q(wanted.get(target).subject.key)}'` });
      await ctx.tool("admin", "execute_graph", { language: "sql", command: `UPDATE Entity SET _home = 'org', _recorded_by = 'mallory' WHERE _kind = 'document' AND name = '${q(m01.expected.document.title)}'` });
      const wrong = bar(batch, await collectRows(batch, ctx.sql));
      ctx.check(!wrong.ok, "not clean with a wrong row");
      const about = (field) => wrong.findings.content.some((x) => x.includes(target) && x.includes(`: ${field}`));
      for (const field of ["kind", "class", "attribute", "value", "valid_from", "valid_until", "recorded_at", "recorded_by", "subject"]) ctx.check(about(field), `the wrong ${field} is named: ${JSON.stringify(wrong.findings.content)}`);
      ctx.check(wrong.findings.misplaced.some((x) => /the document seen from org, expected ops/.test(x)), `the document's home is compared: ${JSON.stringify(wrong.findings.misplaced)}`);
      ctx.check(wrong.findings.content.some((x) => /the document recorded by "mallory"/.test(x)), `the document's recorder is compared: ${JSON.stringify(wrong.findings.content)}`);
      // the rest, each by a defect a real path could make; al04's first claim, its second, its document, its section
      const firstId = al04.expected.placements[0].id;
      const second = al04.expected.placements[1].id;
      const subject = wanted.get(firstId).subject;
      const title = al04.expected.document.title;
      const thingOf = async (id) => String((await ctx.sql(`SELECT @in AS t FROM CLAIMS WHERE id = '${q(id)}'`))[0].t);
      const t1 = await thingOf(firstId);
      const secondFor = subject.key ? `_keys = ['${q(subject.key)}']` : `_norm = '${q(normalizeName(subject.name))}', _class = '${q(wanted.get(firstId).class)}'`;
      const damage = [
        `UPDATE CLAIMS SET subject = '{"name":"someone else"}' WHERE id = '${q(firstId)}'`,
        `UPDATE CLAIMS SET _home = null, closed_by = 'some-other-claim' WHERE id = '${q(second)}'`,
        `UPDATE Entity SET _doc_status = 'failed', _origin = 'org' WHERE _kind = 'document' AND name = '${q(title)}'`,
        `UPDATE Entity SET _doc_id = 'not-its-document', _origin = 'org' WHERE _kind = 'section' AND _doc_title = '${q(title)}' AND _section = 1`,
        `CREATE VERTEX Entity SET name = '${q(prefix)} extra', _kind = 'section', _home = 'ops', _origin = 'ops', _doc_title = '${q(title)}', _doc_id = 'x', _section = 7, text_identity = 'an extra section'`,
        `CREATE VERTEX Entity SET name = '${q(prefix)} twin (other)', label = 'twin', _kind = 'thing', _home = 'org', _homes = ['ops'], ${secondFor}`,
        `UPDATE ${t1} SET _homes = ['floor']`,
        `CREATE VERTEX Entity SET name = '${q(prefix)} stranger', _kind = 'section', _doc_title = 'not in the batch', _section = 0, _home = 'ops'`,
        `CREATE EDGE CLAIMS FROM (SELECT FROM Entity WHERE name = '${q(prefix)} stranger') TO ${t1} SET id = '${q(prefix)}:stray', kind = 'state', class = 'x', attribute = 'x', value = 'x', valid_from = '2026-01-01T00:00:00.000Z', recorded_at = '2026-01-01T00:00:00.000Z', recorded_by = 'x', _home = 'ops'`,
      ];
      for (const command of damage) {
        const r = await ctx.tool("admin", "execute_graph", { language: "sql", command });
        ctx.check(!r.error, `${command.slice(0, 80)}: ${r.error}`);
      }
      const end = bar(batch, await collectRows(batch, ctx.sql), batch.tree, { before: snapshot });
      const all = Object.values(end.findings).flat();
      for (const [what, re] of [
        ["a subject written beside the claim's thing", new RegExp(`${firstId}: subject: .*written beside`)],
        ["a claim with no home", new RegExp(`${second}: seen from null`)],
        ["closed_by", new RegExp(`${second}: closed_by`)],
        ["the document's status", /document's status is "failed"/],
        ["the document's origin", /document's origin is "org"/],
        ["a section's origin", /§2: origin "org"/],
        ["a section's _doc_id", /§2: _doc_id "not-its-document"/],
        ["an extra section", /an unexpected section/],
        ["a second thing for the subject", new RegExp(`${firstId}: subject: a second`)],
        ["the thing not seen from the claim's home", new RegExp(`${firstId}: subject: its thing is not seen from`)],
        ["a claim from outside the batch", /a claim from outside the batch/],
      ]) ctx.check(all.some((x) => re.test(x)), `${what} goes unnoticed: ${JSON.stringify(all).slice(0, 900)}`);
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
