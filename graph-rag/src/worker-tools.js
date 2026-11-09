/**
 * A worker thread's own tools, shaped around reconciliation (docs/ORGANIZATION-MODEL.md, "The worker's
 * job"): confirm a claim against its source row, record a conflict between claims (a query, not a
 * judgement), resolve an unresolved subject by explicit judgement (the one way a worker mints a thing),
 * mark a need met by a claim, enter data into a source system (applied or proposed by authority), and
 * ask. Every write to a source goes through data-entry.js and is audited; every write to the graph is
 * floored by what the worker read (floor.js), its brief included.
 *
 * Gone with the old job (read a note and work out what it means): link_things, relate_things,
 * queue_followup, unlink_things, delete_thing, merge_things, merge_entries, unrelate_things,
 * delete_entry, rename_thing, update_entry. A worker no longer writes entries: upsert_entities refuses
 * (server.js still registers it for the worker role).
 */
import { z } from "zod";
import { effectiveHome } from "./positions.js";
import { normalize, THING_TYPES } from "./things.js";
import { adbCommand, adbQuery, ENTITY_LABEL, RID_RE } from "./db.js";
import { aboutOnce, findThing, linkMentions, thingSeenFrom } from "./linker.js";
import { positionMap } from "./scope.js";
import { liftRefusal, workerWriteFloor } from "./floor.js";
import { actsForOf, assertNotWaiting, claimById, claimsOnAttribute, logChange, PROPOSED_NOTE, raiseQuestion, resolveSubjectStub, unresolvedNames } from "./worker-pool.js";
import { ensureSourceRef, referTo } from "./audit.js";
import { clientFor, columnFor, confirmAgainstRow, enterData } from "./data-entry.js";
import { askerSeesClaim } from "./requests.js";
import { closeIntervals, overlaps } from "./model/claims.js";
import { parseKey } from "./model/schema.js";
import { randomUUID } from "node:crypto";

/** a worker writes no entries: the section is on record as its person put it, and its claims are reconciled, not rewritten */
export async function workerUpsert() {
  throw new Error("A reconciliation worker writes no entries: confirm a claim (confirm_claim), resolve its subject (resolve_subject), record a conflict (record_conflict), enter data into the source (enter_data), or ask (raise_question).");
}

/** a claim by id, or a plain refusal */
async function needClaim(id) {
  const c = await claimById(String(id ?? "").trim());
  if (!c) throw new Error(`no claim ${id}: give a claim id from your brief`);
  return c;
}

/** the record key of a claim's subject: the thing's key in a system the source knows, else none */
async function keyOf(claim) {
  if (!claim.resolved) return null;
  const t = (await adbQuery(`SELECT label, _keys, _class FROM ${claim.thing}`).catch(() => []))[0];
  const keys = (Array.isArray(t?._keys) ? t._keys : []).map((k) => parseKey(k)).filter(Boolean);
  return { thing: t, key: keys[0] ?? null, keys };
}

/** where a claim's section is seen from */
async function sectionHome(claim) {
  const s = RID_RE.test(claim.section) ? (await adbQuery(`SELECT _home FROM ${claim.section}`).catch(() => []))[0] : null;
  return effectiveHome(positionMap, s?._home);
}

/**
 * Confirm a claim against the row its subject refers to: the source is read (never copied), the row's
 * existence is noted on its SourceRef, and the claim's value is compared with the row's column for its
 * attribute. No write to the source, no proposal: a confirmed claim changes nothing; an unconfirmed one
 * is reported, and entering the claim's value into the row is a separate, authorized act (enter_data).
 */
