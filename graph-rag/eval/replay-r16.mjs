#!/usr/bin/env node
// R16's write rule replayed offline over finished runs (no model calls): every filing-log entry that carried fields
// for a row, put through the order a source write now takes, with each run's own record text, rows (before.json) and
// recorder, and reported per run and against the labels.
//
//   node graph-rag/eval/replay-r16.mjs <runs dir> A-1 A-2 ... [--json out.json] [--r18] [--labels]
//   --r18: with the declared shapes (test-sql/data.mjs shapes: R18's yes/no and fixed-choice columns), the record's own
//          day counting as a date, and per field (I-50: an entry whose row is named lands what holds; "part")
//   --labels:   the entries tied to a labelled piece or a must-not line, each with what R16 does to it
//
// The order, for each entry (I-44, I-45):
//   1. the table takes no writes                                -> Proposed (R2, as now)
//   2. I-39, in one of three forms (each run three times):
//        built:    the section's home is stricter than the source's read home -> Proposed
//        narrowed: the section's home is stricter than its recorder's own position (the check raised it), R17 -> Proposed
//        none:     no I-39
//   3. R16 condition 1, the recorder's authority over the table (M0)      -> Proposed (as now; I-44 reads it so)
//   4. no such row (a worker naming a row to create)            -> Held (as now: fileToSource updates existing rows)
//   5. R16 conditions 2 and 3 (model/write-conditions.js)       -> Held, by condition, and for 3 by the kind of value
//   6. otherwise it lands (condition 4, the row unchanged since read, is checked at the write and can't be replayed)
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { writeConditions } from "../src/model/write-conditions.js";
import { normalizeSource, tableShape } from "../src/model/sources.js";
import { shapes } from "../../test-sql/data.mjs";

const DECL = normalizeSource({ system: "mssql", read: { via: "dab-mcp", url: "http://r/mcp" }, commit: { via: "dab-mcp", url: "http://w/mcp", tables: Object.entries(shapes()).map(([name, sh]) => ({ ...sh, name })), actions: ["create", "update", "delete"] } });
let R18 = false;
import { NOTES } from "./labels.mjs";
import { atOrAbove, sees, EVERYONE } from "./positions.mjs";
import { COMMIT, MAP } from "./s0.mjs";

const VARIANTS = ["built", "narrowed", "none"];

/** one entry's outcome under R16 with an I-39 variant: { outcome, by, kinds? } */
export function decide(e, { text, recorderPos, sectionHome, rows, primaryKey, positions, readHome = EVERYONE, recordedAt = null }, variant) {
  const [, table] = String(e.target.key).split(":");
  if (!COMMIT.tables[table]?.includes("update")) return { outcome: "proposed", by: "not writable" };
  if (variant === "built" && !sees(positions, readHome, sectionHome)) return { outcome: "proposed", by: "I-39" };
  if (variant === "narrowed" && sectionHome && recorderPos && sectionHome !== recorderPos && atOrAbove(positions, sectionHome, recorderPos)) return { outcome: "proposed", by: "I-39 (raised)" };
  const authority = MAP[`mssql:${table}`];
  if (!authority || !recorderPos || !atOrAbove(positions, recorderPos, authority)) return { outcome: "proposed", by: "condition 1" };
  const current = rows.find((r) => String(r[primaryKey]).toLowerCase() === String(e.target.key).split(":").slice(2).join(":").toLowerCase());
  if (!current) return { outcome: "held", by: "no such row" };
  const c = writeConditions({ text, key: e.target.key, fields: e.target.fields, rows, primaryKey, current, ...(R18 ? { shape: tableShape(DECL, table), recordedAt } : {}) });
  if (c.unchanged) return { outcome: "lands", by: "already" };
  if (c.failed === 2) return { outcome: "held", by: "condition 2", why: c.why };
  if (R18 && c.failed === 3 && Object.keys(c.passing).length) return { outcome: "lands", by: "part", kinds: [...new Set(c.values.filter((v) => !v.ok).map((v) => v.kind))], why: c.why };
  if (c.failed === 3) return { outcome: "held", by: "condition 3", kinds: [...new Set(c.values.filter((v) => !v.ok).map((v) => v.kind))], why: c.why };
  return { outcome: "lands", by: "conditions hold" };
}

