// The record stream's scenarios (docs/BUILD.md, record): where a section starts (R11.5), the restrict-only
// typed check per section (R4, R11.11), a document's title (R11.13), what an agent read (R11.13), and a file
// uploaded on record (R11.12). The decision model is the harness's fake (fake-models.mjs): it answers a closed
// question from a `[question: choice]` tag in the text with probability 0.9, "none" when that is a choice,
// else the first choice at an even (unsure) spread. Each scenario says what the model said; what is checked is
// what graph-rag does with it.
//
// Labels: the check's visible_from choices start at the writer's own position, P1, and go up. From the floor:
// P1 floor, P2 ops, P3 org. Categories c1… are the policy's list in order (c1 pay and compensation).
import { randomUUID } from "node:crypto";

const graphOf = (ctx) => ctx.GRAPH ?? process.env.GRAPH_URL ?? "http://graph-rag:8000";
const modelsOf = (ctx) => ctx.MODELS ?? process.env.MODELS_URL ?? "http://models:4000";
const adminToken = (ctx) => ctx.TOKENS?.admin ?? "e2e-admin";
const fake = (ctx, path, body) => fetch(modelsOf(ctx) + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

/** PUT /api/thread-record as the person's instance: what the app does when the person flips the switch */
function putThreadRecord(ctx, body, token = adminToken(ctx)) {
  return fetch(`${graphOf(ctx)}/api/thread-record`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** a fresh chat agent of the admin's (its own read marks) at these positions, its thread on record under `position` */
async function agentOnRecord(ctx, positions, position) {
  const agent = randomUUID();
  const r = await putThreadRecord(ctx, { agent, thread: `e2e-rec-${agent.slice(0, 8)}`, on: true, ...(position ? { position } : {}) });
  ctx.check(r.ok, `the thread went on record: ${r.status} ${await r.text()}`);
  return { agent, token: ctx.delegated({ a: agent, p: positions }) };
}

const docRow = async (ctx, docId) => (await ctx.sql(`SELECT @rid AS rid, name, _home, _doc_status, _record_position, _recorded_by, _record_reason, file FROM Entity WHERE _kind = 'document' AND _doc_id = '${docId}'`))[0];
const sectionRows = (ctx, docId) => ctx.sql(`SELECT @rid AS rid, name, _home, _grade, _ungraded, _section, _doc_title FROM Entity WHERE _kind = 'section' AND _doc_id = '${docId}' ORDER BY _section`);
const ready = (ctx, docId, ms = 90_000) => ctx.until(`record ${docId} ready`, async () => ((await docRow(ctx, docId))?._doc_status === "ready" ? docRow(ctx, docId) : false), ms);

export const scenarios = [
  {
    name: "record: a section starts at the position the person put the thread on record under, and an agent cannot choose another",
    async run(ctx) {
      const { tool, check, POS } = ctx;
      const tag = randomUUID().slice(0, 6);
      // the person holds the floor and Operations through this agent; they put the thread on record under the floor
      const a = await agentOnRecord(ctx, [POS.floor, POS.ops], POS.floor);
      const one = await tool(a.token, "record_document", { document: { title: `e2e-rec start ${tag} floor`, reason: "start", sections: [{ heading: "Lathe", text: "Lathe 5 had its chuck jaws replaced on Tuesday." }] } });
      check(one.doc_id && one.on_record, `recorded: ${JSON.stringify(one).slice(0, 200)}`);
      const d1 = await ready(ctx, one.doc_id);
      check(d1._record_position === POS.floor, `on record under the floor: ${JSON.stringify(d1)}`);
      check((await sectionRows(ctx, one.doc_id))[0]._home === POS.floor, "the section starts at the floor");
      // the same person switches a thread on under Operations: its sections start there
      const b = await agentOnRecord(ctx, [POS.floor, POS.ops], POS.ops);
      const two = await tool(b.token, "record_document", { document: { title: `e2e-rec start ${tag} ops`, reason: "start", sections: [{ heading: "Lathe", text: "Lathe 5 will be replaced next quarter." }] } });
      const d2 = await ready(ctx, two.doc_id);
      check(d2._record_position === POS.ops && (await sectionRows(ctx, two.doc_id))[0]._home === POS.ops, `under Operations: ${JSON.stringify(d2)}`);
      // an agent naming a home is not where a record starts: the argument is gone
      const forged = await tool(a.token, "record_document", { document: { title: `e2e-rec start ${tag} forged`, reason: "start", sections: [{ text: "Lathe 6 is idle this week, nothing scheduled." }] }, home: POS.org });
      if (forged.doc_id) {
        const d3 = await ready(ctx, forged.doc_id);
        check(d3._record_position === POS.floor && (await sectionRows(ctx, forged.doc_id))[0]._home === POS.floor, `a home the agent names changes nothing: ${JSON.stringify(d3)}`);
      }
      // a position the person doesn't hold through this agent is not taken from the switch
      const c = await agentOnRecord(ctx, [POS.floor], POS.org);
      const three = await tool(c.token, "record_document", { document: { title: `e2e-rec start ${tag} unheld`, reason: "start", sections: [{ text: "Lathe 7 is booked for the Toro job on Monday." }] } });
      const d4 = await ready(ctx, three.doc_id);
      check(d4._record_position === POS.floor, `not a position it holds: its own instead: ${JSON.stringify(d4)}`);
    },
  },
  {
    name: "record: the check restricts a sure category, holds an unsure one a level higher and asks a person, leaves the rest; the title goes with the strictest",
    async run(ctx) {
      const { tool, sql, check, POS } = ctx;
      const tag = randomUUID().slice(0, 6);
      const a = await agentOnRecord(ctx, [POS.floor], POS.floor);
      const title = `e2e-rec check ${tag} handover`;
      const sent = await tool(a.token, "record_document", {
        document: {
          title,
          reason: "handover",
          sections: [
            { heading: "Press", text: "Press 2 is running the Toro brackets this week." },
            { heading: "Pay", text: "Diep's rate goes up next month. [category: c1] [visible_from: P3]" },
            { heading: "Dispute", text: "There may be a disagreement with the landlord about the dock. [category: c4]" },
          ],
        },
      });
      check(sent.doc_id && sent.sections === 3, `recorded: ${JSON.stringify(sent).slice(0, 200)}`);
      const d = await ready(ctx, sent.doc_id);
      const s = await sectionRows(ctx, sent.doc_id);
      check(s[0]._home === POS.floor, `"none", sure: stays where it started: ${JSON.stringify(s[0])}`);
      check(s[1]._home === POS.org, `a sure category with a sure level: raised there: ${JSON.stringify(s[1])}`);
      check(s[2]._home === POS.ops, `a sure category with an unsure level: one level higher: ${JSON.stringify(s[2])}`);
      check(s.every((x) => !x._ungraded), "every section was checked");
      check(d._home === POS.org, `the title is homed with its strictest section: ${JSON.stringify(d)}`);
      check(s[0]._doc_title !== title && !String(s[0].name).includes(title), `the floor's section shows no title: ${s[0].name}`);
      // the unsure one is flagged: a proposal to bring it back, for a person
      const flagged = await sql(`SELECT kind, status, payload FROM PendingWrite WHERE kind = 'rehome' AND status = 'pending' AND payload LIKE '%${s[2].name.replace(/'/g, "''").slice(0, 60)}%'`);
      check(flagged.length === 1 && JSON.parse(flagged[0].payload).to === POS.floor, `an unsure section asks a person to bring it back: ${JSON.stringify(flagged).slice(0, 300)}`);
      check((await sql(`SELECT count(*) AS n FROM PendingWrite WHERE kind = 'rehome' AND payload LIKE '%${s[1].name.replace(/'/g, "''").slice(0, 60)}%'`))[0].n === 0, "a sure one asks nobody");
      // who sees what
      const seen = async (who) => ((await tool(who, "read_document", { document: sent.doc_id })).contents ?? []).map((c) => c.section);
      check(JSON.stringify(await seen("bob")) === "[1]", `the floor sees the press only: ${JSON.stringify(await seen("bob"))}`);
      check(JSON.stringify(await seen("alice")) === "[1,3]", `Operations sees the press and the held one: ${JSON.stringify(await seen("alice"))}`);
      check(JSON.stringify(await seen("admin")) === "[1,2,3]", "the top sees all three");
      // one call per section, carrying that section only
      const calls = (await (await fetch(modelsOf(ctx) + "/__decisions")).json()).decisions ?? [];
      check(calls.filter((c) => (c.questions ?? []).includes("category") && (c.questions ?? []).includes("visible_from")).length >= 3, `the check was asked per section: ${JSON.stringify(calls).slice(-300)}`);
    },
  },
  {
    name: "record: no answer from the check is admin-only until it answers, then each section and its title come down to where the check puts them",
    async run(ctx) {
      const { tool, check, until, POS } = ctx;
      const tag = randomUUID().slice(0, 6);
      const a = await agentOnRecord(ctx, [POS.floor], POS.floor);
      await fake(ctx, "/__fail", { model: "decisions", status: 500 });
      let sent;
      try {
        sent = await tool(a.token, "record_document", { document: { title: `e2e-rec outage ${tag}`, reason: "outage", sections: [{ heading: "Belts", text: "Lathe 3 had its belts replaced this week." }, { heading: "Rate", text: "The night rate rises in May. [category: c1] [visible_from: P2]" }] } });
        check(sent.doc_id, `recorded: ${JSON.stringify(sent).slice(0, 200)}`);
        const d = await ready(ctx, sent.doc_id);
        const s = await sectionRows(ctx, sent.doc_id);
        check(s.every((x) => x._home === POS.org && x._ungraded), `no answer: admin-only, waiting for the check: ${JSON.stringify(s)}`);
        check(d._home === POS.org, "the title waits with them");
        const bob = await tool("bob", "search_graph", { query: `e2e-rec outage ${tag} Lathe 3 belts`, k: 16 });
        check(!JSON.stringify(bob.results ?? []).includes("Lathe 3 had its belts"), "the floor sees nothing of it while it waits");
      } finally {
        await fake(ctx, "/__ok", { model: "decisions" });
      }
      await until("rechecked", async () => {
        const s = await sectionRows(ctx, sent.doc_id);
        return s.every((x) => !x._ungraded) ? s : false;
      }, 300_000);
      const s = await sectionRows(ctx, sent.doc_id);
      check(s[0]._home === POS.floor, `rechecked: the belts come down to the floor: ${JSON.stringify(s[0])}`);
      check(s[1]._home === POS.ops, `the rate goes where the check put it: ${JSON.stringify(s[1])}`);
      check((await docRow(ctx, sent.doc_id))._home === POS.ops, "the title comes down to its strictest section");
    },
  },
  {
    name: "record: a file uploaded on record is a record, stored as it is in sections; off record, or not text, nothing is",
    async run(ctx) {
      const { tool, sql, check, POS } = ctx;
      const tag = randomUUID().slice(0, 6);
      const para = (w) => Array.from({ length: 10 }, (_, i) => `${w} item ${i + 1}: Job 44${i}0 for ${w} runs on CNC ${1 + (i % 3)} and ships on Friday.`).join(" ");
      const text = `# e2e-rec ${tag} weekly plan\n\n## Toro\n\n${para("Toro")}\n\n## Exatron\n\n${para("Exatron")}\n\n## Pay\n\n[category: c1] [visible_from: P3] The weekend premium goes to 1.5x from June.\n`;
      // off record: refused at the call, nothing stored
      const offAgent = randomUUID();
      await putThreadRecord(ctx, { agent: offAgent, thread: "t-off", on: false });
      const offToken = ctx.delegated({ a: offAgent, p: [POS.floor] });
      const refused = await tool(offToken, "record_file", { file: `plan-${tag}.md`, text });
      check(refused.error && /off record/.test(refused.error), `off record, the upload is refused: ${JSON.stringify(refused).slice(0, 200)}`);
      check(Number((await sql(`SELECT count(*) AS n FROM Entity WHERE _kind = 'document' AND name LIKE 'e2e-rec ${tag}%'`))[0]?.n ?? 0) === 0, "nothing of it was stored");
      // on record: a record under the person, at the position they chose, its text as it is
      const a = await agentOnRecord(ctx, [POS.floor], POS.floor);
      const sent = await tool(a.token, "record_file", { file: `plan-${tag}.md`, text, title: `e2e-rec ${tag} weekly plan`, reason: "the weekly plan, uploaded" });
      check(sent.doc_id && sent.on_record === true && sent.sections >= 3, `the file is on record: ${JSON.stringify(sent).slice(0, 300)}`);
      const d = await ready(ctx, sent.doc_id);
      check(d._recorded_by === "admin" && d._record_position === POS.floor && d._record_reason === "the weekly plan, uploaded", `who, where and why: ${JSON.stringify(d)}`);
      const s = await sectionRows(ctx, sent.doc_id);
      check(s.length === sent.sections, `its sections as chunked: ${s.length}`);
      check(s.some((x) => x._home === POS.org) && s.some((x) => x._home === POS.floor), `each section checked on its own: ${JSON.stringify(s.map((x) => x._home))}`);
      check(d._home === POS.org, "the title with its strictest section");
      const read = await tool("admin", "read_document", { document: sent.doc_id, count: 6 });
      check(read.sections.map((x) => x.text).join("\n").includes(para("Exatron").slice(0, 80)), "the text is the file's, unchanged");
      // the same file again is the same record
      const again = await tool(a.token, "record_file", { file: `plan-${tag}.md`, text, title: `e2e-rec ${tag} weekly plan`, reason: "the weekly plan, uploaded" });
      check(again.doc_id === sent.doc_id && again.already_on_record === true, `the same file again adds nothing: ${JSON.stringify(again).slice(0, 200)}`);
      // not text: refused
      const bin = await tool(a.token, "record_file", { file: "scan.pdf", text: "%PDF-1.7\u0000\u0001 binary content follows here..." });
      check(bin.error && /text/.test(bin.error), `a file that isn't text is not a record: ${JSON.stringify(bin).slice(0, 200)}`);
      // a person's own token puts a file on record too: there is no thread to be off
      const mine = await tool("bob", "record_file", { file: `bob-${tag}.txt`, text: "Bob's note: the saw on bay 2 needs a new blade before Monday." });
      check(mine.doc_id && mine.on_record, `a person uploads directly: ${JSON.stringify(mine).slice(0, 200)}`);
      const md = await ready(ctx, mine.doc_id);
      check(md._recorded_by === "bob" && md._record_position === POS.floor, `bob's, at bob's position: ${JSON.stringify(md)}`);
    },
  },
  {
    name: "record: an agent cannot write lower than what it read, and its person's own notes don't raise it",
    async skip(ctx) {
      return (await ctx.api("/api/policy")).policy?.derivedWindowHours > 0 ? null : "the derived window is off in this harness";
    },
    async run(ctx) {
      const { tool, check, POS } = ctx;
      const tag = randomUUID().slice(0, 6);
      // alice records at Operations; the admin records at Operations through one agent
      const alice = await tool("alice", "record_file", { file: `ops-${tag}.txt`, text: "Operations note: the Exatron contract renewal is due in March; Karl leads it." });
      await ready(ctx, alice.doc_id);
      const own = await agentOnRecord(ctx, [POS.floor, POS.ops], POS.ops);
      const mine = await tool(own.token, "record_document", { document: { title: `e2e-rec own ${tag}`, reason: "r", sections: [{ text: "Operations note: the dock door repair is booked for Thursday." }] } });
      await ready(ctx, mine.doc_id);
      // an agent of the admin's that reads alice's Operations note, then writes at the floor: held at Operations
      const reader = await agentOnRecord(ctx, [POS.floor, POS.ops], POS.floor);
      const r1 = await tool(reader.token, "read_document", { document: alice.doc_id });
      check(r1.sections?.length, `it read alice's note: ${JSON.stringify(r1).slice(0, 200)}`);
      const held = await tool(reader.token, "record_document", { document: { title: `e2e-rec derived ${tag}`, reason: "r", sections: [{ text: "Floor note: the renewal means extra Exatron runs in March." }] } });
      await ready(ctx, held.doc_id);
      check((await sectionRows(ctx, held.doc_id))[0]._home === POS.ops, `held no lower than what it read: ${JSON.stringify(await sectionRows(ctx, held.doc_id))}`);
      // an agent of the admin's that reads only the admin's own Operations note, then writes at the floor: stays at the floor
      const ownReader = await agentOnRecord(ctx, [POS.floor, POS.ops], POS.floor);
      const r2 = await tool(ownReader.token, "read_document", { document: mine.doc_id });
      check(r2.sections?.length, `it read its person's own note: ${JSON.stringify(r2).slice(0, 200)}`);
      const free = await tool(ownReader.token, "record_document", { document: { title: `e2e-rec ownread ${tag}`, reason: "r", sections: [{ text: "Floor note: the dock door will be shut Thursday morning." }] } });
      await ready(ctx, free.doc_id);
      check((await sectionRows(ctx, free.doc_id))[0]._home === POS.floor, `a person's own notes don't raise their level: ${JSON.stringify(await sectionRows(ctx, free.doc_id))}`);
    },
  },
];

export default scenarios;
