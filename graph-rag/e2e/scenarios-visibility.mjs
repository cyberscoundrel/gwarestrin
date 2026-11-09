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
];
