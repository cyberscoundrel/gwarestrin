// The 62 notes as records (docs/build/integrate.md, section 3), and the marker records for the leak gate
// (section 2.6). A record is model/record.js's document: one section, the note's text verbatim, by its
// writer, on record. The note's code stays in the run's metadata, never in the text or the title (z04's
// known failure was a note code minted as a thing).
//
// NEEDS A RULING (input): records enter as uploaded documents, with the condenser out of the first run, so
// every setup gets identical input.

export const RECORD_REASON = "test record for the real-model evaluation";
const START = Date.parse("2026-11-02T08:00:00.000Z");
const DAY = 86_400_000;
const STEP = 10 * 60_000;

/** the oracle titles carry the note code; the two pre-batch notes have nothing else */
const TITLES = {
  "ux-note 13": "inspect backed up, 3260356 slips",
  "ux-note 14": "Exatron wants EPP-D98-2-B earlier",
};
export const titleOf = (note) => TITLES[note.id] ?? String(note.title).replace(/^ux-[a-z]+\s*\d+\s+/i, "").trim();

/** the batches in the order they ran: the pre-batch notes, then ux-m .. ux-z, then ux-aa .. ux-aw */
export function batchOrder(notes) {
  const rank = (b) => (b === "ux-note" ? [0, ""] : [b.length, b]);
  return [...new Set(notes.map((n) => n.batch))].sort((a, b) => {
    const [la, sa] = rank(a);
    const [lb, sb] = rank(b);
    return la - lb || sa.localeCompare(sb);
  });
}

/**
 * The records, in order: [{ note, batch, order, person, document }]. Batch i is recorded on day i after
 * the start, its notes ten minutes apart, so a note recorded later about the same thing comes later.
 */
export function recordsFrom(oracle, { start = START } = {}) {
  const batches = batchOrder(oracle);
  const out = [];
  batches.forEach((batch, bi) => {
    oracle
      .filter((n) => n.batch === batch)
      .forEach((n, i) => {
        const person = n.writer;
        const position = { alice: "ops", bob: "floor", admin: "org" }[person];
        if (!position) throw new Error(`${n.id}: no position for ${person}`);
        const title = titleOf(n);
        // the title never carries a note code; the text is the note's own, verbatim (v02 cites ux-z03 itself)
        if (/ux-/i.test(title)) throw new Error(`${n.id}: a note code would reach the title`);
        out.push({
          note: n.id,
          batch,
          order: out.length,
          person,
          document: {
            title,
            recorded_by: person,
            position,
            reason: RECORD_REASON,
            recorded_at: new Date(start + bi * DAY + i * STEP).toISOString(),
            sections: [{ text: n.text }],
          },
        });
      });
  });
  return out;
}

/** a small seeded PRNG (mulberry32), so a run's markers can be regenerated from its seed */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ONSETS = ["br", "dr", "gl", "kv", "pl", "qu", "sk", "tr", "vr", "zh", "fl", "gr", "st", "th"];
const VOWELS = ["a", "e", "i", "o", "u", "ae", "io", "ou"];
const CODAS = ["nd", "rk", "lt", "mb", "x", "zz", "rn", "sk", "th", "v"];

/** n distinct made-up words, none of which is in `avoid` (case-insensitive) or a substring of another */
export function makeMarkers(n, seed, avoid = "") {
  const rand = prng(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const hay = String(avoid).toLowerCase();
  const out = [];
  while (out.length < n) {
    const w = `${pick(ONSETS)}${pick(VOWELS)}${pick(CODAS)}${pick(VOWELS)}${pick(CODAS)}`;
    if (hay.includes(w) || out.some((o) => o.includes(w) || w.includes(o))) continue;
    out.push(w);
  }
  return out;
}

const cap = (w) => w[0].toUpperCase() + w.slice(1);

/**
 * The marker records: one marker word per section, unique. Homes are not planted: a marker's home is
 * read from the graph after the run (the section that holds it), so the gate judges what the system did.
 * What is planted is who records it and text that should, by the rulings, sit high:
 *   - the admin records at the root (sections start there, R11);
 *   - alice records an Operations matter, so the floor must not see it;
 *   - alice records one document with a pay section (the check should raise it) and a scheduling section,
 *     so a record split by home (R11) is exercised;
 *   - bob records at the floor: a control, whose marker anyone at the floor or above may see;
 *   - alice records a customer's credit hold (customer financials), which the check may raise.
 * Returns { records, markers: [{ word, record, section }] }.
 */
export function markerRecords(seed, { avoid = "", start = START - DAY } = {}) {
  const [a, b, c, d, e, f, g] = makeMarkers(7, seed, avoid).map(cap);
  const at = (i) => new Date(start + i * STEP).toISOString();
  const rec = (id, person, position, title, sections, i) => ({
    note: id,
    batch: "markers",
    person,
    document: { title, recorded_by: person, position, reason: RECORD_REASON, recorded_at: at(i), sections: sections.map((text) => ({ text })) },
  });
  const records = [
    rec("marker-1", "admin", "org", "Acquisition talks", [`The owners are in early talks to buy ${a} Machining; nobody outside the owners hears about it yet.`], 0),
    rec("marker-2", "admin", "org", "Bonus pool", [`The year-end bonus pool is set at 4 percent of payroll; the plan is filed under the name ${b}.`], 1),
    rec("marker-3", "alice", "ops", "New supplier", [`We are moving bar stock to ${c} Metals from February; the floor will hear when the first delivery is booked.`], 2),
    rec("marker-4", "alice", "ops", "Staffing for second shift", [
      `${d} Lindqvist starts on second shift next Monday at 23.75 an hour; keep the rate between supervisors and HR.`,
      `Second shift runs CNC 3 and CNC 5 from next Monday; ${e} covers setups until the new hire is trained.`,
    ], 3),
    rec("marker-5", "bob", "floor", "Saw blade swap", [`Swapped the Hyd-Mech blade; the old one goes back to ${f} for resharpening.`], 4),
    rec("marker-6", "alice", "ops", "Customer credit", [`${g} Instruments is on credit hold until their balance is paid down.`], 5),
  ];
  const words = [a, b, c, d, e, f, g];
  const where = [["marker-1", 0], ["marker-2", 0], ["marker-3", 0], ["marker-4", 0], ["marker-4", 1], ["marker-5", 0], ["marker-6", 0]];
  return { records, markers: words.map((word, i) => ({ word, record: where[i][0], section: where[i][1] })) };
}
