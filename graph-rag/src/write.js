/**
 * Writes and proposals: upsertEntities, the pending-write queue (queueWrite, approve, reject, execute), moving
 * entries (setHome), raw commands, and the executors an approval runs (merge, fold, delete, typed update).
 */
import { randomUUID } from "node:crypto";
import { canSee, commonAncestor, effectiveHome, heldPositions, homeName, moveKind } from "./positions.js";
import { authorityOf, claimHome, decide } from "./model/authority.js";
import { claimKeys } from "./placement.js";
import { chooseValidity, parseValidUntil } from "./extent.js";
import { normalize } from "./things.js";
import { firstJob } from "./pool.js";
import { changedCount, changedNothing, countingCommand } from "./rawcount.js";
import { log } from "./context.js";
import { adbCommand, adbQuery, ensureFullText, ensureIndex, ENTITY_LABEL, esc, knownIndexes, PENDING_ID_RE, PROP_RE, RID_RE, sanitizeFacet } from "./db.js";
import { embedBatch } from "./models.js";
import { homeFilter, isPerson, positionId, positionMap, SCOPED } from "./scope.js";
import { identityText, publicProps } from "./search.js";
import { askAboutPlacement, claimsFollowEntry, claimsOfEntry, derivedFloor, heldNote, placeEntities, workerWriteFloor } from "./floor.js";
import { policy } from "./org-policy.js";
import { dropWaitingShares, refreshGrants, resolveWaitingShares, storeGrant } from "./sharing.js";
import { ASSERTIONS, meetAssertion } from "./requests.js";
import { docStore, startIngest } from "./ingest.js";
import { aboutOnce, ENTRY_KINDS, thingSeenFrom } from "./linker.js";
import { assertNotWaiting, enqueue, logChange, PROPOSED_NOTE, resumeThread, worker, workerModel } from "./worker-pool.js";

/**
 * The write-or-propose decision, made the one way at every site (docs/ORGANIZATION-MODEL.md,
 * "Proposals": an agent proposes when it lacks authority to commit). Built on the contract's
 * authority.decide over the policy's authority map and the position tree; the derived-data floor
 * and today's site rules (queued writers, a worker's raw commands, widening, an entry a person
 * placed) are folded in, so a site needs no test of its own.
 *
 *   decideWrite(identity, { kind, cls, attribute, claims, lives }, ctx)
 *     kind       upsert | rehome | grant | merge | fold | delete_entry | typed_update | command | ingest | backfill | data_entry
 *                (any other kind takes the class rule, queuing and ctx.propose alone: data_entry, a write to a
 *                source system, is decided by authority over its class, with no derived-floor lift, since it
 *                writes no graph content; the lift applies to upsert, typed_update and ingest only)
 *     cls, attribute   the commitment class and attribute the write bears on (null: residue, no class)
 *     claims     instead of one class: the claims the write carries (the strictest decides)
 *     lives      where the entry lives (its home) for a write to an existing entry; undefined for a new one
 *   ctx: origin  the writer's resolved position for a new write (resolveWriteHome)
 *        propose the caller asked for a proposal
 *        to      a rehome's target (widening is always a person's call)
 *        placedBy  who placed the entry (a person's placement is theirs to change)
 *        reason  the caller's reason, kept in the proposal
 *        policy, positions  the authority map and position tree to decide over (default: the live ones;
 *                given, the decision is pure: tests and other streams' stubs)
 *
 *   -> { action: direct | propose | hidden, floor, home, reason, authority, lift }
 *     action   direct: write it; propose: queue it, homed at `home` (queueWrite's `home`), the authority
 *              position when a class rule put it there; hidden: the writer is on another branch than the
 *              authority: queue it held at the common ancestor (`home`), where someone with authority over
 *              both sides decides
 *     floor    the lowest home the written data may get: the derived floor raised to the claims' authority
 *     lift     the derived floor would hold a content write above where the entry lives (worker tools say so)
 * Unscoped deployments: direct, unless the identity's writes are queued or the caller asked to propose.
 */
