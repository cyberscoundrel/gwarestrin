/**
 * R16's conditions 2 and 3 for a source write, pure: does the record name the row, and does every value written
 * appear in it. graph-rag checks these in code; no model decides them (R16). Conditions 1 (the recorder's
 * authority, R11.7) and 4 (the row unchanged since it was read, commitRow) are checked where they always were.
 *
 * How "named", "matches" and "appears" are tested is the coordinator's choice under R16 and can change: every
 * definition is in DEFINITIONS and the small functions right below it, and nothing else in graph-rag decides them.
 *
 *   writeConditions({ text, key, fields, rows, primaryKey, current }) -> {
 *     ok,                       // both hold, or nothing would change
 *     unchanged,                // the row already holds every value: nothing is written, so nothing is tested
 *     failed: 2 | 3 | null,     // the first that fails
 *     row: { ok, how, why },    // how: "named" (its key is in the text) or "only match" (the one row the text matches best)
 *     values: [{ column, value, ok, kind, why }],   // kind: number, date, boolean, closed, text, empty
 *     why,                      // one sentence for the recorder when one fails
 *   }
 *
 * text: the section's text; key: "system:table:row"; fields: { column: value }; rows: the table's rows (the
 * candidates for condition 2); primaryKey: the table's key column; current: the row as read, when there is one. A value
 * the row already holds isn't written, so condition 3 tests only the values that change the row.
 */

export const DEFINITIONS = {
  // condition 2. A row is named when its key value appears in the text (a number as a number, text as a run of words).
  // Failing that, it is the only match when it has more of its own cell values in the text than any other row. A
  // cell counts when it is text of at least this many characters, or a whole number of at least this many digits
  // (so small counts and flags don't make rows look alike).
  matchMinChars: 3,
  matchMinDigits: 3,
  // condition 3. A number appears when the text holds the same number, separators removed (1,200 = 1200, 21.50 = 21.5).
  // A date appears when the text gives its day and month ("December 12", "12 Dec", "12/12" as month/day, or the ISO
  // date); a weekday, "today" or "mid December" gives no day, so it doesn't. Text appears when it is a run of the
  // section's words: case and runs of whitespace ignored, punctuation kept, starting and ending at word edges, so a
  // reworded sentence doesn't. A boolean never appears (true/false aren't words a note uses: the measured gap,
  // BOOLEANS below). A closed-set value (a column whose rows hold at most closedSetMax distinct values, like a
  // Status) is tested as text, and reported apart, so the replay can measure it.
  closedSetMax: 8,
  // the treatment for booleans and closed-set values: null (they don't appear, so the piece is Held and the recorder
  // asked) until the coordinator picks one. The replay's proposal for booleans is columnWords, below (I-45); for
  // closed sets it proposes none.
  booleans: null,
  closedSets: null,
};

/** the words that name a column ("Certs_Required" -> ["certs"]): its parts, less the ones that only say it's a flag */
const FLAG_WORDS = new Set(["is", "has", "required", "flag", "needed", "yn", "bool", "ind"]);
export const columnWords = (column) =>
  String(column ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3 && !FLAG_WORDS.has(w));

/**
 * The boolean treatment the replay proposes (I-45), for DEFINITIONS.booleans: a column set true appears when a sentence
 * of the record names the column's own words (Certs_Required: "certs") with no negation in that sentence; set false,
 * when such a sentence does negate it ("no certs", "doesn't need certs"). Returns why it counts, or null.
 */
export function booleanByColumnWords(value, text, column) {
  const words = columnWords(column);
  if (!words.length) return null;
  const negated = /\b(no|not|never|without|none)\b|n't\b/;
  for (const sentence of normText(text).split(/(?<=[.;!?])\s+/)) {
    if (!words.every((w) => new RegExp(`\\b${w}`).test(sentence))) continue;
    if (negated.test(sentence) === !value) return `the record says "${sentence.slice(0, 80)}"`;
  }
  return null;
}

/** text as compared: lower case, whitespace runs as one space, curly quotes and dashes as plain ones */
export const normText = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

const isWordChar = (c) => /[\p{L}\p{N}]/u.test(c ?? "");

