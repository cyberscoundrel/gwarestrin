/**
 * R16's conditions 2 and 3 for a source write, pure: does the record name the row, and does every value written
 * appear in it; with R18's exception for yes/no and fixed-choice columns, and R19's conditions for adding a row.
 * graph-rag checks these in code; no model decides them (R16). Conditions 1 (the recorder's authority, R11.7) and 4
 * (the row unchanged since it was read, commitRow) are checked where they always were.
 *
 * How "named", "matches" and "appears" are tested is the coordinator's choice under R16 and can change: every
 * definition is in DEFINITIONS and the small functions right below it, and nothing else in graph-rag decides them.
 *
 *   writeConditions({ text, key, fields, rows, primaryKey, current, shape, recordedAt }) -> {
 *     ok,                       // both hold, or nothing would change
 *     unchanged,                // the row already holds every value: nothing is written, so nothing is tested
 *     failed: 2 | 3 | null,     // the first that fails (3: some value; `values` says which, field by field)
 *     row: { ok, how, why },    // how: "named" (its key is in the text) or "only match" (the one row the text matches best)
 *     values: [{ column, value, ok, kind, why, write }],   // kind: number, date, boolean, choice, text, empty;
 *                                                          // write: the value as the column takes it (R18's canonical)
 *     passing, failing,         // the changing fields that hold condition 3, and those that don't, as { column: value }
 *     why,                      // one sentence for the recorder when one fails
 *   }
 *   addConditions({ text, table, data, rows, primaryKey, shape, recordedAt }) -> R19's, below
 *
 * text: the section's text; key: "system:table:row"; fields: { column: value }; rows: the table's rows (the
 * candidates for condition 2); primaryKey: the table's key column; current: the row as read, when there is one;
 * shape: the table's shape as its source declares it (model/sources.js tableShape: which columns are yes/no, which
 * take a fixed set of values, which a new row needs); recordedAt: when the record was put on record. A value the row
 * already holds isn't written, so condition 3 tests only the values that change the row.
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
  // date), or when it is the record's own day (a record carries the day it was put on record; "yesterday" and
  // "tomorrow" in the text count from it); a weekday or "mid December" gives no day, so it doesn't. Text appears when
  // it is a run of the section's words: case and runs of whitespace ignored, punctuation kept, starting and ending at
  // word edges, so a reworded sentence doesn't.
  // R18 (the user: "yes sure", 2026-11-11): a yes/no column, and a column with a fixed set of values, takes the
  // model's reading: the value must be one the column allows, and nothing more is asked of the text. Which columns
  // those are is declared, never inferred from the rows present (I-49): a column the source declaration marks
  // "boolean", or whose row the source serves as true/false (a SQL bit), is yes/no; a column the declaration gives a
  // list of values is fixed-choice.
  booleanWords: { true: ["true", "yes", "y", "1"], false: ["false", "no", "n", "0"] },
};

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

/**
 * R18: what a column takes, from the table's declared shape (model/sources.js tableShape) and the row as the source
 * serves it: "boolean" (declared so, or the source serves the cell as true/false), "choice" (the declaration lists
 * its values), or null (numbers, dates and text, checked against the record's words).
 */
export function columnKind(column, { shape = null, current = null } = {}) {
  const declared = shape?.columns?.[column];
  if (declared?.type === "boolean") return { kind: "boolean" };
  if (Array.isArray(declared?.values) && declared.values.length) return { kind: "choice", values: declared.values };
  if (current && typeof current[column] === "boolean") return { kind: "boolean" };
  return null;
}

/** a yes/no as the column takes it: true or false, from a boolean, 1/0 or yes/no words; undefined when it is none */
export function asBoolean(value) {
  if (typeof value === "boolean") return value;
  const w = normText(value);
  if (DEFINITIONS.booleanWords.true.includes(w)) return true;
  if (DEFINITIONS.booleanWords.false.includes(w)) return false;
  return undefined;
}