export function decideWrite(identity, { kind, cls = null, attribute = null, claims, lives } = {}, ctx = {}) {
  const queued = identity?.caps?.write === "queued";
  const reasons = [];
  const map = ctx.positions ?? positionMap;
  const rules = ctx.policy ?? policy.authorityMap;
  if ((!SCOPED && !ctx.positions) || !map) {
    if (queued) reasons.push("this identity's writes are queued");
    if (ctx.propose) reasons.push("proposed on purpose");
    return { action: reasons.length ? "propose" : "direct", floor: undefined, home: undefined, reason: reasons.join("; "), authority: null, lift: null };
  }
  const at = lives === undefined ? undefined : effectiveHome(map, lives);
  const origin = ctx.origin === undefined ? at : effectiveHome(map, ctx.origin);
  // the rule, per class, by position alone (a queued writer's standing is still its position's; queuing
  // is a reason of its own below): with several claims the strictest answer and the highest authority decide
  const keys = claims ? claimKeys(claims) : cls || attribute ? [{ class: cls, attribute }] : [];
  const standing = { ...identity, caps: undefined };
  let ruling = "direct";
  let authority = null;
  for (const k of keys) {
    const r = decide(standing, k.class, k.attribute, rules, map);
    if (r === "hidden" || (r === "propose" && ruling === "direct")) ruling = r;
    const a = authorityOf(rules, k.class, k.attribute);
    if (a) authority = commonAncestor(map, [...(authority ? [authority] : []), map.positions[a] ? a : map.root]);
  }
  const named = keys.filter((k) => authorityOf(rules, k.class, k.attribute)).map((k) => (k.class && k.attribute ? `${k.class}/${k.attribute}` : k.class ?? k.attribute));
  if (ruling !== "direct") reasons.push(ruling === "hidden" ? `${named.join(", ")}: authority lies with ${homeName(map, authority)}, on another branch` : `authority over ${named.join(", ")} lies with ${homeName(map, authority)}`);
  // the derived floor bounds content writes to an existing entry; a lift means a proposal, never a silent move
  const content = ["upsert", "typed_update", "ingest"].includes(kind);
  const { lift } = content && at !== undefined && map === positionMap ? workerWriteFloor(identity, at) : { lift: null };
  if (lift) reasons.push(`what this identity read in the last ${policy.derivedWindowHours} hours reaches fewer people than ${homeName(map, at)} does`);
  // today's site rules, which the rule keeps
  if (queued) reasons.push("this identity's writes are queued");
  if (ctx.propose) reasons.push("proposed on purpose");
  if (kind === "command" && identity?.role?.kind === "worker") reasons.push("a worker's raw command is always a proposal");
  const widen = kind === "rehome" && ctx.to !== undefined && at !== undefined && moveKind(map, at, ctx.to) === "widen";
  if (widen) reasons.push("widening who sees it is a person's call");
  if (ctx.placedBy && !isPerson(identity)) reasons.push(`${ctx.placedBy} placed it: moving it is a person's decision`);
  const action = ruling === "hidden" ? "hidden" : reasons.length || ruling === "propose" ? "propose" : "direct";
  // where the data may land, and where a proposal is homed (who reviews it)
  const base = origin ?? at;
  const derived = base === undefined ? undefined : lift ? lift.floor : map === positionMap ? derivedFloor(identity, base) : base;
  const floorAt = base === undefined ? undefined : commonAncestor(map, [derived, ...(authority ? [claimHome(map, base, authority)] : [])]);
  const home = action === "hidden" ? floorAt : authority && ruling !== "direct" ? claimHome(map, base ?? authority, authority) : (at ?? origin);
  return { action, floor: floorAt, home, reason: reasons.join("; "), authority, lift };
}

