/**
 * Needs: questions as entries (see needs.js), how they meet assertions and reach owners, the asker's and
 * the owners' sides.
 */
import { randomUUID } from "node:crypto";
import { ancestors, effectiveHome, heldPositions } from "./positions.js";
import { isExpired, liveClause } from "./extent.js";
import { grantShows, isActive } from "./grants.js";
import { askerView, groupLinked, groupView, JOIN_MIN, LINK_MIN, MATCH_MAX, MATCH_MIN, needName, openUntil, ownersFor, ownerView, pickPositions } from "./needs.js";
import { GRADER_MODEL, log } from "./context.js";
import { adbCommand, adbQuery, ENTITY_LABEL, FACETS, knownIndexes, PENDING_ID_RE, RID_RE } from "./db.js";
import { embedBatch } from "./models.js";
import { entriesByUser, ownsHome, personOf, personScope, positionMap, positionName, SCOPED } from "./scope.js";
import { gradeBatch } from "./floor.js";
import { grantAccess, grantCache, refreshGrants, storeGrant } from "./sharing.js";
import { policy } from "./org-policy.js";

/** ---- needs: questions as entries (see needs.js) ---- */

export const QUESTION_GRANTOR = "graph-rag: question";
const REQUEST_MATCH_MIN = Number.isFinite(Number(process.env.REQUEST_MATCH_MIN)) && process.env.REQUEST_MATCH_MIN ? Number(process.env.REQUEST_MATCH_MIN) : MATCH_MIN;
/** reads of assertions only (questions aren't knowledge to search, share or match) */
export const ASSERTIONS = " AND (_kind IS NULL OR _kind IN ['document', 'section'])";
/** in search: assertions, and questions only while open */
export const openNeedsClause = (now = Date.now()) => ` AND (_kind IS NULL OR _kind IN ['document', 'section'] OR (_kind = 'need' AND _status = 'open' AND _open_until > '${new Date(now).toISOString()}'))`;

