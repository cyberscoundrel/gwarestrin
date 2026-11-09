// The Authority stream's acceptance scenarios (docs/ORGANIZATION-MODEL.md, "Authority: the
// hierarchy read the other way"), in the shape run.mjs's scenarios take: an array of
// { name, run }. The Test harness stream's loader runs them inside the replay harness
// (e2e.sh: a real ArcadeDB, graph-rag from this checkout, fake models) and may hand `run` its
// helpers ({ tool, sql, api, models, entry, until, check, save }); without them each scenario
// uses the ones below, built from GRAPH_URL and MODELS_URL like run.mjs's.
//
// The scenarios write claim-bearing entities through `upsert_entities` with `claims` on each
// entity (the contract's claim shape) and expect the write-or-propose decision at the tool to be
// decideWrite's (graph-rag/src/MAP.md, "What the integrator should know"): until the integrator
// has switched server.js's upsert site and let `claims` through its schema, the first and last
// scenario report that, not a defect of the rule.
const GRAPH = process.env.GRAPH_URL ?? "http://graph-rag:8000";
const MODELS = process.env.MODELS_URL ?? "http://models:4000";
const TOKENS = { admin: "e2e-admin", alice: "e2e-alice", bob: "e2e-bob" };
const POS = { org: "org", ops: "ops", floor: "floor" };

