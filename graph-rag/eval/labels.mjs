// The 62 notes' expected filing outcomes (docs/build/integrate.md, section 3), from the notes' words and the
// rulings only, against the synthetic test database (test-sql/data.mjs, via s0.mjs). Two layers: where each piece
// goes, by hand (`target`), and the outcome, also written by hand (`outcome`) and recomputed by R2's table and R12
// under that database and M0 (`ruleOutcome`); test/eval.test.js holds the two equal, so a hand label that
// disagrees with the rule has to say why (`override`).
//
// These are one person's reading (the integrator's) of the notes under the rulings, not an acceptance standard:
// R9 retired the 62-note oracle as one, and nothing here has a pass mark. A run is compared with them to see what
// happens, and where a model disagrees the label may be the one that is wrong.
// The labels assume no person approves a Proposed piece during the run.
//
// A piece:
//   { about, target, outcome, accept?, stated?, unheld?, override? }
//   target: { kind: "doc" }                                  Kept: no system holds it
//           { kind: "unclear", why }                         Held: which record, or the source disagrees
//           { kind: "row", table, key, columns }             an existing row's columns
//           { kind: "new-row", table, columns, needs? }      a new row; `needs` are keys it refers to
// A note:
//   { id, recorder, pieces, resolves?, mustNot? }
//   resolves: instance keys (system:table:row) or names the sections should be about
//   mustNot:  { write: table } | { link: key } | { mint: word } | { change: key }
//
// R12 (ruled 2026-11-10): stated changes are written. A row piece says `stated: "change"` (the record says
// something changed: an update or a new row, Filed given authority), `stated: "current"` (it describes the current
// state and the source disagrees, without saying anything changed: Held, and the worker asks the recorder), or
// `stated: "already"` (it states what the row already holds: nothing to write, Filed with nothing sent, as the
// sources stream's adapter settles an unchanged write). Reading which a note is, is the integrator's (I-12).
// Item 5 (not ruled): a person or organization the source doesn't hold. Pieces marked `unheld` accept both a
// new instance with Kept and a Held question, and the report says which one each model chose.
import { atOrAbove } from "./positions.mjs";
import { COMMIT, MAP, PEOPLE, POSITIONS, SYSTEM, dataset, rowKey } from "./s0.mjs";

const T = (t) => `${SYSTEM}:dbo_${t}`;
const KEY = (t, row) => `${SYSTEM}:dbo_${t}:${row}`;

const K = (about, extra = {}) => ({ about, target: { kind: "doc" }, outcome: "kept", ...extra });
const H = (about, why, extra = {}) => ({ about, target: { kind: "unclear", why }, outcome: "held", ...extra });
const U = (about, t, row, columns, outcome, extra = {}) => ({ about, target: { kind: "row", table: T(t), key: KEY(t, row), columns }, outcome, ...extra });
const C = (about, t, columns, needs, outcome, extra = {}) => ({ about, target: { kind: "new-row", table: T(t), columns, needs }, outcome, ...extra });
/** item 5: also accepts a Held question to the recorder, and the report says which was chosen */
const UNHELD = { accept: ["held"], unheld: true };
const CHANGE = { stated: "change" };
const CURRENT = { stated: "current" };
const ALREADY = { stated: "already" };
const also = (...outcomes) => ({ accept: outcomes });

