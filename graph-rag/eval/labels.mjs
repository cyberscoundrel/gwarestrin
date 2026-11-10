// The 62 notes' expected filing outcomes (docs/build/integrate.md, section 3), from the notes' words and the
// rulings only. Two layers: where each piece goes, by hand (`target`), and the outcome, also written by hand
// (`outcome`) and recomputed by R2's table under S0 and M0 (`ruleOutcome`); test/eval.test.js holds the two
// equal, so a hand label that disagrees with the rule has to say why (`override`).
//
// These are one person's reading (the integrator's) of the notes under the rulings, not an acceptance standard:
// R9 retired the 62-note oracle as one, and nothing here has a pass mark. A run is compared with them to see what
// happens, and where a model disagrees the label may be the one that is wrong.
// The labels assume no person approves a Proposed piece during the run: ux-aj02 and ux-ak03 are Held only while
// ux-ag03's new job stays Proposed (once it is approved and written, both would follow R2's table on a real row).
//
// A piece:
//   { about, target, outcome, accept?, stated?, override? }
//   target: { kind: "doc" }                                  Kept: no system holds it
//           { kind: "unclear", why }                         Held: which record, or the source disagrees
//           { kind: "row", table, key, columns }             an existing row's columns
//           { kind: "new-row", table, columns, needs? }      a new row; `needs` are keys it refers to
// A note:
//   { id, recorder, pieces, resolves?, mustNot? }
//   resolves: instance keys (system:table:row) or names the sections should be about
//   mustNot:  { write: table } | { link: key } | { mint: regex } | { change: key }
//
// R12 (F4, ruled 2026-11-10): stated changes are written. A row piece says `stated: "change"` (the record says
// something changed: an update, Filed given authority) or `stated: "current"` (it describes the current state;
// where the source disagrees, Held, and the worker asks the recorder).
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
/** R12: a stated change is written given authority; a stated state that disagrees with the source is Held */
const CHANGE = { stated: "change" };
const CURRENT = { stated: "current" };