let id = 1;
async function tool(who, name, args) {
  const r = await fetch(`${GRAPH}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKENS[who] ?? who}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
  });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  const msg = JSON.parse(line ? line.slice(5) : t);
  const text = msg.result?.content?.[0]?.text ?? msg.error?.message ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
const own = {
  tool,
  sql: async (query) => (await tool("admin", "query_graph", { query, language: "sql" })).rows ?? [],
  api: async (path, opts = {}) => (await fetch(`${GRAPH}${path}`, { ...opts, headers: { authorization: `Bearer ${TOKENS.admin}`, "content-type": "application/json" } })).json(),
  models: (path, body) => fetch(`${MODELS}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
  check: (cond, msg) => {
    if (!cond) throw new Error(msg);
  },
  async until(label, fn, timeoutMs = 120_000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      try {
        last = await fn();
        if (last) return last;
      } catch (e) {
        last = `threw: ${e}`;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`timed out: ${label} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
  },
};
own.entry = async (name) => (await own.sql(`SELECT @rid AS rid, name, _home, _grade, _ungraded, _authority, _claim_classes FROM Entity WHERE name = '${name}'`))[0];
own.save = (who, name, text) => own.tool(who, "upsert_entities", { entities: [{ name, facets: { identity: text } }] });
const helpers = (h) => ({ ...own, ...h });

/** grader calls so far (the fake models count per model) */
const graderCalls = async (h) => Number((await (await fetch(`${MODELS}/__calls`)).json()).grader ?? 0);
/** a claim-bearing write: the entity carries its claims in the contract's shape */
const saveClaims = (h, who, name, text, claims, extra = {}) => h.tool(who, "upsert_entities", { entities: [{ name, facets: { identity: text }, claims }], ...extra });
/** the pending write a proposal made, by id */
const pending = async (h, pid) => (await h.sql(`SELECT id, kind, home, status, requested_by FROM PendingWrite WHERE id = '${pid}'`))[0];

/** the authority map the scenarios run under: the fixture map plus the oracle's rules the misgrade cases need */
const MAP = {
  classes: { orders: { authority: "ops", attributes: { price: "org", margin: "org" } }, jobs: { authority: "floor" }, hires: { authority: "org" }, maintenance: { authority: "floor" }, review: { authority: "org" } },
  attributes: { pay: "org", pay_rate: "org", dismissal: "org", price: "org", unit_price: "org", margin: "org", credit_limit: "ops", balance_due: "ops", payment_terms: "ops" },
};
const EMPTY = { classes: {}, attributes: {} };
/** entry names unique to this run: an entry is (name, origin), and an update never widens where an earlier run put it */
const TAG = Math.random().toString(36).slice(2, 7);
const nm = (base) => `${base} ${TAG}`;
/**
 * Run under this authority map, with the derived-data window off: what alice and bob read in
 * earlier scenarios (notes at the top) would otherwise hold their writes there, and these
 * scenarios are about authority, not derived data. Both settings are restored afterwards.
 */
async function withPolicy(h, authorityMap, fn) {
  const before = (await h.api("/api/policy")).policy ?? {};
  const set = await h.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap, derivedWindowHours: 0 }) });
  h.check(set.policy?.authorityMap, `the authority map is a policy setting: ${JSON.stringify(set).slice(0, 300)}`);
  try {
    await fn();
  } finally {
    await h.api("/api/policy", { method: "PUT", body: JSON.stringify({ authorityMap: before.authorityMap ?? EMPTY, derivedWindowHours: before.derivedWindowHours ?? 12 }) });
  }
}

export const scenarios = [
  {
    name: "authority: a pay claim from a floor writer is proposed, not placed",
    async run(given) {
      const h = helpers(given);
      await withPolicy(h, MAP, async () => {
        const before = await graderCalls(h);
        const r = await saveClaims(h, "bob", nm("e2e-au1 tomas rate"), "Tomas's rate goes up to 24 an hour from December.", [
          { kind: "state", subject: { name: "Tomas", actor: "person" }, class: "hires", attribute: "pay", value: 24 },
        ]);
        h.check(r.pendingId, `bob holds the floor, pay lies with the top: proposed, not written (${JSON.stringify(r).slice(0, 300)})`);
        const p = await pending(h, r.pendingId);
        h.check(p?.home === POS.org, `the proposal is homed at the authority position, for whoever holds it to review: ${JSON.stringify(p)}`);
        h.check(!(await h.entry(nm("e2e-au1 tomas rate"))), "nothing was placed");
        h.check((await graderCalls(h)) === before, "a claim-bearing write is never graded");
        await h.api(`/api/queue/${r.pendingId}/reject`, { method: "POST", body: "{}" });
      });
    },
  },
  {
    name: "authority: an order-quantity section with claims is placed at its origin with no grader call",
    async run(given) {
      const h = helpers(given);
      await withPolicy(h, MAP, async () => {
        const before = await graderCalls(h);
        const r = await saveClaims(h, "alice", nm("e2e-au2 exatron quantity"), "Exatron's repeat order is 1,200 pieces, due mid December.", [
          { kind: "commitment", subject: { key: "mssql:dbo_Job:3260357", class: "orders" }, attribute: "quantity", value: 1200, valid_until: "2026-12-15" },
        ]);
        h.check(!r.error && !r.pendingId, `alice holds Operations, which holds orders: written directly (${JSON.stringify(r).slice(0, 300)})`);
        const e = await h.entry(nm("e2e-au2 exatron quantity"));
        h.check(e?._home === POS.ops, `placed at its origin, got ${e?._home} (${e?._grade})`);
        h.check(/placed by its claims/.test(e?._grade ?? ""), `placed by the rule, not the grader: ${e?._grade}`);
        h.check(e?._authority === POS.ops, `the authority that placed it is recorded: ${e?._authority}`);
        h.check((await graderCalls(h)) === before, "no grader call for a section with claims");
      });
    },
  },
  {
    name: "authority: a free-text section still goes through the grader",
    async run(given) {
      const h = helpers(given);
      await withPolicy(h, MAP, async () => {
        const before = await graderCalls(h);
        await h.save("alice", nm("e2e-au3 fridge"), "The break room fridge gets cleaned Fridays.");
        const e = await h.entry(nm("e2e-au3 fridge"));
        h.check(e?._home === POS.ops, `graded and kept at its writer's position, got ${e?._home}`);
        h.check(/graded/.test(e?._grade ?? ""), `the grader's note: ${e?._grade}`);
        h.check((await graderCalls(h)) === before + 1, `one grader call for the residue, got ${(await graderCalls(h)) - before}`);
        await h.save("bob", nm("e2e-au3b floater pay"), "The floater crew's pay goes up next month. [admins]");
        h.check((await h.entry(nm("e2e-au3b floater pay")))?._home === POS.org, "and the restricted topics still restrict it");
      });
    },
  },
  {
    name: "authority: the batches' misgrades (ab05 quantity as money, ak06 payroll, aj10 review) come out as the oracle's authority says",
    async run(given) {
      const h = helpers(given);
      await withPolicy(h, MAP, async () => {
        const before = await graderCalls(h);
        // ab05: the grader once read an order quantity as money and restricted it; quantity is Ops's own
        const ab05 = await saveClaims(h, "alice", nm("e2e-ab05 exatron repeat order"), "Exatron placed the repeat order for job 3260357, 1,200 pieces, due mid December. Buy the 4140 bar before the December 1 price increase.", [
          { kind: "commitment", subject: { key: "mssql:dbo_Job:3260357", class: "customer order" }, attribute: "repeat_order", value: "1,200 pieces due mid December", valid_until: "2026-12-15" },
          { kind: "commitment", subject: { name: "4140 bar purchase", class: "purchase" }, attribute: "buy_before", value: "2026-12-01 price increase", valid_until: "2026-12-01" },
        ]);
        h.check(!ab05.error && !ab05.pendingId, `written directly: ${JSON.stringify(ab05).slice(0, 300)}`);
        h.check((await h.entry(nm("e2e-ab05 exatron repeat order")))?._home === POS.ops, "ab05 stays at Operations");
        // ak06: "payroll" the word is not pay the attribute; the schedule is Ops's policy
        const ak06 = await saveClaims(h, "alice", nm("e2e-ak06 payroll biweekly"), "Payroll switches to biweekly from January.", [
          { kind: "state", subject: { name: "payroll", class: "payroll schedule" }, attribute: "frequency", value: "biweekly", valid_from: "2027-01-01" },
        ]);
        h.check(!ak06.error && !ak06.pendingId, `written directly: ${JSON.stringify(ak06).slice(0, 300)}`);
        h.check((await h.entry(nm("e2e-ak06 payroll biweekly")))?._home === POS.ops, "ak06 stays at Operations");
        // no rule names these classes or attributes, so they are the grader's (decision 2); it leaves them at Operations
        h.check((await graderCalls(h)) === before + 2, `a claim with no rule goes to the grader, got ${(await graderCalls(h)) - before} calls`);
        // aj10: a person's review result is admins-only whoever writes it: alice proposes it to the top
        const aj10 = await saveClaims(h, "alice", nm("e2e-aj10 tomas review passed"), "Tomas passed his 90-day review early.", [
          { kind: "event", subject: { name: "Tomas Reyes", actor: "person" }, class: "review", attribute: "result", value: "passed 90-day review, early" },
        ]);
        h.check(aj10.pendingId, `proposed: ${JSON.stringify(aj10).slice(0, 300)}`);
        const p = await pending(h, aj10.pendingId);
        h.check(p?.home === POS.org, `homed at the top for review: ${JSON.stringify(p)}`);
        h.check(!(await h.entry(nm("e2e-aj10 tomas review passed"))), "not placed at Operations");
        const ok = await h.api(`/api/queue/${aj10.pendingId}/approve`, { method: "POST", body: "{}" });
        h.check(ok.result?.approved, `the admin approves it: ${JSON.stringify(ok).slice(0, 300)}`);
        h.check((await h.entry(nm("e2e-aj10 tomas review passed")))?._home === POS.org, "and it lands at the top, where the oracle has it");
      });
    },
  },
  {
    name: "B4: a claim with no matching rule goes to the grader: floor pay text with one pay claim, on an empty map",
    async run(given) {
      const h = helpers(given);
      await withPolicy(h, EMPTY, async () => {
        const before = await graderCalls(h);
        const name = nm("e2e-b4 bob raise");
        const r = await saveClaims(h, "bob", name, "Bob's pay is rising to 34.50 an hour. [admins]", [{ kind: "state", subject: { name: "Bob", actor: "person" }, class: "hires", attribute: "pay", value: 34.5 }]);
        h.check(!r.error && !r.pendingId, `no rule: bob's write isn't proposed: ${JSON.stringify(r).slice(0, 300)}`);
        const e = await h.entry(name);
        h.check(e?._home === POS.org, `the grader restricts it, as with claims: []; got ${e?._home} (${e?._grade})`);
        h.check((await graderCalls(h)) === before + 1, `one grader call, got ${(await graderCalls(h)) - before}`);
      });
    },
  },
  {
    name: "B4: a dummy claim is no way around the grader: pay text with an unrelated ruled claim",
    async run(given) {
      const h = helpers(given);
      await withPolicy(h, MAP, async () => {
        const name = nm("e2e-b4 dummy gauge");
        const r = await saveClaims(h, "bob", name, "Tomas's pay is rising to 34.50 an hour. [admins]", [{ kind: "state", subject: { name: "job 4471", class: "jobs" }, attribute: "gauge", value: "set" }]);
        h.check(!r.error && !r.pendingId, `jobs lies with the floor: written directly: ${JSON.stringify(r).slice(0, 300)}`);
        const e = await h.entry(name);
        h.check(e?._home === POS.org, `graded like the same text with claims: []; got ${e?._home} (${e?._grade})`);
        // a ruled claim the writer is below is still proposed by the rule, not placed by the grader
        const lifted = nm("e2e-b4 quantity floor");
        const p = await saveClaims(h, "bob", lifted, "Job 4471 was quiet today, nothing to report.", [{ kind: "state", subject: { name: "job 4471", class: "orders" }, attribute: "quantity", value: 40 }]);
        h.check(p.pendingId, `a quantity from the floor is still proposed by the rule: ${JSON.stringify(p).slice(0, 300)}`);
        await h.api(`/api/queue/${p.pendingId}/reject`, { method: "POST", body: "{}" });
      });
    },
  },
  {
    name: "B4: a misnamed attribute key in the policy is normalized and matches claims",
    async run(given) {
      const h = helpers(given);
      await withPolicy(h, { classes: {}, attributes: { "Pay Rate": POS.org } }, async () => {
        const stored = (await h.api("/api/policy")).policy?.authorityMap?.attributes ?? {};
        h.check(stored.pay_rate === POS.org && !stored["Pay Rate"], `stored as pay_rate: ${JSON.stringify(stored)}`);
        const r = await saveClaims(h, "bob", nm("e2e-b4 pay rate"), "Tomas's pay rate goes to 24.", [{ kind: "state", subject: { name: "Tomas", actor: "person" }, class: "hires", attribute: "pay_rate", value: 24 }]);
        h.check(r.pendingId, `the rule matches: bob proposes: ${JSON.stringify(r).slice(0, 300)}`);
        await h.api(`/api/queue/${r.pendingId}/reject`, { method: "POST", body: "{}" });
      });
    },
  },
  {
    name: "B5: a stale position in the stored map fails upward for that entry and never erases the map",
    async run(given) {
      const h = helpers(given);
      const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      await withPolicy(h, MAP, async () => {
        const row = (await h.sql("SELECT json FROM OrgPolicy WHERE scope = 'org' LIMIT 1"))[0];
        const stored = JSON.parse(row.json);
        stored.authorityMap.attributes.price = "hr"; // a position the tree no longer has
        const r = await h.tool("admin", "execute_graph", { language: "sql", command: `UPDATE OrgPolicy SET json = '${q(JSON.stringify(stored))}' WHERE scope = 'org'` });
        h.check(!r.error, `the stored row: ${JSON.stringify(r).slice(0, 200)}`);
        // the policy reloads every minute: the stale entry shows, and the rest of the map with it
        const view = await h.until("the stale entry shows in the policy", async () => {
          const p = (await h.api("/api/policy")).policy;
          return p?.authorityMap?.attributes?.price === "hr" && p.authorityMap.attributes.pay === POS.org ? p : null;
        }, 90_000);
        h.check(view.authorityMap.classes.jobs?.authority === POS.floor, `the rest of the map stands: ${JSON.stringify(view.authorityMap).slice(0, 300)}`);
        // the entry fails upward: bob proposes a price, homed at the top
        const price = await saveClaims(h, "bob", nm("e2e-b5 bracket price"), "The bracket price is 12.50.", [{ kind: "state", subject: { name: "bracket", class: "orders" }, attribute: "price", value: 12.5 }]);
        h.check(price.pendingId, `a price from the floor is proposed: ${JSON.stringify(price).slice(0, 300)}`);
        h.check((await pending(h, price.pendingId))?.home === POS.org, "the stale authority counts as the root");
        await h.api(`/api/queue/${price.pendingId}/reject`, { method: "POST", body: "{}" });
        // editing any setting doesn't persist an erased map, and the map can still be edited around the stale row
        const edited = await h.api("/api/policy", { method: "PUT", body: JSON.stringify({ maxGrantDays: 60 }) });
        h.check(edited.policy?.authorityMap?.attributes?.price === "hr", `another setting's edit keeps the map: ${JSON.stringify(edited).slice(0, 300)}`);
        await h.api("/api/policy", { method: "PUT", body: JSON.stringify({ maxGrantDays: 90 }) });
      });
    },
  },
];

export default scenarios;