export const NOTES = [
  { id: "ux-note 13", recorder: "alice", pieces: [K("job 3260356 probably slips a week; the inspect backlog (dependency 3260356 -> INSPECT-2)")], resolves: [KEY("Job", "3260356"), KEY("Work_Center", "INSPECT-2"), KEY("Customer", "EXATRON"), KEY("Employee", "ALEXR")], mustNot: [{ change: KEY("Job", "3260356") }, { mint: "78912" }] },
  { id: "ux-note 14", recorder: "bob", pieces: [K("Exatron wants the next EPP-D98-2-B batch earlier (a need)"), K("Darrin S. is checking material (a task)", UNHELD)], resolves: [KEY("Customer", "EXATRON"), KEY("Material", "EPP-D98-2-B")], mustNot: [{ change: KEY("Job", "3260357") }, { change: KEY("Job", "3260410") }] },
  { id: "ux-m01", recorder: "alice", pieces: [U("INSPECT-2 is down (a state the source disagrees with, not a stated change)", "Work_Center", "INSPECT-2", ["Status"], "held", CURRENT), H("which EPP-D98 jobs wait (3260356 and 3260410 have INSPECT-2 still to do)", "the note names a part, not a job", also("kept"))], resolves: [KEY("Work_Center", "INSPECT-2"), KEY("Customer", "EXATRON"), KEY("Employee", "LUCASP")], mustNot: [{ change: KEY("Work_Center", "INSPECT-2") }] },
  { id: "ux-m03", recorder: "alice", pieces: [K("stop quoting Aetrium below cost (a recommendation)")], resolves: [KEY("Customer", "AETRIUM"), KEY("Employee", "KARLM")], mustNot: [{ write: T("Job") }, { write: T("Sales_Order") }] },
  { id: "ux-t01", recorder: "alice", pieces: [K("the break room fridge is cleaned Fridays at 3pm")] },
  { id: "ux-t02", recorder: "bob", pieces: [K("the holiday party is December 19 at noon")] },
  { id: "ux-t03", recorder: "alice", pieces: [K("ask John F. about the assembly fixtures (a task)")], resolves: [KEY("Employee", "FRAJ")], mustNot: [{ link: KEY("Employee", "NGUD") }, { link: KEY("Employee", "LOWB") }] },
  { id: "ux-t06", recorder: "bob", pieces: [U("job 3260372 needs certs with its shipment (the row says none: a state, not a stated change)", "Job", "3260372", ["Certs_Required"], "held", CURRENT)], resolves: [KEY("Job", "3260372"), KEY("Customer", "BSE")], mustNot: [{ change: KEY("Job", "3260372") }] },
  { id: "ux-t07", recorder: "alice", pieces: [K("should Cohu's prices rise; thin margins (a question)")], resolves: [KEY("Customer", "COHU-CA")], mustNot: [{ write: T("Job") }] },
  { id: "ux-t22", recorder: "bob", pieces: [K("late cryo-optic parts across customers; inspection scheduling (a class-level question)")], mustNot: [{ mint: "inspection step" }] },
  { id: "ux-v02", recorder: "bob", pieces: [K("John Henry Foster quoted $1,840 a year for compressor service")], resolves: [KEY("Vendor", "JOHNH")], mustNot: [{ mint: "ux-z03" }, { write: T("Purchase_Order") }] },
  { id: "ux-w05", recorder: "alice", pieces: [K("Lucas is on Saturday overtime for the Exatron backlog")], resolves: [KEY("Employee", "LUCASP"), KEY("Customer", "EXATRON")], mustNot: [{ link: KEY("Employee", "NGUD") }] },
  { id: "ux-w11", recorder: "alice", pieces: [K("Toro asks to rush 4471 ahead of BSE (a need, not granted)", also("held"))], resolves: [KEY("Job", "4471"), KEY("Customer", "TORO"), KEY("Sales_Order", "51007")], mustNot: [{ change: KEY("Job", "4471") }] },
  { id: "ux-w14", recorder: "bob", pieces: [K("quotes stall everywhere, not just Montana (a class-level question)")], resolves: [KEY("Customer", "MONTANA")] },
  { id: "ux-y02", recorder: "bob", pieces: [K("HILL invoiced the gage pins at the old price; accounting asks")], resolves: [KEY("Vendor", "HILL"), KEY("Purchase_Order", "1")], mustNot: [{ change: KEY("Purchase_Order", "1") }] },
  { id: "ux-z01", recorder: "bob", pieces: [U("job 3260356 shipped Thursday (a stated change; the floor has Job authority)", "Job", "3260356", ["Status"], "filed", CHANGE), K("3260357 still waits on FINAL INSP (as the source has it; dependency stated)")], resolves: [KEY("Job", "3260356"), KEY("Job", "3260357"), KEY("Work_Center", "FINAL INSP")], mustNot: [{ change: KEY("Job", "3260357") }] },
  { id: "ux-z04", recorder: "alice", pieces: [U("the old pin gage set on INSPECT-2 is retired (Equipment takes no writes)", "Equipment", "GAGE-PIN-OLD", ["Status"], "proposed", CHANGE), C("the new HILL set is in use from today", "Equipment", ["Description", "Location", "Status", "Work_Center"], [KEY("Work_Center", "INSPECT-2")], "proposed", { ...CHANGE, ...also("kept") })], resolves: [KEY("Equipment", "GAGE-PIN-OLD"), KEY("Work_Center", "INSPECT-2"), KEY("Vendor", "HILL")], mustNot: [{ mint: "ux-z04" }] },
  { id: "ux-z05", recorder: "bob", pieces: [K("closed Thursday and Friday for Thanksgiving; pickups move to Wednesday")] },
  { id: "ux-aa03", recorder: "alice", pieces: [C("CNC 1 coolant read 4 percent, topped up to 7 (maintenance done)", "Maintenance", ["Work_Center", "Opened", "Description", "Status"], [KEY("Work_Center", "CNC 1")], "filed", { ...CHANGE, ...also("kept") })], resolves: [KEY("Work_Center", "CNC 1")] },
  { id: "ux-aa05", recorder: "alice", pieces: [K("near miss at the dock (an incident)"), C("the Toyota forklift's beeper is tagged out until maintenance replaces it", "Maintenance", ["Equipment", "Opened", "Description", "Status"], [KEY("Equipment", "FL-TOYOTA")], "filed", { ...CHANGE, ...also("kept") })], resolves: [KEY("Equipment", "FL-TOYOTA")], mustNot: [{ link: KEY("Equipment", "FL-HYSTER") }] },
  { id: "ux-aa07", recorder: "alice", pieces: [U("Diep's starting rate is set at 21.50 an hour (Employee takes no writes)", "Employee", "NGUD", ["Pay_Rate"], "proposed", CHANGE), K("Diep's review at 90 days")], resolves: [KEY("Employee", "NGUD")], mustNot: [{ link: KEY("Employee", "NGDT") }, { change: KEY("Employee", "NGUD") }] },
  { id: "ux-aa11", recorder: "alice", pieces: [H("what 'the thing from Tuesday' is", "the subject exists only in the writer's head", also("kept"))] },
  { id: "ux-aa13", recorder: "alice", pieces: [K("October scrap rate 2.1 percent; fewer setup errors on CNC 2")], resolves: [KEY("Work_Center", "CNC 2")] },
  { id: "ux-aa14", recorder: "bob", pieces: [K("Marisol Vega out the week of November 16; Brian covers shipping sign-off")], resolves: [KEY("Employee", "VEGM"), KEY("Employee", "LOWB")] },
  { id: "ux-ab02", recorder: "bob", pieces: [U("CNC 2's problem is a worn spindle bearing, not the warm-up routine (the open maintenance record)", "Maintenance", "1", ["Description"], "filed", { ...CHANGE, ...also("held") }), H("a replacement bearing ordered from the machine builder", "the machine builder is no vendor row", also("kept", "proposed")), K("CNC 2 at reduced speed until the bearing arrives (dependency stated)", also("filed"))], resolves: [KEY("Work_Center", "CNC 2"), KEY("Maintenance", "1"), KEY("Employee", "NGUD")], mustNot: [{ link: KEY("Employee", "NGDT") }] },
  { id: "ux-ab05", recorder: "alice", pieces: [H("Exatron's repeat order of 3260357, 1,200 pieces, due mid December", "a new order needs a PO and a date the note doesn't give; read as a change to 3260357 it disagrees with the row (600, due December 4)", also("proposed")), K("buy the 4140 bar before the December 1 increase (a need)")], resolves: [KEY("Customer", "EXATRON"), KEY("Job", "3260357"), KEY("Material", "4140-BAR-1.25")], mustNot: [{ change: KEY("Job", "3260357") }] },
  { id: "ux-ab06", recorder: "bob", pieces: [K("two second-shift CNC operator openings posted"), K("Diep trains whoever starts first")], resolves: [KEY("Employee", "NGUD"), KEY("Work_Center", "CNC 3")] },
  { id: "ux-ab11", recorder: "alice", pieces: [K("nothing new at the Thursday meeting")], mustNot: [{ write: T("Job") }] },
  { id: "ux-ac13", recorder: "bob", pieces: [U("the Brightline titanium bar is in C1 (Material takes no writes, and is Operations')", "Material", "TI-BAR-1", ["Location"], "proposed", CHANGE), K("rack C is now two racks, C1 for titanium and C2 for aluminum", also("proposed"))], resolves: [KEY("Material", "TI-BAR-1"), KEY("Material", "AL-6061-BAR-2")] },
  { id: "ux-ad03", recorder: "bob", pieces: [K("Tomas Reyes finished his first week on CNC 3; can run setups alone")], resolves: [KEY("Employee", "REYT"), KEY("Work_Center", "CNC 3"), KEY("Employee", "NGUD")] },
  { id: "ux-ad15", recorder: "bob", pieces: [H("C1 holds aluminum and C2 titanium, against the earlier record", "disagrees with ac13", also("kept"))], resolves: [KEY("Material", "TI-BAR-1"), KEY("Material", "AL-6061-BAR-2")], mustNot: [{ change: KEY("Material", "TI-BAR-1") }] },
  { id: "ux-ae15", recorder: "bob", pieces: [K("coolant dosing changes to 6 percent")] },
  { id: "ux-af04", recorder: "alice", pieces: [K("people ask about layoffs; there are no plans")] },
  { id: "ux-ag03", recorder: "bob", pieces: [U("Exatron's order for 500 floaters, job 3260410 (the row already holds it)", "Job", "3260410", ["Order_Quantity"], "filed", { ...ALREADY, ...also("kept") })], resolves: [KEY("Job", "3260410"), KEY("Customer", "EXATRON")], mustNot: [{ change: KEY("Job", "3260410") }] },
  { id: "ux-ai04", recorder: "alice", pieces: [K("Brightline holds the unit price through Q2 if blanks arrive by March")], resolves: [KEY("Customer", "BRIGHTLINE"), KEY("Material", "BL-BLANK-100")], mustNot: [{ change: KEY("Material", "BL-BLANK-100") }, { write: T("Job") }] },
  { id: "ux-ai06", recorder: "alice", pieces: [K("Saturday overtime at time and a half"), K("payroll needs the hours by Monday noon")] },
  { id: "ux-aj02", recorder: "alice", pieces: [H("the floater due date moves to December 12", "two open floater jobs (3260357 and 3260410)", also("filed")), K("Exatron will take partial shipments")], resolves: [KEY("Customer", "EXATRON")], mustNot: [{ change: KEY("Job", "3260357") }] },
  { id: "ux-aj09", recorder: "bob", pieces: [H("the forklift's front left tire has a slow leak", "two forklifts (FL-TOYOTA, FL-HYSTER)", also("kept"))], mustNot: [{ mint: "tire" }] },
  { id: "ux-aj10", recorder: "alice", pieces: [K("Tomas passed his 90-day review early")], resolves: [KEY("Employee", "REYT")] },
  { id: "ux-ak03", recorder: "bob", pieces: [H("the first 250 floaters shipped", "two open floater jobs (3260357 and 3260410)", also("filed"))], resolves: [KEY("Customer", "EXATRON")], mustNot: [{ change: KEY("Job", "3260357") }] },
  { id: "ux-ak06", recorder: "alice", pieces: [K("payroll goes biweekly from January")] },
  { id: "ux-al04", recorder: "alice", pieces: [U("Brightline's PO for 2,000 blanks at 41, job 3260455 (the row already holds it)", "Job", "3260455", ["Order_Quantity", "Unit_Price"], "filed", { ...ALREADY, ...also("kept") })], resolves: [KEY("Job", "3260455"), KEY("Customer", "BRIGHTLINE")], mustNot: [{ change: KEY("Job", "3260455") }] },
  { id: "ux-am02", recorder: "alice", pieces: [K("Brightline blanks run at about a 22 percent margin")], resolves: [KEY("Job", "3260455"), KEY("Customer", "BRIGHTLINE")], mustNot: [{ write: T("Job") }] },
  { id: "ux-am06", recorder: "alice", pieces: [K("Andre's Staffmark assignment ends Friday", UNHELD)], resolves: [KEY("Vendor", "STAFFMRK")] },
  { id: "ux-am10", recorder: "alice", pieces: [K("coolant quotes from Master Fluid and Blaser, cheaper than Hangsterfer's")], resolves: [KEY("Vendor", "MASTERFL"), KEY("Vendor", "BLASER"), KEY("Vendor", "HANGSTER")], mustNot: [{ write: T("Purchase_Order") }] },
  { id: "ux-am12", recorder: "alice", pieces: [K("Tomas strained his back; light duty for two weeks")], resolves: [KEY("Employee", "REYT")] },
  { id: "ux-am15", recorder: "bob", pieces: [K("Tomas is on the deburr bench this week")], resolves: [KEY("Employee", "REYT"), KEY("Work_Center", "DEBURR")] },
  { id: "ux-an02", recorder: "alice", pieces: [K("Exatron's floater price goes to 15.10 from January; not told yet")], resolves: [KEY("Customer", "EXATRON")], mustNot: [{ write: T("Job") }, { change: KEY("Material", "EPP-D98-2-B") }] },
  { id: "ux-an15", recorder: "bob", pieces: [K("Kayla wants her forklift certification (a need)", UNHELD)], resolves: ["Kayla"] },
  { id: "ux-ao04", recorder: "alice", pieces: [K("Kayla's temp assignment extended through January", UNHELD)], resolves: ["Kayla"] },
  { id: "ux-ao12", recorder: "alice", pieces: [K("Exatron disputes the last invoice; the lawyer is looking")], resolves: [KEY("Customer", "EXATRON")] },
  { id: "ux-aq01", recorder: "bob", pieces: [K("Diep runs CNC 5 this afternoon")], resolves: [KEY("Employee", "NGUD"), KEY("Work_Center", "CNC 5")], mustNot: [{ link: KEY("Employee", "NGDT") }] },
  { id: "ux-aq07", recorder: "bob", pieces: [C("three saw blades ordered for the Hyd-Mech (a purchase order is Operations')", "Purchase_Order", ["Vendor", "Description", "Order_Date", "Status"], [KEY("Vendor", "HYDMECH")], "proposed", CHANGE)], resolves: [KEY("Vendor", "HYDMECH"), KEY("Work_Center", "SAW")] },
  { id: "ux-aq10", recorder: "alice", pieces: [K("a contingent plan to lay off two in March")] },
  { id: "ux-aq12", recorder: "alice", pieces: [K("meeting Corvane Medical next week about an order", UNHELD)], resolves: ["Corvane"], mustNot: [{ write: T("Customer") }, { write: T("Sales_Order") }] },
  { id: "ux-ar02", recorder: "alice", pieces: [K("Corvane wants 20 sample parts first")], resolves: ["Corvane"], mustNot: [{ write: T("Sales_Order") }] },
  { id: "ux-as08", recorder: "alice", pieces: [K("the holiday schedule is posted by the time clock")], mustNot: [{ mint: "time clock" }, { mint: "holiday schedule" }] },
  { id: "ux-at03", recorder: "bob", pieces: [K("the break room coffee maker quit again")] },
  { id: "ux-au04", recorder: "alice", pieces: [C("Kayla is permanent from December 1 (Employee takes no writes)", "Employee", ["First_Name", "Status", "Type", "Hire_Date"], [], "proposed", CHANGE)], resolves: ["Kayla"], mustNot: [{ write: T("Employee") }] },
  { id: "ux-au13", recorder: "bob", pieces: [K("the new mats at CNC 3 help")], resolves: [KEY("Work_Center", "CNC 3")] },
  { id: "ux-av06", recorder: "alice", pieces: [K("the owner plans to retire and sell in two years")] },
  { id: "ux-aw10", recorder: "alice", pieces: [K("Diep may lift nothing over 20 pounds for two weeks; a doctor's note")], resolves: [KEY("Employee", "NGUD")], mustNot: [{ link: KEY("Employee", "NGDT") }] },
];

