/**
 * Grants (see grants.js): who sees what beyond their positions, share proposals and the shares that wait on a
 * pending write, and the owned-entry search behind them.
 */
import { randomUUID } from "node:crypto";
import { effectiveHome, visibleHomes } from "./positions.js";
import { danglingGrants, isActive, resolveExpiry } from "./grants.js";
import { log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, PENDING_ID_RE, RID_RE } from "./db.js";
import { entriesByUser, homeFilter, ownsHome, peopleView, personOf, personScope, positionId, positionMap, positionName, SCOPED, scopeOf } from "./scope.js";
import { searchGraph } from "./search.js";
import { recordReads } from "./floor.js";
import { decideWrite, queueWrite } from "./write.js";
import { ASSERTIONS, QUESTION_GRANTOR } from "./requests.js";
import { expiryRules, policy } from "./org-policy.js";

/** ---- grants (see grants.js) ---- */

export let grantCache = []; // active grants, refreshed on change and every minute

export async function ensureGrantSchema() {
  await adbCommand("CREATE DOCUMENT TYPE AccessGrant IF NOT EXISTS").catch(() => {});
  for (const prop of ["id", "kind", "target", "target_name", "target_origin", "target_home", "to_pos", "to_user", "reason", "granted_by", "created_at", "expires_at", "status", "revoked_at", "revoked_by"]) {
    await adbCommand(`CREATE PROPERTY AccessGrant.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
}

export async function refreshGrants() {
  if (!SCOPED) return;
  try {
    const rows = await adbQuery("SELECT FROM AccessGrant WHERE status = 'active' LIMIT 5000");
    const active = rows.map((r) => ({ ...r, to: r.to_pos })).filter((g) => isActive(g));
    // a failed sweep keeps them: the read predicate still checks each entity
    const gone = new Set(
      (await danglingEntityGrants(active).catch((e) => (log.warn(`grant sweep failed: ${String(e).slice(0, 160)}`), []))).map((g) => g.id),
    );
    grantCache = active.filter((g) => !gone.has(g.id));
  } catch (e) {
    log.warn(`grant refresh failed (keeping ${grantCache.length}): ${String(e).slice(0, 160)}`);
  }
}

/**
 * Entity grants whose entry was deleted (or whose record id now holds another
 * entity: ArcadeDB reuses ids) are revoked, whatever deleted it.
 */
async function danglingEntityGrants(grants) {
  const rids = [...new Set(grants.filter((g) => g.kind === "entity" && RID_RE.test(String(g.target))).map((g) => g.target))];
  if (rids.length === 0) return [];
  const found = [];
  for (let i = 0; i < rids.length; i += 500) {
    const chunk = rids.slice(i, i + 500);
    found.push(...(await adbQuery(`SELECT @rid AS rid, name, _origin FROM ${ENTITY_LABEL} WHERE @rid IN [${chunk.join(",")}]`)));
  }
  const gone = danglingGrants(grants, found);
  for (const g of gone) {
    await adbCommand("UPDATE AccessGrant SET status = 'revoked', revoked_at = :now, revoked_by = :actor WHERE id = :id", "sql", {
      now: new Date().toISOString(),
      actor: "graph-rag: entry deleted",
      id: g.id,
    });
    log.info(`grant ${g.id} revoked: ${g.target_name} (${g.target}) was deleted`);
  }
  return gone;
}

/**
 * Who a share goes to: a position (`to`, by id or name) or one person
 * (`person`, by user name). A `to` that names no position but a person
 * counts as that person (agents often say "to": "bob").
 */
function recipientOf({ to, person }, identity) {
  if (to && person) throw new Error("share with a position (to) or a person (person), not both");
  if (!to && !person) throw new Error("say who to share with: a position (to) or a person (person)");
  let name = person ? String(person).trim() : null;
  if (!name) {
    try {
      return { to_pos: positionId(to), to_user: null };
    } catch (err) {
      if (!entriesByUser.has(String(to).trim())) throw err;
      name = String(to).trim();
    }
  }
  if (!entriesByUser.has(name)) throw new Error(`unknown person: ${name}`);
  if (name === personOf(identity.user)) throw new Error("that's you: you already see what you own");
  return { to_pos: null, to_user: name };
}

const recipientName = (g) => g.to_user ?? positionName(g.to_pos);
const recipientKind = (g) => (g.to_user ? "person" : "position");

/**
 * Does the recipient already see data homed at `home` by its own positions (the visibility
 * reading: a position sees the classes its authority covers, homed where it sees, plus what is
 * granted). A grant is the "plus what is granted": it adds to a recipient's view, and is only
 * needed where the recipient's own positions don't reach.
 */
function recipientSees(r, home) {
  // homes null = sees everything (the root)
  const homes = r.to_user ? personScope(r.to_user)?.homes : visibleHomes(positionMap, [r.to_pos]);
  if (homes === undefined) return false; // unknown person: sees nothing
  return homes === null || homes.has(home);
}

/** propose or make a grant; owners only, agents and queued writers propose */
export async function grantAccess({ entities, subtree: subtreeRef, to, person, reason, until }, identity, scope) {
  if (!SCOPED || !positionMap) throw new Error("position scoping is not enabled");
  if (!!entities === !!subtreeRef) throw new Error("grant either entities or a subtree, not both");
  const recipient = recipientOf({ to, person }, identity);
  const who = recipientName(recipient);
  const expires_at = resolveExpiry(until, expiryRules(identity, scope));
  const base = { ...recipient, reason: String(reason).slice(0, 500), granted_by: identity.user, expires_at };
  const targets = [];
  if (subtreeRef) {
    const p = positionId(subtreeRef);
    if (!ownsHome(scope, p)) throw new Error(`you can only grant what you own: ${subtreeRef} is outside your positions`);
    if (recipientSees(recipient, p)) throw new Error(`${who} already sees ${positionName(p)}`);
    targets.push({ kind: "subtree", target: p, target_name: positionName(p), target_home: p });
  } else {
    for (const ref of entities) {
      const from = ref.home === undefined ? undefined : positionId(ref.home);
      const rows = await adbQuery(
        `SELECT @rid AS rid, name, _home, _origin, _kind, _doc_id FROM ${ENTITY_LABEL} WHERE name = :name${homeFilter(scope, { own: true })}${ASSERTIONS}`,
        { name: ref.name },
      );
      const hits = rows.filter((r) => from === undefined || effectiveHome(positionMap, r._home) === from);
      if (hits.length === 0) {
        // not written yet? a share may wait on the person's own pending write
        const pend = await pendingEntityWrite(identity, ref.name);
        if (pend) {
          if (recipientSees(recipient, pend.origin)) throw new Error(`${who} already sees ${ref.name}`);
          targets.push({ kind: "entity", target: null, target_name: ref.name, target_origin: pend.origin, target_home: pend.origin, origin: pend.origin, after: pend.id });
          continue;
        }
        throw new Error(`no entity ${ref.name} you own${from ? ` at ${ref.home}` : ""} (granted entities can't be granted onward)`);
      }
      if (hits.length > 1) throw new Error(`${ref.name} exists at several homes you own; pass its home`);
      const home = effectiveHome(positionMap, hits[0]._home);
      if (recipientSees(recipient, home)) throw new Error(`${who} already sees ${ref.name}`);
      targets.push({ kind: "entity", target: String(hits[0].rid), target_name: ref.name, target_origin: hits[0]._origin ?? null, target_home: home });
      if (hits[0]._kind === "document") {
        // a document is shared with its sections (those the owner owns and the recipient doesn't see)
        const secs = await adbQuery(`SELECT @rid AS rid, name, _home, _origin FROM ${ENTITY_LABEL} WHERE _kind = 'section' AND _doc_id = :d${homeFilter(scope, { own: true })}`, { d: hits[0]._doc_id });
        for (const sec of secs) {
          const h = effectiveHome(positionMap, sec._home);
          if (!recipientSees(recipient, h)) targets.push({ kind: "entity", target: String(sec.rid), target_name: sec.name, target_origin: sec._origin ?? null, target_home: h });
        }
      }
    }
  }
  const results = [];
  for (const t of targets) {
    const grant = { id: randomUUID(), ...base, ...t };
    // people share what they own directly (it's theirs to share; time-limited and recorded) unless
    // the organization routes shares through review; agents only propose, and a person confirms
    const d = decideWrite(identity, { kind: "grant", lives: t.target_home }, { propose: Boolean(identity.agent) || !(policy.peopleShareDirectly || scope.root), reason });
    if (t.after) {
      // waits on the entity's pending write: a person's own share is confirmed
      // already (applies on approval); an agent's waits for the person too
      const q = await queueWrite({
        kind: "grant",
        payload: JSON.stringify(grant),
        user: identity.user,
        home: t.target_home,
        status: d.action !== "direct" ? "waiting" : "confirmed",
      });
      results.push({ proposed: true, waits_for_write: t.after, target: t.target_name, to: who, to_kind: recipientKind(recipient), ...q });
      continue;
    }
    if (d.action === "direct") {
      await storeGrant(grant);
      results.push({ granted: true, id: grant.id, target: t.target_name, to: who, to_kind: recipientKind(recipient), expires_at });
    } else {
      const q = await queueWrite({ kind: "grant", payload: JSON.stringify(grant), user: identity.user, home: d.home ?? t.target_home });
      results.push({ proposed: true, target: t.target_name, to: who, to_kind: recipientKind(recipient), ...q });
    }
  }
  return { results };
}

