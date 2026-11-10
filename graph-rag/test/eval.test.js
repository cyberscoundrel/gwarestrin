// The real-model evaluation's own parts (graph-rag/eval/, docs/build/integrate.md): labels, records, the row
// gate, accounts, outcome matching, leaks, the tree, the check comparison and the report. Each measure is
// shown to pass a clean run and to fail a planted one, so a gate is known to have teeth.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STATED_NOTES, NOTES, accepted, checkLabels, labelCounts, ruleOutcome } from "../eval/labels.mjs";
import { batchOrder, makeMarkers, markerRecords, recordsFrom } from "../eval/records.mjs";
import { accountResults, diffDumps, rowGate } from "../eval/source.mjs";
import { matchNote, scoreOutcomes } from "../eval/outcomes.mjs";
import { classItems, markerHomes, scanLeaks, sectionItems, titleItems } from "../eval/leaks.mjs";
import { duplicateCandidates, foldName, placementSample, renderTree, stability } from "../eval/tree.mjs";
import { compareChecks, kappa } from "../eval/check.mjs";
import { buildReport, compareRuns } from "../eval/report.mjs";
import { POSITIONS, dataset, rowKey } from "../eval/s0.mjs";
import { sees, strictest, widest } from "../eval/positions.mjs";
import { validateDocument } from "../src/model/record.js";
import { normalizeEntry } from "../src/model/filing.js";