/** `home` is already resolved by the caller (resolveWriteHome); undefined = unscoped */
export async function upsertEntities({ entities, home, floor, regrade_floor, written_at, from_worker, written_by }) {
  if (!Array.isArray(entities) || entities.length === 0) throw new Error("entities[] required");
  if (entities.length > 64) throw new Error("max 64 entities per call");
  // dates in the content ("next Friday") mean the day it was written, not approved
  const writtenAt = Number.isFinite(Date.parse(written_at)) ? Date.parse(written_at) : Date.now();
  // scoped: `home` is the origin; grading decides where each entity is seen from
  const graded = home === undefined || !positionMap ? null : await placeEntities(entities, home, floor ?? home, writtenAt);
  // a worker's update (direct, or a proposal someone approved) never hides an entry from the people
  // who see it: its text is mostly the worker's own reading. Hiding it is a set_home, said on purpose
  const placements = graded?.map((p) => (from_worker && p?.restricted ? { ...p, home: p.restricted.from, note: heldNote(p.restricted.from, p.restricted.reason), restricted: undefined } : p));

  let merged = 0;
  const validities = []; // per entity: the end date this write set (ISO / null), if any
  const jobs = []; // {name, facet, text}
  for (const [idx, e] of entities.entries()) {
    if (!e?.name || typeof e.name !== "string") throw new Error("entity.name required");
    const labels = (e.labels ?? []).map(String).filter((l) => l !== ENTITY_LABEL && /^[A-Za-z_][A-Za-z0-9_]*$/.test(l));
    const props = {};
    for (const [k, v] of Object.entries(e.properties ?? {})) {
      if (!PROP_RE.test(k)) throw new Error(`invalid property name: ${k}`);
      if (["string", "number", "boolean"].includes(typeof v)) props[k] = v;
    }
      const propSql = Object.entries(props)
        .map(([k, v]) => `n.${k} = ${typeof v === "string" ? `'${esc(v)}'` : v}`)
        .join(", ");
      // declare properties in the schema first — undeclared properties are
      // writable but invisible to SQL WHERE clauses (e.g. temporal filters)
      for (const k of Object.keys(props)) {
        const type = typeof props[k] === "string" ? "STRING" : typeof props[k] === "boolean" ? "BOOLEAN" : "DOUBLE";
        await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${k} IF NOT EXISTS ${type}`).catch(() => {});
      }
      const labelClause = labels.map((l) => `SET n:\`${l}\``).join(" ");
    // an entity is (name, origin): a write never touches a same-named entity
    // written from another position; where it is seen from is _home
    const key = home === undefined ? `{name: '${esc(e.name)}'}` : `{name: '${esc(e.name)}', \`_origin\`: '${esc(home)}'}`;
    const place = placements?.[idx];
    // awaiting grading: what it needs to be graded again (regradeTick); graded now: no longer awaiting
    const ungradedSql = place?.ungraded
      ? `, n.\`_ungraded\` = '${esc(JSON.stringify({ origin: home, floor: regrade_floor ?? floor ?? home, held: place.home, written_at: new Date(writtenAt).toISOString(), ...(typeof e._text === "string" ? { text: e._text.slice(0, 6000) } : {}) }))}'`
      : place?.graded || place?.claims // graded now, or settled by its claims: no longer awaiting
        ? ", n.`_ungraded` = null"
        : "";
    // placed by its claims: which classes and attributes, and whose authority put it there (claimsOfEntry reads it back)
    const claimSql = place?.claims
      ? `, n.\`_claim_classes\` = '${esc(JSON.stringify(place.claims.map(({ class: c, attribute, authority }) => ({ class: c, attribute, authority }))))}', n.\`_authority\` = ${place.authority ? `'${esc(place.authority)}'` : "null"}`
      : "";
    const placeSql = place ? `, n.\`_home\` = '${esc(place.home)}', n.\`_grade\` = '${esc(place.note)}'${ungradedSql}${claimSql}` : "";
    // server-set fields (documents, sections); never from a caller (tool schemas drop them)
    const systemSql = Object.entries(e._system && typeof e._system === "object" ? e._system : {})
      .filter(([k, v]) => /^_[a-z][a-z0-9_]*$/.test(k) && ["string", "number"].includes(typeof v))
      .map(([k, v]) => `, n.\`${k}\` = ${typeof v === "string" ? `'${esc(v)}'` : Number(v)}`)
      .join("");
    // its end date: the writer's word, else the grader's, else unchanged
    const stored = (
      await adbQuery(`SELECT @rid AS rid, _home, _valid_until, _valid_by FROM ${ENTITY_LABEL} WHERE name = :name${home === undefined ? "" : " AND _origin = :origin"} LIMIT 1`, { name: e.name, origin: home })
    )[0];
    // an update that moves an entry takes its claims along
    if (stored && place && stored._home !== place.home) await claimsFollowEntry(String(stored.rid), place.home);
    const validity = chooseValidity(
      parseValidUntil(e.valid_until, writtenAt),
      stored ? { valid_until: stored._valid_until ?? null, valid_by: stored._valid_by ?? null } : undefined,
      place?.until,
    );
    const validSql = validity
      ? `, n.\`_valid_until\` = ${validity.valid_until ? `'${esc(validity.valid_until)}'` : "null"}, n.\`_valid_by\` = '${validity.valid_by}'`
      : "";
    if (validity) validities[idx] = validity.valid_until;
    // labels only on a new entry: giving an existing one a label changes its type, and ArcadeDB
    // moves it to a new record id (and hands the old id to the next record), so every proposal,
    // thread and reference that holds its id would then point at nothing, or at something else
    await adbCommand(
      `MERGE (n:${ENTITY_LABEL} ${key}) ` +
        `SET n.updated_at = datetime() ${propSql ? ", " + propSql : ""}${placeSql}${validSql}${systemSql} ${stored ? "" : labelClause}`,
      "cypher",
    );
    // its writer: the person who first wrote it (an update by anyone else, a worker included, never takes it over)
    if (written_by && home !== undefined)
      await adbCommand(`UPDATE ${ENTITY_LABEL} SET _written_by = :w WHERE name = :n AND _origin = :o AND _written_by IS NULL`, "sql", { w: written_by, n: e.name, o: home });
    merged++;
    for (const [facet, text] of Object.entries(e.facets ?? {})) {
      const f = sanitizeFacet(facet);
      if (typeof text !== "string" || !text.trim()) continue;
      await ensureIndex(f);
      // a section stores its preview but is embedded from its full text (+ context)
      const embed = typeof e._embed?.[facet] === "string" ? e._embed[facet] : text;
      jobs.push({ name: e.name, facet: f, text: text.slice(0, 4000), embed: embed.slice(0, 6000) });
    }
  }

  // one batched embeddings call for all facet texts
  let embedded = 0;
  if (jobs.length > 0) {
    const vecs = await embedBatch(jobs.map((j) => j.embed ?? j.text));
    for (let i = 0; i < jobs.length; i++) {
      const { name, facet, text } = jobs[i];
      const homeCond = home === undefined ? "" : ` AND _origin = '${esc(home)}'`;
      await adbCommand(
        `UPDATE (SELECT FROM ${ENTITY_LABEL} WHERE name = '${esc(name)}'${homeCond}) ` +
          `SET embed_${facet} = [${vecs[i].join(",")}], text_${facet} = '${esc(text)}'`,
      );
      embedded++;
    }
    // what was just written meets the open questions near it (after the write; never fails it)
    if (home !== undefined) {
      for (let i = 0; i < jobs.length; i++) {
        if (jobs[i].facet !== "identity") continue;
        const vec = vecs[i];
        void adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin LIMIT 1`, { name: jobs[i].name, origin: home })
          .then(async (rows) => {
            if (!rows[0]) return;
            // the graph worker finds what it's about (in the background): the
            // one-call linking, or a thread; what a thread wrote only gets linked
            const rid = String(rows[0].rid);
            const kind = from_worker ? "mentions" : firstJob(worker.pool);
            // with a master: linked first (when there's a linking model), then into the next batch
            const toMaster = !from_worker && worker.pool.master && worker.pool.poolSize > 0;
            if (toMaster && !workerModel()) await enqueue("intake", { rid }, { key: `intake:${rid}` }).catch(() => {});
            else await enqueue(kind, { rid, ...(from_worker ? { from_worker: true } : {}), ...(toMaster ? { intake: true } : {}) }, { key: `${kind}:${rid}` }).catch(() => {});
            await meetAssertion(String(rows[0].rid), vec);
          })
          .catch((e) => log.warn(`meeting questions for ${jobs[i].name}: ${String(e).slice(0, 120)}`));
      }
    }
  }

  // grading's proposals go to a person: release lower, or review an unsure call
  const placed = [];
  if (placements) {
    for (const [i, e] of entities.entries()) {
      const p = placements[i];
      placed.push({ name: e.name, home: homeName(positionMap, p.home), note: p.note, ...(validities[i] !== undefined ? { valid_until: validities[i] } : {}) });
      if (!p.release && !p.review) continue;
      const rows = await adbQuery(`SELECT @rid AS rid FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin LIMIT 1`, { name: e.name, origin: home });
      if (rows[0]) await askAboutPlacement(String(rows[0].rid), e.name, p);
    }
  }
  return { merged, embedded, facets_indexed: [...knownIndexes], ...(placements ? { placed } : {}) };
}

export async function backfillIdentity(limit = 64) {
  const lim = Math.max(1, Math.min(256, Number(limit) || 64));
  const nodes = await adbQuery(
    `SELECT FROM ${ENTITY_LABEL} WHERE embed_identity IS NULL LIMIT ${lim}`,
  );
  if (nodes.length === 0) return { backfilled: 0 };

  const texts = [];
  const names = [];
  const rids = [];
  for (const n of nodes) {
    const props = publicProps(n);
    const labels = Object.keys(n).filter((k) => k.startsWith(ENTITY_LABEL) === false && k.startsWith("@") === false && k === k.toLowerCase() === false);
    // ArcadeDB rows expose the type via @type; keep labels implicit
    void labels;
    texts.push(identityText(n.name, n["@type"] ? [n["@type"]] : [], props));
    names.push(n.name);
    rids.push(n["@rid"]);
  }
  const vecs = await embedBatch(texts);
  for (let i = 0; i < names.length; i++) {
    if (!RID_RE.test(String(rids[i]))) continue;
    // as parameters: an inlined vector or text can fail to parse (and one bad row stalled every sweep).
    // Only while it still has none: a write creates the row before it embeds its texts, so the sweep
    // can read it bare, and its own text must never land over the one the write stored meanwhile
    await adbCommand(`UPDATE ${rids[i]} SET embed_identity = :v, text_identity = :t WHERE embed_identity IS NULL`, "sql", { v: vecs[i], t: texts[i] });
  }
  await ensureFullText();
  return { backfilled: names.length, ...(nodes.length === lim ? { note: "more may remain; run again" } : {}) };
}

export async function executeGraph({ command, language = "cypher", reason }, identity) {
  await assertNotWaiting(identity);
  if (!["cypher", "sql"].includes(language)) throw new Error("language must be cypher or sql");
  if (typeof command !== "string" || !command.trim()) throw new Error("command required");
  if (/^\s*(DROP DATABASE|DROP TYPE|TRUNCATE)/i.test(command)) {
    throw new Error("destructive schema/database operations are not permitted");
  }
  // a worker's raw writes are always proposals: they can do anything, and nothing undoes them
  if (decideWrite(identity, { kind: "command" }, { reason }).action !== "direct") {
    const q = await queueWrite({ kind: "command", command, language, user: identity.user, ...proposalFields(identity, reason) });
    return identity.role?.kind === "worker" ? { ...q, note: PROPOSED_NOTE } : q;
  }
  const result = await adbCommand(command, language);
  if (DELETE_RE.test(command)) await refreshGrants(); // revoke grants on what it deleted
  return { result };
}

/** a raw command that may delete entities (their grants are swept after it) */
const DELETE_RE = /\b(DELETE|TRUNCATE)\b/i;

/**
 * The Reconciliation stream's data-entry module (data-entry.js: a worker's write to a source system
 * through the queue), loaded when a data_entry proposal is first decided, so this module loads
 * without it. `useDataEntry(mod)` sets it instead: tests stub it; a deployment may wire its own.
 */
let dataEntryModule = null;
export function useDataEntry(mod) {
  dataEntryModule = mod;
}
const dataEntry = async () => (dataEntryModule ??= await import("./data-entry.js"));

/**
 * Execute a queued write (admin approval path); `placedBy` = the person who approved it, if a
 * person did; `approver` = whoever approved it. A data_entry proposal (a source-system write) is
 * applied by data-entry.js's applyProposedEntry, which records the audit event.
 */
export async function executePending(rec, placedBy, approver = placedBy) {
  if (rec.kind === "data_entry") return (await dataEntry()).applyProposedEntry(rec.payload, rec.id, approver);
  // upsert payloads carry the home resolved when the write was requested
  if (rec.kind === "upsert") return upsertEntities(JSON.parse(rec.payload));
  if (rec.kind === "rehome") return applyRehome({ ...JSON.parse(rec.payload), placedBy });
  if (rec.kind === "grant") return storeGrant(JSON.parse(rec.payload));
  if (rec.kind === "backfill") return backfillIdentity(Number(JSON.parse(rec.payload).limit) || 64);
  if (rec.kind === "merge") return mergeThings(JSON.parse(rec.payload));
  if (rec.kind === "fold") return foldEntries(JSON.parse(rec.payload));
  if (rec.kind === "typed_update") return applyTypedUpdate(JSON.parse(rec.payload));
  if (rec.kind === "delete_entry") return deleteEntry(JSON.parse(rec.payload));
  // approved: runs in the background (minutes for a long document)
  if (rec.kind === "ingest") {
    const p = JSON.parse(rec.payload);
    void startIngest(p);
    return { ingesting: true, doc_id: p.doc_id, sections: p.sections };
  }
  // an approved command says what it changed: one that matched nothing isn't applied
  const language = rec.language ?? "sql";
  const result = await adbCommand(countingCommand(rec.payload, language), language);
  if (changedCount(rec.payload, language, result) === 0) throw new Error(changedNothing(language));
  if (DELETE_RE.test(rec.payload)) await refreshGrants();
  return result;
}

/** move entities to another home: restricting applies, widening needs a person */
export async function setHome({ entities, to, reason, propose }, identity, scope) {
  await assertNotWaiting(identity);
  if (!SCOPED || !positionMap) throw new Error("position scoping is not enabled");
  const target = positionId(to);
  const results = [];
  for (const ref of entities) {
    const from = ref.home === undefined ? undefined : positionId(ref.home);
    const rows = await adbQuery(
      `SELECT @rid AS rid, name, _home, _placed_by, _placed_at FROM ${ENTITY_LABEL} WHERE name = :name${homeFilter(scope, { own: true })}${ASSERTIONS}`,
      { name: ref.name },
    );
    const candidates = rows.filter((r) => from === undefined || effectiveHome(positionMap, r._home) === from);
    if (candidates.length === 0) throw new Error(`no visible entity ${ref.name}${from ? ` homed at ${ref.home}` : ""} (granted entities can't be moved)`);
    if (candidates.length > 1) throw new Error(`${ref.name} exists at several homes you can see; pass its home`);
    const node = candidates[0];
    const current = effectiveHome(positionMap, node._home);
    if (current === target) {
      results.push({ name: ref.name, unchanged: true });
      continue;
    }
    const move = { rid: String(node.rid), name: ref.name, from: current, to: target };
    const kind = moveKind(positionMap, current, target);
    // one rule: a person placed it (an agent asks), widening (a person's call), a queued writer, a worker
    // asking on purpose, or the entry's claims lie with an authority the mover lacks
    const d = decideWrite(identity, { kind: "rehome", lives: current, claims: await claimsOfEntry(String(node.rid)) }, { to: target, propose, placedBy: node._placed_by, reason });
    if (d.action === "direct") {
      results.push({ name: ref.name, ...(await applyRehome({ ...move, ...(isPerson(identity) ? { placedBy: identity.user } : {}) })) });
      if (identity.role?.kind === "worker") await logChange(identity, { kind: "move", detail: `"${ref.name}" up to ${homeName(positionMap, target)}`, ...(reason ? { reason: String(reason).slice(0, 300) } : {}) });
      continue;
    }
    // a person placed it here: an agent asks before moving it, either way
    const placed = !isPerson(identity) && node._placed_by;
    if (placed) {
      const why = `${node._placed_by} placed "${ref.name}" at ${homeName(positionMap, current)}${node._placed_at ? ` on ${String(node._placed_at).slice(0, 10)}` : ""}: moving it is a person's decision`;
      results.push({ name: ref.name, placed_by_person: why, ...(await queueWrite({ kind: "rehome", payload: JSON.stringify(move), user: identity.user, home: current, ...proposalFields(identity, reason ? `${reason} (${why})` : why) })) });
      continue;
    }
    // only people widen who sees what; queued writers queue restrictions too; a proposal is reviewed where the rule homes it
    results.push({
      name: ref.name,
      [kind === "widen" ? "widening" : "restricting"]: true,
      ...(d.authority ? { authority: homeName(positionMap, d.authority) } : {}),
      ...(await queueWrite({ kind: "rehome", payload: JSON.stringify(move), user: identity.user, home: d.home ?? current, ...proposalFields(identity, reason ?? (d.reason || undefined)) })),
    });
  }
  return { results };
}

async function applyRehome({ rid, name, from, to, placedBy }) {
  if (!RID_RE.test(rid)) throw new Error("invalid record id");
  const rows = await adbQuery(`SELECT _home, name FROM ${rid}`);
  // a record id can be handed to another record once its own is gone: check it's still this entry
  if (!rows.length || (name && rows[0].name !== name)) throw new Error(`entity ${name} no longer exists`);
  if (effectiveHome(positionMap, rows[0]._home) !== from) throw new Error(`entity ${name} moved since the request`);
  // a person's move is recorded: a worker can't move the entry again without asking (setHome)
  if (placedBy) await adbCommand(`UPDATE ${rid} SET _home = :to, _placed_by = :who, _placed_at = :at`, "sql", { to, who: placedBy, at: new Date().toISOString() });
  else await adbCommand(`UPDATE ${rid} SET _home = :to`, "sql", { to });
  await claimsFollowEntry(rid, to);
  // seen from its new home: so are the things it's about
  const about = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('ABOUT')) FROM ${rid})`).catch(() => []);
  for (const a of about) if (RID_RE.test(String(a.dst))) await thingSeenFrom(String(a.dst), to).catch(() => {});
  log.info(`entity ${name} rehomed ${homeName(positionMap, from)} -> ${homeName(positionMap, to)}`);
  return { moved: true, from: homeName(positionMap, from), to: homeName(positionMap, to) };
}

/** fold an entry into another: its ABOUT links move (the things seen from the keep's home), then it's deleted */
export async function foldEntries({ keep, drop }) {
  if (!RID_RE.test(String(keep)) || !RID_RE.test(String(drop))) throw new Error("invalid fold");
  const k = (await adbQuery(`SELECT _home FROM ${keep} WHERE ${ENTRY_KINDS}`))[0];
  const d = (await adbQuery(`SELECT name FROM ${drop} WHERE ${ENTRY_KINDS}`))[0];
  if (!k || !d) throw new Error("one of the entries is gone");
  const edges = await adbQuery(`SELECT @in AS dst, role FROM (SELECT expand(outE('ABOUT')) FROM ${drop})`).catch(() => []);
  const home = effectiveHome(positionMap, k._home);
  let moved = 0;
  for (const e of edges) {
    const dst = String(e.dst);
    if (!RID_RE.test(dst)) continue;
    await aboutOnce(keep, dst, e.role ?? "mentions");
    await thingSeenFrom(dst, home);
    moved++;
  }
  await adbCommand(`DELETE FROM ${ENTITY_LABEL} WHERE @rid = ${drop}`);
  await refreshGrants();
  return { folded: true, kept: keep, deleted: drop, moved };
}

/** delete an entry (approved, or a stray nothing links) */
export async function deleteEntry({ rid }) {
  if (!RID_RE.test(String(rid))) throw new Error("invalid entry");
  const row = (await adbQuery(`SELECT name, _kind FROM ${rid} WHERE name IS NOT NULL AND ${ENTRY_KINDS}`))[0];
  if (!row) throw new Error("that entry is gone");
  if (row._kind === "task") throw new Error("a task entry isn't deleted");
  await adbCommand(`DELETE FROM ${ENTITY_LABEL} WHERE @rid = ${rid}`);
  await refreshGrants();
  return { deleted: rid, name: row.name };
}

/**
 * A typed record (a Database, a Host: another type than entries) is
 * corrected in place, not upserted (that would make an entry beside it).
 * Directly when what the worker read can be seen wherever the record is;
 * otherwise a proposal.
 */
export async function typedUpdate(row, type, args, identity) {
  if (args.valid_until !== undefined) throw new Error(`"${row.name}" is a ${type} record: it has no end date; set properties or facets`);
  const change = typedChange(args);
  const d = decideWrite(identity, { kind: "typed_update", lives: row._home }, { propose: args.propose, reason: args.reason });
  const payload = { rid: String(row.rid), name: row.name, type, ...change };
  if (d.action !== "direct") {
    return {
      ...(await queueWrite({ kind: "typed_update", payload: JSON.stringify(payload), user: identity.user, home: positionMap.root, ...proposalFields(identity, args.reason) })),
      note: args.propose ? PROPOSED_NOTE : d.lift ? `What you read reaches fewer people than this record does, so the correction is a proposal. ${PROPOSED_NOTE}` : `${d.reason}, so the correction is a proposal. ${PROPOSED_NOTE}`,
    };
  }
  const result = await applyTypedUpdate(payload);
  await logChange(identity, { kind: "update", detail: `${row.rid} "${row.name}" (${type}): ${[...Object.keys(change.properties), ...Object.keys(change.facets).map((f) => `${f} facet`)].join(", ")}`, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return result;
}

/** the fields a typed correction may set: plain names and values only */
function typedChange(args) {
  const properties = {};
  for (const [k, v] of Object.entries(args.properties ?? {})) {
    if (!PROP_RE.test(k) || k === "name") throw new Error(`can't set "${k}"`);
    if (["string", "number", "boolean"].includes(typeof v)) properties[k] = v;
  }
  const facets = {};
  for (const [f, text] of Object.entries(args.facets ?? {})) if (typeof text === "string" && text.trim()) facets[sanitizeFacet(f)] = text.slice(0, 4000);
  if (!Object.keys(properties).length && !Object.keys(facets).length) throw new Error("nothing to change");
  return { properties, facets };
}

