// Re-homing (tightening.js, R6): when a class map entry tightens, sections related to instances of that class
// move to the stricter home, the instance is seen from where its sections now are, and the document's title
// takes the strictest home among its sections (R11.13). Loosening moves nothing. The class, the instance and
// the edges are written by hand here (the classes and filing streams make them); the records come the way a
// chat agent sends them. Restores the coverage the claim-shaped scenarios had (review of ba583bc, item 6).
import { randomUUID } from "node:crypto";

const q = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const iso = (ms) => new Date(ms).toISOString();
const graphOf = (ctx) => ctx.GRAPH ?? process.env.GRAPH_URL ?? "http://graph-rag:8000";

async function exec(ctx, command) {
  const r = await ctx.tool("admin", "execute_graph", { language: "sql", command });
  ctx.check(!r.error, `${command.slice(0, 80)}: ${JSON.stringify(r).slice(0, 200)}`);
  return r;
}
const one = async (ctx, where) => (await ctx.sql(`SELECT @rid AS rid, name, _home, _homes, _grade, _ungraded, _doc_id, _doc_title FROM Entity WHERE ${where}`))[0];

/** a class with one instance (seen from the floor), as the classes stream writes them */
async function classWithInstance(ctx, id) {
  const key = `e2e_rh_${id}`;
  await exec(ctx, `CREATE VERTEX Entity SET name = 'e2e-rh class ${id}', _kind = 'class', _class_name = 'e2e rh ${id}', _class_key = '${key}', _home = 'everyone', _status = 'active'`);
  await exec(ctx, `CREATE VERTEX Entity SET name = 'e2e-rh thing ${id}', label = 'e2e-rh thing ${id}', _kind = 'thing', _home = '${ctx.POS.org}', _homes = ['${ctx.POS.floor}']`);
  const cls = await one(ctx, `_kind = 'class' AND _class_key = '${key}'`);
  const inst = await one(ctx, `_kind = 'thing' AND name = 'e2e-rh thing ${id}'`);
  await exec(ctx, `CREATE EDGE INSTANCE_OF FROM ${inst.rid} TO ${cls.rid} SET added_by = 'e2e', at = '${iso(Date.now())}'`);
  return { key, cls, inst };
}

/** a record from a fresh floor agent on record (no reads to lift it); resolves when it is ready */
async function recordAtFloor(ctx, title, sections) {
  const agent = randomUUID();
  const r = await fetch(`${graphOf(ctx)}/api/thread-record`, { method: "PUT", headers: { authorization: `Bearer ${ctx.TOKENS?.admin ?? "e2e-admin"}`, "content-type": "application/json" }, body: JSON.stringify({ agent, thread: `e2e-rh-${agent.slice(0, 8)}`, on: true, position: ctx.POS.floor }) });
  ctx.check(r.ok, `on record: ${r.status}`);
  const token = ctx.delegated({ a: agent, p: [ctx.POS.floor] });
  const sent = await ctx.tool(token, "record_document", { document: { title, reason: "e2e re-homing", sections } });
  ctx.check(sent.doc_id, `recorded: ${JSON.stringify(sent).slice(0, 200)}`);
  await ctx.until(`${title} ready`, async () => (await one(ctx, `_kind = 'document' AND _doc_id = '${sent.doc_id}'`))?.name && (await ctx.sql(`SELECT _doc_status FROM Entity WHERE _kind = 'document' AND _doc_id = '${sent.doc_id}'`))[0]?._doc_status === "ready", 120_000);
  const secs = await ctx.sql(`SELECT @rid AS rid, name, _home, _grade, _ungraded, _doc_title, _section FROM Entity WHERE _kind = 'section' AND _doc_id = '${sent.doc_id}' ORDER BY _section`);
  return { docId: sent.doc_id, token, sections: secs };
}
const about = (ctx, section, inst) => exec(ctx, `CREATE EDGE ABOUT FROM ${section.rid} TO ${inst.rid} SET role = 'mentions'`);
const sectionAt = (ctx, rid) => one(ctx, `@rid = ${rid}`);
const docOf = (ctx, docId) => one(ctx, `_kind = 'document' AND _doc_id = '${docId}'`);
const settled = async (ctx) => Number((await ctx.sql("SELECT count(*) AS n FROM PolicyChange WHERE rehome_status = 'pending'"))[0]?.n ?? 0) === 0;

