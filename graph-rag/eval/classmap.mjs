// The eval's class map (I-2, I-32): the authority M0 gives each class, from its source table. The record_table the model
// set; else, harness only, the one table its evidence names when that table exists in the source. Nothing is written on
// the class, so a model leaving record_table empty stays visible; the result says which way each class was mapped.

/** rows: { _class_key, _class_name, _record_table, _evidence }; sourceTables: lower-cased system:table; map: M0 */
export function classMapFrom(rows, sourceTables, map) {
  const mapKey = (t) => Object.keys(map).find((k) => k.toLowerCase() === String(t ?? "").toLowerCase());
  const out = { classes: {}, by_record_table: [], by_evidence: [], unmapped_with_table: [], record_table_not_in_map: [], no_table: [] };
  for (const c of rows) {
    const name = c._class_name ?? c._class_key;
    if (c._record_table) {
      const k = mapKey(c._record_table);
      if (k) (out.classes[c._class_key] = { authority: map[k] }), out.by_record_table.push({ class: name, table: k });
      else out.record_table_not_in_map.push({ class: name, table: c._record_table });
      continue;
    }
    let ev = [];
    try {
      ev = typeof c._evidence === "string" ? JSON.parse(c._evidence || "[]") : (c._evidence ?? []);
    } catch {}
    const named = [...new Set((Array.isArray(ev) ? ev : []).filter((x) => x?.kind === "table" && x.ref).map((x) => String(x.ref).toLowerCase()))];
    const k = named.length === 1 && sourceTables.has(named[0]) ? mapKey(named[0]) : null;
    if (k) (out.classes[c._class_key] = { authority: map[k] }), out.by_evidence.push({ class: name, table: k });
    else if (named.length) out.unmapped_with_table.push({ class: name, tables: named });
    else out.no_table.push(name);
  }
  return out;
}