export const NOTES = [
  { id: "ux-note 13", recorder: "alice", pieces: [K("job 3260356 probably slips a week; the inspect backlog (dependency 3260356 -> INSPECT-2)")], resolves: [KEY("Job", "3260356"), KEY("Work_Center", "INSPECT-2"), KEY("Customer", "EXATRON")], mustNot: [{ change: KEY("Job", "3260356") }, { mint: "78912" }] },
  { id: "ux-note 14", recorder: "bob", pieces: [K("Exatron wants the next EPP-D98-2-B batch earlier (a need)"), K("Darrin S. is checking material (a task)", UNHELD)], resolves: [KEY("Job", "3260357"), KEY("Customer", "EXATRON")], mustNot: [{ change: KEY("Job", "3260357") }] },
  { id: "ux-m01", recorder: "alice", pieces: [U("INSPECT-2 is down (a state, not a stated change)", "Work_Center", "INSPECT-2", ["Status"], "held", CURRENT), H("which EPP-D98 job waits", "two open jobs match EPP-D98", { accept: ["kept"] })], resolves: [KEY("Work_Center", "INSPECT-2"), KEY("Customer", "EXATRON")], mustNot: [{ change: KEY("Work_Center", "INSPECT-2") }] },
  { id: "ux-m03", recorder: "alice", pieces: [K("stop quoting Aetrium below cost (a recommendation)")], resolves: [KEY("Customer", "AETRIUM")], mustNot: [{ write: T("Job") }, { write: T("Customer") }] },
  { id: "ux-t01", recorder: "alice", pieces: [K("the break room fridge is cleaned Fridays at 3pm")] },
  { id: "ux-t02", recorder: "bob", pieces: [K("the holiday party is December 19 at noon")] },
  { id: "ux-t03", recorder: "alice", pieces: [K("ask John F. about the assembly fixtures (a task)")], resolves: [KEY("Employee", "FRAJ")], mustNot: [{ link: KEY("Employee", "NGUD") }, { link: KEY("Employee", "LOWB") }] },
  { id: "ux-t06", recorder: "bob", pieces: [K("certs required with the shipment of job 3260372")], resolves: [KEY("Job", "3260372"), KEY("Customer", "BSE")], mustNot: [{ write: T("Job") }] },
  { id: "ux-t07", recorder: "alice", pieces: [K("should Cohu's prices rise; thin margins (a question)")], resolves: [KEY("Customer", "COHU-CA")], mustNot: [{ write: T("Job") }] },
  { id: "ux-t22", recorder: "bob", pieces: [K("late cryo-optic parts across customers; inspection scheduling (a class-level question)")], mustNot: [{ mint: "inspection step" }] },
  { id: "ux-v02", recorder: "bob", pieces: [K("John Henry Foster quoted $1,840 a year for compressor service")], resolves: [KEY("Vendor", "JOHNH")], mustNot: [{ mint: "ux-z03" }] },
  { id: "ux-w05", recorder: "alice", pieces: [K("Lucas is on Saturday overtime for the Exatron backlog", UNHELD)], resolves: [KEY("Customer", "EXATRON")], mustNot: [{ link: KEY("Employee", "NGUD") }, { link: KEY("Employee", "LOWB") }, { link: KEY("Employee", "FRAJ") }] },
  { id: "ux-w11", recorder: "alice", pieces: [K("Toro asks to rush 4471 ahead of BSE (a need, not granted)", { accept: ["held"] })], resolves: [KEY("Job", "4471"), KEY("Customer", "TORO")], mustNot: [{ change: KEY("Job", "4471") }] },
  { id: "ux-w14", recorder: "bob", pieces: [K("quotes stall everywhere; one person, the process or the tooling (a class-level question)")] },
  { id: "ux-y02", recorder: "bob", pieces: [K("HILL invoiced the gage pins at the old price; accounting asks", UNHELD)] },
  { id: "ux-z01", recorder: "bob", pieces: [U("only job 3260356 shipped Thursday", "Job", "3260356", ["Status"], "proposed", CHANGE), K("3260357 still waits on FINAL INSP (dependency stated)")], resolves: [KEY("Job", "3260356"), KEY("Job", "3260357"), KEY("Work_Center", "FINAL INSP")], mustNot: [{ change: KEY("Job", "3260357") }] },
  { id: "ux-z04", recorder: "alice", pieces: [K("the old pin gauge set on INSPECT-2 is retired; the new HILL set is in use")], resolves: [KEY("Work_Center", "INSPECT-2")], mustNot: [{ mint: "ux-z04" }] },
  { id: "ux-z05", recorder: "bob", pieces: [K("closed Thursday and Friday for Thanksgiving; pickups move to Wednesday")] },
  { id: "ux-aa03", recorder: "alice", pieces: [K("CNC 1 coolant read 4 percent, topped up to 7")], resolves: ["CNC 1"], mustNot: [{ link: KEY("Work_Center", "CNC") }] },
  { id: "ux-aa05", recorder: "alice", pieces: [K("near miss at the dock; the Toyota forklift's beeper is tagged out")], resolves: ["forklift"] },
  { id: "ux-aa07", recorder: "alice", pieces: [U("Diep's starting rate is 21.50 an hour", "Employee", "NGUD", ["Hourly_Rate"], "proposed", CHANGE), K("Diep's review at 90 days")], resolves: [KEY("Employee", "NGUD")], mustNot: [{ link: KEY("Employee", "NGDT") }, { change: KEY("Employee", "NGUD") }] },
  { id: "ux-aa11", recorder: "alice", pieces: [H("what 'the thing from Tuesday' is", "the subject exists only in the writer's head", { accept: ["kept"] })] },
  { id: "ux-aa13", recorder: "alice", pieces: [K("October scrap rate 2.1 percent; fewer setup errors on CNC 2")], resolves: ["CNC 2"] },
  { id: "ux-aa14", recorder: "bob", pieces: [K("Marisol Vega out the week of November 16; Brian covers shipping sign-off", UNHELD)], resolves: [KEY("Employee", "LOWB")] },
  { id: "ux-ab02", recorder: "bob", pieces: [K("CNC 2's problem is a worn spindle bearing"), K("a replacement bearing ordered from the machine builder"), K("CNC 2 at reduced speed until the bearing arrives (dependency stated)")], resolves: ["CNC 2", KEY("Employee", "NGUD")], mustNot: [{ link: KEY("Employee", "NGDT") }] },
  { id: "ux-ab05", recorder: "alice", pieces: [C("Exatron's repeat order of 3260357, 1,200 pieces", "Job", ["Customer", "Part_Number", "Order_Quantity"], [KEY("Customer", "EXATRON")], "filed", CHANGE), H("the due date ('mid December')", "no date is given"), K("buy the 4140 bar before the December 1 increase")], resolves: [KEY("Customer", "EXATRON"), KEY("Job", "3260357")], mustNot: [{ change: KEY("Job", "3260357") }] },
  { id: "ux-ab06", recorder: "bob", pieces: [K("two second-shift CNC operator openings posted"), K("Diep trains whoever starts first")], resolves: [KEY("Employee", "NGUD"), "CNC 3"] },
  { id: "ux-ab11", recorder: "alice", pieces: [K("nothing new at the Thursday meeting")], mustNot: [{ write: T("Job") }] },
  { id: "ux-ac13", recorder: "bob", pieces: [K("rack C is now C1 (titanium) and C2 (aluminum); Brightline's titanium bar is in C1")], resolves: ["C1", "C2"] },
  { id: "ux-ad03", recorder: "bob", pieces: [K("Tomas Reyes finished his first week on CNC 3; can run setups alone", UNHELD)], resolves: ["Tomas Reyes", "CNC 3", KEY("Employee", "NGUD")] },
  { id: "ux-ad15", recorder: "bob", pieces: [H("C1 holds aluminum and C2 titanium, against the earlier record", "disagrees with ac13, which is Kept", { accept: ["kept"] })], resolves: ["C1", "C2"] },
  { id: "ux-ae15", recorder: "bob", pieces: [K("coolant dosing changes to 6 percent")] },
  { id: "ux-af04", recorder: "alice", pieces: [K("people ask about layoffs; there are no plans")] },
  { id: "ux-ag03", recorder: "bob", pieces: [C("Exatron's new order: job 3260410, 500 floaters", "Job", ["Customer", "Order_Quantity"], [KEY("Customer", "EXATRON")], "proposed", CHANGE)], resolves: [KEY("Customer", "EXATRON")] },
  { id: "ux-ai04", recorder: "alice", pieces: [K("Brightline holds the unit price through Q2 if blanks arrive by March", UNHELD)], resolves: ["Brightline"], mustNot: [{ write: T("Job") }] },
  { id: "ux-ai06", recorder: "alice", pieces: [K("Saturday overtime at time and a half"), K("payroll needs the hours by Monday noon")] },
  { id: "ux-aj02", recorder: "alice", pieces: [U("the floater due date moves to December 12", "Job", "3260410", ["Promised_Date"], "held", CHANGE), K("Exatron will take partial shipments")], resolves: [KEY("Customer", "EXATRON")], mustNot: [{ change: KEY("Job", "3260356") }, { change: KEY("Job", "3260357") }] },
  { id: "ux-aj09", recorder: "bob", pieces: [K("the forklift's front left tire has a slow leak")], resolves: ["forklift"], mustNot: [{ mint: "tire" }] },
  { id: "ux-aj10", recorder: "alice", pieces: [K("Tomas passed his 90-day review early")], resolves: ["Tomas Reyes"] },
  { id: "ux-ak03", recorder: "bob", pieces: [U("the first 250 floaters shipped", "Job", "3260410", ["Qty_Shipped"], "held", CHANGE)], resolves: [KEY("Customer", "EXATRON")] },
  { id: "ux-ak06", recorder: "alice", pieces: [K("payroll goes biweekly from January")] },
  { id: "ux-al04", recorder: "alice", pieces: [C("Brightline's PO: job 3260455, 2,000 blanks at 41", "Job", ["Customer", "Order_Quantity", "Unit_Price"], [KEY("Customer", "BRIGHTLINE")], "held", CHANGE)], resolves: ["Brightline"] },
  { id: "ux-am02", recorder: "alice", pieces: [K("Brightline blanks run at about a 22 percent margin")], resolves: ["Brightline"], mustNot: [{ write: T("Job") }] },
  { id: "ux-am06", recorder: "alice", pieces: [K("Andre's Staffmark assignment ends Friday", UNHELD)], resolves: ["Andre"] },
  { id: "ux-am10", recorder: "alice", pieces: [K("coolant quotes from Master Fluid and Blaser, cheaper than Hangsterfer's", UNHELD)] },
  { id: "ux-am12", recorder: "alice", pieces: [K("Tomas strained his back; light duty for two weeks")], resolves: ["Tomas Reyes"] },
  { id: "ux-am15", recorder: "bob", pieces: [K("Tomas is on the deburr bench this week")], resolves: ["Tomas Reyes"] },
  { id: "ux-an02", recorder: "alice", pieces: [K("Exatron's floater price goes to 15.10 from January; not told yet")], resolves: [KEY("Customer", "EXATRON")], mustNot: [{ write: T("Job") }] },
  { id: "ux-an15", recorder: "bob", pieces: [K("Kayla wants her forklift certification (a need)", UNHELD)], resolves: ["Kayla"] },
  { id: "ux-ao04", recorder: "alice", pieces: [K("Kayla's temp assignment extended through January", UNHELD)], resolves: ["Kayla"] },
  { id: "ux-ao12", recorder: "alice", pieces: [K("Exatron disputes the last invoice; the lawyer is looking")], resolves: [KEY("Customer", "EXATRON")] },
  { id: "ux-aq01", recorder: "bob", pieces: [K("Diep runs CNC 5 this afternoon")], resolves: [KEY("Employee", "NGUD"), "CNC 5"], mustNot: [{ link: KEY("Employee", "NGDT") }] },
  { id: "ux-aq07", recorder: "bob", pieces: [K("three saw blades ordered for the Hyd-Mech")], resolves: ["Hyd-Mech"] },
  { id: "ux-aq10", recorder: "alice", pieces: [K("a contingent plan to lay off two in March")] },
  { id: "ux-aq12", recorder: "alice", pieces: [K("meeting Corvane Medical next week about an order", UNHELD)], resolves: ["Corvane"], mustNot: [{ write: T("Customer") }] },
  { id: "ux-ar02", recorder: "alice", pieces: [K("Corvane wants 20 sample parts first")], resolves: ["Corvane"] },
  { id: "ux-as08", recorder: "alice", pieces: [K("the holiday schedule is posted by the time clock")], mustNot: [{ mint: "time clock" }, { mint: "holiday schedule" }] },
  { id: "ux-at03", recorder: "bob", pieces: [K("the break room coffee maker quit again")] },
  { id: "ux-au04", recorder: "alice", pieces: [C("Kayla is permanent from December 1", "Employee", ["First_Name", "Status"], [], "proposed", CHANGE)], resolves: ["Kayla"], mustNot: [{ write: T("Employee") }] },
  { id: "ux-au13", recorder: "bob", pieces: [K("the new mats at CNC 3 help")], resolves: ["CNC 3"] },
  { id: "ux-av06", recorder: "alice", pieces: [K("the owner plans to retire and sell in two years")] },
  { id: "ux-aw10", recorder: "alice", pieces: [K("Diep may lift nothing over 20 pounds for two weeks; a doctor's note")], resolves: [KEY("Employee", "NGUD")], mustNot: [{ link: KEY("Employee", "NGDT") }] },
];

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
  if ((t.needs ?? []).some((k) => !keys.has(k))) return "held";
  const table = t.table.split(":")[1];
  const action = t.kind === "row" ? "update" : "create";
  const cols = commit.columns[table] ?? [];
  const writable = commit.tables.includes(table) && commit.actions.includes(action) && t.columns.every((c) => cols.includes(c));
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
          const sample = data[table].rows[0] ?? {};
          for (const c of t.columns) if (!(c in sample)) problems.push(`${where}: no column ${table}.${c}`);
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