const oracle = JSON.parse(readFileSync(new URL("./fixtures/oracle-sixty.json", import.meta.url), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

test("labels: one per note, every table, column and key in the synthetic database, and each hand outcome equal to R2's rule", () => {
  assert.deepEqual(checkLabels(NOTES, oracle.map((n) => n.id)), []);
  const c = labelCounts();
  assert.deepEqual([c.filed, c.proposed, c.held, c.kept], [6, 6, 10, 53]);
  assert.equal(NOTES.length, 62);
});

test("labels: the rule gives Held for a missing row, Proposed without authority or a writable source, Filed otherwise", () => {
  const up = (key, columns) => ({ target: { kind: "row", table: key.split(":").slice(0, 2).join(":"), key, columns } });
  const create = (table, columns) => ({ target: { kind: "new-row", table, columns, needs: [] } });
  assert.equal(ruleOutcome(up("mssql:dbo_Work_Center:INSPECT-2", ["Status"]), "bob"), "filed"); // the floor holds the map's position
  assert.equal(ruleOutcome(up("mssql:dbo_Job:3260356", ["Status"]), "bob"), "filed"); // jobs are the floor's (M0)
  assert.equal(ruleOutcome(up("mssql:dbo_Sales_Order:51007", ["Status"]), "bob"), "proposed"); // orders are Operations'
  assert.equal(ruleOutcome(up("mssql:dbo_Sales_Order:51007", ["Status"]), "alice"), "filed");
  assert.equal(ruleOutcome(up("mssql:dbo_Employee:NGUD", ["Pay_Rate"]), "admin"), "proposed"); // Employee takes no writes
  assert.equal(ruleOutcome(create("mssql:dbo_Job", ["Customer"]), "alice"), "proposed"); // Job takes updates, not creates
  assert.equal(ruleOutcome(create("mssql:dbo_Maintenance", ["Description"]), "bob"), "filed");
  assert.equal(ruleOutcome(up("mssql:dbo_Job:9999", ["Status"]), "alice"), "held");
  // a different dataset changes the answer: the labels are checked against whatever the sources stream ships
  const d = dataset();
  d.dbo_Job.rows = d.dbo_Job.rows.filter((r) => r.Job !== 3260356);
  assert.ok(checkLabels(NOTES, null, { data: d }).some((p) => p.includes("ux-z01")));
});

test("labels, R12: a stated change is written given authority; a stated state the source disagrees with is Held", () => {
  assert.deepEqual(STATED_NOTES, ["ux-m01", "ux-t06", "ux-z01", "ux-z04", "ux-aa03", "ux-aa05", "ux-aa07", "ux-ab02", "ux-ac13", "ux-ag03", "ux-al04", "ux-aq07", "ux-au04"]);
  const piece = (id) => NOTES.find((n) => n.id === id).pieces[0];
  assert.deepEqual([piece("ux-m01").stated, piece("ux-m01").outcome], ["current", "held"]); // "INSPECT-2 is down": a state
  assert.deepEqual([piece("ux-t06").stated, piece("ux-t06").outcome], ["current", "held"]); // "needs certs": the row says none
  assert.deepEqual([piece("ux-z01").stated, piece("ux-z01").outcome], ["change", "filed"]); // "shipped Thursday": the floor's job
  assert.deepEqual([piece("ux-ag03").stated, piece("ux-ag03").outcome], ["already", "filed"]); // the row holds the order already
  assert.deepEqual(accepted(piece("ux-z01")), ["filed"]);
  const asChange = { ...piece("ux-m01"), stated: "change" };
  assert.equal(ruleOutcome(asChange, "alice"), "filed");
});

test("records: 62 valid documents in batch order, no note code in any title, later notes after earlier ones", () => {
  const recs = recordsFrom(oracle);
  assert.equal(recs.length, 62);
  for (const r of recs) {
    assert.deepEqual(validateDocument(r.document).errors, [], r.note);
    assert.doesNotMatch(r.document.title, /ux-/i);
  }
  assert.deepEqual(recs.filter((r) => /ux-/i.test(r.document.sections[0].text)).map((r) => r.note), ["ux-v02"]); // its own words cite ux-z03
  assert.deepEqual(batchOrder(oracle).slice(0, 4), ["ux-note", "ux-m", "ux-t", "ux-v"]);
  const at = (id) => recs.find((r) => r.note === id).document.recorded_at;
  for (const [a, b] of [["ux-ag03", "ux-aj02"], ["ux-aj02", "ux-ak03"], ["ux-ac13", "ux-ad15"], ["ux-aq12", "ux-ar02"], ["ux-am12", "ux-am15"]]) assert.ok(at(a) < at(b), `${a} before ${b}`);
  assert.equal(recs.find((r) => r.note === "ux-m03").document.position, "ops");
});

test("markers: distinct made-up words, the same for the same seed, in none of the notes", () => {
  const all = oracle.map((n) => n.text).join(" ");
  const a = makeMarkers(20, 7, all);
  assert.equal(new Set(a).size, 20);
  assert.deepEqual(makeMarkers(20, 7, all), a);
  assert.notDeepEqual(makeMarkers(20, 8, all), a);
  for (const w of a) assert.ok(!all.toLowerCase().includes(w));
  const { records, markers } = markerRecords(3, { avoid: all });
  assert.equal(markers.length, 8);
  for (const r of records) assert.deepEqual(validateDocument(r.document).errors, []);
  for (const m of markers) {
    const doc = records.find((r) => r.note === m.record).document;
    assert.ok((m.title ? doc.title : doc.sections[m.section].text).includes(m.word), m.word);
    assert.equal(m.floor, doc.position, "each marker's floor is its recorder's position, from the record, not the graph");
  }
  assert.equal(markers.filter((m) => m.title).length, 1);
});

test("positions: a holder sees its home and below, and everyone; strictest is nearest the root, widest is everyone or the deepest", () => {
  assert.ok(sees(POSITIONS, "org", "floor"));
  assert.ok(sees(POSITIONS, "ops", "ops"));
  assert.ok(!sees(POSITIONS, "floor", "ops"));
  assert.ok(sees(POSITIONS, "floor", "everyone"));
  assert.equal(strictest(POSITIONS, ["everyone", "ops", "floor"]), "ops");
  assert.equal(strictest(POSITIONS, ["floor", "org"]), "org");
  assert.equal(strictest(POSITIONS, ["everyone", "org"]), "org");
  assert.equal(widest(POSITIONS, ["ops", "floor"]), "floor");
  assert.equal(widest(POSITIONS, ["org", "everyone"]), "everyone");
});

/** a filing entry as the contract takes it: a Filed piece names its class and carries an account, a Kept one its instances (model/filing.js) */
const entry = (over) => {
  const outcome = over.outcome ?? "kept";
  const contract = outcome === "filed" ? { class: "job", account: "wrote it" } : outcome === "kept" ? { instances: ["#9:9"] } : {};
  return normalizeEntry({ id: over.id ?? "e1", outcome, record: "#1:0", section: "#2:0", home: "ops", piece: "p", recorder: "alice", worker: "w", ...contract, ...over });
};

test("row gate: a change with a Filed entry naming its columns passes; any other change, or a delete, fails", () => {
  const before = dataset();
  const after = clone(before);
  after.dbo_Work_Center.rows.find((r) => r.Work_Center === "INSPECT-2").Status = "Down";
  after.dbo_Job.rows.push({ Job: "3260500", Customer: "EXATRON", Part_Number: "EPP-D98-2-B", Order_Quantity: 1200 });
  const changes = diffDumps(before, after);
  assert.deepEqual(changes.map((c) => [c.kind, c.key]), [["created", "mssql:dbo_Job:3260500"], ["updated", "mssql:dbo_Work_Center:INSPECT-2"]]);
  const filed = [
    entry({ id: "a", outcome: "filed", target: { table: "mssql:dbo_Work_Center", key: "mssql:dbo_Work_Center:INSPECT-2", fields: { Status: "Down" } } }),
    entry({ id: "b", outcome: "filed", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:3260500", fields: { Customer: "EXATRON", Part_Number: "EPP-D98-2-B", Order_Quantity: 1200 } } }),
  ];
  assert.equal(rowGate(changes, filed).ok, true);
  assert.equal(rowGate(changes, filed.slice(0, 1)).ok, false); // the created job has no entry
  const proposedOnly = [entry({ id: "c", outcome: "proposed", reason: "no authority", target: { table: "mssql:dbo_Work_Center", key: "mssql:dbo_Work_Center:INSPECT-2" } })];
  assert.equal(rowGate(changes, proposedOnly).ok, false); // a Proposed piece must change nothing
  const more = clone(after);
  more.dbo_Work_Center.rows.find((r) => r.Work_Center === "INSPECT-2").Description = "x";
  assert.match(rowGate(diffDumps(before, more), filed).violations[0].why, /Description/);
  const gone = clone(before);
  gone.dbo_Job.rows.pop();
  assert.equal(rowGate(diffDumps(before, gone), filed).violations[0].why, "a row was deleted");
});

test("accounts: true, false claim and wrong values against the diff; caught, missed and false alarm from the verdicts", () => {
  const before = dataset();
  const after = clone(before);
  after.dbo_Work_Center.rows.find((r) => r.Work_Center === "INSPECT-2").Status = "Down";
  const changes = diffDumps(before, after);
  const v = (result) => ({ result, by: "orchestrator" });
  const es = [
    entry({ id: "t", outcome: "filed", target: { table: "mssql:dbo_Work_Center", key: "mssql:dbo_Work_Center:INSPECT-2", fields: { Status: "Down" } }, account: "set INSPECT-2 down", verdict: v("matches") }),
    entry({ id: "f", outcome: "filed", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:4471", fields: { Status: "Rush" } }, account: "rushed 4471", verdict: v("differs") }),
    entry({ id: "w", outcome: "filed", target: { table: "mssql:dbo_Work_Center", key: "mssql:dbo_Work_Center:INSPECT-2", fields: { Status: "Up" } }, account: "x", verdict: v("matches") }),
    entry({ id: "a", outcome: "filed", target: { table: "mssql:dbo_Work_Center", key: "mssql:dbo_Work_Center:INSPECT-2", fields: { Status: "Down" } }, account: "x", verdict: v("differs") }),
  ];
  const r = accountResults(changes, es);
  assert.deepEqual(r.items.map((i) => [i.entry, i.result, i.check]), [["t", "true", "agreed"], ["f", "false-claim", "caught"], ["w", "wrong-values", "missed"], ["a", "true", "false-alarm"]]);
  const same = accountResults(changes, [entry({ id: "s", outcome: "filed", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:4471", fields: { Status: "Active" } }, account: "set 4471 to Active" })], { before });
  assert.deepEqual([same.items[0].result, same.items[0].saysRow], ["true", true], "a write of the value the row held is true, not a false claim");
  const bare = accountResults(changes, [entry({ id: "n", outcome: "filed", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:4471" }, account: "did it" })], { before });
  assert.deepEqual([bare.items[0].result, bare.items[0].saysRow], ["unverifiable", false], "no fields: nothing to check, and the words don't name the row");
  const after2 = clone(after);
  after2.dbo_Job.rows.find((r) => r.Job === 3260356).Status = "Hold";
  assert.deepEqual(accountResults(diffDumps(before, after2), es.slice(0, 1)).omitted, ["mssql:dbo_Job:3260356"]);
});

/** a log a perfect worker would write for the labels: used only to show the scorer scores it perfect */
function perfectLog(notes) {
  const entries = [];
  const noteOf = {};
  notes.forEach((n, i) => {
    const rec = `#10:${i}`;
    noteOf[rec] = n.id;
    n.pieces.forEach((p, j) => {
      const t = p.target;
      const target = t.kind === "row" ? { table: t.table, key: t.key, fields: Object.fromEntries(t.columns.map((c) => [c, "v"])) } : t.kind === "new-row" ? { table: t.table, key: p.outcome === "filed" ? `${t.table}:new${i}` : null } : t.kind === "unclear" ? { table: "mssql:dbo_Job" } : null;
      entries.push(entry({ id: `${i}.${j}`, record: rec, outcome: p.outcome, target, question: p.outcome === "held" ? "which?" : undefined, reason: p.outcome === "proposed" ? "no authority" : undefined }));
    });
  });
  return { entries, noteOf };
}

test("outcomes: a perfect log scores every piece exact; a swapped outcome is wrong, on the rule or the target", () => {
  const { entries, noteOf } = perfectLog(NOTES);
  const s = scoreOutcomes(NOTES, entries, { noteOf: (r) => noteOf[r] });
  assert.equal(s.totals.exact, s.totals.pieces);
  assert.equal(s.totals.wrong + s.totals.missing + s.totals.extra, 0);
  const z01 = NOTES.find((n) => n.id === "ux-z01");
  const asKept = matchNote(z01, [entry({ id: "k1", outcome: "kept" }), entry({ id: "k2", outcome: "kept" })]);
  assert.deepEqual(asKept.pieces.map((p) => [p.verdict, p.failure]), [["wrong", "target"], ["exact", null]]);
  const proposedOnly = matchNote(z01, [entry({ id: "p", outcome: "proposed", reason: "no authority", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:3260356", fields: { Status: "Shipped" } } })]);
  assert.deepEqual([proposedOnly.pieces[0].verdict, proposedOnly.pieces[0].failure, proposedOnly.pieces[1].verdict], ["wrong", "rule", "missing"]);
  const m01 = NOTES.find((n) => n.id === "ux-m01");
  const wroteState = matchNote(m01, [entry({ id: "w", outcome: "filed", target: { table: "mssql:dbo_Work_Center", key: "mssql:dbo_Work_Center:INSPECT-2", fields: { Status: "Down" } } })]);
  assert.deepEqual([wroteState.pieces[0].verdict, wroteState.pieces[0].failure], ["wrong", "rule"]); // R12: a state is asked about, not written
});

test("outcomes: must-not lines catch a change, a write to a table, a link to the wrong row, and a mint", () => {
  const n = NOTES.filter((x) => ["ux-aa07", "ux-z04", "ux-w11"].includes(x.id));
  const info = new Map([["#5:1", { key: "mssql:dbo_Employee:NGDT", name: "Diep Ngo" }]]);
  const entries = [entry({ id: "x", record: "#10:0", outcome: "kept", instances: ["#5:1"] })];
  const changes = [{ key: "mssql:dbo_Job:4471", kind: "updated", columns: ["Status"] }];
  const noteOf = (r) => ({ "#10:0": "ux-aa07", "#10:1": "ux-z04", "#10:2": "ux-aj09" })[r];
  const about = new Map([["#10:1", ["#5:2"]], ["#10:2", ["#5:3", "#5:4"]]]);
  const instances = [{ rid: "#5:2", name: "ux-z04" }, { rid: "#5:3", name: "Retired pin gauge set" }, { rid: "#5:4", name: "forklift" }, { rid: "#5:9", name: "spare tire" }];
  const notes = [...n, NOTES.find((x) => x.id === "ux-aj09")];
  const s = scoreOutcomes(notes, entries, { noteOf, info, changes, instances, about });
  const rules = s.mustNot.map((m) => `${m.note} ${m.rule}`);
  assert.ok(rules.includes("ux-aa07 linked mssql:dbo_Employee:NGDT"));
  assert.ok(rules.includes('ux-z04 minted "ux-z04"'), "an instance one of its own sections is about");
  assert.ok(rules.includes("ux-w11 changed mssql:dbo_Job:4471 (no Filed entry accounts for it)"));
  // another note's Filed write to the row is not this note's wrong action (ux-z01 writes 3260356; note 13 must not)
  const z01 = entry({ id: "z", record: "#10:9", outcome: "filed", target: { table: "mssql:dbo_Job", key: "mssql:dbo_Job:3260356", fields: { Status: "Shipped" } } });
  const both = scoreOutcomes(NOTES.filter((x) => ["ux-note 13", "ux-z01"].includes(x.id)), [z01], { noteOf: (r) => (r === "#10:9" ? "ux-z01" : null), changes: [{ key: "mssql:dbo_Job:3260356", kind: "updated", columns: ["Status"] }] });
  assert.deepEqual(both.mustNot, [], "z01's legitimate write is nobody's wrong action");
  assert.ok(!rules.some((r) => r.includes("Retired")), "a whole word: 'tire' isn't in 'Retired'");
  assert.ok(!rules.some((r) => r.includes("spare tire")), "an instance no section of the note is about doesn't count against it");
});

test("leaks: a marker's home is its labelled floor, or stricter where stored so; a marker above an audience is a leak", () => {
  const holders = [{ rid: "#3:1", record: "#1:1", home: "ops", text: "Moving to Vraexind Metals" }, { rid: "#3:2", record: "#1:2", home: "floor", text: "Back to Glouzzarn" }, { rid: "#3:3", record: "#1:3", home: "org", text: "Plimbex pay" }];
  const homes = markerHomes([
    { word: "Vraexind", record: "marker-3", recordId: "#1:1", floor: "ops" },
    { word: "Glouzzarn", record: "marker-5", recordId: "#1:2", floor: "floor" },
    { word: "Plimbex", record: "marker-4", recordId: "#1:3", floor: "ops", expect: "org" }, // the check raised it
    { word: "Neverlanded", record: "marker-9", recordId: "#1:9", floor: "ops" },
  ], holders, POSITIONS);
  assert.deepEqual(homes.map((h) => h.home), ["ops", "floor", "org", "ops"]);
  assert.deepEqual(homes.map((h) => h.untested), [false, false, false, true]);
  const items = [
    { where: "brief:b1", audience: "floor", text: "... VRAEXINDmetals ..." },
    { where: "brief:b2", audience: "ops", text: "Glouzzarn and Vraexind" },
    { where: "brief:b3", audience: "ops", text: "Plimbex" }, // raised to org: now a leak at ops
    { where: "entry:e1", audience: null, text: "Glouzzarn" },
    { where: "brief:b4", audience: "floor", text: "neverlanded" }, // never stored, but its floor still counts
  ];
  const r = scanLeaks(items, homes, POSITIONS, { briefs: 4 });
  assert.deepEqual(r.leaks.map((l) => [l.where, l.word]), [["brief:b1", "Vraexind"], ["brief:b3", "Plimbex"], ["entry:e1", "Glouzzarn"], ["brief:b4", "Neverlanded"]]);
  assert.deepEqual(r.untested, ["Neverlanded"]);
  assert.equal(r.ok, false);
});

test("leaks, the reviewer's probe: an org-recorded section the system stored at the floor, carried in a floor brief, fails the gate", () => {
  const holders = [{ rid: "#3:7", record: "#1:7", home: "floor", text: "Talks to buy Skarnex Machining" }];
  const homes = markerHomes([{ word: "Skarnex", record: "marker-1", recordId: "#1:7", floor: "org" }], holders, POSITIONS);
  assert.deepEqual([homes[0].home, homes[0].stored, homes[0].misplaced], ["org", "floor", true], "the label's floor, not the stored home");
  const r = scanLeaks([{ where: "brief:f1", audience: "floor", text: "context: Skarnex machining" }, ...sectionItems(holders)], homes, POSITIONS, { briefs: 1 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.leaks.map((l) => l.where), ["brief:f1", "section:#3:7"]);
  assert.deepEqual(r.misplaced, [{ word: "Skarnex", record: "marker-1", stored: "floor", floor: "org" }]);
});

test("leaks: a gate with nothing to check fails: no briefs, no markers, or a marker never stored", () => {
  const holders = [{ rid: "#3:1", record: "#1:1", home: "ops", text: "Vraexind" }];
  const homes = markerHomes([{ word: "Vraexind", record: "marker-3", recordId: "#1:1", floor: "ops" }], holders, POSITIONS);
  const none = scanLeaks([], homes, POSITIONS, { briefs: 0 });
  assert.equal(none.ok, false);
  assert.match(none.reasons.join(), /no briefs to scan/);
  assert.equal(scanLeaks([{ where: "brief:b", audience: "ops", text: "x" }], [], POSITIONS, { briefs: 1 }).ok, false);
  assert.equal(scanLeaks([{ where: "brief:b", audience: "ops", text: "x" }], homes, POSITIONS, { briefs: 1 }).ok, true);
  assert.throws(() => markerHomes([{ word: "W", record: "r" }], holders, POSITIONS), /no labelled floor/);
});

test("leaks: titles and classes are scanned at their homes", () => {
  const homes = markerHomes([{ word: "Thalvex", record: "marker-1", recordId: "#1:1", floor: "org" }], [{ rid: "#1:1", record: "#1:1", home: "org", text: "Thalvex acquisition talks" }], POSITIONS);
  const r = scanLeaks([...titleItems([{ rid: "#1:1", home: "org", title: "Thalvex acquisition talks" }]), ...classItems([{ key: "thalvex_deal", name: "Thalvex deal", home: "everyone", evidence: [] }])], homes, POSITIONS, { briefs: 1 });
  assert.deepEqual(r.leaks.map((l) => l.where), ["class:thalvex_deal"]);
});

const cls = (key, parents, extra = {}) => ({ key, name: key.replace(/_/g, " "), parents, home: "everyone", evidence: [], rows_are_nodes: false, record_table: null, status: "active", ...extra });
const roots = ["agent", "commitment", "event", "resource"].map((k) => cls(k, []));

test("tree: every class under each parent, the multi-parent one marked; orphans listed", () => {
  const classes = [...roots, cls("employee", ["agent"], { record_table: "mssql:dbo_Employee" }), cls("machine", ["resource"]), cls("leased_building", ["resource"]), cls("warehouse", ["leased_building", "resource"]), cls("lost", ["nowhere"])];
  const md = renderTree(classes, { employee: 4 });
  assert.match(md, /\*\*warehouse\*\*.*also under resource/);
  assert.match(md, /\*\*warehouse\*\* \(again\)/);
  assert.match(md, /employee\*\* \| everyone \| 4 \| no \| mssql:dbo_Employee/);
  assert.match(md, /reach no root:\n\n- lost/);
});

test("tree: stability across runs; duplicates by name, table or shared instances; placements flag the inactive row", () => {
  const r1 = [...roots, cls("employee", ["agent"], { record_table: "mssql:dbo_Employee" }), cls("machine", ["resource"])];
  const r2 = [...roots, cls("employees", ["agent"], { key: "employees" }), cls("machine", ["resource"])];
  const r3 = [...roots, cls("staff", ["agent"], { record_table: "mssql:dbo_Employee" }), cls("vehicle", ["resource"])];
  const st = stability([r1, r2, r3]);
  assert.equal(foldName("Employees"), "employee");
  assert.equal(st.inAll, 1); // employee / employees / staff (by table)
  assert.deepEqual(st.onlyOne, ["vehicle"]);
  const d = duplicateCandidates([...roots, cls("customer_order", ["commitment"]), cls("customer_orders", ["commitment"]), cls("job", ["commitment"], { record_table: "mssql:dbo_Job" }), cls("work_order", ["commitment"], { record_table: "mssql:dbo_Job" })]);
  assert.deepEqual(d.map((x) => [x.a, x.b]), [["customer_order", "customer_orders"], ["job", "work_order"]]);
  const rows = new Map();
  const data = dataset();
  for (const [t, v] of Object.entries(data)) for (const r of v.rows) rows.set(rowKey(t, v.primaryKey, r), r);
  const classes = [...roots, cls("employee", ["agent"], { record_table: "mssql:dbo_Employee" })];
  const p = placementSample([{ rid: "#1", name: "Diep", key: "mssql:dbo_Employee:NGDT", classes: ["employee"] }, { rid: "#2", name: "Diep", key: "mssql:dbo_Employee:NGUD", classes: ["employee"] }], classes, rows);
  assert.deepEqual(p.sample.find((s) => s.rid === "#1").problems, ["row mssql:dbo_Employee:NGDT is inactive"]);
  assert.deepEqual(p.sample.find((s) => s.rid === "#2").problems, []);
});

test("check: agreement and kappa on the modal level, unsure rate, and stability across repeats", () => {
  assert.equal(kappa([["a", "a"], ["b", "b"]]), 1);
  const ans = (model, section, run, level, unsure = false) => ({ model, section, run, level, unsure, answered: level !== null, probs: { [level ?? "none"]: 0.8 } });
  const a = [ans("A", "s1", 1, "ops"), ans("A", "s1", 2, "ops"), ans("A", "s2", 1, "org", true), ans("A", "s2", 2, "ops")];
  const b = [ans("B", "s1", 1, "ops"), ans("B", "s2", 1, "org"), ans("B", "s2", 2, null)];
  const c = compareChecks(a, b);
  assert.equal(c.compared, 2);
  assert.equal(c.a.stability, 0.5);
  assert.equal(c.a.unsureRate, 0.25);
  assert.equal(c.b.unanswered, 1);
});

test("report: a clean snapshot passes both gates; a planted row change or a leaked marker fails them", () => {
  const { entries, noteOf } = perfectLog(NOTES.slice(0, 3));
  const before = dataset();
  const after = clone(before);
  const snap = {
    meta: { setup: "fake", run: 1, seed: 1, noteOf, markers: [{ word: "Vraexind", record: "marker-3", recordId: "#1:9", floor: "ops" }] },
    positions: POSITIONS,
    before,
    after,
    entries: entries.filter((e) => e.outcome !== "filed"),
    requests: [],
    briefs: [{ id: "b1", audience: "floor", text: "a brief for the floor" }],
    classes: roots,
    instances: [],
    sections: [{ rid: "#3:9", record: "#1:9", home: "ops", text: "Moving to Vraexind Metals" }],
    about: {},
  };
  const ok = buildReport(snap, { notes: NOTES.slice(0, 3) });
  assert.deepEqual(ok.gates, { rows: true, leaks: true, ok: true });
  assert.match(ok.markdown, /Gates.*PASS.*PASS/);
  assert.equal(buildReport({ ...snap, briefs: [] }, { notes: NOTES.slice(0, 3) }).gates.leaks, false, "no briefs: the gate fails, it doesn't pass");
  after.dbo_Job.rows.find((r) => r.Job === 4471).Status = "Rush";
  snap.briefs.push({ id: "b2", audience: "floor", text: "context: vraexind metals" });
  const bad = buildReport(snap, { notes: NOTES.slice(0, 3) });
  assert.deepEqual(bad.gates, { rows: false, leaks: false, ok: false });
  assert.match(bad.markdown, /row mssql:dbo_Job:4471 \(updated\): no Filed entry/);
  assert.match(bad.markdown, /leak: "Vraexind" \(home ops\) in brief:b2, seen by floor/);
  const cmp = compareRuns([{ report: ok, classes: roots }, { report: bad, classes: roots }]);
  assert.match(cmp.markdown, /\| fake \| 2 \| FAIL \|/);
});

test("seed guard: only the synthetic test database (server, database and write login) is a seeding target", async () => {
  const { assertSeedTarget, SYNTHETIC_WRITE, HARNESS_FAKE } = await import("../eval/dump.mjs");
  const src = (live, extra = {}) => ({ sources: [{ system: "mssql", writable: true, declared: null, live: { ok: true, status: "ok", ...live }, ...extra }] });
  assert.equal(assertSeedTarget(src(SYNTHETIC_WRITE)).length, 1);
  assert.equal(assertSeedTarget(src({ ...SYNTHETIC_WRITE, server: SYNTHETIC_WRITE.server.toUpperCase() })).length, 1, "case doesn't matter");
  // the reviewer's probe: a target whose declared guard is some other database passes graph-rag's own guard
  assert.throws(() => assertSeedTarget(src({ server: "mssql-server", database: "ErpLive", login: "erp_write" })), /refusing to seed: mssql writes into mssql-server\/ErpLive/);
  assert.throws(() => assertSeedTarget(src({ ...SYNTHETIC_WRITE, login: "sa" })), /as sa, not the synthetic test database/, "the login counts even where no login is declared");
  assert.throws(() => assertSeedTarget({ sources: [{ system: "mssql", writable: false }] }), /declares no write source/);
  assert.throws(() => assertSeedTarget(src({ ok: false, why: "no guard is declared" })), /guard didn't pass \(no guard is declared\)/);
  assert.throws(() => assertSeedTarget(src(HARNESS_FAKE)), /not the synthetic test database/, "the harness's fake only with --harness");
  assert.equal(assertSeedTarget(src(HARNESS_FAKE), { harness: true }).length, 1);
  assert.throws(() => assertSeedTarget(src(SYNTHETIC_WRITE), { harness: true }), /not the harness's fake/);
  // one good source and one other: refused
  assert.throws(() => assertSeedTarget({ sources: [...src(SYNTHETIC_WRITE).sources, ...src({ server: "tcmautomation", database: "Tcm", login: "w" }).sources] }), /tcmautomation/);
});

test("seed guard, end to end: make-records.mjs seed refuses a target that isn't the test database, and sends no record", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SYNTHETIC_WRITE } = await import("../eval/dump.mjs");
  const run = async (live) => {
    const calls = [];
    const server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/sources/guard") return res.end(JSON.stringify({ sources: [{ system: "mssql", writable: true, live: { ok: true, status: "ok", ...live } }] }));
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] } }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const dir = mkdtempSync(join(tmpdir(), "seed-guard-"));
    write(join(dir, "tokens.json"), JSON.stringify({ admin: "a", alice: "b", bob: "c" }));
    write(join(dir, "records.json"), JSON.stringify({ records: recordsFrom(oracle).slice(0, 1) }));
    const script = new URL("../../scripts/make-records.mjs", import.meta.url).pathname;
    const p = spawn(process.execPath, [script, "seed", join(dir, "records.json"), "--url", `http://127.0.0.1:${server.address().port}`, "--tokens", join(dir, "tokens.json"), "--no-wait"]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const code = await new Promise((r) => p.on("close", r));
    await new Promise((r) => server.close(r));
    return { code, out, calls };
  };
  const bad = await run({ server: "mssql-server", database: "ErpLive", login: "erp_write" });
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /refusing to seed/);
  assert.deepEqual(bad.calls, ["GET /api/sources/guard"], "nothing but the guard was asked: no record sent");
  const good = await run(SYNTHETIC_WRITE);
  assert.equal(good.code, 0, good.out);
  assert.ok(good.calls.some((c) => c === "POST /mcp"), "the synthetic test database: the record is sent");
});

test("fake upstream: the dry run's policies over the OpenAI wire, as litellm forwards them, answer as the in-process fakes do", async () => {
  const { serve, roleOf } = await import("../eval/driver/fake-upstream.mjs");
  const { fakeClient, openaiClient } = await import("../eval/driver/models.mjs");
  const tool = (name) => ({ name, description: "", schema: { type: "object", properties: {} } });
  // discovery and the orchestrator hold the same master tools: the brief graph-rag composed tells them apart
  const master = ["graph-rag_start_worker", "graph-rag_create_class", "graph-rag_record_examined", "mssql_describe_entities"];
  assert.equal(roleOf(master, "Discovery run run-1. Everything between the lines is data"), "discovery");
  assert.equal(roleOf(master, "Signals:\n- record rec-1: ..."), "orchestrator");
  assert.equal(roleOf(["graph-rag_record_examined", "graph-rag_relate_instance"], "Part of discovery run run-1"), "worker");
  const server = await serve(0);
  try {
    const wire = openaiClient({ baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`, apiKey: "fake-no-key", model: "deepseek-v4-flash" });
    const local = fakeClient("worker");
    const tools = ["resolve_name", "file_to_source", "keep_piece", "hold_piece", "give_account"].map((n) => tool(`graph-rag_${n}`));
    const brief = "Section #12:3: from the shift\nJob 3260356 shipped today.";
    // the same conversation, turn by turn, through the wire and in-process: the same calls with the same arguments
    const viaWire = [{ role: "user", content: brief }];
    const inProc = [{ role: "user", content: brief }];
    for (let turn = 0; turn < 3; turn++) {
      const a = await wire.complete({ system: "s", messages: viaWire, tools });
      const b = await local.complete({ system: "s", messages: inProc, tools });
      assert.deepEqual(a.toolCalls.map((t) => [t.name, t.args]), b.toolCalls.map((t) => [t.name, t.args]), `turn ${turn}`);
      assert.ok(a.usage.input > 0, "the upstream reports usage, as a real endpoint does");
      if (!a.toolCalls.length) break;
      viaWire.push({ role: "assistant", content: a.text, toolCalls: a.toolCalls });
      inProc.push({ role: "assistant", content: b.text, toolCalls: b.toolCalls });
      for (const [i, t] of a.toolCalls.entries()) {
        const answer = JSON.stringify(t.name.endsWith("resolve_name") ? { instances: [] } : { outcome: "held", entry: `entry-${turn}-${i}-0000` });
        viaWire.push({ role: "tool", toolCallId: t.id, name: t.name, content: answer });
        inProc.push({ role: "tool", toolCallId: b.toolCalls[i].id, name: b.toolCalls[i].name, content: answer });
      }
    }
    assert.ok(viaWire.some((m) => m.toolCalls?.some((t) => t.name === "graph-rag_give_account")), "the wire conversation reaches the account");
  } finally {
    server.close();
  }
});