export async function ensureNeedSchema() {
  for (const prop of ["_kind", "_qid", "_asker", "_asked_by", "_status", "_open_until", "_joined_into", "_questions", "_dismissed", "_met_by"]) {
    await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}.${prop} IF NOT EXISTS STRING`).catch(() => {});
  }
  await adbCommand(`CREATE PROPERTY ${ENTITY_LABEL}._asked IF NOT EXISTS INTEGER`).catch(() => {});
  await adbCommand(`CREATE INDEX IF NOT EXISTS ON ${ENTITY_LABEL} (_qid) NOTUNIQUE`).catch(() => {});
  await adbCommand("CREATE EDGE TYPE NEAR IF NOT EXISTS").catch(() => {});
  // ALSO: two people asking nearly the same thing (new question -> earlier one)
  await adbCommand("CREATE EDGE TYPE ALSO IF NOT EXISTS").catch(() => {});
  for (const [prop, type] of [["score", "DOUBLE"], ["state", "STRING"], ["at", "STRING"]]) await adbCommand(`CREATE PROPERTY NEAR.${prop} IF NOT EXISTS ${type}`).catch(() => {});
}

const needOf = (r) => ({
  rid: String(r["@rid"] ?? r.rid),
  qid: r._qid,
  name: r.name,
  question: r.text_identity ?? "",
  asker: r._asker,
  asked_by: r._asked_by,
  status: r._status,
  home: r._home,
  origin: r._origin,
  open_until: r._open_until ?? null,
  valid_until: r._valid_until ?? null,
  joined_into: r._joined_into ?? null,
  asked: Number(r._asked ?? 1),
  questions: JSON.parse(r._questions || "[]"),
  dismissed: JSON.parse(r._dismissed || "[]"),
  met_by: r._met_by ?? null,
});

async function loadNeed(qid) {
  if (!PENDING_ID_RE.test(String(qid))) throw new Error("invalid request id");
  const row = (await adbQuery(`SELECT FROM ${ENTITY_LABEL} WHERE _kind = 'need' AND _qid = :qid LIMIT 1`, { qid }))[0];
  return row ? needOf(row) : null;
}

/** a need's meetings: [{ erid, rid, name, home, state, score }] */
async function needEdges(rid) {
  const edges = await adbQuery(`SELECT @rid AS erid, @in AS dst, state, score FROM (SELECT expand(outE('NEAR')) FROM ${rid})`).catch(() => []);
  const dsts = [...new Set(edges.map((e) => String(e.dst)).filter((r) => RID_RE.test(r)))];
  const rows = dsts.length ? await adbQuery(`SELECT @rid AS rid, name, _home FROM [${dsts.join(",")}]`) : [];
  const at = new Map(rows.map((r) => [String(r.rid), r]));
  return edges
    .filter((e) => at.has(String(e.dst)))
    .map((e) => ({ erid: String(e.erid), rid: String(e.dst), name: at.get(String(e.dst)).name, home: effectiveHome(positionMap, at.get(String(e.dst))._home), state: e.state, score: Number(e.score) }));
}

/** who holds which positions (people only; for routing) */
const holdersMap = () => new Map([...entriesByUser].map(([name, e]) => [name, heldPositions(positionMap, e.positions)]));

/** does this person see the assertion (by position, or through a share) */
function personSees(person, row) {
  const s = personScope(person);
  if (!s) return false;
  if (row._written_by && row._written_by === person) return true;
  return ownsHome(s, row._home) || s.granted?.homes.has(effectiveHome(positionMap, row._home)) || grantShows(s.granted, { rid: String(row.rid ?? row["@rid"]), name: row.name, origin: row._origin ?? null });
}

/** show a need to someone: a share of the question itself, for as long as it's open */
async function shareNeed(need, recipient) {
  const already = grantCache.some(
    (g) => g.kind === "entity" && g.target === need.rid && (recipient.to_user ? g.to_user === recipient.to_user : g.to_pos === recipient.to_pos),
  );
  if (already) return;
  await storeGrant({
    id: randomUUID(),
    kind: "entity",
    target: need.rid,
    target_name: need.name,
    target_origin: need.origin,
    target_home: need.home,
    to_pos: recipient.to_pos ?? null,
    to_user: recipient.to_user ?? null,
    reason: `Asked by ${need.asker}`,
    granted_by: QUESTION_GRANTOR,
    expires_at: need.open_until,
  });
}

/** is this person among the owners an entry's meeting goes to (not merely above it) */
const ownerOf = (person, home, asker) => ownersFor(positionMap, home, holdersMap(), asker).includes(person);

/** is the question shown to this person: an active share of it to them or a position they reach */
function shownTo(need, person, scope) {
  const vis = scope.homes;
  return grantCache.some(
    (g) => isActive(g) && g.kind === "entity" && g.target === need.rid && (g.to_user ? g.to_user === person : vis === null || vis.has(g.to_pos)),
  );
}

/** record a meeting (once per pair) */
async function meet(need, assertionRid, score, state) {
  const edges = await adbQuery(`SELECT @in AS dst FROM (SELECT expand(outE('NEAR')) FROM ${need.rid})`).catch(() => []);
  if (edges.some((e) => String(e.dst) === assertionRid)) return false;
  await adbCommand(`CREATE EDGE NEAR FROM ${need.rid} TO ${assertionRid} SET score = :score, state = :state, at = :at`, "sql", {
    score: Math.round(score * 1000) / 1000,
    state,
    at: new Date().toISOString(),
  });
  return true;
}

/** the assertions closest to `vec` that `askerScope` can't see (never reaches the asker) */
async function matchHidden(vec, askerScope) {
  if (askerScope.homes === null) return []; // sees everything already
  const v = `[${vec.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
  const best = new Map();
  for (const facet of Object.keys(FACETS)) {
    if (!knownIndexes.has(facet)) continue;
    const rows = await adbQuery(
      `SELECT @rid AS rid, vectorCosineSimilarity(embed_${facet}, ${v}) AS score FROM ${ENTITY_LABEL} WHERE embed_${facet} IS NOT NULL${ASSERTIONS}${liveClause()} ORDER BY score DESC LIMIT 32`,
    ).catch(() => []);
    for (const row of rows) {
      const rid = String(row.rid);
      const score = Number(row.score);
      if (RID_RE.test(rid) && Number.isFinite(score) && score >= REQUEST_MATCH_MIN && score > (best.get(rid) ?? -2)) best.set(rid, score);
    }
  }
  if (best.size === 0) return [];
  const rows = await adbQuery(`SELECT @rid AS rid, name, _home, _origin FROM [${[...best.keys()].join(",")}]`);
  const granted = askerScope.granted ?? { homes: new Set(), entities: [] };
  return rows
    .map((r) => ({ rid: String(r.rid), name: r.name, origin: r._origin ?? null, home: effectiveHome(positionMap, r._home), score: best.get(String(r.rid)) ?? 0 }))
    .filter((m) => m.name && !askerScope.homes.has(m.home) && !granted.homes.has(m.home) && !grantShows(granted, m))
    .sort((a, b) => b.score - a.score)
    .slice(0, MATCH_MAX);
}

/** positions' description vectors (for posting unmatched needs); refreshed with the map */
let positionVecs = { map: null, list: [] };
async function describedPositions() {
  if (positionVecs.map === positionMap) return positionVecs.list;
  const described = Object.entries(positionMap.positions).filter(([id, p]) => id !== positionMap.root && p.description);
  const vecs = described.length ? await embedBatch(described.map(([, p]) => `${p.name}: ${p.description}`)) : [];
  positionVecs = { map: positionMap, list: described.map(([id], i) => ({ id, vec: vecs[i] })) };
  return positionVecs.list;
}

async function needVec(rid) {
  const row = (await adbQuery(`SELECT embed_identity FROM ${rid}`))[0];
  return Array.isArray(row?.embed_identity) ? row.embed_identity : null;
}

/**
 * A need opens: join the same person's open need if it's nearly the same
 * question; else meet the hidden assertions near it (their owners are shown
 * the question), or, if none, post it for the positions its words fit.
 */
async function openNeed(need, askerScope) {
  const vec = await needVec(need.rid);
  const now = Date.now();
  if (vec) {
    const v = `[${vec.join(",")}]`;
    const twin = (
      await adbQuery(
        `SELECT _qid, vectorCosineSimilarity(embed_identity, ${v}) AS score FROM ${ENTITY_LABEL} WHERE _kind = 'need' AND _asker = :asker AND _status = 'open' AND _open_until > :now AND _qid <> :qid ORDER BY score DESC LIMIT 1`,
        { asker: need.asker, now: new Date(now).toISOString(), qid: need.qid },
      ).catch(() => [])
    )[0];
    if (twin && Number(twin.score) >= JOIN_MIN) {
      const t = await loadNeed(twin._qid);
      const until = openUntil(now, policy.requestDays, t.valid_until);
      await adbCommand(`UPDATE ${t.rid} SET _asked = :asked, _questions = :q, _open_until = :until`, "sql", {
        asked: t.asked + 1,
        q: JSON.stringify([...t.questions, { text: need.question, at: new Date(now).toISOString() }].slice(-20)),
        until: until > t.open_until ? until : t.open_until,
      });
      await adbCommand(`UPDATE ${need.rid} SET _status = 'joined', _joined_into = :joined_into`, "sql", { joined_into: t.qid });
      log.info(`question ${need.qid} joined ${t.qid} (same asker, same question)`);
      return;
    }
    // other people asking nearly the same thing: linked, so owners answer them together
    const others = await adbQuery(
      `SELECT @rid AS rid, _qid, vectorCosineSimilarity(embed_identity, ${v}) AS score FROM ${ENTITY_LABEL} WHERE _kind = 'need' AND _status = 'open' AND _open_until > :now AND _asker <> :asker ORDER BY score DESC LIMIT 5`,
      { asker: need.asker, now: new Date(now).toISOString() },
    ).catch(() => []);
    for (const o of others) {
      if (!(Number(o.score) >= LINK_MIN) || !RID_RE.test(String(o.rid))) continue;
      await adbCommand(`CREATE EDGE ALSO FROM ${need.rid} TO ${String(o.rid)} SET score = :score, at = :at`, "sql", {
        score: Math.round(Number(o.score) * 1000) / 1000,
        at: new Date(now).toISOString(),
      });
      log.info(`question ${need.qid} linked to ${o._qid} (another person asked nearly the same)`);
    }
  }
  // how long it matters: the grader judges the question's subject (Friday's visit ends Friday)
  let validUntil = null;
  let validBy = "grader";
  if (GRADER_MODEL && policy.gradingEnabled) {
    const [v] = await gradeBatch(need.origin, [{ name: need.name, facets: { identity: need.question } }], now);
    validUntil = v ? (v.confidence >= policy.gradingConfidence ? v.until : null) : undefined;
  }
  const open_until = openUntil(now, policy.requestDays, validUntil ?? null);
  // a failed or absent grading: kept only as long as it's open (then pruned)
  if (validUntil === undefined || !(GRADER_MODEL && policy.gradingEnabled)) {
    validUntil = open_until;
    validBy = "question";
  }
  await adbCommand(`UPDATE ${need.rid} SET _status = 'open', _open_until = :open_until, _valid_until = :valid_until, _valid_by = :valid_by`, "sql", {
    open_until,
    valid_until: validUntil,
    valid_by: validBy,
  });
  const opened = { ...need, status: "open", open_until };
  const matches = vec ? await matchHidden(vec, askerScope) : [];
  const holders = holdersMap();
  const owners = new Set();
  for (const m of matches) {
    await meet(opened, m.rid, m.score, "open");
    for (const person of ownersFor(positionMap, m.home, holders, need.asker)) owners.add(person);
  }
  for (const person of owners) await shareNeed(opened, { to_user: person });
  let posted = [];
  if (matches.length === 0 && vec) {
    // nobody's data matches: post it where its words fit, for someone who knows to add it
    const seesAlready = new Set([effectiveHome(positionMap, need.home), ...ancestors(positionMap, effectiveHome(positionMap, need.home))]);
    posted = pickPositions(vec, await describedPositions(), seesAlready);
    for (const p of posted) await shareNeed(opened, { to_pos: p.id });
  }
  log.info(
    `question ${need.qid} by ${need.asker}: ${matches.length} match(es)${owners.size ? ` shown to ${[...owners].join(", ")}` : ""}${posted.length ? `; posted for ${posted.map((p) => positionName(p.id)).join(", ")}` : ""}; open until ${open_until.slice(0, 10)}`,
  );
}

/**
 * A new or changed assertion meets the open needs near it: the asker is told
 * if they can see it; otherwise its owners are shown the question.
 */
export async function meetAssertion(rid, vec) {
  if (!SCOPED || !positionMap || !Array.isArray(vec)) return;
  const row = (await adbQuery(`SELECT @rid AS rid, name, _home, _origin, _kind, _valid_until FROM ${rid}`))[0];
  if (!row || (row._kind && row._kind !== "section") || isExpired(row._valid_until)) return;
  const now = new Date().toISOString();
  const near = await adbQuery(
    `SELECT @rid AS rid, vectorCosineSimilarity(embed_identity, [${vec.join(",")}]) AS score FROM ${ENTITY_LABEL} WHERE _kind = 'need' AND _status = 'open' AND _open_until > :now AND embed_identity IS NOT NULL ORDER BY score DESC LIMIT 16`,
    { now },
  ).catch(() => []);
  const holders = holdersMap();
  for (const n of near) {
    if (!(Number(n.score) >= REQUEST_MATCH_MIN)) continue;
    const need = needOf((await adbQuery(`SELECT FROM ${String(n.rid)}`))[0]);
    if (personSees(need.asker, row)) {
      if (await meet(need, rid, Number(n.score), "visible")) log.info(`question ${need.qid}: ${row.name} answers it, and ${need.asker} can see it`);
      continue;
    }
    if (!(await meet(need, rid, Number(n.score), "open"))) continue;
    const owners = ownersFor(positionMap, effectiveHome(positionMap, row._home), holders, need.asker);
    for (const person of owners) await shareNeed(need, { to_user: person });
    log.info(`question ${need.qid}: new entry ${row.name} may answer it; shown to ${owners.join(", ") || "nobody"}`);
  }
}

/** ask: an agent drafts it (the person confirms on a card); a person's ask goes out at once */
export async function requestAccess({ question }, identity, scope) {
  if (!SCOPED || !positionMap) throw new Error("position scoping is not enabled");
  const text = String(question ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (text.length < 3) throw new Error("say what you'd like to know");
  const home = scope.writeHome ?? heldPositions(positionMap, entriesByUser.get(personOf(identity.user))?.positions)[0];
  if (!home) throw new Error("this identity holds no position, so it can't ask");
  const qid = randomUUID();
  const now = new Date().toISOString();
  const name = needName(qid, text);
  await adbCommand(
    `CREATE VERTEX ${ENTITY_LABEL} SET name = :name, _kind = 'need', _qid = :qid, _asker = :asker, _asked_by = :asked_by, _status = 'proposed', ` +
      "_home = :home, _origin = :home, _asked = 1, _questions = :questions, _dismissed = '[]', text_identity = :text, updated_at = :now",
    "sql",
    { name, qid, asker: personOf(identity.user), asked_by: identity.user, home, questions: JSON.stringify([{ text, at: now }]), text, now },
  );
  const need = await loadNeed(qid);
  try {
    const [vec] = await embedBatch([text]);
    await adbCommand(`UPDATE ${need.rid} SET embed_identity = [${vec.join(",")}]`);
  } catch (e) {
    log.warn(`question ${qid}: embedding failed, it won't meet anything: ${String(e).slice(0, 120)}`);
  }
  if (identity.agent) {
    return {
      proposed: true,
      requestId: qid,
      note: "Drafted only: nothing has been sent. Tell the person: \"I've drafted the question; nothing is sent until you press Ask on the card below.\"",
    };
  }
  await openNeed(need, scope);
  return askerRequest(qid, identity);
}

/** the asker's side: their own questions only (a joined one shows the one it joined) */
export async function askerRequest(qid, identity) {
  const need = await loadNeed(qid);
  if (!need || need.asker !== personOf(identity.user)) throw new Error(`no request ${qid} of yours`);
  if (need.status === "joined" && need.joined_into) {
    const target = await loadNeed(need.joined_into);
    if (target) return { ...askerView(target, await needEdges(target.rid)), id: need.qid, joined_into: target.qid };
  }
  return { ...askerView(need, await needEdges(need.rid)), also_asked: await alsoAsked(need) };
}

/** who else asked nearly the same, among questions the asker can see anyway */
async function alsoAsked(need) {
  const names = [];
  for (const rid of await linkedRids(need.rid)) {
    const row = (await adbQuery(`SELECT @rid AS rid, name, _home, _origin, _asker, _status FROM ${rid}`).catch(() => []))[0];
    if (row && row._asker !== need.asker && row._status === "open" && personSees(need.asker, row)) names.push(row._asker);
  }
  return [...new Set(names)];
}

export async function confirmRequest(qid, identity, scope) {
  if (identity.agent) throw new Error("the person confirms a request, not an agent");
  const need = await loadNeed(qid);
  if (!need || need.asker !== identity.user) throw new Error(`no request ${qid} waiting for you`);
  // claim it: a second confirm finds nothing to do
  const claimed = await adbCommand(`UPDATE ${ENTITY_LABEL} SET _status = 'opening' WHERE _kind = 'need' AND _qid = :qid AND _status = 'proposed'`, "sql", { qid });
  if (Number(claimed?.[0]?.count ?? 0) !== 1) throw new Error("this request was already handled");
  await openNeed(need, scope);
  return askerRequest(qid, identity);
}

async function closeNeed(need, status) {
  await adbCommand(`UPDATE ${need.rid} SET _status = :status`, "sql", { status });
  // owners and positions stop seeing it
  await adbCommand("UPDATE AccessGrant SET status = 'revoked', revoked_at = :now, revoked_by = 'graph-rag: question closed' WHERE target = :rid AND status = 'active'", "sql", {
    now: new Date().toISOString(),
    rid: need.rid,
  });
  await refreshGrants();
}

export async function withdrawRequest(qid, identity) {
  if (identity.agent) throw new Error("only the person can withdraw a request");
  const need = await loadNeed(qid);
  if (!need || need.asker !== identity.user) throw new Error(`no request ${qid} of yours`);
  if (!["proposed", "open"].includes(need.status)) throw new Error("this request is already closed");
  await closeNeed(need, "withdrawn");
  return askerRequest(qid, identity);
}

/** questions linked to this one (other people asking the same thing) */
async function linkedRids(rid) {
  const rows = await adbQuery(`SELECT @out AS a, @in AS b FROM (SELECT expand(bothE('ALSO')) FROM ${rid})`).catch(() => []);
  return [...new Set(rows.flatMap((r) => [String(r.a), String(r.b)]))].filter((r) => r !== rid && RID_RE.test(r));
}

/** the open questions shown to this person with their meetings, grouped where linked */
async function shownGroups(person, scope) {
  const rows = await adbQuery(
    `SELECT FROM ${ENTITY_LABEL} WHERE _kind = 'need' AND _status = 'open' AND _open_until > :now AND _asker <> :me LIMIT 300`,
    { now: new Date().toISOString(), me: person },
  );
  const items = new Map(); // qid -> { need, edges, mine }
  for (const row of rows) {
    const need = needOf(row);
    // shown to me through a share of the question (not merely below me in the tree)
    if (!shownTo(need, person, scope) || need.dismissed.includes(person)) continue;
    const edges = await needEdges(need.rid);
    items.set(need.qid, { need, edges, mine: edges.filter((e) => e.state !== "visible" && ownerOf(person, e.home, need.asker)) });
  }
  const byRid = new Map([...items.values()].map((i) => [i.need.rid, i.need.qid]));
  const links = [];
  for (const { need } of items.values()) for (const r of await linkedRids(need.rid)) if (byRid.has(r)) links.push([need.qid, byRid.get(r)]);
  const asked = (i) => i.need.questions[0]?.at ?? "";
  return groupLinked([...items.keys()], links).map((g) => g.map((q) => items.get(q)).sort((a, b) => asked(a).localeCompare(asked(b))));
}

const groupOut = (group) => {
  const v = groupView(group.map((i) => ownerView(i.need, i.mine)));
  return { ...v, entries: v.entries.map((e) => ({ ...e, home: positionName(e.home) })) };
};

/** the owners' side: open questions shown to this person, one item per group of linked ones */
export async function incomingRequests(identity) {
  const person = personOf(identity.user);
  const scope = personScope(person);
  if (!scope) return { requests: [] };
  const out = (await shownGroups(person, scope)).map(groupOut);
  return { requests: out.sort((a, b) => Number(b.status === "open") - Number(a.status === "open")) };
}

/** the group of linked questions shown to this person that holds `qid` */
async function groupOf(qid, person, scope) {
  return (await shownGroups(person, scope)).find((g) => g.some((i) => i.need.qid === qid)) ?? null;
}

/** the owner shares (some of) their entries with everyone in the group who asked */
export async function answerRequest(qid, { entries, until }, identity, scope) {
  if (identity.agent) throw new Error("the person who owns the data answers a request");
  const person = personOf(identity.user);
  const group = await groupOf(qid, person, personScope(person) ?? scope);
  if (!group) throw new Error("this request is closed");
  // the owner's entries across the group, by record id
  const offered = new Map();
  for (const i of group) for (const e of i.mine) if (e.state === "open" && !offered.has(e.rid)) offered.set(e.rid, e);
  const keys = new Set(Array.isArray(entries) ? entries.map(String) : []);
  const chosen = [...offered.values()].filter((e) => keys.has(e.rid));
  if (chosen.length === 0) throw new Error(offered.size ? "pick at least one of the matching entries" : `no request ${qid} for you to answer`);
  const results = [];
  for (const { need, edges } of group) {
    for (const e of chosen) {
      const edge = edges.find((x) => x.rid === e.rid);
      if (edge?.state === "shared" || edge?.state === "visible") continue;
      let done = false;
      try {
        // an answer always ends: the organization's default unless the owner picked a date
        const end = until ?? `${policy.defaultShareDays}d`;
        const r = (await grantAccess({ entities: [{ name: e.name, home: e.home }], person: need.asker, reason: `Asked: ${need.question}`.slice(0, 500), until: end }, identity, scope)).results[0];
        results.push({ name: e.name, asker: need.asker, ...(r.granted ? { granted: true, expires_at: r.expires_at } : { proposed: true }) });
        done = true;
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        done = /already sees/.test(msg); // that asker got it some other way meanwhile
        results.push({ name: e.name, asker: need.asker, error: msg.slice(0, 200) });
      }
      if (!done) continue;
      // a linked question that didn't meet the entry itself gets the meeting now
      if (edge) await adbCommand(`UPDATE ${edge.erid} SET state = 'shared'`);
      else await meet(need, e.rid, e.score ?? 0, "shared");
    }
  }
  const view = (await incomingRequests(identity)).requests.find((r) => r.ids.includes(qid)) ?? null;
  return { request: view, results };
}

export async function dismissRequest(qid, identity) {
  if (identity.agent) throw new Error("the person who owns the data answers a request");
  const person = personOf(identity.user);
  const scope = personScope(person);
  const group = scope && (await groupOf(qid, person, scope));
  if (!group) throw new Error(`no request ${qid} for you`);
  for (const { need, mine } of group) {
    for (const e of mine) if (e.state === "open") await adbCommand(`UPDATE ${e.erid} SET state = 'declined'`);
    await adbCommand(`UPDATE ${need.rid} SET _dismissed = :d`, "sql", { d: JSON.stringify([...new Set([...need.dismissed, person])]) });
  }
  return { dismissed: true, id: qid };
}

export async function expireRequests() {
  await adbCommand(`UPDATE ${ENTITY_LABEL} SET _status = 'expired' WHERE _kind = 'need' AND _status IN ['proposed', 'open'] AND _open_until < :now`, "sql", {
    now: new Date().toISOString(),
  }).catch((e) => log.warn(`question expiry sweep: ${String(e).slice(0, 120)}`));
}