/** apply a typed record's correction (direct, or approved) */
async function applyTypedUpdate({ rid, properties, facets }) {
  if (!RID_RE.test(String(rid))) throw new Error("invalid record");
  if (!(await adbQuery(`SELECT @rid FROM ${rid}`).catch(() => [])).length) throw new Error("that record is gone");
  const sets = [];
  const params = { now: new Date().toISOString() };
  for (const [i, [k, v]] of Object.entries(properties ?? {}).entries()) {
    if (!PROP_RE.test(k)) throw new Error(`can't set "${k}"`);
    sets.push(`${k} = :p${i}`);
    params[`p${i}`] = v;
  }
  const list = Object.entries(facets ?? {});
  const vecs = list.length ? await embedBatch(list.map(([, t]) => t)) : [];
  for (const [i, [f, text]] of list.entries()) {
    const facet = sanitizeFacet(f);
    sets.push(`text_${facet} = :f${i}`, `embed_${facet} = [${vecs[i].join(",")}]`);
    params[`f${i}`] = text;
  }
  await adbCommand(`UPDATE ${rid} SET ${[...sets, "updated_at = :now"].join(", ")}`, "sql", params);
  return { updated: rid, properties: Object.keys(properties ?? {}), facets: list.map(([f]) => f) };
}