/**
 * The labels R16 changes (the user, 2026-11-11: code decides whether a source write lands, and R12's state-versus-change
 * test is dropped), old and new (I-47). NOTES above stay the R12 labels, so a run is scored either way: `notesUnder`.
 * Each change is the integrator's reading of the note under R16 and the conditions as built (model/write-conditions.js,
 * DEFINITIONS); a treatment chosen for booleans or closed-set values would move t06 and z01 to Filed, which they accept.
 */
export const R16_CHANGES = [
  { note: "ux-m01", piece: 0, from: "held", to: "filed", accept: [], dropMustNot: KEY("Work_Center", "INSPECT-2"), why: "no longer Held for describing a state: the note names INSPECT-2 and gives the values in its own words (down, until the gauge is recalibrated), and alice (Operations) holds the authority over work centers" },
  { note: "ux-t06", piece: 0, from: "held", to: "held", accept: ["filed"], dropMustNot: KEY("Job", "3260372"), why: "no longer Held for describing a state, but Held by condition 3: Certs_Required true isn't in the note's words (\"needs certs\"); Filed once a boolean treatment counts it (I-45)" },
  { note: "ux-z01", piece: 0, from: "filed", to: "held", accept: ["filed"], dropMustNot: null, why: "Held by condition 3: the Status \"shipped Thursday\" means is a closed-set value (Complete) not in the note's words; no treatment for closed sets is proposed (I-45)" },
];