async function workerConfirmClaim(args, identity) {
  const claim = await needClaim(args.claim_id);
  if (!claim.resolved) throw new Error(`claim ${claim.id}'s subject is unresolved: resolve it first (resolve_subject), or ask`);
  const { thing, key } = await keyOf(claim);
  if (!key) throw new Error(`${thing?.label ?? claim.thing} has no record key: no source row to confirm against`);
  const { client } = await clientFor(key.key);
  const hit = await client.readRow(key.table, key.row_key, { key_column: args.key_column });
  const refRid = await ensureSourceRef(key.key, { seen_by: identity.user, seen: Boolean(hit) });
  if (hit) await referTo(claim.thing, refRid);
  const verdict = confirmAgainstRow(claim, hit?.row ?? null);
  await logChange(identity, { kind: "confirm", claim: claim.id, key: key.key, confirmed: verdict.confirmed, ...(verdict.column ? { column: verdict.column } : {}), ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return {
    claim: claim.id,
    key: key.key,
    row_found: Boolean(hit),
    ...verdict,
    note: !hit
      ? "The source has no such row: the key may be wrong (resolve the subject again), or the row is gone. Report it."
      : verdict.column === null
        ? "The row doesn't record this attribute: nothing to confirm or deny. Report it; the claim stands as recorded."
        : verdict.confirmed
          ? "Confirmed: the row holds the claimed value. Nothing to write."
          : "Not confirmed: the row holds a different value. If the row is right, the claim is what's wrong: leave it and report. If the claim is right and the row is stale, enter_data (it applies or is proposed by authority).",
  };
}

/**
 * Record a conflict between two claims on one attribute of one subject whose intervals overlap with
 * different values. Checked here by the query (model/claims.js overlaps over the subject's claims, after
 * closing intervals): what one claim supersedes is no conflict, and two claims the query doesn't name
 * aren't recorded as one whatever the worker thinks. A ClaimConflict row, once per pair, for a person.
 */
async function workerRecordConflict(args, identity) {
  await assertNotWaiting(identity);
  const [a, b] = await Promise.all(args.claim_ids.map(needClaim));
  if (a.id === b.id) throw new Error("two different claims are needed");
  if (!a.resolved || !b.resolved) throw new Error("both claims need a resolved subject: resolve_subject first");
  if (a.thing !== b.thing) throw new Error(`not a conflict: the claims are about different subjects (${a.thing} and ${b.thing})`);
  if (a.attribute !== b.attribute) throw new Error(`not a conflict: the claims are on different attributes (${a.attribute} and ${b.attribute})`);
  if (a.kind === "event" || b.kind === "event") throw new Error("not a conflict: an event is a point in time, it neither closes nor contradicts a state");
  const all = await claimsOnAttribute(a.thing, a.attribute, { limit: 100 });
  const byId = new Map(all.map((c) => [c.id, c]));
  byId.set(a.id, a);
  byId.set(b.id, b);
  const forQuery = (c) => ({ ...c, subject: { key: c.thing } });
  const pairs = overlaps(closeIntervals([...byId.values()].map(forQuery)));
  const hit = pairs.find(([x, y]) => (x.id === a.id && y.id === b.id) || (x.id === b.id && y.id === a.id));
  if (!hit) throw new Error(a.value === b.value ? "not a conflict: the claims give the same value" : `not a conflict: the claims' intervals don't overlap once closed (${a.valid_from}..${a.valid_until ?? "open"} and ${b.valid_from}..${b.valid_until ?? "open"}): the later one supersedes the earlier`);
  const [first, second] = [a, b].sort((x, y) => x.id.localeCompare(y.id));
  const existing = (await adbQuery("SELECT id, status FROM ClaimConflict WHERE claim_a = :a AND claim_b = :b LIMIT 1", { a: first.id, b: second.id }).catch(() => []))[0];
  if (existing) return { conflict: existing.id, already: true, status: existing.status, note: "This conflict is already recorded." };
  const id = randomUUID();
  await adbCommand("INSERT INTO ClaimConflict SET id = :id, subject = :s, attribute = :attr, claim_a = :a, claim_b = :b, found_by = :who, job = :job, at = :now, status = 'open', note = :note", "sql", {
    id,
    s: a.thing,
    attr: a.attribute,
    a: first.id,
    b: second.id,
    who: identity.user,
    job: identity.role.job,
    now: new Date().toISOString(),
    note: String(args.note ?? "").slice(0, 600),
  });
  await logChange(identity, { kind: "conflict", conflict: id, claims: [first.id, second.id], attribute: a.attribute, ...(args.note ? { reason: String(args.note).slice(0, 300) } : {}) });
  return { conflict: id, subject: a.thing, attribute: a.attribute, claims: [first.id, second.id], values: [first.value, second.value], note: "Recorded for a person to settle. You don't pick a side: report both values." };
}

/**
 * Resolve a subject to its instance, by the worker's explicit judgement: a claim's UNRESOLVED subject
 * (claim_id), or a name linking resolved to nothing (name; the entry's `_unresolved`, linker.js). The
 * instance is an existing thing (by record key, or by name and type) or a new one. Minting goes the one
 * way a thing is minted on a worker's vouching: linker.js `linkMentions` with `create: true` (the
 * Admission stream's admission rules apply there); the resolver (worker-pool.js resolveSubjectStub, or
 * the Admission stream's resolveSubject) only finds. A claim's edge is re-pointed at the thing. What is
 * minted is seen from the section's home, floored by what the worker read. A bare name resolved to an
 * existing thing links the entry to it the way the minting path does (an ABOUT edge, the thing seen from
 * here); a claim's subject is linked by its claim edge alone.
 */
async function workerResolveSubject(args, identity) {
  await assertNotWaiting(identity);
  const claim = args.claim_id ? await needClaim(args.claim_id) : null;
  if (claim?.resolved) throw new Error(`claim ${claim.id}'s subject is already resolved (${claim.thing}); nothing to do`);
  if (!claim && !args.name) throw new Error("which subject: a claim_id from your brief, or an unresolved name");
  const sectionRid = claim ? claim.section : identity.role.entry;
  const want = { key: args.thing?.key ?? null, name: args.thing?.name ?? args.name ?? claim?.subject?.name ?? null, type: args.thing?.type ?? null };
  const key = want.key ? parseKey(want.key) : null;
  if (want.key && !key) throw new Error(`not a record key (system:table:row): ${want.key}`);
  const home = claim ? await sectionHome(claim) : effectiveHome(positionMap, (await adbQuery(`SELECT _home FROM ${sectionRid}`).catch(() => []))[0]?._home);
  const { lift, floor } = workerWriteFloor(identity, home);
  let thing = await resolveSubjectStub({ key: key?.key ?? null, name: want.name });
  let minted = false;
  if (thing?.mint) {
    // the resolver found no instance for the key and says what to make: the key is an identity, so it resolves
    want.name = want.name ?? thing.mint.name ?? null;
    want.type = want.type ?? thing.mint.type ?? null;
    thing = null;
  }
  if (!thing) {
    if (!want.name || !want.type) throw new Error(`no existing thing matches: to make one, give its name and type (${THING_TYPES.join(", ")})${key ? "" : " and, when a source holds it, its record key"}`);
    const type = String(want.type).toLowerCase();
    if (!THING_TYPES.includes(type)) throw new Error(`type must be one of ${THING_TYPES.join(", ")}`);
    if (lift) throw new Error(liftRefusal(want.name, lift));
    // the worker vouches for the name: the linker mints it (and links the section to it) under its admission rules
    const [r] = await linkMentions(sectionRid, [{ name: want.name, type, role: "subject", ...(key ? { key: key.key } : {}) }], floor, { unsure: "skip", create: true, seen_by: identity.user });
    if (!r || (!r.created && !r.linked)) throw new Error(`the linker made nothing of "${want.name}": ${r?.skipped ?? r?.unsure ?? "no reason given"}`);
    thing = await findThing({ name: want.name, type, ...(key ? { key: key.key } : {}) });
    if (!thing) throw new Error(`"${want.name}" was linked but can't be found as one thing: give its key`);
    minted = Boolean(r.created);
    if (claim && minted) await adbCommand(`UPDATE ${thing.rid} SET _class = :c`, "sql", { c: claim.class }).catch(() => {});
  } else {
    // an existing thing learns the key and the class it was resolved under, and is seen from here
    const cur = (await adbQuery(`SELECT _keys, _class FROM ${thing.rid}`).catch(() => []))[0] ?? {};
    const keys = Array.isArray(cur._keys) ? cur._keys : [];
    await adbCommand(`UPDATE ${thing.rid} SET _keys = :k, _class = :c`, "sql", {
      k: key && !keys.includes(key.key) ? [...keys, key.key].slice(-10) : keys,
      c: cur._class ?? claim?.class ?? null,
    }).catch(() => {});
    await thingSeenFrom(String(thing.rid), floor).catch(() => {});
  }
  const rid = String(thing.rid);
  if (claim) {
    // the claim now points at its instance: the same edge properties, a new end
    const props = (await adbQuery(`SELECT id, kind, class, attribute, value, value_num, valid_from, valid_until, recorded_at, recorded_by, closed_by, _home, subject FROM ${claim.edge}`))[0];
    if (!props) throw new Error("the claim's edge is gone");
    await adbCommand(`DELETE FROM ${claim.edge}`);
    await adbCommand(
      `CREATE EDGE CLAIMS FROM ${claim.section} TO ${rid} SET id = :id, kind = :kind, class = :cls, attribute = :attr, value = :value, value_num = :num, valid_from = :vf, valid_until = :vu, recorded_at = :ra, recorded_by = :rb, closed_by = :cb, _home = :home, subject = :subject`,
      "sql",
      { id: props.id, kind: props.kind, cls: props.class, attr: props.attribute, value: props.value, num: props.value_num ?? null, vf: props.valid_from, vu: props.valid_until ?? null, ra: props.recorded_at, rb: props.recorded_by, cb: props.closed_by ?? null, home: props._home ?? null, subject: JSON.stringify({ ...(claim.subject ?? {}), key: key?.key ?? claim.subject?.key ?? null, name: want.name }) },
    );
  } else {
    // the name is settled: it leaves the entry's unresolved list, and the entry is about the thing (as when the linker mints)
    const row = (await adbQuery(`SELECT _unresolved FROM ${sectionRid}`).catch(() => []))[0];
    const unresolved = unresolvedNames(row?._unresolved);
    if (!minted) await linkResolvedThing(sectionRid, rid, resolvedRole(unresolved, args.name));
    const left = unresolved.filter((u) => normalize(u.name) !== normalize(args.name));
    await adbCommand(`UPDATE ${sectionRid} SET _unresolved = :u`, "sql", { u: left.length ? JSON.stringify(left) : null }).catch(() => {});
  }
  await logChange(identity, { kind: "resolve", ...(claim ? { claim: claim.id } : { name: args.name }), thing: rid, label: thing.label, minted, ...(key ? { key: key.key } : {}), ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return { ...(claim ? { claim: claim.id } : { name: args.name }), thing: rid, label: thing.label, type: thing._thing_type, minted, ...(key ? { key: key.key } : {}), note: minted ? `Made ${thing.label} (${thing._thing_type}) and resolved to it.` : `Resolved to the existing ${thing.label} (${thing._thing_type}).` };
}

/** the role an entry's unresolved name was mentioned in (linker.js), else the subject the worker resolved */
export function resolvedRole(unresolved, name) {
  const n = normalize(String(name ?? ""));
  return unresolved.find((u) => normalize(u.name) === n)?.role || "subject";
}

/**
 * A bare name resolved to an existing thing: the entry is about it, once (linker.js `aboutOnce`), as the
 * minting path links what it makes. The claim path has no use for this: the claim's edge is re-pointed.
 */
export async function linkResolvedThing(sectionRid, thingRid, role, { about = aboutOnce } = {}) {
  if (!RID_RE.test(String(sectionRid)) || !RID_RE.test(String(thingRid))) throw new Error("linking an entry to a thing takes two record ids");
  await about(String(sectionRid), String(thingRid), role);
  return { entry: String(sectionRid), thing: String(thingRid), role };
}

/**
 * Mark a need (a question on record; requests.js) met by a claim: the need meets the claim's section
 * (a NEAR edge, state "met") and closes. A question on an attribute is a state query when the state
 * exists; this is the worker saying it does. A claim the asker can't see can't close their need: it
 * stays open for an owner, and the asker learns nothing of what the worker found.
 */
async function workerMarkNeedMet(args, identity) {
  await assertNotWaiting(identity);
  const claim = await needClaim(args.claim_id);
  if (!claim.resolved) throw new Error(`claim ${claim.id}'s subject is unresolved: resolve it first`);
  const ref = String(args.need ?? "").trim();
  const need = RID_RE.test(ref)
    ? (await adbQuery(`SELECT @rid AS rid, name, _status, _asker FROM ${ref} WHERE _kind = 'need'`).catch(() => []))[0]
    : (await adbQuery(`SELECT @rid AS rid, name, _status, _asker FROM ${ENTITY_LABEL} WHERE _kind = 'need' AND (_qid = :r OR name = :r) LIMIT 2`, { r: ref }).catch(() => []))[0];
  if (!need) throw new Error(`no need ${ref}: give its id, its question id or its exact name`);
  if (need._status !== "open") throw new Error(`that need isn't open (${need._status})`);
  if (!(await askerSeesClaim(need._asker, claim))) throw new Error(`claim ${claim.id} can't close this need: the person who asked can't see it. Leave the need open; someone with authority over it answers or shares it.`);
  const rid = String(need.rid);
  const edges = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('NEAR')) FROM ${rid})`).catch(() => []);
  // the asker sees this claim: a meeting they're told about (needs.js askerView), as answering from state records it
  const met = edges.find((e) => String(e.dst) === claim.section);
  if (!met) await adbCommand(`CREATE EDGE NEAR FROM ${rid} TO ${claim.section} SET score = 1, state = 'visible', at = :now, claim = :claim`, "sql", { now: new Date().toISOString(), claim: claim.id });
  else await adbCommand(`UPDATE (SELECT expand(outE('NEAR')) FROM ${rid}) SET state = 'visible', claim = :claim WHERE @in = ${claim.section}`, "sql", { claim: claim.id }).catch(() => {});
  await adbCommand(`UPDATE ${rid} SET _status = 'met', _met_by = :claim`, "sql", { claim: claim.id });
  await logChange(identity, { kind: "need_met", need: rid, claim: claim.id, ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return { need: rid, claim: claim.id, met: true, note: "The need is met by this claim's section and closed." };
}

/**
 * Enter data into the source row a claim is about: the claim's value into the row's column for its
 * attribute (or the fields given), for the person who put the section on record, under their position.
 * data-entry.js decides by authority: applied through the write-capable instance, proposed for someone
 * with authority, or refused; every outcome is audited (an AuditEvent WROTE to the row's SourceRef).
 */
async function workerEnterData(args, identity) {
  await assertNotWaiting(identity);
  const claim = await needClaim(args.claim_id);
  if (!claim.resolved) throw new Error(`claim ${claim.id}'s subject is unresolved: resolve it first`);
  const { thing, key } = await keyOf(claim);
  if (!key) throw new Error(`${thing?.label ?? claim.thing} has no record key: there is no source row to enter data into`);
  const actsFor = await actsForOf(claim.section);
  if (!actsFor) throw new Error("the section says nobody put it on record: a data entry needs the person it's made for");
  let fields = args.fields && Object.keys(args.fields).length ? args.fields : null;
  if (!fields) {
    const { client } = await clientFor(key.key);
    const hit = await client.readRow(key.table, key.row_key, { key_column: args.key_column }).catch(() => null);
    const column = hit ? columnFor(claim.attribute, hit.row) : null;
    if (!column) throw new Error(`the row has no column for ${claim.attribute}: give fields ({ column: value }) naming the column to write`);
    if (confirmAgainstRow(claim, hit.row).confirmed) return { claim: claim.id, key: key.key, outcome: "unchanged", note: "The row already holds the claimed value: nothing to enter." };
    fields = { [column]: claim.value_num ?? claim.value };
  }
  const r = await enterData({ actsFor, by: identity.user, key: key.key, fields, cls: claim.class, attribute: claim.attribute, reason: args.reason, identity });
  await logChange(identity, { kind: "data_entry", claim: claim.id, key: key.key, outcome: r.outcome, fields, ...(r.pendingId ? { pending: r.pendingId } : {}), ...(args.reason ? { reason: String(args.reason).slice(0, 300) } : {}) });
  return { claim: claim.id, key: key.key, fields, ...r, ...(r.outcome === "proposed" ? { note: `${r.note} ${PROPOSED_NOTE}` } : {}) };
}

/** the tools of a worker thread, registered on the MCP server built for that identity (see createServer) */
export function registerWorkerTools(server, { identity, need }) {
  server.tool(
    "confirm_claim",
    `Confirm a claim from your brief against the source row its subject refers to (read-only): the row is
looked up by the subject's record key and its column for the claim's attribute is compared with the
claim's value. Nothing is written. key_column names the row's key column when the source can't say.`,
    { claim_id: z.string().min(8).max(80), key_column: z.string().max(80).optional(), reason: z.string().max(300).optional() },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await workerConfirmClaim(args, identity)) }] };
    },
  );
  server.tool(
    "record_conflict",
    `Record a conflict between two claims (by id) on one attribute of one subject whose values differ over
the same time. The overlap is checked here, not taken from you: a later claim that supersedes an earlier
one is no conflict. Recorded once per pair, for a person to settle; you don't pick a side.`,
    { claim_ids: z.array(z.string().min(8).max(80)).length(2), note: z.string().max(600).optional() },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerRecordConflict(args, identity)) }] };
    },
  );
  server.tool(
    "resolve_subject",
    `Resolve a subject to its instance, when you can tell which: a claim whose subject is UNRESOLVED in
your brief (claim_id), or a name linking resolved to nothing (name). An existing thing by record key
("mssql:dbo_Customer:TORO") or by name and type; or a new one, made with its name, type
(${THING_TYPES.join(", ")}) and, when a source holds it, its key. The one way you make a thing: only for
an identity that outlives this section. Can't tell? raise_question.`,
    {
      claim_id: z.string().min(8).max(80).optional(),
      name: z.string().min(1).max(120).optional(),
      thing: z.object({ name: z.string().min(1).max(120).optional(), type: z.string().max(20).optional(), key: z.string().max(200).optional() }).optional(),
      reason: z.string().max(300).optional(),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerResolveSubject(args, identity)) }] };
    },
  );
  server.tool(
    "mark_need_met",
    `Mark an open question (a need, by its id or exact name) met by a claim from your brief, when the claim
answers it. The need meets the claim's section and closes.`,
    { need: z.string().min(2).max(200), claim_id: z.string().min(8).max(80), reason: z.string().max(300).optional() },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerMarkNeedMet(args, identity)) }] };
    },
  );
  server.tool(
    "enter_data",
    `Enter a claim's value into the source row its subject refers to (the row's column for the attribute,
or the fields you give), for the person who put the section on record. Applied when that person holds
authority over the class and attribute; proposed for someone who does otherwise (then END YOUR TURN: you
resume with the decision); refused when they hold none. Every attempt is audited. Give a reason.`,
    {
      claim_id: z.string().min(8).max(80),
      fields: z.record(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
      key_column: z.string().max(80).optional(),
      reason: z.string().min(3).max(600),
    },
    async (args) => {
      need("write");
      return { content: [{ type: "text", text: JSON.stringify(await workerEnterData(args, identity)) }] };
    },
  );
  server.tool(
    "raise_question",
    `Ask the admin something you can't settle from the graph or your sources (which instance a subject
means, whether a conflict's values are both right). Give options when there are clear choices, and why
you're asking. Then END YOUR TURN with a short report: you're resumed with the answer later, in this
same conversation.`,
    { question: z.string().min(8).max(600), options: z.array(z.string().max(200)).max(6).optional(), why: z.string().max(600).optional() },
    async (args) => {
      need("read");
      return { content: [{ type: "text", text: JSON.stringify(await raiseQuestion(identity, args)) }] };
    },
  );
}

/** for tests and the integrator: the tools a worker has now, and the ones the old job had */
export const WORKER_TOOLS = ["confirm_claim", "record_conflict", "resolve_subject", "mark_need_met", "enter_data", "raise_question"];
export const REMOVED_WORKER_TOOLS = ["link_things", "relate_things", "queue_followup", "unlink_things", "delete_thing", "merge_things", "merge_entries", "unrelate_things", "delete_entry", "rename_thing", "update_entry"];