/** the record's own day as YYYY-MM-DD, and the days "yesterday" and "tomorrow" name when the text uses them */
function recordDays(text, recordedAt) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(recordedAt ?? ""));
  if (!m) return [];
  const day = (d) => new Date(Date.parse(`${m[1]}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
  const t = normText(text);
  return [day(0), ...(/\byesterday\b/.test(t) ? [day(-1)] : []), ...(/\btomorrow\b/.test(t) ? [day(1)] : [])];
}

/**
 * condition 3 for one value: does it appear in the text, or, for a yes/no or fixed-choice column (R18), is it one the
 * column allows. `write` is the value as the column takes it (a choice in its declared spelling, a yes/no as a boolean).
 */
export function valueAppears(value, text, { column = null, kind = null, recordedAt = null } = {}) {
  const t = normText(text);
  const name = column ?? "the column";
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return { ok: false, kind: "empty", why: `${name} would be emptied, which the record doesn't say` };
  if (kind?.kind === "boolean") {
    const b = asBoolean(value);
    return b === undefined ? { ok: false, kind: "boolean", why: `${name} takes yes or no, not "${String(value).slice(0, 40)}"` } : { ok: true, kind: "boolean", write: b };
  }
  if (kind?.kind === "choice") {
    const hit = kind.values.find((v) => normText(v) === normText(value));
    return hit === undefined ? { ok: false, kind: "choice", why: `${name} takes one of ${kind.values.join(", ")}, not "${String(value).slice(0, 40)}"` } : { ok: true, kind: "choice", write: hit };
  }
  if (typeof value === "boolean") return { ok: false, kind: "boolean", why: `${name} would be set ${value}, and ${name} isn't declared a yes/no column` };
  if (isNumeric(value)) {
    const n = numberOf(value);
    return numbersIn(text).includes(n) ? { ok: true, kind: "number", write: value } : { ok: false, kind: "number", why: `${name} would be ${n}, a number the record doesn't give` };
  }
  const s = String(value);
  const d = DATE_RE.exec(s.trim());
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const hit = datesIn(text).some((x) => x.month === m && x.day === day && (x.year === undefined || x.year === y)) || recordDays(text, recordedAt).includes(`${d[1]}-${d[2]}-${d[3]}`);
    return hit ? { ok: true, kind: "date", write: value } : { ok: false, kind: "date", why: `${name} would be ${s.slice(0, 10)}, a day the record doesn't give` };
  }
  if (hasRun(t, normText(s))) return { ok: true, kind: "text", write: value };
  return { ok: false, kind: "text", why: `${name} would read "${s.slice(0, 80)}${s.length > 80 ? "…" : ""}", which isn't the record's own words` };
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

/** the values of a write, each through condition 3 with its column's kind */
const checkValues = (entries, text, { shape, current, recordedAt }) => entries.map(([column, value]) => ({ column, value, ...valueAppears(value, text, { column, kind: columnKind(column, { shape, current }), recordedAt }) }));
const asFields = (vs) => Object.fromEntries(vs.map((v) => [v.column, v.ok ? v.write : v.value]));

/**
 * R16 conditions 2 and 3 together, field by field: `failed` and `why` name the first that fails; when it is 3,
 * `passing` holds the fields that may still land and `failing` those that may not.
 */
export function writeConditions({ text, key, fields, rows = [], primaryKey = null, current = null, shape = null, recordedAt = null }) {
  const changing = Object.entries(fields ?? {}).filter(([column, value]) => !(current && column in current && sameCell(current[column], value)));
  if (current && !changing.length) return { ok: true, unchanged: true, failed: null, row: { ok: true, how: "unchanged" }, values: [], passing: {}, failing: {}, why: null };
  const row = rowNamed({ text, key, rows, primaryKey });
  const values = checkValues(changing, text, { shape, current, recordedAt });
  const bad = values.filter((v) => !v.ok);
  const failed = !row.ok ? 2 : bad.length ? 3 : null;
  const why = failed === 2 ? `It isn't clear which row: ${row.why}.` : failed === 3 ? `Not every value is in your words: ${bad.map((v) => v.why).join("; ")}.` : null;
  return { ok: failed === null, failed, row, values, passing: asFields(values.filter((v) => v.ok)), failing: asFields(bad), why };
}

/**
 * R19's conditions for adding a row (the user, 2026-11-11; the coordinator's reading), in place of "the row is named":
 *   - every value is from the record (condition 3, with R18's exception), field by field;
 *   - the key is the source's to make: a value the worker gives for the key column is dropped (`dropped`), never sent;
 *   - every column the declaration says a new row needs is given, or the source fills it (shape.required, shape.defaults);
 *   - no existing row already holds these values (`existing`, that row: the piece is then already in the source).
 * One piece adding at most one row however often it is filed is the caller's (filing.js), which knows the piece.
 * Returns { ok, failed: "values" | "required" | null, values, passing, failing, data, dropped, missing, existing, why }.
 */
export function addConditions({ text, table = null, data, rows = [], primaryKey = null, shape = null, recordedAt = null }) {
  const entries = Object.entries(data ?? {}).filter(([c]) => c !== primaryKey);
  const dropped = primaryKey && data && primaryKey in data ? [primaryKey] : [];
  const values = checkValues(entries, text, { shape, current: null, recordedAt });
  const bad = values.filter((v) => !v.ok);
  const given = new Set(entries.filter(([, v]) => v !== null && v !== undefined && !(typeof v === "string" && !v.trim())).map(([c]) => c));
  const missing = (shape?.required ?? []).filter((c) => c !== primaryKey && !given.has(c) && !(shape?.defaults ?? []).includes(c));
  const out = asFields(values.filter((v) => v.ok));
  const existing = entries.length ? rows.find((r) => entries.every(([c, v]) => c in r && sameCell(r[c], out[c] ?? v))) ?? null : null;
  const where = table ? ` to ${table}` : "";
  const failed = bad.length ? "values" : missing.length ? "required" : null;
  const why = failed === "values" ? `Not every value is in your words: ${bad.map((v) => v.why).join("; ")}.` : failed === "required" ? `A new row${where} needs ${missing.join(", ")}, which the record doesn't give.` : null;
  return { ok: failed === null, failed, values, passing: out, failing: asFields(bad), data: out, dropped, missing, existing: existing && primaryKey ? { key: existing[primaryKey], row: existing } : existing ? { key: null, row: existing } : null, why };
}