/**
 * The labels R18 and R19 change, over R16's (the user, 2026-11-11: yes/no and fixed-choice fields take the model's
 * reading; workers add rows through the write interface), old (R16) and new. Which tables take new rows is the test
 * declaration's: Maintenance and Purchase_Order (graph-rag/src/sources.js TEST_SHAPES). Labels that name a new row
 * elsewhere (z04's Equipment, au04's Employee) stay Proposed: those tables take no writes. aq07's Purchase_Order row
 * stays Proposed: the table takes new rows now, but a purchase order is Operations', and bob is on the floor.
 */
export const R19_CHANGES = [
  { note: "ux-t06", piece: 0, from: "held", to: "filed", accept: [], dropMustNot: null, why: "R18: Certs_Required is a yes/no column, so the model's reading of \"needs certs\" (true) stands" },
  { note: "ux-z01", piece: 0, from: "held", to: "filed", accept: [], dropMustNot: null, why: "R18: Status is fixed-choice, so Complete for \"shipped\" stands; decided per field (I-50), an 800 the note doesn't give is held on its own and doesn't land" },
  { note: "ux-aa03", piece: 0, from: "filed", to: "filed", accept: [], dropMustNot: null, why: "R19: Maintenance takes new rows, so the row can be added; Kept is no longer accepted in its place" },
  { note: "ux-aa05", piece: 1, from: "filed", to: "filed", accept: [], dropMustNot: null, why: "R19: Maintenance takes new rows, so the row can be added; Kept is no longer accepted in its place" },
];