/** set class-level entries, run fn, and put the map back (putting it back only loosens: nothing moves) */
async function withMap(ctx, fn) {
  const before = (await ctx.api("/api/policy")).policy?.authorityMap ?? { classes: {}, attributes: {} };
  const put = async (classes) => {
    const set = await ctx.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: { ...before, classes: { ...(before.classes ?? {}), ...classes } } }) });
    ctx.check(set.policy, `policy set: ${JSON.stringify(set).slice(0, 200)}`);
    await ctx.until("the change worked through", () => settled(ctx), 90_000);
    return set;
  };
  try {
    await fn(put, before);
  } finally {
    await ctx.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: before }) });
    await ctx.until("the map put back", () => settled(ctx), 90_000);
  }
}

export default [
  {
    name: "a class map entry that tightens re-homes the sections about its instances, and the instance follows; loosening moves nothing",
    run: async (ctx) => {
      const { POS, check, tool, sql, until, api, randomUUID } = ctx;
      const id = randomUUID().slice(0, 8);
      const key = `e2e_rh_${id}`;
      const exec = async (command) => {
        const r = await tool("admin", "execute_graph", { language: "sql", command });
        check(!r.error, `${command.slice(0, 80)}: ${JSON.stringify(r).slice(0, 200)}`);
      };
      const one = async (where) => (await sql(`SELECT @rid AS rid, _home, _homes FROM Entity WHERE ${where}`))[0];
      await exec(`CREATE VERTEX Entity SET name = 'e2e-rh class ${id}', _kind = 'class', _class_name = 'e2e rh ${id}', _class_key = '${key}', _home = '${POS.ops}', _status = 'active'`);
      await exec(`CREATE VERTEX Entity SET name = 'e2e-rh press ${id}', label = 'e2e-rh press ${id}', _kind = 'thing', _home = '${POS.org}', _homes = ['${POS.floor}']`);
      await exec(`CREATE VERTEX Entity SET name = 'e2e-rh section ${id}', _kind = 'section', _home = '${POS.floor}', _origin = '${POS.floor}', text_identity = '${q(`Press ${id} is down for its bearings.`)}'`);
      const cls = await one(`_kind = 'class' AND _class_key = '${key}'`);
      const inst = await one(`_kind = 'thing' AND name = 'e2e-rh press ${id}'`);
      const sec = await one(`_kind = 'section' AND name = 'e2e-rh section ${id}'`);
      check(cls && inst && sec, "class, instance and section written");
      await exec(`CREATE EDGE INSTANCE_OF FROM ${inst.rid} TO ${cls.rid} SET added_by = 'e2e', at = '${new Date().toISOString()}'`);
      await exec(`CREATE EDGE ABOUT FROM ${sec.rid} TO ${inst.rid} SET role = 'mentions'`);

      const before = (await api("/api/policy")).policy?.authorityMap ?? { classes: {}, attributes: {} };
      const put = (authority) => api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: { ...before, classes: { ...(before.classes ?? {}), [key]: { authority } } } }) });
      const done = async () => Number((await sql("SELECT count(*) AS n FROM PolicyChange WHERE rehome_status = 'pending'"))[0]?.n ?? 0) === 0;
      try {
        // an entry at the floor: where the section already is, so it stays
        const first = await put(POS.floor);
        check(first.policy?.authorityMap?.classes?.[key]?.authority === POS.floor, `the entry is set: ${JSON.stringify(first).slice(0, 200)}`);
        await until("the first change worked through", done, 60_000);
        check((await one(`@rid = ${sec.rid}`))._home === POS.floor, "the section stays where the entry already is");
        // tightened to Operations: the section rises, the instance is seen from there and no longer from the floor
        await put(POS.ops);
        await until("the section re-homed", async () => (await one(`@rid = ${sec.rid}`))?._home === POS.ops, 60_000);
        const after = await one(`@rid = ${inst.rid}`);
        check((after._homes ?? []).includes(POS.ops) && !(after._homes ?? []).includes(POS.floor), `the instance follows its section: ${JSON.stringify(after._homes)}`);
        const grade = (await sql(`SELECT _grade FROM ${sec.rid}`))[0]?._grade ?? "";
        check(grade.includes(key) && /raised to Operations/.test(grade), `it says why: ${grade}`);
        // loosened back to the floor: nothing moves down
        await put(POS.floor);
        await until("the loosening worked through", done, 60_000);
        check((await one(`@rid = ${sec.rid}`))._home === POS.ops, "loosening moves nothing");
      } finally {
        await api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: before }) });
      }
    },
  },
  {
    name: "re-homing raises a section and its document's title goes with the strictest section (R11.13); the other section shows no title",
    run: (ctx) =>
      withMap(ctx, async (put) => {
        const { POS, check, tool } = ctx;
        const id = randomUUID().slice(0, 8);
        const { key, inst } = await classWithInstance(ctx, id);
        const title = `e2e-rh Pay review for Bob ${id}`;
        const rec = await recordAtFloor(ctx, title, [
          { heading: "Rate", text: `Thing ${id} gets a new rate next month.` },
          { heading: "Shift", text: "The second shift starts at six from Monday." },
        ]);
        check(rec.sections.every((s) => s._home === POS.floor) && (await docOf(ctx, rec.docId))._home === POS.floor, "all at the floor to begin with");
        await about(ctx, rec.sections[0], inst);
        await put({ [key]: { authority: POS.org } });
        check((await sectionAt(ctx, rec.sections[0].rid))._home === POS.org, "the section about the instance rose to the top");
        check((await sectionAt(ctx, rec.sections[1].rid))._home === POS.floor, "the other stays");
        check((await docOf(ctx, rec.docId))._home === POS.org, `the title takes the strictest home among its sections: ${(await docOf(ctx, rec.docId))._home}`);
        const low = await sectionAt(ctx, rec.sections[1].rid);
        check(!String(low.name).includes(title) && low._doc_title !== title, `the floor's section shows no title: ${low.name}`);
        const hits = (await tool("bob", "search_graph", { query: title, k: 16 })).results ?? [];
        check(!JSON.stringify(hits).includes(title), `the floor doesn't find the title: ${JSON.stringify(hits).slice(0, 200)}`);
        check((await tool("admin", "read_document", { document: rec.docId })).document === title, "the top reads it under its title");
      }),
  },
  {
    name: "re-homing: loosening widens nothing, a person lowers a section with set_home, and the next tightening moves it again",
    run: (ctx) =>
      withMap(ctx, async (put) => {
        const { POS, check, api, tool } = ctx;
        const id = randomUUID().slice(0, 8);
        const { key, inst } = await classWithInstance(ctx, id);
        const rec = await recordAtFloor(ctx, `e2e-rh loosen ${id}`, [{ heading: "Note", text: `Thing ${id} was serviced on Monday.` }]);
        const s = rec.sections[0];
        await about(ctx, s, inst);
        await put({ [key]: { authority: POS.org } });
        check((await sectionAt(ctx, s.rid))._home === POS.org, "raised to the top");
        await put({ [key]: { authority: POS.ops } });
        check((await sectionAt(ctx, s.rid))._home === POS.org, "moved down the tree: stays where it is");
        await put({ [key]: { authority: POS.floor } });
        check((await sectionAt(ctx, s.rid))._home === POS.org, "loosened to the floor: stays where it is");
        const name = (await sectionAt(ctx, s.rid)).name;
        const asked = await tool("admin", "set_home", { entities: [{ name }], to: "Production floor" });
        const pid = asked.results?.[0]?.pendingId ?? asked.results?.[0]?.id;
        check(pid, `lowering is asked for: ${JSON.stringify(asked).slice(0, 300)}`);
        const ok = await api(`/api/queue/${pid}/approve`, { method: "POST", body: "{}" });
        check(ok.result?.approved || ok.approved, `a person approves it: ${JSON.stringify(ok).slice(0, 200)}`);
        check((await sectionAt(ctx, s.rid))._home === POS.floor, "lowered by the person");
        check((await docOf(ctx, rec.docId))._home === POS.floor, "the title came down with it");
        await put({ [key]: { authority: POS.ops } });
        check((await sectionAt(ctx, s.rid))._home === POS.ops, "a later tightening covers it again");
        check((await docOf(ctx, rec.docId))._home === POS.ops, "and the title goes with it");
      }),
  },
  {
    name: "re-homing: a restart partway finishes the change, and running it twice changes nothing",
    run: (ctx) =>
      withMap(ctx, async (_put, before) => {
        const { POS, check, until, sql, api } = ctx;
        const id = randomUUID().slice(0, 8);
        const { key, inst } = await classWithInstance(ctx, id);
        const recs = [];
        for (const n of [1, 2, 3]) {
          const rec = await recordAtFloor(ctx, `e2e-rh restart ${id} ${n}`, [{ heading: "Note", text: `Thing ${id} part ${n} was inspected.` }]);
          await about(ctx, rec.sections[0], inst);
          recs.push(rec);
        }
        // what a crash leaves: the first section whole, but its title not settled; the others not begun
        await exec(ctx, `UPDATE ${recs[0].sections[0].rid} SET _home = 'ops', _grade = 'done before the restart'`);
        check((await docOf(ctx, recs[0].docId))._home === POS.floor, "the first title was left behind by the crash");
        const current = (await api("/api/policy")).policy;
        const next = { ...current, authorityMap: { ...before, classes: { ...(before.classes ?? {}), [key]: { authority: POS.ops } } } };
        await exec(ctx, `UPDATE OrgPolicy SET json = '${q(JSON.stringify(next))}', updated_by = 'carol', updated_at = '${iso(Date.now())}' WHERE scope = 'org'`);
        await exec(ctx, `INSERT INTO PolicyChange SET changed_at = '${iso(Date.now())}', changed_by = 'carol', prev_json = '${q(JSON.stringify(current))}', next_json = '${q(JSON.stringify(next))}', rehome_status = 'pending'`);
        await until("the change finished", () => settled(ctx), 90_000);
        const after = await Promise.all(recs.map((r) => sectionAt(ctx, r.sections[0].rid)));
        check(after.every((s) => s._home === POS.ops), `all of them moved: ${after.map((s) => s._home)}`);
        check(after[0]._grade === "done before the restart", `the one already moved isn't touched: ${after[0]._grade}`);
        check(/carol/.test(after[1]._grade), `the rest say who: ${after[1]._grade}`);
        const titles = await Promise.all(recs.map((r) => docOf(ctx, r.docId)));
        check(titles.every((d) => d._home === POS.ops), `every title settled, the crashed one included: ${titles.map((d) => d._home)}`);
        const thing = await sectionAt(ctx, inst.rid);
        check((thing._homes ?? []).includes(POS.ops) && !(thing._homes ?? []).includes(POS.floor), `the instance left the floor with its sections: ${JSON.stringify(thing._homes)}`);
        // and again, from the top
        const row = (await sql("SELECT @rid AS rid FROM PolicyChange WHERE rehome_status = 'done' AND changed_by = 'carol' ORDER BY changed_at DESC LIMIT 1"))[0];
        await exec(ctx, `UPDATE ${row.rid} SET rehome_status = 'pending', rehome_moved = null`);
        await until("the change finished again", async () => (await sql(`SELECT rehome_status FROM ${row.rid}`))[0]?.rehome_status === "done", 90_000);
        const again = await Promise.all(recs.map((r) => sectionAt(ctx, r.sections[0].rid)));
        check(JSON.stringify(again.map((s) => [s._home, s._grade])) === JSON.stringify(after.map((s) => [s._home, s._grade])), "run twice: nothing changes");
        check(Number((await sql(`SELECT rehome_moved FROM ${row.rid}`))[0].rehome_moved) === 0, "and it moved nothing");
      }),
  },
  {
    name: "re-homing: a map changed some other way re-homes too: a direct edit of the stored policy, and a crash before the change was logged",
    run: (ctx) =>
      withMap(ctx, async (put, before) => {
        const { POS, check, until, api } = ctx;
        const id = randomUUID().slice(0, 8);
        const a = await classWithInstance(ctx, `${id}a`);
        const ra = await recordAtFloor(ctx, `e2e-rh direct ${id}`, [{ heading: "Note", text: `Thing ${id}a was moved to bay 4.` }]);
        await about(ctx, ra.sections[0], a.inst);
        const current = (await api("/api/policy")).policy;
        await exec(ctx, `UPDATE OrgPolicy SET json = '${q(JSON.stringify({ ...current, authorityMap: { ...before, classes: { ...(before.classes ?? {}), [a.key]: { authority: POS.ops } } } }))}' WHERE scope = 'org'`);
        await until("the direct edit is applied", async () => (await sectionAt(ctx, ra.sections[0].rid))._home === POS.ops, 90_000);
        check(/outside the settings/.test((await sectionAt(ctx, ra.sections[0].rid))._grade), `says it didn't come through the settings: ${(await sectionAt(ctx, ra.sections[0].rid))._grade}`);
        check((await docOf(ctx, ra.docId))._home === POS.ops, "its title went with it");
        await put({});
        const b = await classWithInstance(ctx, `${id}b`);
        const rb = await recordAtFloor(ctx, `e2e-rh crash ${id}`, [{ heading: "Note", text: `Thing ${id}b was moved to bay 5.` }]);
        await about(ctx, rb.sections[0], b.inst);
        const now = (await api("/api/policy")).policy;
        await exec(ctx, `UPDATE OrgPolicy SET json = '${q(JSON.stringify({ ...now, authorityMap: { ...now.authorityMap, classes: { ...(now.authorityMap?.classes ?? {}), [b.key]: { authority: POS.ops } } } }))}', updated_by = 'carol', updated_at = '${iso(Date.now() + 1000)}' WHERE scope = 'org'`);
        await until("the change nobody logged is applied", async () => (await sectionAt(ctx, rb.sections[0].rid))._home === POS.ops, 90_000);
        check(/carol/.test((await sectionAt(ctx, rb.sections[0].rid))._grade), `the policy row says who: ${(await sectionAt(ctx, rb.sections[0].rid))._grade}`);
      }),
  },
  {
    name: "re-homing: a section waiting for its check keeps the rule, and its recheck never places it below the class's home",
    run: (ctx) =>
      withMap(ctx, async (put) => {
        const { POS, check, until } = ctx;
        const id = randomUUID().slice(0, 8);
        const { key, inst } = await classWithInstance(ctx, id);
        let rec;
        await ctx.models("/__fail", { model: "decisions", status: 500 });
        try {
          rec = await recordAtFloor(ctx, `e2e-rh waiting ${id}`, [{ heading: "Note", text: `Thing ${id} had its guard refitted.` }]);
          const s = await sectionAt(ctx, rec.sections[0].rid);
          check(s._ungraded && s._home === POS.org, `admin-only, waiting for its check: ${JSON.stringify(s).slice(0, 200)}`);
          await about(ctx, rec.sections[0], inst);
          await put({ [key]: { authority: POS.ops } });
          const w = await sectionAt(ctx, rec.sections[0].rid);
          check(w._home === POS.org && JSON.parse(w._ungraded).rule === POS.ops, `still waiting, now carrying the rule: ${w._ungraded}`);
        } finally {
          await ctx.models("/__ok", { model: "decisions" });
        }
        await until("rechecked", async () => !(await sectionAt(ctx, rec.sections[0].rid))._ungraded, 300_000);
        const after = await sectionAt(ctx, rec.sections[0].rid);
        check(after._home === POS.ops, `the check said nothing restricted, the rule holds it at Operations: ${after._home}`);
        check(/e2e_rh_/.test(after._grade), `and it says why: ${after._grade}`);
        check((await docOf(ctx, rec.docId))._home === POS.ops, "its title came down with it, to the rule's home");
      }),
  },
];