/** does `run` occur in `text` as a run that starts and ends at word edges (both already normalized) */
export function hasRun(text, run) {
  if (!run) return false;
  let i = text.indexOf(run);
  while (i >= 0) {
    const before = text[i - 1];
    const after = text[i + run.length];
    const startsOk = !isWordChar(run[0]) || !isWordChar(before);
    const endsOk = !isWordChar(run[run.length - 1]) || !isWordChar(after);
    if (startsOk && endsOk) return true;
    i = text.indexOf(run, i + 1);
  }
  return false;
}

/** the numbers a text gives, separators removed: "1,200 pieces at 21.50" -> [1200, 21.5] */
export function numbersIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/(?<![\p{L}\p{N}.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\p{N}])|(?<![\p{L}\p{N}.,])-?\d+(?:\.\d+)?(?![\p{N}])/gu)) out.push(Number(m[0].replace(/,/g, "")));
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthOf = (w) => {
  const i = MONTHS.indexOf(String(w).toLowerCase().slice(0, 3));
  return i >= 0 ? i + 1 : null;
};

/** the days a text gives with their month: [{ month, day, year? }] ("December 12", "12 Dec", "12/12", "2026-12-12") */
export function datesIn(text) {
  const t = String(text ?? "");
  const out = [];
  const month = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
  for (const m of t.matchAll(new RegExp(`\\b${month}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "gi"))) out.push({ month: monthOf(m[1]), day: Number(m[2]), ...(m[3] ? { year: Number(m[3]) } : {}) });
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${month}\\b(?:,?\\s+(\\d{4}))?`, "gi"))) out.push({ month: monthOf(m[2]), day: Number(m[1]), ...(m[3] ? { year: Number(m[3]) } : {}) });
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) });
  for (const m of t.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])/g)) out.push({ month: Number(m[1]), day: Number(m[2]), ...(m[3] ? { year: Number(m[3].length === 2 ? `20${m[3]}` : m[3]) } : {}) });
  return out.filter((d) => d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= 31);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+Z?)?$/;
const isNumeric = (v) => typeof v === "number" || (typeof v === "string" && /^-?\d[\d,]*(\.\d+)?$/.test(v.trim()));
const numberOf = (v) => (typeof v === "number" ? v : Number(String(v).trim().replace(/,/g, "")));

/** the distinct values a column holds across the rows, when there are few enough to call it a closed set */
export function closedSet(rows, column) {
  const seen = new Set();
  for (const r of rows ?? []) {
    const v = r?.[column];
    if (v === null || v === undefined || typeof v !== "string") continue;
    seen.add(normText(v));
    if (seen.size > DEFINITIONS.closedSetMax) return null;
  }
  return seen.size ? seen : null;
}

/** condition 3 for one value: does it appear in the text */
export function valueAppears(value, text, { column = null, rows = [] } = {}) {
  const t = normText(text);
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return { ok: false, kind: "empty", why: `${column ?? "the column"} would be emptied, which the record doesn't say` };
  if (typeof value === "boolean") {
    const treated = DEFINITIONS.booleans?.(value, t, column);
    if (treated) return { ok: true, kind: "boolean", why: treated };
    return { ok: false, kind: "boolean", why: `${column ?? "the column"} would be set ${value}, and a yes or no doesn't appear in the record as written` };
  }
  if (isNumeric(value)) {
    const n = numberOf(value);
    return numbersIn(text).includes(n) ? { ok: true, kind: "number" } : { ok: false, kind: "number", why: `${column ?? "the column"} would be ${n}, a number the record doesn't give` };
  }
  const s = String(value);
  const d = DATE_RE.exec(s.trim());
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const hit = datesIn(text).some((x) => x.month === m && x.day === day && (x.year === undefined || x.year === y));
    return hit ? { ok: true, kind: "date" } : { ok: false, kind: "date", why: `${column ?? "the column"} would be ${s.slice(0, 10)}, a day the record doesn't give` };
  }
  const set = column ? closedSet(rows, column) : null;
  const kind = set && set.has(normText(s)) ? "closed" : "text";
  if (hasRun(t, normText(s))) return { ok: true, kind };
  if (kind === "closed") {
    const treated = DEFINITIONS.closedSets?.(s, t, column);
    if (treated) return { ok: true, kind, why: treated };
  }
  return { ok: false, kind, why: `${column ?? "the column"} would read "${s.slice(0, 80)}${s.length > 80 ? "…" : ""}", which isn't the record's own words` };
}