/** a label set's changes applied to the notes */
function applying(notes, changes, tag) {
  return notes.map((n) => {
    const mine = changes.filter((c) => c.note === n.id);
    if (!mine.length) return n;
    const pieces = n.pieces.map((p, i) => {
      const c = mine.find((x) => x.piece === i);
      return c ? { ...p, outcome: c.to, accept: c.accept, [tag]: c.why } : p;
    });
    const drop = new Set(mine.map((c) => c.dropMustNot).filter(Boolean));
    return { ...n, pieces, ...(n.mustNot ? { mustNot: n.mustNot.filter((m) => !drop.has(m.change)) } : {}) };
  });
}

/** the notes as labelled under "r12" (the labels as written), "r16" (R16_CHANGES applied) or "r19" (then R19_CHANGES) */
export const LABEL_SETS = ["r12", "r16", "r19"];
export function notesUnder(labels = "r19") {
  if (!LABEL_SETS.includes(labels)) throw new Error(`labels: ${LABEL_SETS.join(", ")}, not ${labels}`);
  if (labels === "r12") return NOTES;
  const r16 = applying(NOTES, R16_CHANGES, "r16");
  return labels === "r16" ? r16 : applying(r16, R19_CHANGES, "r19");
}

/** the notes with a stated change or a stated state (R12), listed apart in the report */
export const STATED_NOTES = NOTES.filter((n) => n.pieces.some((p) => p.stated)).map((n) => n.id);