export async function storeGrant(g) {
  if (g.expires_at && Date.parse(g.expires_at) <= Date.now()) throw new Error("this grant has already expired");
  await adbCommand(
    "INSERT INTO AccessGrant SET id = :id, kind = :kind, target = :target, target_name = :target_name, target_origin = :target_origin, target_home = :target_home, " +
      "to_pos = :to_pos, to_user = :to_user, reason = :reason, granted_by = :granted_by, created_at = :created_at, expires_at = :expires_at, status = 'active'",
    "sql",
    { ...g, target_origin: g.target_origin ?? null, to_pos: g.to_pos ?? null, to_user: g.to_user ?? null, created_at: new Date().toISOString(), expires_at: g.expires_at ?? null },
  );
  log.info(`grant ${g.id}: ${g.kind} ${g.target_name} -> ${g.to_user ? `person ${g.to_user}` : positionName(g.to_pos)} by ${g.granted_by} until ${g.expires_at ?? "revoked"}`);
  await refreshGrants();
  return { granted: true, id: g.id };
}

/** revoking only restricts: the grantor or any owner of the data may */
export async function revokeGrant({ id }, identity, scope) {
  if (!positionMap) throw new Error("position map not loaded");
  if (!PENDING_ID_RE.test(id)) throw new Error("invalid grant id");
  const rows = await adbQuery("SELECT FROM AccessGrant WHERE id = :id AND status = 'active'", { id });
  const g = rows[0];
  if (!g || !(g.granted_by === identity.user || ownsHome(scope, g.target_home))) throw new Error(`no grant ${id} you can revoke`);
  await adbCommand("UPDATE AccessGrant SET status = 'revoked', revoked_at = :now, revoked_by = :actor WHERE id = :id", "sql", {
    now: new Date().toISOString(),
    actor: identity.user,
    id,
  });
  log.info(`grant ${id} revoked by ${identity.user}`);
  await refreshGrants();
  return { revoked: true, id };
}

