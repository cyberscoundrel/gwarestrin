// Conversation batches: the input model docs/ORGANIZATION-MODEL.md puts in
// place of sparse notes. A batch is a set of on-record conversations, each
// between a named person at a position and their agent, with the condensed
// document the condenser is expected to emit (src/model/claims.js shape) and
// where each claim and section is expected to land. This module is pure: the
// generator from the oracle fixture, the shape check, and the clean-batch
// bar over rows read from a graph. Used by scripts/make-conversation-batch.mjs,
// scripts/batch-bar.mjs, e2e/scenarios-harness.mjs and test/harness-batch.test.js.
// The batch file's shape is documented in test/fixtures/conversations/README.md.
import { claimHome } from "../src/model/authority.js";
import { claimsOf, normalizeDocument, normalizeName } from "../src/model/claims.js";
import { parseKey } from "../src/model/schema.js";
import { ancestors, commonAncestor, parsePositionMap } from "../src/positions.js";

export const BATCH_SHAPE = 1;

/** the batches' three positions (ORACLE.md) in the test tree's ids (test/fixtures/positions.json, e2e.sh) */
export const POSITION = { floor: "floor", Ops: "ops", "admins-only": "org" };
/** how a conversation refers to each position */
export const POSITION_SPOKEN = { floor: "the floor", ops: "Operations", org: "the owners" };
/** the writers of every oracle note, at the positions they wrote from */
export const PEOPLE = {
  alice: { name: "Alice", position: "ops" },
  bob: { name: "Bob", position: "floor" },
  admin: { name: "the admin", position: "org" },
};
/** a batch is generated against this tree (the one every fixture and e2e.sh use) */
export const TREE = {
  root: "org",
  positions: {
    org: { name: "Top of the organization" },
    ops: { name: "Operations", parent: "org" },
    floor: { name: "Production floor", parent: "ops" },
  },
};

const RANK = { floor: 0, Ops: 1, "admins-only": 2 };

/** "mssql:dbo_Work_Center:INSPECT-2" -> "INSPECT-2"; a name stays a name; a class subject drops its marker */
export function subjectLabel(subject) {
  if (subject && typeof subject === "object") return subject.name ?? subject.key?.split(":").pop() ?? subject.class ?? "it";
  const s = String(subject ?? "");
  const m = /^(.*)\s\(class\)$/.exec(s);
  if (m) return `${m[1]} in general`;
  const parts = s.split(":");
  return parts.length === 3 ? parts[2] : s;
}

/** "quote_floor" -> "quote floor" */
export const spokenAttribute = (a) => String(a ?? "").replace(/_/g, " ");

/**
 * One oracle claim in the contract's shape (as test/oracle.test.js adapts
 * it): `authority` leaves the claim (it becomes the expected placement), a
 * subject "X (class)" is the class itself, and the claim gets an id.
 */
export function adaptClaim(c, id) {
  const m = typeof c.subject === "string" ? /^(.*)\s\(class\)$/.exec(c.subject) : null;
  const { authority: _authority, ...claim } = c;
  return { id, ...claim, ...(m ? { subject: { scope: "class", name: m[1] } } : {}) };
}

const OPENER = {
  commitment: (x) => `Something for the record about ${x}.`,
  event: (x) => `An update on ${x}.`,
  actor: (x) => `A note about ${x}.`,
  resource: (x) => `About ${x}.`,
  residue: () => "One more thing.",
};

const sentence = (c) => `${subjectLabel(c.subject)} ${spokenAttribute(c.attribute)}: ${c.value}`;

/**
 * One conversation from one oracle note: a short exchange in which the
 * note's facts come up in context across a few turns, the condensed
 * document the condenser is expected to emit, and where each claim and
 * section lands. Claims of one authority share a section, lowest authority
 * first; the note's own words go in the most restricted section, the lower
 * sections carry only their own claims, so nothing a section says is above
 * the people who see it. `recordedAt` is the conversation's recording time.
 */
