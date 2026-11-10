// The class tree (docs/build/integrate.md, 2.3), duplicate classes (2.4) and instances checked against the
// source (2.5). Pure.
//
// A class: { key, name, parents, home, description, evidence, rows_are_nodes, record_table, status }, as
// model/classes.js normalizes it. An instance: { rid, name, key?, classes: [classKey], homes? }.
import { prng } from "./records.mjs";

export const ROOTS = ["agent", "commitment", "event", "resource"];

/** a class name folded for matching across runs: lower case, spaces, a plural s dropped */
export const foldName = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ");

const evidenceText = (ev) =>
  (ev ?? [])
    .map((e) => (typeof e === "string" ? e : [e.kind, e.ref ?? e.table ?? e.record ?? e.source, e.note].filter(Boolean).join(" ")))
    .slice(0, 3)
    .join("; ");

/**
 * The one-page tree, in Markdown: each class under each of its parents (marked "also under" after the
 * first), with home, instance count, rows-become-nodes, source table and evidence, and a blank mark column.
 */
export function renderTree(classes, counts = {}, { title = "Class tree" } = {}) {
  const live = classes.filter((c) => c.status !== "retired");
  const children = new Map();
  for (const c of live) for (const p of c.parents ?? []) {
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(c);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const shown = new Set();
  const lines = [`# ${title}`, "", `${live.length} classes (${live.filter((c) => !ROOTS.includes(c.key)).length} below the roots). Mark each line: right, wrong, or missing (add missing classes at the end).`, "", "| Mark | Class | Home | Instances | Rows are nodes | Source table | Evidence |", "|---|---|---|--:|---|---|---|"];
  const walk = (c, depth, path) => {
    const again = shown.has(c.key);
    const others = (c.parents ?? []).filter((p) => p !== path.at(-1));
    const name = `${"&nbsp;&nbsp;".repeat(depth * 2)}${depth ? "└ " : ""}**${c.name}**${again ? " (again)" : ""}${others.length && depth ? ` (also under ${others.join(", ")})` : ""}`;
    lines.push(`|  | ${name} | ${c.home ?? ""} | ${counts[c.key] ?? 0} | ${c.rows_are_nodes ? "yes" : "no"} | ${c.record_table ?? ""} | ${evidenceText(c.evidence).replace(/\|/g, "/")} |`);
    if (again || path.includes(c.key)) return;
    shown.add(c.key);
    for (const k of children.get(c.key) ?? []) walk(k, depth + 1, [...path, c.key]);
  };
  const byKey = new Map(live.map((c) => [c.key, c]));
  for (const r of ROOTS) walk(byKey.get(r) ?? { key: r, name: r, parents: [], home: "everyone" }, 0, []);
  const orphans = live.filter((c) => !shown.has(c.key) && !ROOTS.includes(c.key));
  if (orphans.length) {
    lines.push("", "Classes that reach no root:", "");
    for (const c of orphans) lines.push(`- ${c.name} (parents: ${(c.parents ?? []).join(", ") || "none"})`);
  }
  lines.push("", "Missing classes:", "", "- ", "");
  return lines.join("\n");
}

/** the share of marks: { right, wrong, missing, unmarked } from [{ key, mark }] */
export function markShares(marks, classes) {
  const live = classes.filter((c) => c.status !== "retired" && !ROOTS.includes(c.key));
  const by = new Map((marks ?? []).map((m) => [m.key, m.mark]));
  const out = { right: 0, wrong: 0, unmarked: 0, missing: (marks ?? []).filter((m) => m.mark === "missing").length, classes: live.length };
  for (const c of live) {
    const m = by.get(c.key);
    if (m === "right") out.right++;
    else if (m === "wrong") out.wrong++;
    else out.unmarked++;
  }
  return out;
}

/** a class's identity across runs: its folded name, or its source table when it has one */
const ids = (c) => [`n:${foldName(c.name)}`, ...(c.record_table ? [`t:${c.record_table}`] : [])];

/**
 * How much of the tree survives across runs (three runs of one setup): classes matched by folded name or
 * source table, and (class, parent) edges by folded names. Returns { classes, edges, inAll, onlyOne }.
 */
export function stability(runs) {
  if (!runs.length) return { runs: 0, classes: 0, inAll: 0, edgesInAll: 0, edges: 0, onlyOne: [] };
  const groups = []; // [{ ids: Set, runs: Set, names: Set }]
  runs.forEach((classes, r) => {
    for (const c of classes.filter((x) => x.status !== "retired" && !ROOTS.includes(x.key))) {
      const mine = ids(c);
      let g = groups.find((x) => mine.some((i) => x.ids.has(i)));
      if (!g) groups.push((g = { ids: new Set(), runs: new Set(), names: new Set() }));
      mine.forEach((i) => g.ids.add(i));
      g.runs.add(r);
      g.names.add(c.name);
    }
  });
  const edgeRuns = new Map();
  runs.forEach((classes, r) => {
    const byKey = new Map(classes.map((c) => [c.key, c]));
    for (const c of classes) for (const p of c.parents ?? []) {
      const e = `${foldName(c.name)} < ${foldName(byKey.get(p)?.name ?? p)}`;
      if (!edgeRuns.has(e)) edgeRuns.set(e, new Set());
      edgeRuns.get(e).add(r);
    }
  });
  const inAll = groups.filter((g) => g.runs.size === runs.length).length;
  const edgesInAll = [...edgeRuns.values()].filter((s) => s.size === runs.length).length;
  return {
    runs: runs.length,
    classes: groups.length,
    inAll,
    shareInAll: groups.length ? inAll / groups.length : 0,
    edges: edgeRuns.size,
    edgesInAll,
    shareEdgesInAll: edgeRuns.size ? edgesInAll / edgeRuns.size : 0,
    onlyOne: groups.filter((g) => g.runs.size === 1).map((g) => [...g.names].join(" / ")),
  };
}

const tokens = (s) => new Set(foldName(s).split(" ").filter(Boolean));
const jaccard = (a, b) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
};