/** grants on data the caller owns (outgoing) and grants it receives (incoming) */
export function listGrants(scope) {
  if (!positionMap) return { grants: [] };
  const vis = scope.homes;
  const out = [];
  for (const g of grantCache) {
    if (!isActive(g)) continue;
    // a question shown to its owners isn't a share anyone made: listing it
    // would tell the asker who was asked (owners see it under Asked of you)
    if (g.granted_by === QUESTION_GRANTOR) continue;
    const outgoing = ownsHome(scope, g.target_home);
    const incoming = g.to_user ? g.to_user === scope.person : vis === null || vis.has(g.to_pos);
    if (!outgoing && !incoming) continue;
    out.push({
      id: g.id,
      kind: g.kind,
      target: g.target_name,
      target_home: positionName(g.target_home),
      to: recipientName(g),
      to_kind: recipientKind(g),
      reason: g.reason,
      granted_by: g.granted_by,
      expires_at: g.expires_at ?? null,
      direction: outgoing ? "outgoing" : "incoming",
    });
  }
  return { grants: out };
}

/** a pending upsert by the same person (or their agents) that would create `name` */
async function pendingEntityWrite(identity, name) {
  const person = personOf(identity.user);
  const rows = await adbQuery("SELECT id, payload, requested_by FROM PendingWrite WHERE kind = 'upsert' AND status = 'pending' ORDER BY created_at DESC LIMIT 200");
  for (const r of rows) {
    if (personOf(r.requested_by) !== person) continue;
    try {
      const p = JSON.parse(r.payload);
      if (p.home && (p.entities ?? []).some((e) => e?.name === name)) return { id: r.id, origin: p.home };
    } catch {
      /* not an upsert payload */
    }
  }
  return null;
}

/**
 * A write was approved: shares waiting on it now point at the real entity.
 * Grading may have homed it above the person; then it isn't theirs to share.
 */
