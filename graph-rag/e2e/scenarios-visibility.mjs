// What the re-review of integration 2a1a12f left open on visibility, each with the neighbouring
// routes to the same harm: text a claim doesn't account for reaches the grader (B4), a question is
// answered from state only when it asks for a current value (B11), and a claim's stored home
// follows its section however the section moved (NB3). The fake grader is told nothing about
// these: it restricts on "[admins]" in what it is shown, and records what it was asked about.
const DAY = 86400000;
const JOB = "mssql:dbo_Job:";
const POS = { org: "org", ops: "ops", floor: "floor" };
const EMPTY = { classes: {}, attributes: {} };
const q = (s) => String(s).replace(/'/g, "\\'");
const iso = (ms) => new Date(ms).toISOString();
const valid = iso(Date.now() - DAY);

const job = (id, attribute, value, valid_from = valid) => ({ kind: "state", subject: { key: `${JOB}${id}`, class: "jobs" }, attribute, value, valid_from });
const doc = (who, title, sections) => ({ title, recorded_by: who, position: "floor", reason: "e2e", sections });
const record = (ctx, who, title, text, claims, heading) => ctx.tool(who, "record_document", { document: doc(who, title, [{ ...(heading ? { heading } : {}), text, claims }]) });
const graded = async (ctx) => (await (await fetch(`${ctx.MODELS}/__graded`)).json()).graded;
const sectionOf = async (ctx, title) => (await ctx.sql(`SELECT @rid AS rid, name, _home, _grade, _ungraded FROM Entity WHERE _kind = 'section' AND _doc_title = '${q(title)}'`))[0];
const stored = (ctx, title) => ctx.until(`${title} ingested`, async () => (await ctx.sql(`SELECT _doc_status FROM Entity WHERE _kind = 'document' AND name = '${q(title)}'`))[0]?._doc_status === "ready" && sectionOf(ctx, title), 120_000);
const edgesOf = async (ctx, rid) => ctx.sql(`SELECT @rid AS rid, id, value, _home FROM (SELECT expand(outE('CLAIMS')) FROM ${rid})`);

async function schema(ctx) {
  if (!(await ctx.sql("SELECT name FROM CommitmentClass WHERE name = 'jobs'")).length)
    await ctx.tool("admin", "execute_graph", { language: "sql", command: "CREATE VERTEX CommitmentClass SET name = 'jobs', record_table = 'mssql:dbo_Job', status = 'confirmed', stages = ['planned', 'running', 'paused', 'done']" });
}

/** under this authority map, with the derived-data window off (what earlier scenarios read would lift these writes) */
async function under(ctx, authorityMap, fn) {
  await schema(ctx);
  const before = (await ctx.api("/api/policy")).policy ?? {};
  const put = (body) => ctx.api("/api/policy", { method: "PUT", body: JSON.stringify(body) });
  const set = await put({ authorityMap, derivedWindowHours: 0 });
  ctx.check(set.policy, `policy set: ${JSON.stringify(set).slice(0, 300)}`);
  try {
    await fn();
  } finally {
    await put({ authorityMap: before.authorityMap ?? EMPTY, derivedWindowHours: before.derivedWindowHours ?? 24 });
  }
}

const stateOf = async (ctx, who, subject) => (await ctx.tool(who, "current_state", { subject })).things?.[0]?.state ?? {};

const GAUGE = { classes: {}, attributes: { gauge: POS.floor } };

// B6: a floor reader who didn't write it (a writer always reads their own note), and what the rule covers
const READER = "e2e-dana";
const ZZ = { classes: {}, attributes: { zz_rate: POS.ops } };
const tighten = async (ctx, authorityMap) => {
  const set = await ctx.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap }) });
  ctx.check(set.policy, `policy set: ${JSON.stringify(set).slice(0, 300)}`);
  return set;
};
const subjectOf = async (ctx, rid) => {
  const dst = (await ctx.sql(`SELECT @in AS dst FROM (SELECT expand(outE('CLAIMS')) FROM ${rid})`))[0]?.dst;
  return (await ctx.sql(`SELECT label, _homes FROM ${dst}`))[0];
};
/** every plain read of a recorded note, by who: does each still show it */
async function reads(ctx, who, title, query, label) {
  const hit = (r) => (r.results ?? []).some((x) => String(x.name).startsWith(title));
  const out = {
    search: hit(await ctx.tool(who, "search_graph", { query, k: 8 })),
    searchAsOf: hit(await ctx.tool(who, "search_graph", { query, k: 8, as_of: iso(Date.now()) })),
    findShareable: hit(await ctx.tool(who, "find_shareable", { query, k: 8 })),
    readDocument: !(await ctx.tool(who, "read_document", { document: title })).error,
  };
  if (label) out.aboutThing = JSON.stringify((await ctx.tool(who, "about_thing", { name: label })).things ?? []).includes(title);
  return out;
}

