/**
 * A worker thread's own tools: its writes, links, relationships, merges, folds, deletions and corrections, and
 * the MCP registration of those tools.
 */
import { effectiveHome, EVERYONE, homeName, visibleHomes } from "./positions.js";
import { parseValidUntil } from "./extent.js";
import { normalize, thingClash, normalizeRel, parseMentions, thingName } from "./things.js";
import { z } from "zod";
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { embedBatch } from "./models.js";
import { homeFilter, positionMap, resolveWriteHome, SCOPED } from "./scope.js";
import { liftRefusal, workerWriteFloor } from "./floor.js";
import { deleteEntry, foldEntries, mergeThings, proposalFields, queueWrite, typedUpdate, upsertEntities } from "./write.js";
import { bareThing, ENTRY_KINDS, findEntry, findThing, linkMentions, thingNamed } from "./linker.js";
import { assertNotWaiting, createTask, logChange, PROPOSED_NOTE, raiseQuestion } from "./worker-pool.js";
import { MASTER } from "./master-tools.js";

/**
 * A worker thread's upsert. It applies directly (with the derived-data floor
 * like anyone's writes: what it read elsewhere holds them where both are
 * visible), unless the worker judges it a large change and sets propose:
 * then it's a proposal and the thread waits for the admin.
 */