/** what a rejection leaves behind, per kind: a data_entry proposal's audit event says it was refused */
export async function refusePending(rec) {
  if (rec?.kind !== "data_entry") return;
  await dataEntry()
    .then(({ refuseProposedEntry }) => refuseProposedEntry(rec.id))
    .catch((e) => log.warn(`data entry ${rec.id} not marked refused: ${String(e?.message ?? e).slice(0, 160)}`));
}

/** approved merge: the dropped thing's links move to the kept one */
export async function mergeThings({ keep, drop, drop_name }) {
  if (!RID_RE.test(String(keep)) || !RID_RE.test(String(drop))) throw new Error("invalid merge");
  const k = (await adbQuery(`SELECT _homes, _alias_norms FROM ${keep}`))[0];
  const d = (await adbQuery(`SELECT _homes, _alias_norms, _norm FROM ${drop}`))[0];
  if (!k || !d) throw new Error("one of the things is gone");
  const edges = await adbQuery(`SELECT @out AS src, role FROM (SELECT expand(inE('ABOUT')) FROM ${drop})`).catch(() => []);
  for (const e of edges) await aboutOnce(String(e.src), keep, e.role ?? "mentions");
  await adbCommand(`UPDATE ${keep} SET _homes = :homes, _alias_norms = :aliases`, "sql", {
    homes: [...new Set([...(k._homes ?? []), ...(d._homes ?? [])])],
    aliases: [...new Set([...(k._alias_norms ?? []), ...(d._alias_norms ?? []), d._norm, normalize(drop_name)].filter(Boolean))],
  });
  await adbCommand(`DELETE FROM ${ENTITY_LABEL} WHERE @rid = ${drop} AND _kind = 'thing'`);
  return { merged: true };
}