/** does the text give a row's cell (for condition 2's "only match") */
function cellIn(text, t, v) {
  if (v === null || v === undefined || typeof v === "boolean") return false;
  if (typeof v === "number") return Number.isInteger(v) && String(Math.abs(v)).length >= DEFINITIONS.matchMinDigits && numbersIn(text).includes(v);
  const s = normText(v);
  if (s.length < DEFINITIONS.matchMinChars) return false;
  if (DATE_RE.test(String(v).trim())) return false; // dates are values, not names
  return hasRun(t, s);
}

/** condition 2: is the row named in the text, or the only row that matches what the text names */
export function rowNamed({ text, key, rows = [], primaryKey = null }) {
  const t = normText(text);
  const rowPart = String(key ?? "").split(":").slice(2).join(":");
  const keyNamed = isNumeric(rowPart) ? numbersIn(text).includes(numberOf(rowPart)) : hasRun(t, normText(rowPart));
  if (keyNamed) return { ok: true, how: "named" };
  if (!primaryKey || !rows.length) return { ok: false, how: null, why: `the record doesn't name ${rowPart} (its key isn't in the text), and there are no rows to tell it apart from` };
  const score = (r) => Object.entries(r).filter(([c, v]) => c !== primaryKey && cellIn(text, t, v)).length;
  const target = rows.find((r) => String(r[primaryKey]).toLowerCase() === rowPart.toLowerCase());
  if (!target) return { ok: false, how: null, why: `there is no row ${rowPart} to write` };
  const mine = score(target);
  const rivals = rows.filter((r) => r !== target && score(r) >= mine && mine > 0).map((r) => String(r[primaryKey]));
  if (mine > 0 && !rivals.length) return { ok: true, how: "only match" };
  if (mine === 0) return { ok: false, how: null, why: `the record doesn't name ${rowPart}: neither its key nor anything of that row is in the text` };
  return { ok: false, how: null, why: `the record doesn't say which row it means: ${rowPart} and ${rivals.slice(0, 3).join(", ")}${rivals.length > 3 ? " and others" : ""} match it equally` };
}

/** a value the row already holds (numbers by value, dates by day, text by its words in any case) */
export function sameCell(a, b) {
  if ((a ?? null) === null || (b ?? null) === null) return (a ?? null) === (b ?? null);
  if (typeof a === "boolean" || typeof b === "boolean") return String(a).toLowerCase() === String(b).toLowerCase();
  if (isNumeric(a) && isNumeric(b)) return numberOf(a) === numberOf(b);
  const da = DATE_RE.exec(String(a).trim());
  const db = DATE_RE.exec(String(b).trim());
  if (da && db) return da.slice(1, 4).join("-") === db.slice(1, 4).join("-");
  return normText(a) === normText(b);
}

/** R16 conditions 2 and 3 together; `failed` and `why` name the first that fails */
export function writeConditions({ text, key, fields, rows = [], primaryKey = null, current = null }) {
  const changing = Object.entries(fields ?? {}).filter(([column, value]) => !(current && column in current && sameCell(current[column], value)));
  if (current && !changing.length) return { ok: true, unchanged: true, failed: null, row: { ok: true, how: "unchanged" }, values: [], why: null };
  const row = rowNamed({ text, key, rows, primaryKey });
  const values = changing.map(([column, value]) => ({ column, value, ...valueAppears(value, text, { column, rows }) }));
  const bad = values.filter((v) => !v.ok);
  const failed = !row.ok ? 2 : bad.length ? 3 : null;
  const why = failed === 2 ? `It isn't clear which row: ${row.why}.` : failed === 3 ? `Not every value is in your words: ${bad.map((v) => v.why).join("; ")}.` : null;
  return { ok: failed === null, failed, row, values, why };
}