export async function workerUpsert(args, identity, scope) {
  await assertNotWaiting(identity);
  for (const e of args.entities) {
    const clash = await thingNamed(e.name);
    if (clash) throw new Error(thingClash(e.name, { ...clash, rid: String(clash.rid) }));
  }
  const own = (await adbQuery(`SELECT name, _origin FROM ${identity.role.entry}`).catch(() => []))[0];
  const now = Date.now();
  const entities = args.entities.map((e) => {
    const v = parseValidUntil(e.valid_until, now);
    return v === undefined ? e : { ...e, valid_until: v.valid_until ?? "lasting" };
  });
  // where each lands: the home asked for; else an existing entry's own home (it's updated where it
  // lives, never copied next to it); else the worker's own entry's
  const asked = args.home === undefined ? undefined : resolveWriteHome(scope, args.home, { everyoneOk: (await threadAudience(identity)) === EVERYONE });
  // grouped by origin (what an entry is keyed by) and where it lives (who sees it): the floor
  // is judged against where it lives, which grading may have put above its origin
  const byHome = new Map();
  for (const e of entities) {
    let home = asked;
    let lives;
    const found = await adbQuery(`SELECT @rid AS rid, _origin, _home FROM ${ENTITY_LABEL} WHERE name = :n AND ${ENTRY_KINDS} LIMIT 2`, { n: e.name }).catch(() => []);
    // two entries by this name: which one is meant isn't for a guess (update_entry takes the id)
    if (found.length > 1) await findEntry(e.name);
    if (found.length === 1 && found[0]._origin) {
      // an existing entry is updated where it was written (an entry is its name and origin: any
      // other origin would be a copy beside it); where it's seen from moves only with set_home
      lives = effectiveHome(positionMap, found[0]._home);
      if (asked !== undefined && asked !== lives) {
        throw new Error(`"${e.name}" already exists at ${homeName(positionMap, lives)}: an update is written where it lives, so leave home out. To change who sees it, use set_home.`);
      }
      home = found[0]._origin;
    } else if (home === undefined) home = own?._origin ?? positionMap.root;
    lives ??= home;
    const key = `${home} ${lives}`;
    if (!byHome.has(key)) byHome.set(key, { home, lives, list: [] });
    byHome.get(key).list.push(e);
  }
  const results = [];
  for (const { home, lives, list } of byHome.values()) {
    await refuseHiddenNames(list, lives);
    const { lift, floor } = workerWriteFloor(identity, lives);
    if (lift && !args.propose) throw new Error(liftRefusal(list.map((e) => e.name).join(", "), lift));
    // proposed past the floor: an admin who approves it writes it where it lives
    const write = { entities: list, home, floor, written_at: new Date(now).toISOString(), from_worker: true };
    if (args.propose) {
      results.push({ ...(await queueWrite({ kind: "upsert", payload: JSON.stringify(write), user: identity.user, home, ...proposalFields(identity, args.reason) })), note: PROPOSED_NOTE });
      continue;
    }
    results.push(await upsertEntities(write));
  }
  if (!args.propose) await logChange(identity, { kind: "upsert", entries: entities.map((e) => e.name), ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return results.length === 1 ? results[0] : { results };
}

/**
 * A worker's text names no entry the people who see it can't see: a title can say what's in it
 * ("kayla accepted"), and the master's brief, written from the root, may cite ones they can't.
 * Only titles: a one-word name, or one a thing also goes by (a part number, a job), is the text's subject.
 */
async function refuseHiddenNames(entities, lives) {
  if (!SCOPED || !positionMap || lives === undefined) return;
  const vis = visibleHomes(positionMap, [effectiveHome(positionMap, lives)]);
  if (vis === null) return;
  const text = entities.flatMap((e) => Object.values(e.facets ?? {})).map(String).join("\n").toLowerCase();
  if (!text) return;
  const own = new Set(entities.map((e) => String(e.name).toLowerCase()));
  const rows = await adbQuery(`SELECT name, _home FROM ${ENTITY_LABEL} WHERE (_kind IS NULL OR _kind IN ['document', 'section']) AND name IS NOT NULL`).catch(() => []);
  const seen = new Set(rows.filter((r) => vis.has(effectiveHome(positionMap, r._home))).map((r) => String(r.name).toLowerCase()));
  // a name that's also a thing's (a part number, a job, a database) is what the text is about, not a title
  const things = new Set();
  for (const t of await adbQuery(`SELECT _norm, _alias_norms FROM ${ENTITY_LABEL} WHERE _kind = 'thing'`).catch(() => [])) for (const n of [t._norm, ...(Array.isArray(t._alias_norms) ? t._alias_norms : [])]) if (n) things.add(String(n));
  const titled = (n) => n.length >= 8 && /\S\s+\S/.test(n) && !things.has(normalize(n));
  const hidden = [...new Set(rows.map((r) => String(r.name)).filter((n) => titled(n) && !seen.has(n.toLowerCase()) && !own.has(n.toLowerCase()) && text.includes(n.toLowerCase())))];
  if (hidden.length) {
    throw new Error(
      `not written: it names ${hidden.map((n) => `"${n}"`).join(", ")}, which people at ${homeName(positionMap, lives)} can't see (a name can say what's in it). Write it again without ${hidden.length > 1 ? "them" : "it"}, and without saying hidden entries exist.`,
    );
  }
}

/** who a task thread writes for: "everyone" when the admin started its survey for everyone */
async function threadAudience(identity) {
  const job = identity.role?.job;
  if (!job) return null;
  const row = (await adbQuery("SELECT payload FROM Job WHERE id = :id", { id: job }).catch(() => []))[0];
  return JSON.parse(row?.payload || "{}").audience ?? null;
}

/** a worker links its own entry to things (the same resolution as the one-call step; unsure matches come back to it) */
async function workerLink(args, identity) {
  await assertNotWaiting(identity);
  // its own entry by default; or another entry it names (a table's entry listing its records)
  const rid = args.entry ? String((await findEntry(args.entry)).rid) : identity.role.entry;
  const row = (await adbQuery(`SELECT _home FROM ${rid}`).catch(() => []))[0];
  if (!row) throw new Error("that entry is gone");
  const mentions = parseMentions(JSON.stringify({ things: args.things.map(bareThing) }), 25);
  const linked = await linkMentions(rid, mentions, effectiveHome(positionMap, row._home), { unsure: "skip" });
  await adbCommand(`UPDATE ${rid} SET _mentions_at = :now`, "sql", { now: new Date().toISOString() });
  const done = linked.filter((l) => !l.unsure && !l.skipped);
  if (done.length) {
    const created = done.filter((l) => l.created).length;
    await logChange(identity, {
      kind: "link",
      detail: `${args.entry ? `"${args.entry}": ` : ""}${done.length > 6 ? `${done.length} things (${created} new)` : done.map((l) => `${l.name} (${l.type}${l.created ? ", new" : ""})`).join(", ")}`,
    });
  }
  return {
    linked,
    ...(linked.some((l) => l.unsure)
      ? { note: "Unsure ones weren't linked: they may be an existing thing. Check with about_thing, then link the existing name, merge, or ask." }
      : {}),
  };
}

/** a worker removes links it judges wrong (from its entry by default, or the entry it names) */
async function workerUnlink(args, identity) {
  await assertNotWaiting(identity);
  const rid = args.entry ? String((await findEntry(args.entry)).rid) : identity.role.entry;
  const edges = await adbQuery(`SELECT @rid AS edge, @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`).catch(() => []);
  const out = [];
  for (const ref of args.things) {
    const t = await findThing(ref);
    if (!t) {
      out.push({ name: ref.name, skipped: "no single thing by that name, type or key" });
      continue;
    }
    const e = edges.filter((x) => String(x.dst) === String(t.rid));
    for (const x of e) if (RID_RE.test(String(x.edge))) await adbCommand(`DELETE FROM ${x.edge}`);
    out.push({ name: t.label, [e.length ? "unlinked" : "wasnt_linked"]: true, ...(e.length && (await dropIfStray(t)) ? { deleted: "no source record and nothing links it any more" } : {}) });
  }
  const done = out.filter((o) => o.unlinked);
  if (done.length) await logChange(identity, { kind: "unlink", detail: `${args.entry ? `"${args.entry}": ` : ""}${done.map((o) => o.name).join(", ")}`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  const gone = out.filter((o) => o.deleted);
  if (gone.length) await logChange(identity, { kind: "delete", detail: gone.map((o) => o.name).join(", "), reason: "left with nothing linking it after an unlink" });
  return { results: out };
}

/** a thing an unlink left with no edges at all and no source record (a linker's stray mint) goes with it */
async function dropIfStray(t) {
  const row = (await adbQuery(`SELECT _keys FROM ${t.rid}`).catch(() => []))[0];
  if (!row || (Array.isArray(row._keys) && row._keys.length)) return false;
  const edges = Number((await adbQuery(`SELECT count(*) AS n FROM (SELECT expand(bothE()) FROM ${t.rid})`))[0]?.n ?? 0);
  if (edges) return false;
  await adbCommand(`DELETE FROM ${t.rid}`);
  return true;
}

/** a worker deletes a stray thing nothing refers to any more (anything still linked is merged or unlinked first) */
async function workerDeleteThing(args, identity) {
  await assertNotWaiting(identity);
  const t = await findThing(args);
  if (!t) throw new Error(`no single thing called "${args.name}"${args.type ? ` (${args.type})` : ""}: give its type or key`);
  const about = Number((await adbQuery(`SELECT count(*) AS n FROM (SELECT expand(inE('ABOUT')) FROM ${t.rid})`))[0]?.n ?? 0);
  const rel = Number((await adbQuery(`SELECT count(*) AS n FROM (SELECT expand(bothE('RELATES')) FROM ${t.rid})`))[0]?.n ?? 0);
  if (about || rel) throw new Error(`"${t.label}" is still linked from ${about} entr${about === 1 ? "y" : "ies"} and has ${rel} relationship(s): unlink or merge it first`);
  await adbCommand(`DELETE FROM ${t.rid}`);
  await logChange(identity, { kind: "delete", detail: `${t.label} (${t._thing_type})`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return { deleted: t.label };
}

/** a worker corrects a thing's name (a work center stored as "cnc" that is "CNC 2"); the old name stays an alias */
async function workerRenameThing(args, identity) {
  await assertNotWaiting(identity);
  const t = await findThing(args.thing);
  if (!t) throw new Error(`no single thing called "${args.thing.name}"${args.thing.type ? ` (${args.thing.type})` : ""}: give its type or key`);
  const label = String(args.name).replace(/\s+/g, " ").trim();
  const n = normalize(label);
  if (n.length < 1) throw new Error("a name is needed");
  const row = (await adbQuery(`SELECT _norm, _alias_norms FROM ${t.rid}`))[0];
  if (row?._norm === n && t.label === label) return { already: true, name: thingName(t._thing_type, label) };
  const other = (await adbQuery(`SELECT @rid AS rid, label FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND _thing_type = :t AND (_norm = :n OR _alias_norms CONTAINS :n) LIMIT 2`, { t: t._thing_type, n }).catch(() => [])).find(
    (o) => String(o.rid) !== String(t.rid),
  );
  if (other) throw new Error(`another ${t._thing_type} is already called that (${other.label}, ${other.rid}): if they're the same, merge_things instead`);
  const [vec] = await embedBatch([`${t._thing_type}: ${label}`]);
  const aliases = [...new Set([...(row?._alias_norms ?? []), row?._norm].filter((a) => a && a !== n))];
  await adbCommand(`UPDATE ${t.rid} SET name = :name, label = :label, _norm = :n, _alias_norms = :a, embed_thing = [${vec.join(",")}], updated_at = :now`, "sql", {
    name: thingName(t._thing_type, label),
    label,
    n,
    a: aliases,
    now: new Date().toISOString(),
  });
  await logChange(identity, { kind: "rename", detail: `${t.label} -> ${label} (${t._thing_type})`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return { renamed: true, from: t.label, to: thingName(t._thing_type, label), aliases };
}

/**
 * Relationships between things (a job is for a customer, an employee works
 * in a work center), with the evidence. A relationship shows only to someone
 * who can see both things.
 */
async function workerRelate(args, identity) {
  await assertNotWaiting(identity);
  const out = [];
  for (const r of args.relations) {
    const rel = normalizeRel(r.rel);
    if (!rel) {
      out.push({ ...r, skipped: "no relationship verb" });
      continue;
    }
    const from = await findThing(r.from);
    const to = await findThing(r.to);
    if (!from || !to) {
      out.push({ from: r.from.name, rel, to: r.to.name, skipped: `no single thing called "${!from ? r.from.name : r.to.name}": link it to an entry first (link_things), or give its type or key` });
      continue;
    }
    if (String(from.rid) === String(to.rid)) {
      out.push({ from: from.label, rel, to: to.label, skipped: "a thing and itself" });
      continue;
    }
    const existing = await adbQuery(`SELECT @in AS dst, rel FROM (SELECT expand(outE('RELATES')) FROM ${from.rid})`).catch(() => []);
    if (existing.some((e) => String(e.dst) === String(to.rid) && e.rel === rel)) {
      out.push({ from: from.label, rel, to: to.label, already: true });
      continue;
    }
    await adbCommand(`CREATE EDGE RELATES FROM ${from.rid} TO ${to.rid} SET rel = :rel, evidence = :ev, job = :job, at = :now`, "sql", {
      rel,
      ev: String(r.evidence ?? "").slice(0, 400),
      job: identity.role.job,
      now: new Date().toISOString(),
    });
    out.push({ from: from.label, rel, to: to.label, related: true });
  }
  const made = out.filter((o) => o.related);
  if (made.length) await logChange(identity, { kind: "relate", detail: made.length > 6 ? `${made.length} relationships` : made.map((o) => `${o.from} ${o.rel} ${o.to}`).join("; ") });
  return { relations: out };
}

/** a worker queues follow-up work (a survey fanning out by topic); a few per thread */
async function workerFollowup(args, identity) {
  await assertNotWaiting(identity);
  const queued = Number((await adbQuery("SELECT count(*) AS n FROM Job WHERE kind = 'review' AND (payload LIKE :p OR payload LIKE :f)", { p: `%"parent":"${identity.role.job}"%`, f: `%"from":"${identity.role.job}"%` }))[0]?.n ?? 0);
  // a master's worker's follow-ups report to the master too
  const own = JSON.parse((await adbQuery("SELECT payload FROM Job WHERE id = :id", { id: identity.role.job }))[0]?.payload || "{}");
  if (queued >= 20) throw new Error("this thread already queued 20 follow-ups: finish with what's queued");
  // follow-ups write for whoever their survey wrote for
  const r = await createTask({
    title: args.title,
    brief: args.brief,
    minutes: args.minutes,
    parent: own.parent === MASTER ? MASTER : identity.role.job,
    from: identity.role.job,
    by: identity.user,
    audience: await threadAudience(identity),
    level: Number(args.level) || own.level,
  });
  await logChange(identity, { kind: "followup", detail: r.task });
  return { ...r, note: "Queued: another thread does it. Don't wait for it." };
}

/** a worker merges two things (by name): directly, or as a proposal when it judges it consequential */
async function workerMerge(args, identity, scope) {
  await assertNotWaiting(identity);
  const find = async (name, type) =>
    (
      await adbQuery(
        `SELECT @rid AS rid, label, _thing_type FROM ${ENTITY_LABEL} WHERE _kind = 'thing' AND (_norm = :n OR _alias_norms CONTAINS :n)${type ? " AND _thing_type = :t" : ""}${homeFilter(scope)} LIMIT 2`,
        { n: normalize(name), t: type },
      )
    )[0];
  const keep = await find(args.keep, args.type);
  const drop = await find(args.drop, args.type);
  if (!keep || !drop) throw new Error(`no thing called "${!keep ? args.keep : args.drop}"${args.type ? ` (${args.type})` : ""}`);
  if (String(keep.rid) === String(drop.rid)) throw new Error("those are the same thing already");
  if (keep._thing_type !== drop._thing_type) throw new Error(`different types (${keep._thing_type}, ${drop._thing_type}): not merged`);
  const payload = { keep: String(keep.rid), drop: String(drop.rid), keep_name: keep.label, drop_name: drop.label, type: keep._thing_type };
  if (args.propose) {
    return { ...(await queueWrite({ kind: "merge", payload: JSON.stringify(payload), user: identity.user, home: positionMap.root, ...proposalFields(identity, args.reason) })), note: PROPOSED_NOTE };
  }
  const result = await mergeThings(payload);
  await logChange(identity, { kind: "merge", detail: `"${drop.label}" into "${keep.label}" (${keep._thing_type})`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return result;
}

/**
 * A worker folds a duplicate entry into the one it duplicates: the drop's
 * links move to the keep, then the drop is deleted. Direct when both live at
 * the same home; otherwise a proposal (the drop's audience would lose it, the
 * keep's would gain its links).
 */
async function workerFoldEntries(args, identity) {
  await assertNotWaiting(identity);
  const keep = await findEntry(args.keep);
  const drop = await findEntry(args.drop);
  if (String(keep.rid) === String(drop.rid)) throw new Error("those are the same entry");
  if (String(drop.rid) === identity.role.entry) throw new Error("that's your own entry: fold the other into it instead");
  const payload = { keep: String(keep.rid), drop: String(drop.rid), keep_name: keep.name, drop_name: drop.name };
  const sameHome = effectiveHome(positionMap, keep._home) === effectiveHome(positionMap, drop._home);
  if (args.propose || !sameHome) {
    const why = sameHome ? args.reason : `${args.reason ? `${args.reason} ` : ""}(${homeName(positionMap, drop._home)} -> ${homeName(positionMap, keep._home)})`;
    return { ...(await queueWrite({ kind: "fold", payload: JSON.stringify(payload), user: identity.user, home: positionMap.root, ...proposalFields(identity, why) })), note: sameHome ? PROPOSED_NOTE : `The two live at different homes, so this is a proposal. ${PROPOSED_NOTE}` };
  }
  const result = await foldEntries(payload);
  await logChange(identity, { kind: "fold", detail: `${drop.rid} "${drop.name}" into ${keep.rid} "${keep.name}" (${result.moved} link${result.moved === 1 ? "" : "s"} moved)`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return result;
}

/**
 * A worker deletes an entry by id or name: directly when nothing links it
 * and it links nothing (a stray copy its own write made); otherwise a
 * proposal. Its text is kept in the thread's change log.
 */
async function workerDeleteEntry(args, identity) {
  await assertNotWaiting(identity);
  const row = await findEntry(args.entry);
  const rid = String(row.rid);
  if (rid === identity.role.entry) throw new Error("that's your own entry");
  const full = (await adbQuery(`SELECT * FROM ${rid}`))[0] ?? {};
  if (full._kind === "task") throw new Error("a task entry isn't deleted: it's the record of a thread's work");
  const edges = Number((await adbQuery(`SELECT count(*) AS n FROM (SELECT expand(bothE()) FROM ${rid})`))[0]?.n ?? 0);
  const text = Object.keys(full).filter((k) => k.startsWith("text_") && full[k]).map((k) => `${k.slice(5)}: ${full[k]}`).join(" | ").slice(0, 400);
  if (args.propose || edges > 0) {
    return {
      ...(await queueWrite({ kind: "delete_entry", payload: JSON.stringify({ rid, name: row.name, home: row._home ?? null, text }), user: identity.user, home: positionMap.root, ...proposalFields(identity, args.reason) })),
      note: edges > 0 ? `It has ${edges} link(s), so deleting it is a proposal (fold it into the copy it duplicates with merge_entries instead, if that's what it is). ${PROPOSED_NOTE}` : PROPOSED_NOTE,
    };
  }
  const result = await deleteEntry({ rid });
  await logChange(identity, { kind: "delete", detail: `entry ${rid} "${row.name}"${text ? ` (${text.slice(0, 200)})` : ""}`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return result;
}

/** a worker removes relationships it judges wrong (all of them between the two when no verb is given) */
async function workerUnrelate(args, identity) {
  await assertNotWaiting(identity);
  const out = [];
  for (const r of args.relations) {
    const rel = r.rel ? normalizeRel(r.rel) : null;
    const from = await findThing(r.from);
    const to = await findThing(r.to);
    if (!from || !to) {
      out.push({ from: r.from.name, rel, to: r.to.name, skipped: `no single thing called "${!from ? r.from.name : r.to.name}": give its type or key` });
      continue;
    }
    const edges = (await adbQuery(`SELECT @rid AS edge, @in AS dst, rel FROM (SELECT expand(outE('RELATES')) FROM ${from.rid})`).catch(() => [])).filter(
      (e) => String(e.dst) === String(to.rid) && (!rel || e.rel === rel),
    );
    for (const e of edges) if (RID_RE.test(String(e.edge))) await adbCommand(`DELETE FROM ${e.edge}`);
    out.push({ from: from.label, rel: rel ?? edges.map((e) => e.rel).join(", "), to: to.label, ...(edges.length ? { removed: edges.length } : { wasnt_related: true }) });
  }
  const done = out.filter((o) => o.removed);
  if (done.length) await logChange(identity, { kind: "unrelate", detail: done.map((o) => `${o.from} ${o.rel} ${o.to}`).join("; "), ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return { relations: out };
}

/**
 * A worker corrects an entry it names by id or name (a stale version, a wrong
 * field, a facet's text): the same write as an upsert, at that entry's own
 * origin, with the derived-data floor.
 */
async function workerUpdateEntry(args, identity) {
  await assertNotWaiting(identity);
  const row = await findEntry(args.entry);
  if (!args.properties && !args.facets && args.valid_until === undefined) throw new Error("nothing to change: give properties, facets or valid_until");
  const type = String((await adbQuery(`SELECT @type AS t FROM ${row.rid}`))[0]?.t ?? ENTITY_LABEL);
  if (type !== ENTITY_LABEL && !type.startsWith(`${ENTITY_LABEL}~`)) return typedUpdate(row, type, args, identity);
  const origin = row._origin ?? positionMap.root;
  const twins = Number((await adbQuery(`SELECT count(*) AS n FROM ${ENTITY_LABEL} WHERE name = :n AND _origin = :o`, { n: row.name, o: origin }))[0]?.n ?? 0);
  if (twins > 1) throw new Error(`${twins} entries are called "${row.name}" at the same home: fold the duplicate first (merge_entries), then update the one left`);
  const entity = { name: row.name, ...(args.properties ? { properties: args.properties } : {}), ...(args.facets ? { facets: args.facets } : {}), ...(args.valid_until !== undefined ? { valid_until: args.valid_until } : {}) };
  const now = Date.now();
  const v = parseValidUntil(entity.valid_until, now);
  if (v !== undefined) entity.valid_until = v.valid_until ?? "lasting";
  await refuseHiddenNames([entity], row._home ?? origin);
  const { lift, floor } = workerWriteFloor(identity, row._home ?? origin);
  if (lift && !args.propose) throw new Error(liftRefusal(row.name, lift));
  const write = { entities: [entity], home: origin, floor, written_at: new Date(now).toISOString(), from_worker: true };
  if (args.propose) return { ...(await queueWrite({ kind: "upsert", payload: JSON.stringify(write), user: identity.user, home: origin, ...proposalFields(identity, args.reason) })), note: PROPOSED_NOTE };
  const result = await upsertEntities(write);
  const changed = [...Object.keys(args.properties ?? {}), ...Object.keys(args.facets ?? {}).map((f) => `${f} facet`), ...(args.valid_until !== undefined ? ["valid_until"] : [])];
  await logChange(identity, { kind: "update", detail: `${row.rid} "${row.name}": ${changed.join(", ")}`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return result;
}

/** the tools of a worker thread, registered on the MCP server built for that identity (see createServer) */
export function registerWorkerTools(server, { identity, scope, need }) {
  server.tool(
    "link_things",
    `Link an entry (yours by default; or name one in entry by name or id, e.g. a table's entry) to
the things it's about: people, customers, suppliers, machines, parts, orders, places, projects, teams
(type one of: person, customer, supplier, machine, part, order, place, project, team, other). Up to 25
a call. Give a record's key when you know it ("mssql:dbo_Customer:TORO"): the same key is always the
same thing. Existing things are found by key, name or alias; new ones are created. A name that may be
an existing thing under another name isn't linked: it comes back as unsure for you to check. Another
entry is never a thing: cross-reference entries by name in the text, not with a link.`,
    {
      things: z.array(z.object({ name: z.string().min(2).max(120), type: z.string(), role: z.string().max(30).optional(), key: z.string().max(200).optional() })).min(1).max(25),
      entry: z.string().max(200).optional(),
    },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await workerLink(args, identity)) }] };
    },
  );
  server.tool(
    "relate_things",
    `Record relationships between things: from, a verb (rel: works_in, supplies, orders, belongs_to,
runs_on, reports_to...), to, and the evidence (which table and columns, or the aggregate). Each thing
by name and type, or by key. Up to 25 a call. A relationship shows only to people who can see both.`,
    {
      relations: z
        .array(
          z.object({
            from: z.object({ name: z.string().min(2), type: z.string().optional(), key: z.string().optional() }),
            rel: z.string().min(2).max(40),
            to: z.object({ name: z.string().min(2), type: z.string().optional(), key: z.string().optional() }),
            evidence: z.string().max(400).optional(),
          }),
        )
        .min(1)
        .max(25),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerRelate(args, identity)) }] };
    },
  );
  server.tool(
    "queue_followup",
    `Queue a follow-up task for another thread: a title and a precise brief (which tables, what to seed,
which relationships). For a survey's topics that don't fit this conversation. A few per thread.`,
    { title: z.string().min(4).max(120), brief: z.string().min(20).max(6000), minutes: z.number().int().min(5).max(180).optional(), level: z.number().int().min(1).max(3).optional() },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerFollowup(args, identity)) }] };
    },
  );
  server.tool(
    "unlink_things",
    `Remove links you judge wrong between an entry (yours by default, or one you name by name or id) and
things: e.g. a note linked to the wrong "John". Each thing by name and type, or key. Give a short reason.`,
    {
      things: z.array(z.object({ name: z.string().min(1), type: z.string().optional(), key: z.string().optional() })).min(1).max(25),
      entry: z.string().max(200).optional(),
      reason: z.string().max(300).optional(),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerUnlink(args, identity)) }] };
    },
  );
  server.tool(
    "delete_thing",
    `Delete a stray thing that nothing links to any more (a mis-typed duplicate, a placeholder). Anything
still linked or related must be unlinked or merged first. Give a short reason.`,
    { name: z.string().min(1), type: z.string().optional(), key: z.string().optional(), reason: z.string().max(300).optional() },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerDeleteThing(args, identity)) }] };
    },
  );
  server.tool(
    "merge_things",
    `Merge two things that are the same (e.g. "Toro Co." and "Toro", both customers): keep one, fold the
other's links and names into it. Plain duplicates: merge directly. When it matters (things many entries
point at, or you're not certain), set propose: true with a reason: an admin decides and you wait.`,
    { keep: z.string().min(2), drop: z.string().min(2), type: z.string().optional(), reason: z.string().max(600).optional(), propose: z.boolean().optional() },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerMerge(args, identity, scope)) }] };
    },
  );
  server.tool(
    "merge_entries",
    `Fold a duplicate entry into the one it duplicates (two copies of one note): the drop's links move to
the keep, then the drop is deleted. Name each by name, or by its id ("#1:352258") when several share a
name. Two copies at the same home fold directly; at different homes, or with propose: true, it's a
proposal and you wait. Give a short reason.`,
    { keep: z.string().min(2).max(200), drop: z.string().min(2).max(200), reason: z.string().max(600).optional(), propose: z.boolean().optional() },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerFoldEntries(args, identity)) }] };
    },
  );
  server.tool(
    "unrelate_things",
    `Remove relationships you judge wrong or stale between things (a works_in the current data no longer
supports). Each by from, rel and to (each thing by name and type, or key); without rel, every
relationship from the one to the other goes. Give a short reason.`,
    {
      relations: z
        .array(
          z.object({
            from: z.object({ name: z.string().min(2), type: z.string().optional(), key: z.string().optional() }),
            rel: z.string().max(40).optional(),
            to: z.object({ name: z.string().min(2), type: z.string().optional(), key: z.string().optional() }),
          }),
        )
        .min(1)
        .max(25),
      reason: z.string().max(300).optional(),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerUnrelate(args, identity)) }] };
    },
  );
  server.tool(
    "delete_entry",
    `Delete an entry by name or id ("#971:0"): a stray copy a write made by mistake, a placeholder. With
nothing linking it and no links of its own it goes directly; otherwise it's a proposal (a duplicate of
another entry is folded with merge_entries instead). Use this, not raw commands. Give a short reason.`,
    { entry: z.string().min(2).max(200), reason: z.string().max(300).optional(), propose: z.boolean().optional() },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerDeleteEntry(args, identity)) }] };
    },
  );
  server.tool(
    "rename_thing",
    `Correct a thing's name (a work center stored as "cnc" that the ERP calls "CNC 2"). The thing by name
and type, or key; the new name without its type. The old name stays as an alias, so searches still find
it. Don't write a thing's name as an entry: that makes a second copy beside it.`,
    {
      thing: z.object({ name: z.string().min(1), type: z.string().optional(), key: z.string().optional() }),
      name: z.string().min(1).max(120),
      reason: z.string().max(300).optional(),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerRenameThing(args, identity)) }] };
    },
  );
  server.tool(
    "update_entry",
    `Correct an entry you name by name or id: set properties (a stale version, a wrong field), rewrite a
facet's text, or set its valid_until. A typed record (a Database, a Host: give its id, "#13:0") is
corrected in place the same way, without an end date. It's updated where it lives, with the usual
floor. Use this, not raw commands, for corrections. Set propose: true with a reason when it matters.`,
    {
      entry: z.string().min(2).max(200),
      properties: z.record(z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
      facets: z.record(z.string().max(4000)).optional(),
      valid_until: z.string().max(40).optional(),
      reason: z.string().max(600).optional(),
      propose: z.boolean().optional(),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerUpdateEntry(args, identity)) }] };
    },
  );
  server.tool(
    "raise_question",
    `Ask the admin something you can't settle from the graph or your sources (which customer a name means,
whether a change is right). Give options when there are clear choices, and why you're asking. Then END
YOUR TURN with a short report: you're resumed with the answer later, in this same conversation.`,
    { question: z.string().min(8).max(600), options: z.array(z.string().max(200)).max(6).optional(), why: z.string().max(600).optional() },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await raiseQuestion(identity, args)) }] };
    },
  );
}