export default [
  {
    name: "B4 remainder: one sentence that states a ruled claim and carries more goes to the grader; a sentence that is only the claim doesn't",
    run: (ctx) =>
      under(ctx, GAUGE, async () => {
        const a = "e2e-vis gauge and pay";
        ctx.check(!(await record(ctx, "bob", a, "The gauge is set and Bob's pay is rising to 34.50 an hour [admins]", [job(90901, "gauge", "set")])).error, "recorded");
        const s = await stored(ctx, a);
        ctx.check(s._home === POS.org, `graded like the same text with no claim; got ${s._home} (${s._grade})`);
        ctx.check((await graded(ctx)).includes(s.name), "the grader was asked");
        const b = "e2e-vis gauge alone";
        ctx.check(!(await record(ctx, "bob", b, "The gauge is set.", [job(90902, "gauge", "set")])).error, "recorded");
        const t = await stored(ctx, b);
        ctx.check(t._home === POS.floor, `placed by its claim: ${t._home}`);
        ctx.check(!(await graded(ctx)).includes(t.name), "nothing for the grader: the sentence is the claim");
      }),
  },
  {
    name: "B4 remainder: the other places unaccounted text sits: a claim that carries the sentence, a heading, past the preview, a caller's entry name",
    run: (ctx) =>
      under(ctx, GAUGE, async () => {
        const sentence = "Bob's pay is rising to 34.50 an hour [admins]";
        const value = "e2e-vis in the value";
        ctx.check(!(await record(ctx, "bob", value, sentence, [job(90903, "gauge", sentence)])).error, "recorded");
        ctx.check((await stored(ctx, value))._home === POS.org, "the sentence as the claim's own value");
        const heading = "e2e-vis in the heading";
        ctx.check(!(await record(ctx, "bob", heading, "The gauge is set.", [job(90904, "gauge", "set")], "Pay review [admins]")).error, "recorded");
        ctx.check((await stored(ctx, heading))._home === POS.org, "a heading the grader is shown");
        const tail = "e2e-vis past the preview";
        const long = `${"The gauge is set. ".repeat(30)}Bob's pay is rising to 34.50 an hour [admins]`;
        ctx.check(long.indexOf("[admins]") > 400, "past the stored preview");
        ctx.check(!(await record(ctx, "bob", tail, long, [job(90905, "gauge", "set")])).error, "recorded");
        ctx.check((await stored(ctx, tail))._home === POS.org, "text past the preview is judged, and shown to the grader");
        const name = "e2e-vis Bob's pay is rising";
        const u = await ctx.tool("bob", "upsert_entities", { entities: [{ name, facets: { identity: "The gauge is set." }, claims: [{ kind: "state", class: "jobs", attribute: "gauge", value: "set" }] }] });
        ctx.check(!u.error, JSON.stringify(u).slice(0, 200));
        ctx.check((await graded(ctx)).includes(name), "the name a caller chose is text the grader judges");
      }),
  },
  {
    name: "B4 remainder: class keys in the authority map are normalized, and every reading of the rule uses them",
    run: async (ctx) => {
      await schema(ctx);
      await under(ctx, { classes: { Jobs: { authority: POS.org } }, attributes: {} }, async () => {
        const got = (await ctx.api("/api/policy")).policy?.authorityMap;
        ctx.check(got?.classes?.jobs?.authority === POS.org && !got.classes.Jobs, `stored as jobs: ${JSON.stringify(got)}`);
        const r = await record(ctx, "bob", "e2e-vis class key", "The widget count is 3.", [job(90906, "widget", "3")]);
        ctx.check(r.pendingId || r.queued, `the authority lies above bob: proposed, not written at the floor: ${JSON.stringify(r).slice(0, 300)}`);
      });
    },
  },
  {
    name: "B11 remainder: a question is answered from state only in the shape of a current-value question",
    run: (ctx) =>
      under(ctx, EMPTY, async () => {
        const id = 90921;
        await record(ctx, "bob", "e2e-vis lathe", "Job 90921 machine is Lathe 4.", [job(id, "machine", "Lathe 4", iso(Date.now() - 5 * DAY))]);
        await record(ctx, "bob", "e2e-vis cnc", "Job 90921 machine is CNC 2.", [job(id, "machine", "CNC 2", iso(Date.now() - DAY))]);
        await ctx.until("the claims are stored", async () => (await ctx.sql(`SELECT id FROM CLAIMS WHERE attribute = 'machine' AND value IN ['Lathe 4', 'CNC 2'] AND @in._keys CONTAINS '${JOB}${id}'`)).length >= 2);
        await new Promise((r) => setTimeout(r, 5500)); // the claim vocabulary is cached for a few seconds
        for (const question of [
          "What machine has job 90921 been on?",
          "Which machines has job 90921 been on?",
          "What are all the machines of job 90921?",
          "Which machine can job 90921 be on?",
          "What machines is job 90921 on?",
          "What is the best machine of job 90921?",
          "What machine is job 90921 on and who runs it?",
        ]) {
          const r = await ctx.tool("bob", "request_access", { question });
          ctx.check(!r.answer && r.status === "asked", `${question} reaches an owner: ${JSON.stringify(r).slice(0, 240)}`);
        }
        const yes = await ctx.tool("bob", "request_access", { question: "What machine is job 90921 on?" });
        ctx.check(yes.answer?.value === "CNC 2" && yes.status === "answered", `the current value is answered: ${JSON.stringify(yes).slice(0, 240)}`);
      }),
  },
  {
    name: "B11 remainder: two claims in force that disagree are not answered from state",
    run: (ctx) =>
      under(ctx, EMPTY, async () => {
        const id = 90922;
        await record(ctx, "bob", "e2e-vis disputed", "Job 90922 machine is CNC 7 or Lathe 8.", [job(id, "machine", "CNC 7"), job(id, "machine", "Lathe 8")]);
        await ctx.until("the claims are stored", async () => (await ctx.sql(`SELECT id FROM CLAIMS WHERE attribute = 'machine' AND @in._keys CONTAINS '${JOB}${id}'`)).length >= 2);
        await new Promise((r) => setTimeout(r, 5500));
        const r = await ctx.tool("bob", "request_access", { question: "What machine is job 90922 on?" });
        ctx.check(!r.answer && r.status === "asked", `a contradiction reaches an owner: ${JSON.stringify(r).slice(0, 240)}`);
      }),
  },
  {
    name: "NB3: after a grader outage a claim follows its section to where the regrade puts it, and its writer sees it again",
    run: (ctx) =>
      under(ctx, EMPTY, async () => {
        const title = "e2e-vis outage";
        await ctx.models("/__fail", { model: "grader", status: 500 });
        let s;
        try {
          ctx.check(!(await record(ctx, "bob", title, "The widget colour is red.", [job(90931, "colour", "red")])).error, "recorded");
          s = await stored(ctx, title);
          ctx.check(s._home === POS.ops && s._ungraded, `held one level up: ${s._home}`);
          ctx.check((await edgesOf(ctx, s.rid))[0]?._home === POS.ops, "its claim held with it");
          ctx.check(!(await stateOf(ctx, "bob", `${JOB}90931`)).colour, "while it waits, not read at the floor");
        } finally {
          await ctx.models("/__ok", { model: "grader" });
        }
        const back = await ctx.until("regraded", async () => {
          const x = await sectionOf(ctx, title);
          return x && !x._ungraded ? x : false;
        }, 150_000);
        ctx.check(back._home === POS.floor, `graded down: ${back._home}`);
        ctx.check((await edgesOf(ctx, s.rid))[0]?._home === POS.floor, "the claim followed");
        ctx.check((await stateOf(ctx, "bob", `${JOB}90931`)).colour?.value === "red", "bob sees his claim beside his section");
      }),
  },
  {
    name: "NB3: a regrade that restricts a held section takes its claim up with it, reading the section's whole text",
    run: (ctx) =>
      under(ctx, EMPTY, async () => {
        const title = "e2e-vis outage up";
        const long = `${"The widget colour is green. ".repeat(20)}Bob's pay is rising [admins]`;
        ctx.check(long.indexOf("[admins]") > 400, "past the stored preview");
        await ctx.models("/__fail", { model: "grader", status: 500 });
        let s;
        try {
          ctx.check(!(await record(ctx, "bob", title, long, [job(90932, "colour", "green")])).error, "recorded");
          s = await stored(ctx, title);
        } finally {
          await ctx.models("/__ok", { model: "grader" });
        }
        const back = await ctx.until("regraded", async () => {
          const x = await sectionOf(ctx, title);
          return x && !x._ungraded ? x : false;
        }, 150_000);
        ctx.check(back._home === POS.org, `the grader saw past the preview: ${back._home}`);
        ctx.check((await edgesOf(ctx, s.rid))[0]?._home === POS.org, "the claim went up with it");
      }),
  },
  {
    name: "NB3: a person's move takes the claims along, either way, and never below the claim's authority",
    run: (ctx) =>
      under(ctx, { classes: {}, attributes: { zz_kept: POS.ops } }, async () => {
        const title = "e2e-vis moved";
        const r = await ctx.tool("admin", "record_document", { document: { title, recorded_by: "admin", position: POS.org, reason: "e2e", sections: [{ text: "The widget size is 4. The zz kept is 9.", claims: [job(90933, "size", "4"), job(90933, "zz_kept", "9")] }] } });
        ctx.check(!r.error, JSON.stringify(r).slice(0, 300));
        const s = await stored(ctx, title);
        ctx.check(s._home === POS.org, `written at the top: ${s._home}`);
        const asked = await ctx.tool("admin", "set_home", { entities: [{ name: s.name }], to: "Production floor" });
        const id = asked.results?.[0]?.id ?? asked.results?.[0]?.pendingId;
        ctx.check(id, `the release is queued: ${JSON.stringify(asked).slice(0, 300)}`);
        const ok = await ctx.api(`/api/queue/${id}/approve`, { method: "POST", body: "{}" });
        ctx.check(ok.result?.approved, `approved: ${JSON.stringify(ok).slice(0, 300)}`);
        ctx.check((await sectionOf(ctx, title))._home === POS.floor, "released");
        const homes = Object.fromEntries((await edgesOf(ctx, s.rid)).map((e) => [e.value, e._home]));
        ctx.check(homes["4"] === POS.floor, `the unruled claim followed: ${JSON.stringify(homes)}`);
        ctx.check(homes["9"] === POS.ops, `the ruled claim stops at its authority: ${JSON.stringify(homes)}`);
        const state = await stateOf(ctx, "bob", `${JOB}90933`);
        ctx.check(state.size?.value === "4" && !state.zz_kept, `bob reads what was released to him and not the rest: ${JSON.stringify(state).slice(0, 240)}`);
        const up = await ctx.tool("admin", "set_home", { entities: [{ name: s.name }], to: "Top of the organization" });
        ctx.check(!up.error, JSON.stringify(up).slice(0, 300));
        ctx.check((await edgesOf(ctx, s.rid)).every((e) => e._home === POS.org), "restricted: every claim goes up with it");
      }),
  },
  {
    name: "NB3: an update that moves a section takes its claims, and a retried ingest settles claims already written",
    run: (ctx) =>
      under(ctx, EMPTY, async () => {
        const title = "e2e-vis updated";
        const claims = [job(90934, "colour", "blue")];
        ctx.check(!(await record(ctx, "bob", title, "The widget colour is blue.", claims)).error, "recorded");
        const s = await stored(ctx, title);
        ctx.check(s._home === POS.floor, `floor: ${s._home}`);
        // a retry: the run before stopped with this claim at another home
        const [edge] = await edgesOf(ctx, s.rid);
        const raw = (command) => ctx.tool("admin", "execute_graph", { language: "sql", command });
        await raw(`UPDATE ${edge.rid} SET _home = 'ops'`);
        await raw(`UPDATE Entity SET _doc_status = 'failed' WHERE _kind = 'document' AND name = '${q(title)}'`);
        ctx.check(!(await record(ctx, "bob", title, "The widget colour is blue.", claims)).error, "sent again");
        await stored(ctx, title);
        await ctx.until("the retry settled it", async () => (await edgesOf(ctx, s.rid))[0]?._home === POS.floor);
        // an update the grader restricts
        const u = await ctx.tool("bob", "upsert_entities", { entities: [{ name: s.name, facets: { identity: "The widget colour is blue. Bob's pay is rising [admins]" } }] });
        ctx.check(!u.error, JSON.stringify(u).slice(0, 300));
        const moved = await sectionOf(ctx, title);
        ctx.check(moved._home === POS.org, `the update raised it: ${moved._home}`);
        ctx.check((await edgesOf(ctx, s.rid))[0]?._home === POS.org, "its claim went with it");
      }),
  },
  {
    name: "B6: a rule that tightens re-homes the section at once, and no read of the sentence is left below it",
    run: (ctx) =>
      under(ctx, EMPTY, async () => {
        const title = "e2e-tight rate";
        const query = "zz_rate job 90941 an hour lathe crew";
        ctx.check(!(await record(ctx, "bob", title, "The zz_rate on job 90941 is 21.50 an hour. The lathe crew covers it.", [job(90941, "zz_rate", "21.50")])).error, "recorded");
        const s = await stored(ctx, title);
        ctx.check(s._home === POS.floor, `written at the floor: ${s._home} (${s._grade})`);
        const about = await subjectOf(ctx, s.rid);
        for (const [how, seen] of Object.entries(await reads(ctx, READER, title, query, about.label))) ctx.check(seen, `before the rule ${READER} reads it through ${how}`);
        const set = await tighten(ctx, ZZ);
        ctx.check(set.rehoming === false, `finished by the time the save answered: ${JSON.stringify(set).slice(0, 200)}`);
        const up = await sectionOf(ctx, title);
        ctx.check(up._home === POS.ops, `the section moved with the policy change: ${up._home}`);
        ctx.check(/attributes\.zz_rate/.test(up._grade) && /admin/.test(up._grade), `_grade names the rule and who changed it: ${up._grade}`);
        for (const [how, seen] of Object.entries(await reads(ctx, READER, title, query, about.label))) ctx.check(!seen, `${READER} no longer reads it through ${how}`);
        const above = await reads(ctx, "alice", title, query, about.label);
        ctx.check(above.search && above.readDocument, `ops still does: ${JSON.stringify(above)}`);
        ctx.check((await edgesOf(ctx, s.rid))[0]?._home === POS.ops, "its claim keeps the section's home");
        const thing = (await subjectOf(ctx, s.rid))._homes;
        ctx.check(thing.includes(POS.ops) && !thing.includes(POS.floor), `its subject is seen from where it now is: ${thing}`);
        const d = (await ctx.sql(`SELECT _home, _grade FROM Entity WHERE _kind = 'document' AND name = '${q(title)}'`))[0];
        ctx.check(d._home === POS.ops, `the title goes with its only section: ${d._home}`);
        const change = (await ctx.sql("SELECT rehome_status, rehome_moved, changed_by FROM PolicyChange WHERE rehome_status IS NOT NULL ORDER BY changed_at DESC LIMIT 1"))[0];
        ctx.check(change.rehome_status === "done" && change.changed_by === "admin" && Number(change.rehome_moved) >= 1, `the change records what it did: ${JSON.stringify(change)}`);
      }),
  },
  {
    name: "B6: what the section takes with it and what stays: another section, another statement about its subject, what was extracted from it",
    run: (ctx) =>
      under(ctx, EMPTY, async () => {
        const title = "e2e-tight two";
        const r = await ctx.tool("bob", "record_document", { document: doc("bob", title, [
          { text: "The zz_rate on job 90942 is 22.75 an hour. The zz_shift on job 90943 is nights.", claims: [job(90942, "zz_rate", "22.75"), job(90943, "zz_shift", "nights")] },
          { text: "The oil on the old lathe was changed on Tuesday by the morning crew." },
        ]) });
        ctx.check(!r.error, JSON.stringify(r).slice(0, 300));
        await stored(ctx, title);
        const other = "e2e-tight other";
        ctx.check(!(await record(ctx, "bob", other, "The zz_gauge on job 90942 is set.", [job(90942, "zz_gauge", "set")])).error, "recorded");
        await stored(ctx, other);
        const sections = await ctx.sql(`SELECT @rid AS rid, _home FROM Entity WHERE _kind = 'section' AND _doc_title = '${q(title)}' ORDER BY _section`);
        await ctx.tool("admin", "execute_graph", { language: "sql", command: "CREATE VERTEX Entity SET name = 'e2e-tight fact', _origin = 'floor', _home = 'floor', text_identity = 'zz_rate on job 90942 is 22.75'" });
        const fact = (await ctx.sql("SELECT @rid AS rid FROM Entity WHERE name = 'e2e-tight fact'"))[0];
        await ctx.tool("admin", "execute_graph", { language: "sql", command: `CREATE EDGE SOURCED_FROM FROM ${fact.rid} TO ${sections[0].rid}` });
        await tighten(ctx, ZZ);
        const after = await ctx.sql(`SELECT _home FROM Entity WHERE _kind = 'section' AND _doc_title = '${q(title)}' ORDER BY _section`);
        ctx.check(after[0]._home === POS.ops && after[1]._home === POS.floor, `only the section with the claim moves: ${JSON.stringify(after)}`);
        ctx.check((await ctx.sql("SELECT _home FROM Entity WHERE name = 'e2e-tight fact'"))[0]._home === POS.ops, "what was extracted from it goes with it");
        ctx.check((await ctx.sql(`SELECT _home FROM Entity WHERE _kind = 'document' AND name = '${q(title)}'`))[0]._home === POS.floor, "the document stays while another section is seen there");
        const edges = await edgesOf(ctx, sections[0].rid);
        ctx.check(edges.length === 2 && edges.every((e) => e._home === POS.ops), `every claim on the section keeps its home: ${JSON.stringify(edges)}`);
        const things = await ctx.sql(`SELECT label, _homes, _keys FROM Entity WHERE _kind = 'thing' AND _keys CONTAINSANY ['${JOB}90942', '${JOB}90943']`);
        const homes = (id) => things.find((t) => t._keys.includes(`${JOB}${id}`))._homes;
        ctx.check(homes(90942).includes(POS.floor), `another statement at the floor keeps its subject there: ${homes(90942)}`);
        ctx.check(!homes(90943).includes(POS.floor), `a subject only this section spoke of leaves: ${homes(90943)}`);
        const read = await ctx.tool(READER, "read_document", { document: title });
        ctx.check(read.contents?.length === 1 && read.contents[0].section === 2 && !JSON.stringify(read).includes("22.75"), `the document reads as what is left: ${JSON.stringify(read).slice(0, 300)}`);
      }),
  },
  {
    name: "B6: loosening a rule widens nothing, a person lowers a section with set_home, and the next tightening moves it again",
    run: (ctx) =>
      under(ctx, EMPTY, async () => {
        const title = "e2e-tight loosen";
        const query = "zz_rate job 90944 an hour";
        ctx.check(!(await record(ctx, "bob", title, "The zz_rate on job 90944 is 23.10 an hour.", [job(90944, "zz_rate", "23.10")])).error, "recorded");
        const s = await stored(ctx, title);
        await tighten(ctx, { classes: {}, attributes: { zz_rate: POS.org } });
        ctx.check((await sectionOf(ctx, title))._home === POS.org, "raised to the top");
        await tighten(ctx, ZZ);
        ctx.check((await sectionOf(ctx, title))._home === POS.org, "moved down the tree: stays where it is");
        await tighten(ctx, EMPTY);
        ctx.check((await sectionOf(ctx, title))._home === POS.org, "removed: stays where it is");
        ctx.check(!(await reads(ctx, "alice", title, query)).search, "ops doesn't read it for the loosening");
        const asked = await ctx.tool("admin", "set_home", { entities: [{ name: s.name }], to: "Production floor" });
        const id = asked.results?.[0]?.id ?? asked.results?.[0]?.pendingId;
        ctx.check(id, `lowering is asked for: ${JSON.stringify(asked).slice(0, 300)}`);
        ctx.check((await ctx.api(`/api/queue/${id}/approve`, { method: "POST", body: "{}" })).result?.approved, "and a person approves it");
        ctx.check((await sectionOf(ctx, title))._home === POS.floor, "lowered");
        ctx.check((await reads(ctx, READER, title, query)).search, "the floor reads it again");
        await tighten(ctx, ZZ);
        ctx.check((await sectionOf(ctx, title))._home === POS.ops, "a later tightening covers it again");
      }),
  },
  {
    name: "B6: a restart partway finishes the change, and running it twice changes nothing",
    run: (ctx) =>
      under(ctx, EMPTY, async () => {
        const ids = [90945, 90946, 90947];
        const secs = [];
        for (const id of ids) {
          const title = `e2e-tight restart ${id}`;
          ctx.check(!(await record(ctx, "bob", title, `The zz_rate on job ${id} is 24.00 an hour.`, [job(id, "zz_rate", "24.00")])).error, "recorded");
          secs.push(await stored(ctx, title));
        }
        const raw = (command) => ctx.tool("admin", "execute_graph", { language: "sql", command });
        // what a crash leaves: one section whole, one with only its claim moved, one not begun
        await raw(`UPDATE ${secs[0].rid} SET _home = 'ops', _grade = 'done before the restart'`);
        await raw(`UPDATE ${(await edgesOf(ctx, secs[0].rid))[0].rid} SET _home = 'ops'`);
        await raw(`UPDATE ${(await edgesOf(ctx, secs[1].rid))[0].rid} SET _home = 'ops'`);
        const current = (await ctx.api("/api/policy")).policy;
        const next = { ...current, authorityMap: ZZ };
        await raw(`UPDATE OrgPolicy SET json = '${q(JSON.stringify(next))}', updated_by = 'carol', updated_at = '${iso(Date.now())}' WHERE scope = 'org'`);
        await raw(`INSERT INTO PolicyChange SET changed_at = '${iso(Date.now())}', changed_by = 'carol', prev_json = '${q(JSON.stringify(current))}', next_json = '${q(JSON.stringify(next))}', rehome_status = 'pending'`);
        await ctx.until("the change finished", async () => (await ctx.sql("SELECT rehome_status FROM PolicyChange WHERE rehome_status = 'pending'")).length === 0);
        const after = await Promise.all(ids.map((id) => sectionOf(ctx, `e2e-tight restart ${id}`)));
        ctx.check(after.every((s) => s._home === POS.ops), `all of them moved: ${after.map((s) => s._home)}`);
        ctx.check(after[0]._grade === "done before the restart", `the one already moved isn't touched: ${after[0]._grade}`);
        ctx.check(/carol/.test(after[1]._grade), `the rest say who: ${after[1]._grade}`);
        ctx.check(!(await subjectOf(ctx, secs[1].rid))._homes.includes(POS.floor), "the subject left with the section that was half done");
        // and again, from the top
        const row = (await ctx.sql("SELECT @rid AS rid FROM PolicyChange WHERE rehome_status = 'done' ORDER BY changed_at DESC LIMIT 1"))[0];
        await raw(`UPDATE ${row.rid} SET rehome_status = 'pending', rehome_moved = null`);
        await ctx.until("the change finished again", async () => (await ctx.sql(`SELECT rehome_status FROM ${row.rid}`))[0]?.rehome_status === "done");
        const again = await Promise.all(ids.map((id) => sectionOf(ctx, `e2e-tight restart ${id}`)));
        ctx.check(JSON.stringify(again.map((s) => [s._home, s._grade])) === JSON.stringify(after.map((s) => [s._home, s._grade])), "run twice: nothing changes");
        ctx.check(Number((await ctx.sql(`SELECT rehome_moved FROM ${row.rid}`))[0].rehome_moved) === 0, "and it moved nothing");
      }),
  },
  {
    name: "B6: a map changed some other way re-homes too: a direct edit of the stored policy, and a crash before the change was logged",
    run: (ctx) =>
      under(ctx, EMPTY, async () => {
        const raw = (command) => ctx.tool("admin", "execute_graph", { language: "sql", command });
        const a = "e2e-tight direct";
        ctx.check(!(await record(ctx, "bob", a, "The zz_rate on job 90948 is 25.00 an hour.", [job(90948, "zz_rate", "25.00")])).error, "recorded");
        await stored(ctx, a);
        const current = (await ctx.api("/api/policy")).policy;
        await raw(`UPDATE OrgPolicy SET json = '${q(JSON.stringify({ ...current, authorityMap: ZZ }))}' WHERE scope = 'org'`);
        await ctx.until("the direct edit is applied", async () => (await sectionOf(ctx, a))._home === POS.ops);
        ctx.check(/outside the settings/.test((await sectionOf(ctx, a))._grade), `says it didn't come through the settings: ${(await sectionOf(ctx, a))._grade}`);
        await tighten(ctx, EMPTY);
        const b = "e2e-tight crash";
        ctx.check(!(await record(ctx, "bob", b, "The zz_rate on job 90949 is 26.00 an hour.", [job(90949, "zz_rate", "26.00")])).error, "recorded");
        await stored(ctx, b);
        const now = (await ctx.api("/api/policy")).policy;
        await raw(`UPDATE OrgPolicy SET json = '${q(JSON.stringify({ ...now, authorityMap: ZZ }))}', updated_by = 'carol', updated_at = '${iso(Date.now() + 1000)}' WHERE scope = 'org'`);
        await ctx.until("the change nobody logged is applied", async () => (await sectionOf(ctx, b))._home === POS.ops);
        ctx.check(/carol/.test((await sectionOf(ctx, b))._grade), `the policy row says who: ${(await sectionOf(ctx, b))._grade}`);
      }),
  },
  {
    name: "B6: a section waiting for the grader rises with the rule, and its regrade neither lowers it nor loses why",
    run: (ctx) =>
      under(ctx, EMPTY, async () => {
        const title = "e2e-tight held";
        await ctx.models("/__fail", { model: "grader", status: 500 });
        try {
          ctx.check(!(await record(ctx, "bob", title, "The zz_rate on job 90950 is 27.00 an hour.", [job(90950, "zz_rate", "27.00")])).error, "recorded");
          const s = await stored(ctx, title);
          ctx.check(s._ungraded, `waiting for the grader: ${JSON.stringify(s).slice(0, 200)}`);
          await tighten(ctx, { classes: {}, attributes: { zz_rate: POS.org } });
          ctx.check((await sectionOf(ctx, title))._home === POS.org, "raised while it waits");
        } finally {
          await ctx.models("/__ok", { model: "grader" });
        }
        await ctx.until("regraded", async () => !(await sectionOf(ctx, title))._ungraded);
        const after = await sectionOf(ctx, title);
        ctx.check(after._home === POS.org && /attributes\.zz_rate/.test(after._grade), `still at the rule's home, still saying why: ${after._home} (${after._grade})`);
      }),
  },
];