export async function resolveWaitingShares(writeId) {
  const rows = await adbQuery(
    "SELECT FROM PendingWrite WHERE kind = 'grant' AND status IN ['waiting', 'confirmed'] AND payload LIKE :pat",
    { pat: `%"after":"${writeId}"%` },
  );
  for (const rec of rows) {
    const g = JSON.parse(rec.payload);
    const ent = (await adbQuery(`SELECT @rid AS rid, _home FROM ${ENTITY_LABEL} WHERE name = :name AND _origin = :origin LIMIT 1`, { name: g.target_name, origin: g.origin }))[0];
    const entry = entriesByUser.get(personOf(rec.requested_by));
    const owner = entry ? scopeOf({ user: entry.user, positions: entry.positions ?? [], caps: {} }) : null;
    if (!ent || !owner || !ownsHome(owner, ent._home)) {
      const why = !ent ? "the entry wasn't written" : "the entry was filed above the person, so it isn't theirs to share";
      await adbCommand("UPDATE PendingWrite SET status = 'failed', executed_at = :now, note = :why WHERE id = :id", "sql", { now: new Date().toISOString(), why, id: rec.id });
      log.info(`share ${rec.id} not made: ${why}`);
      continue;
    }
    const resolved = { ...g, target: String(ent.rid), target_origin: g.origin, target_home: effectiveHome(positionMap, ent._home), after: undefined };
    if (rec.status === "confirmed" && !(policy.peopleShareDirectly || owner.root)) {
      // shares go through review: an ordinary request in Approvals now
      await adbCommand("UPDATE PendingWrite SET status = 'pending', payload = :payload, note = :note WHERE id = :id", "sql", {
        payload: JSON.stringify(resolved),
        note: "said yes; waiting for review",
        id: rec.id,
      });
      continue;
    }
    if (rec.status === "confirmed") {
      try {
        await storeGrant({ ...resolved, granted_by: rec.approved_by || personOf(rec.requested_by) });
        await adbCommand("UPDATE PendingWrite SET status = 'approved', payload = :payload, executed_at = :now WHERE id = :id", "sql", {
          payload: JSON.stringify(resolved),
          now: new Date().toISOString(),
          id: rec.id,
        });
      } catch (e) {
        await adbCommand("UPDATE PendingWrite SET status = 'failed' WHERE id = :id", "sql", { id: rec.id }).catch(() => {});
        log.warn(`share ${rec.id} failed: ${String(e).slice(0, 120)}`);
      }
    } else {
      // the person hasn't decided yet: an ordinary proposal now
      await adbCommand("UPDATE PendingWrite SET status = 'pending', payload = :payload WHERE id = :id", "sql", { payload: JSON.stringify(resolved), id: rec.id });
    }
  }
}

/** a write was rejected: shares waiting on it go with it */
export async function dropWaitingShares(writeId) {
  await adbCommand(
    "UPDATE PendingWrite SET status = 'rejected', executed_at = :now WHERE kind = 'grant' AND status IN ['waiting', 'confirmed'] AND payload LIKE :pat",
    "sql",
    { now: new Date().toISOString(), pat: `%"after":"${writeId}"%` },
  );
}

/** a share proposed by one of this person's own agents, on data the person owns */
function ownProposal(identity, scope, rec) {
  if (identity.agent || rec?.kind !== "grant") return null;
  if (!String(rec.requested_by ?? "").startsWith(`${identity.user}/agent:`)) return null;
  let g;
  try {
    g = JSON.parse(rec.payload);
  } catch {
    return null;
  }
  return ownsHome(scope, g.target_home) ? g : null;
}

function proposalView(rec, g) {
  return {
    id: rec.id,
    status: rec.status,
    // waiting/confirmed: the entry's write isn't approved yet
    ...(g.after ? { waits_for_write: true } : {}),
    ...(rec.note ? { note: rec.note } : {}),
    max_days: policy.maxGrantDays,
    target: g.kind === "subtree" ? `everything under ${positionName(g.target)}` : g.target_name,
    to: recipientName(g),
    to_kind: recipientKind(g),
    reason: g.reason,
    expires_at: g.expires_at ?? null,
  };
}

export async function proposalStatus(id, identity, scope) {
  if (!PENDING_ID_RE.test(id)) throw new Error("invalid id");
  const rec = (await adbQuery("SELECT FROM PendingWrite WHERE id = :id", { id }))[0];
  const g = rec && ownProposal(identity, scope, rec);
  if (!g) throw new Error(`no share proposal ${id} of yours`);
  return proposalView(rec, g);
}