export function conversationOf(note, recordedAt, tree = parsePositionMap(TREE)) {
  const person = PEOPLE[note.writer] ?? { name: note.writer, position: POSITION[note.origin_position] ?? tree.root };
  const origin = POSITION[note.origin_position] ?? person.position;
  const originSpoken = POSITION_SPOKEN[origin] ?? origin;
  const claims = (note.claims ?? []).map((c, j) => ({ ...c, id: `${note.id}#${j}` }));
  const authorities = [...new Set(claims.map((c) => c.authority))].sort((a, b) => RANK[a] - RANK[b]);
  const above = claims.filter((c) => RANK[c.authority] > RANK[note.origin_position]);
  const unresolved = claims.filter((c) => c.valid_from === null);
  const label = note.instance ? subjectLabel(note.instance) : subjectLabel(claims[0]?.subject ?? "it");
  const turns = [{ role: "person", text: (OPENER[note.primitive] ?? OPENER.residue)(label) }, { role: "agent", text: "Go ahead. Say when it goes on record and I will condense it." }, { role: "person", text: note.text }];
  if (claims.length === 0) {
    turns.push({ role: "agent", text: "I cannot tell what that refers to. Which job, person or order is it about?" });
    turns.push({ role: "person", text: "Leave it as it is; I know what it means. On record." });
    turns.push({ role: "agent", text: `On record under ${originSpoken}: no claims, the note stands as text.` });
  } else {
    if (unresolved.length) turns.push({ role: "agent", text: `When does that take effect: ${unresolved.map((c) => spokenAttribute(c.attribute)).join(" and ")}?` });
    else if (claims.length > 1) turns.push({ role: "agent", text: `So that is ${claims.length} things to record: ${claims.map((c) => spokenAttribute(c.attribute)).join(", ")}. Anything to keep narrower than ${originSpoken}?` });
    else turns.push({ role: "agent", text: `Noted, ${subjectLabel(claims[0].subject)} ${spokenAttribute(claims[0].attribute)}. Is that for everyone at ${originSpoken}?` });
    const answer = [];
    if (unresolved.length) answer.push("It holds from when I say it; I will tell you when it changes.");
    if (above.length) answer.push(`Keep the ${[...new Set(above.map((c) => spokenAttribute(c.attribute)))].join(" and ")} part to ${POSITION_SPOKEN[POSITION[above[0].authority]]}.`);
    else answer.push(`Yes, for everyone at ${originSpoken}.`);
    answer.push("On record.");
    turns.push({ role: "person", text: answer.join(" ") });
    turns.push({ role: "agent", text: `On record under ${originSpoken}: ${claims.map(sentence).join("; ")}.` });
  }
  // the condensed document: one section per authority, lowest first; the note's words in the most restricted
  const groups = authorities.length ? authorities : [note.origin_position];
  const top = groups[groups.length - 1];
  const sections = groups.map((authority, i) => {
    const own = claims.filter((c) => c.authority === authority);
    const spoken = POSITION_SPOKEN[POSITION[authority]];
    const text =
      authority === top
        ? `${person.name} (${originSpoken}) put on record: ${note.text}${unresolved.length ? " It holds from the time of recording until said otherwise." : ""}`
        : `${person.name} (${originSpoken}) recorded, for ${spoken}: ${own.map((c) => `${sentence(c)}.`).join(" ")}`;
    return { heading: groups.length === 1 ? note.title : `${note.title}: ${spoken} part`, text, claims: own.map((c) => adaptClaim(c, c.id)), authority, index: i };
  });
  const sectionHome = (s) => (s.claims.length ? claimHome(tree, origin, POSITION[s.authority]) : origin);
  const document = {
    title: note.title,
    description: `Condensed from ${person.name}'s on-record conversation with their agent (${note.id}, batch ${note.batch}).`,
    recorded_by: note.writer,
    position: origin,
    reason: `${person.name} put the exchange on record`,
    recorded_at: recordedAt,
    sections: sections.map(({ heading, text, claims: cs }) => ({ heading, text, claims: cs })),
  };
  const placements = sections.flatMap((s) => s.claims.map((c) => ({ id: c.id, section: s.index, authority: s.authority, home: commonAncestor(tree, [claimHome(tree, origin, POSITION[s.authority]), sectionHome(s)]) })));
  return {
    id: `conv-${note.id.replace(/\s+/g, "-")}`,
    note: note.id,
    batch: note.batch,
    primitive: note.primitive,
    person: note.writer,
    person_name: person.name,
    position: origin,
    on_record: true,
    recorded_at: recordedAt,
    turns,
    expected: {
      document,
      sections: sections.map((s) => ({ index: s.index, heading: s.heading, authority: s.authority, home: sectionHome(s) })),
      placements,
      document_home: origin,
    },
  };
}

/**
 * The batch from the oracle (every note, in order). `recordedAt` is the
 * first conversation's time; each later one is a minute on, so the batch is
 * the same bytes every run and claims on one attribute still order.
 */
export function generateBatch(oracle, { recordedAt = "2026-11-06T09:00:00.000Z", name = "oracle-sixty", source = "oracle-sixty.json" } = {}) {
  const notes = Array.isArray(oracle) ? oracle : oracle.notes;
  const tree = parsePositionMap(TREE);
  const t0 = Date.parse(recordedAt);
  const conversations = notes.map((n, i) => conversationOf(n, new Date(t0 + i * 60_000).toISOString(), tree));
  return {
    shape: BATCH_SHAPE,
    batch: name,
    generated_from: source,
    generator: "scripts/make-conversation-batch.mjs",
    tree: TREE,
    positions: POSITION,
    people: Object.fromEntries(Object.entries(PEOPLE).filter(([u]) => notes.some((n) => n.writer === u))),
    counts: {
      conversations: conversations.length,
      turns: conversations.reduce((a, c) => a + c.turns.length, 0),
      sections: conversations.reduce((a, c) => a + c.expected.document.sections.length, 0),
      claims: conversations.reduce((a, c) => a + c.expected.placements.length, 0),
    },
    conversations,
  };
}