/** every key in a dataset, as system:table:row */
export function keysOf(data) {
  const out = new Set();
  for (const [table, t] of Object.entries(data)) for (const row of t.rows) out.add(rowKey(table, t.primaryKey, row));
  return out;
}

/**
 * R2's table, applied to one piece: Held when it is unclear which record (the row or a row it refers to
 * isn't there), Proposed when it is clear but the source isn't writable for it or the recorder lacks
 * authority, Filed otherwise; Kept for the document. R12: a stated current state on an existing row is Held
 * (the labels mark only states the source disagrees with: S0's rows are as the notes' world began). Written
 * apart from the system's own filedOrProposed.
 */
export function ruleOutcome(piece, recorder, { data = dataset(), commit = COMMIT, map = MAP, positions = POSITIONS, people = PEOPLE } = {}) {
  const t = piece.target;
  if (t.kind === "doc") return "kept";
  if (t.kind === "unclear") return "held";
  const keys = keysOf(data);
  if (t.kind === "row" && !keys.has(t.key)) return "held";
  if (t.kind === "row" && piece.stated === "current") return "held";
  // R12's "already": the row holds what the record says; nothing is written, so neither writability nor authority
  // is asked (the sources adapter settles such a write as written with nothing sent)
  if (t.kind === "row" && piece.stated === "already") return "filed";
  if ((t.needs ?? []).some((k) => !keys.has(k))) return "held";
  const table = t.table.split(":")[1];
  const action = t.kind === "row" ? "update" : "create";
  const cols = commit.columns[table] ?? [];
  const writable = (commit.tables[table] ?? []).includes(action) && t.columns.every((c) => cols.includes(c));
  if (!writable) return "proposed";
  const pos = map[t.table];
  if (!pos || !atOrAbove(positions, people[recorder], pos)) return "proposed";
  return "filed";
}