/**
 * Pairs that may be duplicates, for a person to confirm (2.4): names close (token overlap of half or more,
 * plurals folded), the same source table, or most instances shared. `instancesOf`: classKey -> [rid].
 */
export function duplicateCandidates(classes, instancesOf = new Map(), { nameAt = 0.5, sharedAt = 0.5 } = {}) {
  const live = classes.filter((c) => c.status !== "retired" && !ROOTS.includes(c.key));
  const out = [];
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      const why = [];
      const nameScore = jaccard(tokens(a.name), tokens(b.name));
      if (nameScore >= nameAt) why.push(`names ${Math.round(nameScore * 100)}% alike`);
      if (a.record_table && a.record_table === b.record_table) why.push(`both from ${a.record_table}`);
      const ia = new Set(instancesOf.get(a.key) ?? []);
      const ib = new Set(instancesOf.get(b.key) ?? []);
      const small = Math.min(ia.size, ib.size);
      const shared = [...ia].filter((x) => ib.has(x)).length;
      if (small && shared / small >= sharedAt) why.push(`${shared} of ${small} instances shared`);
      if (why.length) out.push({ a: a.key, b: b.key, why });
    }
  return out;
}

/** confirmed duplicates as a share of classes: `confirmed` is [{ a, b }] a person marked */
export const duplicateShare = (confirmed, classes) => {
  const live = classes.filter((c) => c.status !== "retired" && !ROOTS.includes(c.key)).length;
  return { confirmed: confirmed.length, classes: live, share: live ? confirmed.length / live : 0 };
};

/** the primitives a class reaches, through any of its parents */
export function primitivesOf(key, byKey) {
  const out = new Set();
  const seen = new Set();
  const walk = (k) => {
    if (seen.has(k)) return;
    seen.add(k);
    if (ROOTS.includes(k)) out.add(k);
    for (const p of byKey.get(k)?.parents ?? []) walk(p);
  };
  walk(key);
  return [...out];
}

const INACTIVE = /^(inactive|terminated|closed|retired|deleted)$/i;

/**
 * Instances checked against the source (2.5): a seeded sample of `per` under each primitive, plus every
 * instance with several classes. Mechanical checks: the key's table is the source table of one of its classes
 * that has one; the row exists; the row isn't inactive. The rest is listed for a person.
 * `rows`: key -> row (from the after-dump). Returns { sample: [{ rid, name, key, classes, primitive, problems }] }.
 */
export function placementSample(instances, classes, rows, { per = 10, seed = 1 } = {}) {
  const byKey = new Map(classes.map((c) => [c.key, c]));
  const rand = prng(seed);
  const chosen = new Map();
  for (const prim of ROOTS) {
    const under = instances.filter((i) => i.classes.some((k) => primitivesOf(k, byKey).includes(prim)));
    const pool = [...under];
    for (let n = 0; n < per && pool.length; n++) {
      const i = pool.splice(Math.floor(rand() * pool.length), 1)[0];
      chosen.set(i.rid, { ...i, primitive: prim });
    }
  }
  for (const i of instances) if (i.classes.length > 1 && !chosen.has(i.rid)) chosen.set(i.rid, { ...i, primitive: "several classes" });
  const sample = [...chosen.values()].map((i) => {
    const problems = [];
    if (i.key) {
      const table = i.key.split(":").slice(0, 2).join(":");
      const tables = i.classes.map((k) => byKey.get(k)?.record_table).filter(Boolean);
      if (tables.length && !tables.includes(table)) problems.push(`key ${i.key} is not from ${tables.join(" or ")}`);
      const row = rows.get(i.key);
      if (!row) problems.push(`no row ${i.key}`);
      else if (Object.entries(row).some(([c, v]) => /status|active/i.test(c) && (v === false || INACTIVE.test(String(v))))) problems.push(`row ${i.key} is inactive`);
    }
    return { rid: i.rid, name: i.name, key: i.key ?? null, classes: i.classes, primitive: i.primitive, problems };
  });
  return { sample, flagged: sample.filter((s) => s.problems.length).length };
}