/**
 * A copy of a batch whose document titles, headings, conversation ids, claim
 * ids and claim subjects carry a prefix, so two scenarios can store the same
 * conversations in one graph without one replacing the other's documents,
 * colliding on the unique CLAIMS.id index, or landing on the other's things.
 * Placements and section homes are unchanged.
 */
export function prefixed(batch, prefix) {
  const head = (h) => (h ? `${prefix} ${h}` : h);
  const subject = (s) => {
    if (typeof s === "string") return parseKey(s) ? s.replace(/:([^:]+)$/, (_, row) => `:${prefix}-${row}`) : `${prefix} ${s}`;
    return s?.name ? { ...s, name: `${prefix} ${s.name}` } : s;
  };
  return {
    ...batch,
    conversations: batch.conversations.map((c) => ({
      ...c,
      id: `${prefix}-${c.id}`,
      expected: {
        ...c.expected,
        document: {
          ...c.expected.document,
          title: `${prefix} ${c.expected.document.title}`,
          sections: c.expected.document.sections.map((s) => ({ ...s, heading: head(s.heading), claims: (s.claims ?? []).map((cl) => ({ ...cl, id: `${prefix}:${cl.id}`, subject: subject(cl.subject) })) })),
        },
        sections: c.expected.sections.map((s) => ({ ...s, heading: head(s.heading) })),
        placements: c.expected.placements.map((p) => ({ ...p, id: `${prefix}:${p.id}` })),
      },
    })),
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

/**
 * A copy of a batch moved to a run's own day: every absolute date in the
 * expected documents, and the batch's recording times, move by the same whole
 * number of days, so the batch's first day is today. The record path stamps the
 * real recording time (B2), and the oracle's dates are fixed in Nov 2026 to Mar
 * 2027: a claim "from the recording until 2026-12-01" ends before it starts
 * once the real date passes that, whatever is true of the code. Relative dates
 * ("recorded_at+14d") need nothing; day counts between dates are unchanged.
 */
export function rebaseBatch(batch, now = Date.now()) {
  const days = Math.floor((now - Date.parse(batch.conversations[0].recorded_at)) / 86_400_000);
  const move = (v) => {
    if (typeof v !== "string" || !ISO_DAY.test(v)) return v;
    const at = new Date(Date.parse(v) + days * 86_400_000).toISOString();
    return v.length === 10 ? at.slice(0, 10) : at;
  };
  const claim = (c) => ({ ...c, ...(Object.fromEntries(["valid_from", "valid_until", "at"].filter((k) => k in c).map((k) => [k, move(c[k])]))) });
  return {
    ...batch,
    conversations: batch.conversations.map((c) => ({
      ...c,
      recorded_at: move(c.recorded_at),
      expected: { ...c.expected, document: { ...c.expected.document, recorded_at: move(c.expected.document.recorded_at), sections: c.expected.document.sections.map((s) => ({ ...s, claims: (s.claims ?? []).map(claim) })) } },
    })),
  };
}

/**
 * The batch as expected under the shipped default authority map (empty): no
 * rule places any claim, so everything stays at the writer's own position,
 * where the (fake) grader leaves it.
 */
export function underDefaultMap(batch) {
  return {
    ...batch,
    conversations: batch.conversations.map((c) => ({
      ...c,
      expected: {
        ...c.expected,
        sections: c.expected.sections.map((s) => ({ ...s, home: c.position })),
        placements: c.expected.placements.map((p) => ({ ...p, home: c.position })),
        document_home: c.position,
      },
    })),
  };
}

/** what is in the graph before a run writes: the bar then knows which things and claims are that run's */
export async function graphSnapshot(query) {
  const claims = (await query("SELECT id FROM CLAIMS").catch(() => [])) ?? [];
  const things = (await query("SELECT @rid AS rid FROM Entity WHERE _kind = 'thing'").catch(() => [])) ?? [];
  return { claims: new Set(claims.map((c) => String(c.id))), things: new Set(things.map((t) => String(t.rid))) };
}

/**
 * Every problem with a batch file, as strings (empty = sound): the shape,
 * alternating turns, and every expected document normalizing with
 * `normalizeDocument` (no class gate: the oracle's classes are discovery
 * output). `classes` (optional) gates the claims when a stream wants that.
 */
export function checkBatch(batch, { classes } = {}) {
  const problems = [];
  const p = (s) => problems.push(s);
  if (!batch || typeof batch !== "object") return ["batch: not an object"];
  if (batch.shape !== BATCH_SHAPE) p(`shape: expected ${BATCH_SHAPE}, got ${batch.shape}`);
  if (!Array.isArray(batch.conversations) || batch.conversations.length === 0) return [...problems, "conversations: needs a non-empty list"];
  let tree;
  try {
    tree = parsePositionMap(batch.tree ?? TREE);
  } catch (e) {
    return [...problems, `tree: ${e.message}`];
  }
  const ids = new Set();
  for (const [i, c] of batch.conversations.entries()) {
    const f = `conversations[${i}]`;
    if (!c.id) p(`${f}: needs an id`);
    if (ids.has(c.id)) p(`${f}: duplicate id ${c.id}`);
    ids.add(c.id);
    if (!c.person) p(`${f}: needs a person`);
    if (!c.position || !tree.positions[c.position]) p(`${f}: position ${c.position} is not in the tree`);
    if (c.on_record !== true) p(`${f}: a batch conversation is on record`);
    if (!Array.isArray(c.turns) || c.turns.length < 3) p(`${f}: needs at least three turns`);
    else {
      if (c.turns[0].role !== "person") p(`${f}.turns[0]: the person opens`);
      c.turns.forEach((t, k) => {
        if (!["person", "agent"].includes(t.role)) p(`${f}.turns[${k}]: role must be person or agent`);
        if (typeof t.text !== "string" || !t.text.trim()) p(`${f}.turns[${k}]: needs text`);
        if (k > 0 && c.turns[k - 1].role === t.role) p(`${f}.turns[${k}]: turns alternate`);
      });
    }
    const x = c.expected;
    if (!x || typeof x !== "object") {
      p(`${f}.expected: missing`);
      continue;
    }
    let doc = null;
    try {
      doc = normalizeDocument(x.document, { classes, now: c.recorded_at });
    } catch (e) {
      p(`${f}.expected.document: ${e.message}`);
    }
    if (doc) {
      if (doc.recorded_by !== c.person) p(`${f}.expected.document.recorded_by: ${doc.recorded_by} is not the conversation's person ${c.person}`);
      if (doc.position !== c.position) p(`${f}.expected.document.position: ${doc.position} is not the conversation's position ${c.position}`);
      const claimIds = doc.sections.flatMap((s) => s.claims.map((cl) => cl.id));
      if (claimIds.some((id) => !id)) p(`${f}.expected.document: every claim needs an id`);
      if (new Set(claimIds).size !== claimIds.length) p(`${f}.expected.document: claim ids repeat`);
      if (!Array.isArray(x.placements)) p(`${f}.expected.placements: needs a list`);
      else {
        const placed = new Set(x.placements.map((pl) => pl.id));
        for (const id of claimIds) if (!placed.has(id)) p(`${f}.expected.placements: no placement for claim ${id}`);
        for (const pl of x.placements) {
          if (!tree.positions[pl.home]) p(`${f}.expected.placements[${pl.id}]: home ${pl.home} is not in the tree`);
          if (!doc.sections[pl.section]) p(`${f}.expected.placements[${pl.id}]: section ${pl.section} does not exist`);
          if (pl.home !== c.position && !ancestors(tree, c.position).includes(pl.home)) p(`${f}.expected.placements[${pl.id}]: home ${pl.home} is below the origin ${c.position}`);
        }
      }
      if (!Array.isArray(x.sections) || x.sections.length !== doc.sections.length) p(`${f}.expected.sections: one per document section`);
      else
        for (const s of x.sections) if (!tree.positions[s.home]) p(`${f}.expected.sections[${s.index}]: home ${s.home} is not in the tree`);
    }
  }
  return problems;
}

// ---- the clean-batch bar ----

/** text as the bar compares it: whitespace folded, case kept */
export const fold = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** the stored preview of a section is 400 characters (documents.js PREVIEW); compare that much */
export const PREVIEW_CHARS = 380;

/**
 * What every claim of a batch must say once it has landed, by claim id: the
 * expected document as the contract normalizes it (relative dates resolved
 * against the recording). A stored claim keeps its own interval: decision 3
 * closes intervals at read time, per reader (state.js), and no write touches
 * an earlier claim. `recordedAt(title)` is when a document was really
 * recorded, the server's stamp: the claims' relative dates resolve against it.
 */
export function expectedClaims(batch, recordedAt = () => null) {
  const all = batch.conversations.flatMap((c) => claimsOf(normalizeDocument({ ...c.expected.document, recorded_at: recordedAt(c.expected.document.title) ?? c.expected.document.recorded_at }, { now: c.recorded_at })));
  return new Map(all.map((cl) => [cl.id, cl]));
}

/** the same instant, however the store writes it; both absent counts as the same */
const sameDate = (a, b) => {
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "";
  if (b === null || b === undefined || b === "") return false;
  const at = (v) => Date.parse(String(v).replace(" ", "T"));
  return at(a) === at(b) && !Number.isNaN(at(a));
};

/** why a landed claim's subject is not the expected one, or null: by the row's key, else by name; a thing holding another row's key is two rows on one thing */
function subjectProblem(want, thing, batchKeys) {
  if (!thing) return "its subject is not in the graph";
  const keys = thing._keys ?? [];
  const seen = thing.label ?? thing.name;
  if (want.key) {
    if (!keys.includes(want.key)) return `about "${seen}" (${keys.join(", ") || "no key"}), expected the row ${want.key}`;
    const others = keys.filter((k) => k !== want.key && batchKeys.has(k));
    return others.length ? `about a thing that also holds ${others.join(", ")}: two rows on one thing` : null;
  }
  // a class subject's own thing is named "class (qualifier)", or the class alone
  const expected = want.scope === "class" ? (want.name ? `${want.class} (${want.name})` : want.class) : want.name;
  if (normalizeName(seen) !== normalizeName(expected)) return `about "${seen}", expected "${expected}"`;
  const others = keys.filter((k) => batchKeys.has(k));
  return others.length ? `about a thing that holds the row ${others.join(", ")}, expected "${expected}" by name` : null;
}

/**
 * A claim with no thing points back at its own section, its subject as written on the edge (admission: content
 * inside a claim is no node; linker.js recordSubject). A subject the oracle gives a row for must not end up here.
 */
function statedSubjectProblem(want, claim) {
  if (want.key) return `left without a thing, expected the row ${want.key}`;
  let stated = null;
  try {
    stated = JSON.parse(claim.subject);
  } catch {
    /* nothing readable on the edge */
  }
  if (!stated) return "left without a thing and no subject written on the claim";
  return sameStated(stated, want) ? null : `written as ${JSON.stringify(stated)}, expected ${JSON.stringify({ name: want.name, class: want.class, scope: want.scope })}`;
}

const sameStated = (stated, want) => normalizeName(stated.name) === normalizeName(want.name) && (stated.scope ?? null) === (want.scope ?? null) && (stated.class ?? null) === (want.class ?? null);

/** a subject written on a claim that has a thing (the writer writes none; a worker's resolve keeps what was written): if it is there it must name that subject */
function statedBeside(want, claim) {
  if (claim.subject === null || claim.subject === undefined || claim.subject === "") return null;
  let stated = null;
  try {
    stated = JSON.parse(claim.subject);
  } catch {
    return `has a thing, and an unreadable subject written beside it: ${JSON.stringify(claim.subject)}`;
  }
  if (want.key) return stated?.key === want.key ? null : `has the row ${want.key}, and ${JSON.stringify(stated)} written beside it`;
  return stated && sameStated(stated, want) ? null : `has its thing, and ${JSON.stringify(stated)} written beside it`;
}

/**
 * Another thing holding the same row, or a keyless thing of the same name and class: a subject in two pieces. Given
 * what was there before a run, two things that both predate it are not that run's doing; a landed thing that is new
 * beside an older one, or two new ones, are.
 */
function secondThing(want, thing, things, before) {
  if (!thing) return null;
  const old = (t) => before?.things.has(String(t.rid));
  const others = [...things.values()].filter((t) => String(t.rid) !== String(thing.rid) && !(old(thing) && old(t)));
  if (want.key) {
    const same = others.filter((t) => (t._keys ?? []).some((k) => String(k).toLowerCase() === want.key.toLowerCase()));
    return same.length ? `a second thing holds ${want.key}: ${same.map((t) => t.rid).join(", ")}` : null;
  }
  if ((thing._keys ?? []).length) return null;
  const same = others.filter((t) => !(t._keys ?? []).length && t._norm && t._norm === thing._norm && (t._class ?? null) === (thing._class ?? null));
  return same.length ? `a second keyless thing of this name and class: ${same.map((t) => t.rid).join(", ")}` : null;
}

/**
 * The bar, as the live batches applied it (docs/GRAPH-WORKER-RELIABILITY.md,
 * test/fixtures/ORACLE.md), now over what the claims say. `rows` is what
 * `collectRows` (or a scenario) read from the graph:
 *   documents: [{ rid, name, _home, _origin, _placed_by, _doc_id, _on_record, _recorded_by, _recorded_at, _record_position }]
 *   sections:  [{ rid, name, _doc_title, _section, _home, _placed_by, text }]
 *   claims:    [{ id, kind, class, attribute, value, valid_from, valid_until, recorded_at, recorded_by, subject, _home, out_rid, in_rid }]   (CLAIMS edges; [] when the type does not exist)
 *   things:    [{ rid, name, label, _keys, _norm, _class, _homes }]   (every thing in the graph)
 *   allClaims: [{ id, out_rid }]                            (every CLAIMS edge, to see one from outside a batch)
 *   rescues:   [{ kind, status, approved_by, payload }]     (approved rehomes and other person-approved moves)
 * Five checks, each a list of findings, and `ok` when all five are empty:
 *   rescues:    a person moved or approved a move of a batch entry (`_placed_by`, an approved rehome naming it)
 *   misplaced:  a document, section or claim seen from somewhere other than expected (a missing claim counts here)
 *   lost:       an expected section whose text is not stored, or a document with no entry
 *   hidden:     a section's text names a batch entry (document, section) homed above that section
 *   content:    a landed claim that does not say what the oracle says (subject, kind, class, attribute, value, dates,
 *               recorder, the section it came from), a claim on a batch section the oracle does not have, or a
 *               document whose on-record marker is wrong
 * Not compared: a thing's `_home`, which every writer sets to the root (scoping reads `_homes`).
 * The recording time is the server's (a condenser's word for it is ignored): a document must carry one no earlier
 * than the batch says, or no earlier than `recordedSince` (ms) when given, which a run that started just now
 * passes so a time merely copied from the document fails; its claims must carry the same time, and their relative
 * dates are read against it.
 */
export function bar(batch, rows, treeDoc = batch.tree ?? TREE, { recordedSince = null, before = null } = {}) {
  const tree = parsePositionMap(treeDoc);
  const isAbove = (home, than) => home !== than && ancestors(tree, than).includes(home);
  const findings = { rescues: [], misplaced: [], lost: [], hidden: [], content: [] };
  const docs = new Map((rows.documents ?? []).map((d) => [d.name, d]));
  const sections = rows.sections ?? [];
  const claims = new Map((rows.claims ?? []).map((c) => [c.id, c]));
  const things = new Map((rows.things ?? []).map((t) => [String(t.rid), t]));
  const sectionByRid = new Map(sections.map((s) => [String(s.rid), s]));
  const landedAt = (title) => {
    const at = docs.get(title)?._recorded_at;
    return at && !Number.isNaN(Date.parse(String(at).replace(" ", "T"))) ? at : null;
  };
  const wanted = expectedClaims(batch, landedAt);
  const batchKeys = new Set([...wanted.values()].map((c) => c.subject.key).filter(Boolean));
  // every batch entry's name and home, for the hidden-title check
  const named = [];
  let expectedCount = 0;
  let foundCount = 0;
  for (const c of batch.conversations) {
    const x = c.expected;
    const doc = docs.get(x.document.title);
    if (!doc) findings.lost.push(`${c.id}: no document entry "${x.document.title}"`);
    else {
      named.push({ name: doc.name, home: doc._home, kind: "document" });
      if (doc._placed_by) findings.rescues.push(`${c.id}: a person placed the document (${doc._placed_by})`);
      if (doc._home !== x.document_home) findings.misplaced.push(`${c.id}: the document seen from ${doc._home}, expected ${x.document_home}`);
      if (doc._on_record !== true) findings.content.push(`${c.id}: the document is not marked on record`);
      if (doc._doc_status !== "ready") findings.content.push(`${c.id}: the document's status is ${JSON.stringify(doc._doc_status ?? null)}, expected "ready"`);
      if (doc._origin !== c.position) findings.content.push(`${c.id}: the document's origin is ${JSON.stringify(doc._origin ?? null)}, expected ${JSON.stringify(c.position)}`);
      if (doc._recorded_by !== x.document.recorded_by) findings.content.push(`${c.id}: the document recorded by ${JSON.stringify(doc._recorded_by)}, expected ${JSON.stringify(x.document.recorded_by)}`);
      if (doc._record_position !== x.document.position) findings.content.push(`${c.id}: the document recorded under ${JSON.stringify(doc._record_position)}, expected ${JSON.stringify(x.document.position)}`);
      const earliest = recordedSince ?? Date.parse(x.document.recorded_at);
      const at = Date.parse(String(doc._recorded_at ?? "").replace(" ", "T"));
      if (Number.isNaN(at) || at < earliest) findings.content.push(`${c.id}: the document recorded at ${JSON.stringify(doc._recorded_at ?? null)}, expected ${new Date(earliest).toISOString()} or later`);
    }
    const own = sections.filter((s) => s._doc_title === x.document.title || (doc && s._doc_id && s._doc_id === doc._doc_id));
    for (const s of own) if (!x.sections.some((es) => es.index === Number(s._section))) findings.content.push(`${c.id}: an unexpected section "${s.name}"`);
    for (const es of x.sections) {
      const s = own.find((r) => Number(r._section) === es.index);
      const want = fold(x.document.sections[es.index].text);
      if (!s) {
        findings.lost.push(`${c.id} §${es.index + 1}: no section stored`);
        continue;
      }
      named.push({ name: s.name, home: s._home, kind: "section", heading: es.heading });
      if (s._placed_by) findings.rescues.push(`${c.id} §${es.index + 1}: a person placed the section (${s._placed_by})`);
      if (s._home !== es.home) findings.misplaced.push(`${c.id} §${es.index + 1}: seen from ${s._home}, expected ${es.home}`);
      if (s._origin !== c.position) findings.content.push(`${c.id} §${es.index + 1}: origin ${JSON.stringify(s._origin ?? null)}, expected ${JSON.stringify(c.position)}`);
      if (doc && s._doc_id !== doc._doc_id) findings.content.push(`${c.id} §${es.index + 1}: _doc_id ${JSON.stringify(s._doc_id ?? null)} is not its document's`);
      // a recorded section may be stored with its heading first ("## heading", then the body; the stored preview folds
      // the newline between them to a space), a manual's chunk is not: compare the body
      let have = fold(s.text);
      const hd = fold(x.document.sections[es.index].heading ?? "");
      if (hd && have.startsWith(`## ${hd}`)) have = have.slice(3 + hd.length).trim();
      else have = have.replace(/^##\s+\S[^\n]*?\s+(?=\S)/, (m) => (want.startsWith(fold(m)) ? m : ""));
      // the whole text when it fits in the stored preview, else as much of it as the preview holds
      if (want.length <= PREVIEW_CHARS ? have !== want : !have.startsWith(want.slice(0, PREVIEW_CHARS))) findings.lost.push(`${c.id} §${es.index + 1}: stored text differs ("${have.slice(0, 60)}…")`);
    }
    for (const pl of x.placements) {
      expectedCount++;
      const cl = claims.get(pl.id);
      if (!cl) {
        findings.misplaced.push(`${c.id} claim ${pl.id}: not in the graph`);
        continue;
      }
      foundCount++;
      const sec = sectionByRid.get(String(cl.out_rid));
      const home = cl._home ?? null;
      if (home !== pl.home) findings.misplaced.push(`${c.id} claim ${pl.id}: seen from ${home}, expected ${pl.home}`);
      if (!sec) findings.content.push(`${c.id} claim ${pl.id}: not from a section of this batch`);
      else if (sec._doc_title !== x.document.title) findings.content.push(`${c.id} claim ${pl.id}: from a section of "${sec._doc_title}", expected "${x.document.title}"`);
      else if (Number(sec._section) !== pl.section) findings.misplaced.push(`${c.id} claim ${pl.id}: from §${Number(sec._section) + 1}, expected §${pl.section + 1}`);
      const want = wanted.get(pl.id);
      if (!want) {
        findings.content.push(`${c.id} claim ${pl.id}: placed, but the expected document has no such claim`);
        continue;
      }
      const wrong = (field, have, exp) => findings.content.push(`${c.id} claim ${pl.id}: ${field} ${JSON.stringify(have ?? null)}, expected ${JSON.stringify(exp ?? null)}`);
      const subject = String(cl.in_rid) === String(cl.out_rid) ? statedSubjectProblem(want.subject, cl) : subjectProblem(want.subject, things.get(String(cl.in_rid)), batchKeys);
      if (subject) findings.content.push(`${c.id} claim ${pl.id}: subject: ${subject}`);
      if (String(cl.in_rid) !== String(cl.out_rid)) {
        const thing = things.get(String(cl.in_rid));
        for (const problem of [statedBeside(want.subject, cl), secondThing(want.subject, thing, things, before)]) if (problem) findings.content.push(`${c.id} claim ${pl.id}: subject: ${problem}`);
        if (thing && !(thing._homes ?? []).includes(pl.home)) findings.content.push(`${c.id} claim ${pl.id}: subject: its thing is not seen from ${pl.home} (${JSON.stringify(thing._homes ?? [])})`);
      }
      if (cl.closed_by !== null && cl.closed_by !== undefined && cl.closed_by !== "") findings.content.push(`${c.id} claim ${pl.id}: closed_by ${JSON.stringify(cl.closed_by)}: a write closed it; closing is a read`);
      for (const field of ["kind", "class", "attribute", "value", "recorded_by"]) if (cl[field] !== want[field]) wrong(field, cl[field], want[field]);
      for (const field of ["valid_from", "valid_until", "recorded_at"]) if (!sameDate(cl[field], want[field])) wrong(field, cl[field], want[field]);
    }
  }
  // a claim nobody expected, on a section of the batch
  const expectedIds = new Set(batch.conversations.flatMap((c) => c.expected.placements.map((p) => p.id)));
  for (const cl of rows.claims ?? []) {
    if (expectedIds.has(cl.id)) continue;
    const sec = sectionByRid.get(String(cl.out_rid));
    if (sec) findings.content.push(`"${sec.name}": an unexpected claim ${cl.id} (${cl.class}/${cl.attribute})`);
  }
  if (before) {
    // a run's claims and things: nothing else is new, and a thing this run minted is seen from nowhere its claims aren't
    for (const c of rows.allClaims ?? []) if (!before.claims.has(String(c.id)) && !expectedIds.has(String(c.id))) findings.content.push(`a claim from outside the batch: ${c.id} (from ${c.out_rid})`);
    const homesOf = new Map();
    for (const cl of rows.claims ?? []) if (expectedIds.has(String(cl.id)) && String(cl.in_rid) !== String(cl.out_rid)) homesOf.set(String(cl.in_rid), [...(homesOf.get(String(cl.in_rid)) ?? []), cl._home]);
    for (const [rid, homes] of homesOf) {
      if (before.things.has(rid)) continue;
      const thing = things.get(rid);
      const extra = (thing?._homes ?? []).filter((h) => !homes.includes(h));
      if (extra.length) findings.content.push(`thing ${rid} (${thing.label}): seen from ${extra.join(", ")}, where none of its claims is`);
    }
  }
  // operator rescues recorded as approved moves naming a batch entry
  const names = named.map((n) => n.name);
  for (const r of rows.rescues ?? []) {
    const payload = String(r.payload ?? "");
    const hit = names.find((n) => payload.includes(n)) ?? [...docs.values(), ...sections].find((e) => e.rid && payload.includes(String(e.rid)))?.name;
    if (hit) findings.rescues.push(`"${hit}": a ${r.kind} approved by ${r.approved_by ?? "a person"}`);
  }
  // a hidden title: a section's text names a batch entry (title or heading) homed above the section
  const titles = named.filter((n) => n.home).flatMap((n) => [n.name, n.heading].filter((t) => t && t.length >= 8).map((t) => ({ title: t, home: n.home, of: n.name })));
  for (const s of sections) {
    if (!names.includes(s.name) || !s._home) continue;
    const text = fold(s.text);
    for (const t of titles) {
      if (t.of === s.name || !isAbove(t.home, s._home)) continue;
      if (text.includes(t.title)) findings.hidden.push(`"${s.name}" (seen from ${s._home}) names "${t.title}" (seen from ${t.home})`);
    }
  }
  const counts = { documents: batch.conversations.filter((c) => docs.has(c.expected.document.title)).length, documents_expected: batch.conversations.length, claims: foundCount, claims_expected: expectedCount };
  return { ok: Object.values(findings).every((l) => l.length === 0) && foundCount === expectedCount, counts, findings };
}

/** the findings per note, for a report: note id -> [check: finding] (only notes with findings); a finding names its conversation or its document's title */
export function failingNotes(batch, result) {
  const out = new Map();
  for (const c of batch.conversations) {
    const mine = Object.entries(result.findings).flatMap(([check, list]) => list.filter((f) => f.includes(`${c.id}:`) || f.includes(`${c.id} `) || f.includes(`"${c.expected.document.title}`)).map((f) => `${check}: ${f}`));
    if (mine.length) out.set(c.note, mine);
  }
  return out;
}

/** the one line: CLEAN or NOT CLEAN, with the counts */
export function verdictLine(batch, result) {
  const { counts: c, findings: f } = result;
  return `${result.ok ? "CLEAN" : "NOT CLEAN"} ${batch.batch}: ${c.documents}/${c.documents_expected} documents, ${c.claims}/${c.claims_expected} claims; rescues ${f.rescues.length}, misplaced ${f.misplaced.length}, lost ${f.lost.length}, hidden titles ${f.hidden.length}, wrong content ${f.content.length}`;
}

const inList = (xs) => `[${xs.map((x) => `'${String(x).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ")}]`;

const CLAIM_FIELDS = "id, kind, class, attribute, value, valid_from, valid_until, recorded_at, recorded_by, closed_by, subject, _home, @out AS out_rid, @in AS in_rid";

/**
 * The rows the bar reads, through a `query(sql) -> rows` that runs SQL as
 * someone with the raw capability (query_graph as the admin). Claims are read
 * two ways, by the batch's ids and off the batch's sections, so a claim the
 * oracle does not have shows too. A missing CLAIMS type (the model's DDL not
 * run) reads as no claims, which the bar then reports as every claim missing.
 */
export async function collectRows(batch, query) {
  const titles = batch.conversations.map((c) => c.expected.document.title);
  const claimIds = batch.conversations.flatMap((c) => c.expected.placements.map((p) => p.id));
  const documents = (await query(`SELECT @rid AS rid, name, _home, _origin, _placed_by, _doc_id, _doc_status, _on_record, _recorded_by, _recorded_at, _record_position FROM Entity WHERE _kind = 'document' AND name IN ${inList(titles)}`)) ?? [];
  const sections = (await query(`SELECT @rid AS rid, name, _doc_title, _doc_id, _section, _home, _origin, _placed_by, text_identity AS text FROM Entity WHERE _kind = 'section' AND _doc_title IN ${inList(titles)}`)) ?? [];
  const byId = new Map();
  const add = (list) => (list ?? []).forEach((c) => byId.set(String(c.id), c));
  if (claimIds.length) {
    try {
      add(await query(`SELECT ${CLAIM_FIELDS} FROM CLAIMS WHERE id IN ${inList(claimIds)}`));
    } catch {
      // no CLAIMS type: every claim missing
    }
  }
  const rids = sections.map((s) => String(s.rid)).filter((r) => /^#\d+:\d+$/.test(r));
  if (rids.length) {
    try {
      add(await query(`SELECT ${CLAIM_FIELDS} FROM (SELECT expand(outE('CLAIMS')) FROM [${rids.join(", ")}])`));
    } catch {
      // as above
    }
  }
  const claims = [...byId.values()];
  // every thing, not only the claims' subjects: a second thing holding a row shows up here
  const things = (await query("SELECT @rid AS rid, name, label, _keys, _norm, _class, _homes FROM Entity WHERE _kind = 'thing'").catch(() => [])) ?? [];
  const allClaims = (await query("SELECT id, @out AS out_rid FROM CLAIMS").catch(() => [])) ?? [];
  const rescues = (await query("SELECT kind, status, approved_by, payload FROM PendingWrite WHERE kind = 'rehome' AND status = 'approved'").catch(() => [])) ?? [];
  return { documents, sections, claims, things, allClaims, rescues };
}