/** ---- pending-write queue (audited writes for low-capability identities) ---- */

export async function ensurePendingSchema() {
  await adbCommand("CREATE DOCUMENT TYPE PendingWrite").catch(() => {});
  for (const prop of ["id", "kind", "payload", "language", "requested_by", "created_at", "status", "executed_at", "approved_by", "home", "note", "job_id"]) {
    await adbCommand(`CREATE PROPERTY PendingWrite.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
}

/** a worker thread's queued write is a proposal: its reason, and the thread to resume when it's decided */
export const proposalFields = (identity, reason) =>
  identity.role?.kind === "worker" ? { note: String(reason ?? "").trim().slice(0, 600) || "(no reason given)", job: identity.role.job } : {};

export async function queueWrite(entry) {
  const id = randomUUID();
  const created = new Date().toISOString();
  const payload = entry.payload ?? entry.command ?? "";
  const language = entry.language ?? "sql";
  // awaited: a write is only reported as queued once the record exists
  await adbCommand(
    "INSERT INTO PendingWrite SET id = :id, kind = :kind, payload = :payload, language = :lang, " +
      "requested_by = :user, created_at = :created, status = :status, home = :home, note = :note, job_id = :job",
    "sql",
    {
      id,
      kind: entry.kind,
      payload,
      lang: language,
      user: entry.user,
      created,
      home: entry.home ?? null,
      status: entry.status ?? "pending",
      // a worker thread's proposal: its reason, and the thread (resumed when it's decided)
      note: entry.note ?? null,
      job: entry.job ?? null,
    },
  );
  console.log(`[graph-rag] write queued by ${entry.user}: ${String(payload).slice(0, 80)} (${id})`);
  return { queued: true, pendingId: id };
}

/** pending writes the approver may review (it must be able to see where each lands) */
export async function listPending(identity) {
  const rows = await adbQuery("SELECT FROM PendingWrite WHERE status = 'pending' ORDER BY created_at DESC LIMIT 100");
  return rows.filter((r) => mayReview(identity, r));
}

function mayReview(identity, rec) {
  if (!SCOPED || identity.open) return true;
  if (!positionMap) return false;
  const held = heldPositions(positionMap, identity.positions);
  if (!canSee(positionMap, held, rec.home ?? undefined)) return false;
  if (rec.kind === "rehome") {
    const { to } = JSON.parse(rec.payload);
    return canSee(positionMap, held, to);
  }
  return true;
}

export async function approvePending(id, identity, reason = "", { quiet = false } = {}) {
  const approver = identity.user;
  if (!PENDING_ID_RE.test(id)) throw new Error("invalid pending id");
  const rows = await adbQuery("SELECT FROM PendingWrite WHERE id = :id AND status = 'pending'", { id });
  const rec = rows[0];
  if (!rec || !mayReview(identity, rec)) throw new Error(`no pending write ${id}`);
  // claim it first: a write runs once, even with two approvals racing
  // (note: "by" is reserved in ArcadeDB SQL, so parameters avoid it)
  const claimed = await adbCommand(
    "UPDATE PendingWrite SET status = 'executing', approved_by = :actor WHERE id = :id AND status = 'pending'",
    "sql",
    { actor: approver, id },
  );
  if (Number(claimed?.[0]?.count ?? 0) !== 1) throw new Error(`pending write ${id} was already handled`);
  let result;
  try {
    // upsert/backfill payloads are JSON for their handlers, not SQL
    result = await executePending(rec, isPerson(identity) ? approver : undefined, approver);
  } catch (err) {
    await adbCommand("UPDATE PendingWrite SET status = 'failed', executed_at = :now WHERE id = :id", "sql", {
      now: new Date().toISOString(),
      id,
    }).catch(() => {});
    // a worker's proposal that couldn't be applied: the waiting thread hears why
    if (rec.job_id && !quiet) await resumeThread(rec.job_id, { proposal: rec.note || rec.kind, decision: "failed", reason: String(err?.message ?? err).slice(0, 600), answered_by: approver }).catch(() => {});
    throw err;
  }
  await adbCommand("UPDATE PendingWrite SET status = 'approved', executed_at = :now WHERE id = :id", "sql", {
    now: new Date().toISOString(),
    id,
  });
  console.log(`[graph-rag] write ${id} approved by ${approver}`);
  // a worker thread's proposal: it waited for this, and carries on
  if (rec.job_id && !quiet) await resumeThread(rec.job_id, { proposal: rec.note || rec.kind, decision: "approved", reason, answered_by: approver }).catch(() => {});
  // shares that waited on this write can now point at its entities
  if (rec.kind === "upsert") await resolveWaitingShares(id).catch((e) => log.warn(`waiting shares for ${id}: ${String(e).slice(0, 160)}`));
  return { approved: true, result };
}
export async function rejectPending(id, identity, reason = "", { quiet = false } = {}) {
  const rejector = identity.user;
  if (!PENDING_ID_RE.test(id)) throw new Error("invalid pending id");
  const rows = await adbQuery("SELECT FROM PendingWrite WHERE id = :id AND status = 'pending'", { id });
  if (!rows[0] || !mayReview(identity, rows[0])) throw new Error(`no pending write ${id}`);
  const done = await adbCommand(
    "UPDATE PendingWrite SET status = 'rejected', executed_at = :now, approved_by = :actor WHERE id = :id AND status = 'pending'",
    "sql",
    { now: new Date().toISOString(), actor: rejector, id },
  );
  if (Number(done?.[0]?.count ?? 0) !== 1) throw new Error(`pending write ${id} was already handled`);
  if (rows[0].kind === "upsert") await dropWaitingShares(id).catch((e) => log.warn(`waiting shares for ${id}: ${String(e).slice(0, 160)}`));
  // a rejected ingest leaves nothing behind
  if (rows[0].kind === "ingest" && docStore) await docStore.remove(JSON.parse(rows[0].payload).doc_id).catch(() => {});
  await refusePending(rows[0]);
  // a worker thread's proposal: the thread decides again (wherever it was rejected)
  if (rows[0].job_id && !quiet) await resumeThread(rows[0].job_id, { proposal: rows[0].note || rows[0].kind, decision: "rejected", reason, answered_by: rejector }).catch(() => {});
  return { rejected: true };
}