/** the outcomes a piece accepts: its own and those it lists */
export const accepted = (piece) => [...new Set([piece.outcome, ...(piece.accept ?? [])])];

/** problems with the labels against a dataset (a table, column or key it lacks) and the rule; [] when sound */
export function checkLabels(notes = NOTES, oracleIds = null, opts = {}) {
  const data = opts.data ?? dataset();
  const keys = keysOf(data);
  const problems = [];
  if (oracleIds) {
    const ids = new Set(notes.map((n) => n.id));
    for (const id of oracleIds) if (!ids.has(id)) problems.push(`${id}: no label`);
    for (const id of ids) if (!oracleIds.includes(id)) problems.push(`${id}: labelled but not a note`);
  }
  for (const n of notes) {
    if (!PEOPLE[n.recorder]) problems.push(`${n.id}: unknown recorder ${n.recorder}`);
    if (!n.pieces?.length) problems.push(`${n.id}: no pieces`);
    for (const [i, p] of (n.pieces ?? []).entries()) {
      const where = `${n.id} piece ${i}`;
      const t = p.target;
      if (t.kind === "row" || t.kind === "new-row") {
        const table = t.table.split(":")[1];
        if (!data[table]) problems.push(`${where}: no table ${t.table}`);
        else {
          const cols = new Set(data[table].rows.flatMap((r) => Object.keys(r)));
          for (const c of t.columns) if (!cols.has(c)) problems.push(`${where}: no column ${table}.${c}`);
        }
      }
      const rule = ruleOutcome(p, n.recorder, { ...opts, data });
      if (rule !== p.outcome && !p.override) problems.push(`${where}: labelled ${p.outcome}, the rule says ${rule}`);
    }
    for (const r of n.resolves ?? []) if (/^\w+:dbo_/.test(r) && !keys.has(r)) problems.push(`${n.id}: resolves to ${r}, not in the dataset`);
  }
  return problems;
}

/** counts by outcome, for the doc and the report header */
export function labelCounts(notes = NOTES) {
  const c = { filed: 0, proposed: 0, held: 0, kept: 0, pieces: 0, stated: 0, unheld: 0 };
  for (const n of notes) for (const p of n.pieces) {
    c[p.outcome]++;
    c.pieces++;
    if (p.stated) c.stated++;
    if (p.unheld) c.unheld++;
  }
  return c;
}