/** the person confirms (optionally with another end date or recipient) */
export async function confirmProposal(id, { until, to, person } = {}, identity, scope) {
  if (!PENDING_ID_RE.test(id)) throw new Error("invalid id");
  const rec = (await adbQuery("SELECT FROM PendingWrite WHERE id = :id AND status IN ['pending', 'waiting']", { id }))[0];
  const g = rec && ownProposal(identity, scope, rec);
  if (!g) throw new Error(`no pending share proposal ${id} of yours`);
  const grant = { ...g, granted_by: identity.user };
  if (until !== undefined) grant.expires_at = resolveExpiry(until, expiryRules(identity, scope));
  if (to !== undefined || person !== undefined) {
    Object.assign(grant, recipientOf({ to, person }, identity));
    if (recipientSees(grant, grant.target_home)) throw new Error(`${recipientName(grant)} already sees it`);
  }
  if (!policy.peopleShareDirectly && !scope.root) {
    // the organization routes people's shares through review: the person's yes
    // is recorded; an approver makes it (it stays in Approvals)
    await adbCommand("UPDATE PendingWrite SET payload = :payload, note = :note WHERE id = :id AND status IN ['pending', 'waiting']", "sql", {
      payload: JSON.stringify(grant),
      note: `${identity.user} said yes; waiting for review`,
      id,
    });
    return proposalView({ ...rec, note: `${identity.user} said yes; waiting for review` }, grant);
  }
  if (rec.status === "waiting") {
    // the entry isn't written yet: remember the yes; it applies on approval
    const done = await adbCommand(
      "UPDATE PendingWrite SET status = 'confirmed', approved_by = :actor, payload = :payload WHERE id = :id AND status = 'waiting'",
      "sql",
      { actor: identity.user, payload: JSON.stringify(grant), id },
    );
    if (Number(done?.[0]?.count ?? 0) !== 1) throw new Error("this share was already handled");
    return proposalView({ ...rec, status: "confirmed" }, grant);
  }
  const claimed = await adbCommand(
    "UPDATE PendingWrite SET status = 'executing', approved_by = :actor WHERE id = :id AND status = 'pending'",
    "sql",
    { actor: identity.user, id },
  );
  if (Number(claimed?.[0]?.count ?? 0) !== 1) throw new Error("this share was already handled");
  try {
    await storeGrant(grant);
  } catch (err) {
    await adbCommand("UPDATE PendingWrite SET status = 'failed' WHERE id = :id", "sql", { id }).catch(() => {});
    throw err;
  }
  await adbCommand("UPDATE PendingWrite SET status = 'approved', executed_at = :now WHERE id = :id", "sql", { now: new Date().toISOString(), id });
  return proposalView({ ...rec, status: "approved" }, grant);
}

export async function declineProposal(id, identity, scope) {
  if (!PENDING_ID_RE.test(id)) throw new Error("invalid id");
  const rec = (await adbQuery("SELECT FROM PendingWrite WHERE id = :id AND status IN ['pending', 'waiting', 'confirmed']", { id }))[0];
  const g = rec && ownProposal(identity, scope, rec);
  if (!g) throw new Error(`no pending share proposal ${id} of yours`);
  await adbCommand("UPDATE PendingWrite SET status = 'rejected', executed_at = :now, approved_by = :actor WHERE id = :id AND status IN ['pending', 'waiting', 'confirmed']", "sql", {
    now: new Date().toISOString(),
    actor: identity.user,
    id,
  });
  return proposalView({ ...rec, status: "rejected" }, g);
}

/** semantic search over what the caller owns (what it may share) */
export async function findShareable({ query, k = 8 }, identity, scope) {
  const own = { ...scope, granted: undefined };
  const read = [];
  const res = await searchGraph({ query, k, assertions_only: true }, own, read);
  recordReads(identity, read);
  return {
    results: res.results.map((r) => ({
      name: r.name,
      home: r.home?.name,
      snippet: String(r.properties?.text_identity ?? "").slice(0, 240),
      score: r.score,
    })),
    related: res.relationships,
    // where things can be shared to (match the person's wording to these)
    positions: Object.values(positionMap?.positions ?? {}).filter((p) => p.parent !== null).map((p) => p.name),
    people: positionMap ? peopleView(personOf(identity.user)) : [],
  };
}