/** the entries of one run with what R16 does to each, under each variant */
export function replayRun(dir) {
  const snap = JSON.parse(readFileSync(`${dir}/snapshot.json`, "utf8"));
  const before = snap.before ?? JSON.parse(readFileSync(`${dir}/before.json`, "utf8"));
  const report = existsSync(`${dir}/report.json`) ? JSON.parse(readFileSync(`${dir}/report.json`, "utf8")) : null;
  const sections = new Map(snap.sections.map((s) => [s.rid, s]));
  const docs = new Map((snap.documents ?? []).map((d) => [d._doc_id, d]));
  const labelOf = new Map();
  for (const n of report?.outcomes?.notes ?? []) for (const p of n.pieces) if (p.entry) labelOf.set(p.entry, { note: n.note, label: p.label, verdict: p.verdict, about: p.about });
  const out = [];
  for (const e of snap.entries) {
    if (!e.target?.key || !e.target.fields || !Object.keys(e.target.fields).length) continue;
    const [, table] = String(e.target.key).split(":");
    const t = before[table];
    const section = sections.get(e.section);
    const ctx = { recordedAt: docs.get(e.record)?._recorded_at ?? null, text: section?.text ?? "", recorderPos: docs.get(e.record)?._record_position ?? null, sectionHome: section?.home ?? e.home, rows: t?.rows ?? [], primaryKey: t?.primaryKey?.[0] ?? null, positions: snap.positions };
    const note = snap.meta?.noteOf?.[e.record] ?? null;
    const mustNot = NOTES.find((n) => n.id === note)?.mustNot?.some((m) => m.change && m.change.toLowerCase() === String(e.target.key).toLowerCase()) ?? false;
    out.push({ entry: e.id, note, was: e.outcome, key: e.target.key, fields: e.target.fields, text: ctx.text, recorderPos: ctx.recorderPos, sectionHome: ctx.sectionHome, label: labelOf.get(e.id) ?? null, mustNot, r16: Object.fromEntries(VARIANTS.map((v) => [v, decide(e, ctx, v)])) });
  }
  return out;
}

/** counts for one run under one variant: lands, Held by condition (and by kind for 3), Proposed by reason */
export function tally(rows, variant) {
  const c = { entries: rows.length, lands: 0, already: 0, part: 0, held: {}, heldKinds: {}, proposed: {} };
  for (const r of rows) {
    const d = r.r16[variant];
    if (d.outcome === "lands") (c.lands++, d.by === "already" && c.already++, d.by === "part" && c.part++);
    else if (d.outcome === "held") {
      c.held[d.by] = (c.held[d.by] ?? 0) + 1;
      for (const k of d.kinds ?? []) c.heldKinds[k] = (c.heldKinds[k] ?? 0) + 1;
    } else c.proposed[d.by] = (c.proposed[d.by] ?? 0) + 1;
  }
  return c;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, ...argv] = process.argv.slice(2);
  R18 = argv.includes("--r18");
  const showLabels = argv.includes("--labels");
  const rest = argv.filter((a) => a !== "--r18" && a !== "--labels");
  const jsonAt = rest.indexOf("--json");
  const runs = (jsonAt >= 0 ? rest.slice(0, jsonAt) : rest).filter(Boolean);
  const all = {};
  for (const r of runs) all[r] = replayRun(`${root}/${r}`);
  if (jsonAt >= 0) writeFileSync(rest[jsonAt + 1], JSON.stringify(all, null, 2));
  for (const v of VARIANTS) {
    console.log(`\n## I-39 ${v}\n`);
    console.log("| run | entries | lands (already, part) | Held: cond 2 | Held: cond 3 (kinds) | Held: no such row | Proposed: I-39 | Proposed: cond 1 | Proposed: not writable |");
    console.log("|---|--:|--:|--:|--:|--:|--:|--:|--:|");
    for (const r of runs) {
      const c = tally(all[r], v);
      const kinds = Object.entries(c.heldKinds).map(([k, n]) => `${k} ${n}`).join(", ");
      console.log(`| ${r} | ${c.entries} | ${c.lands} (${c.already}, ${c.part}) | ${c.held["condition 2"] ?? 0} | ${c.held["condition 3"] ?? 0}${kinds ? ` (${kinds})` : ""} | ${c.held["no such row"] ?? 0} | ${(c.proposed["I-39"] ?? 0) + (c.proposed["I-39 (raised)"] ?? 0)} | ${c.proposed["condition 1"] ?? 0} | ${c.proposed["not writable"] ?? 0} |`);
    }
  }
  if (showLabels) {
    const say = (d) => (d.outcome === "lands" ? (d.by === "already" ? "lands (already)" : "lands") : `${d.outcome} (${d.by}${d.kinds ? `: ${d.kinds.join(", ")}` : ""})`);
    console.log("\n## Entries tied to a label or a must-not line\n");
    console.log("| run | note | label / verdict | must-not | was | row and values | built | narrowed (R17) | none |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const r of runs)
      for (const e of all[r]) {
        if (!e.label && !e.mustNot) continue;
        console.log(`| ${r} | ${e.note} | ${e.label ? `${e.label.label} / ${e.label.verdict}` : "-"} | ${e.mustNot ? "yes" : ""} | ${e.was} | ${e.key.replace(/^mssql:dbo_/, "")} ${JSON.stringify(e.fields).slice(0, 70).replace(/\|/g, "/")} | ${say(e.r16.built)} | ${say(e.r16.narrowed)} | ${say(e.r16.none)} |`);
      }
  }
}
