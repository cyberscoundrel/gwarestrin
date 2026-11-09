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
import { normalizeAttribute, normalizeDocument, normalizeName } from "../src/model/claims.js";
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
 * A copy of a batch whose document titles, headings, conversation ids and
 * claim ids carry a prefix, so two scenarios can store the same conversations
 * in one graph without one replacing the other's documents or colliding on
 * the unique CLAIMS.id index. Placements and section homes are unchanged.
 */
export function prefixed(batch, prefix) {
  const head = (h) => (h ? `${prefix} ${h}` : h);
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
          sections: c.expected.document.sections.map((s) => ({ ...s, heading: head(s.heading), claims: (s.claims ?? []).map((cl) => ({ ...cl, id: `${prefix}:${cl.id}` })) })),
        },
        sections: c.expected.sections.map((s) => ({ ...s, heading: head(s.heading) })),
        placements: c.expected.placements.map((p) => ({ ...p, id: `${prefix}:${p.id}` })),
      },
    })),
  };
}

/**
 * The authority map a batch's placements imply, in the policy's shape
 * ({ classes: { name: { authority } | { attributes: { attr: position } } },
 * attributes: {} }): each claim's class and attribute take the position of
 * its authority; a class whose claims all agree gets one `authority`; where
 * two notes disagree on one attribute the more restrictive position (the
 * ancestor) wins. Built from the conversations given, so a scenario's subset
 * yields the rules its own claims need.
 */
export function authorityMapOf(batch, treeDoc = batch.tree ?? TREE) {
  const tree = parsePositionMap(treeDoc);
  const position = batch.positions ?? POSITION;
  const above = (a, b) => a !== b && ancestors(tree, b).includes(a);
  const perClass = new Map();
  for (const c of batch.conversations) {
    for (const pl of c.expected.placements) {
      const claim = c.expected.document.sections.flatMap((s) => s.claims ?? []).find((cl) => cl.id === pl.id);
      if (!claim) continue;
      const pos = position[pl.authority] ?? pl.home;
      const attr = normalizeAttribute(claim.attribute);
      if (!perClass.has(claim.class)) perClass.set(claim.class, new Map());
      const cur = perClass.get(claim.class).get(attr);
      if (!cur || above(pos, cur)) perClass.get(claim.class).set(attr, pos);
    }
  }
  const classes = {};
  for (const [cls, attrs] of perClass) {
    const values = new Set(attrs.values());
    classes[cls] = values.size === 1 ? { authority: [...values][0] } : { attributes: Object.fromEntries(attrs) };
  }
  return { classes, attributes: {} };
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
 * The bar, as the live batches applied it (docs/GRAPH-WORKER-RELIABILITY.md,
 * test/fixtures/ORACLE.md), now over claims. `rows` is what `collectRows`
 * (or a scenario) read from the graph:
 *   documents: [{ rid, name, _home, _origin, _placed_by }]
 *   sections:  [{ rid, name, _doc_title, _section, _home, _placed_by, text }]
 *   claims:    [{ id, _home, out_rid, in_rid }]         (CLAIMS edges; [] when the type does not exist)
 *   rescues:   [{ kind, status, approved_by, payload }] (approved rehomes and other person-approved moves)
 * Four checks, each a list of findings, and `ok` when all four are empty:
 *   rescues:    a person moved or approved a move of a batch entry (`_placed_by`, an approved rehome naming it)
 *   misplaced:  a claim or section seen from somewhere other than expected (a missing claim counts here)
 *   lost:       an expected section whose text is not stored, or a document with no entry
 *   hidden:     a section's text names a batch entry (document, section) homed above that section
 */
export function bar(batch, rows, treeDoc = batch.tree ?? TREE) {
  const tree = parsePositionMap(treeDoc);
  const isAbove = (home, than) => home !== than && ancestors(tree, than).includes(home);
  const findings = { rescues: [], misplaced: [], lost: [], hidden: [] };
  const docs = new Map((rows.documents ?? []).map((d) => [d.name, d]));
  const sections = rows.sections ?? [];
  const claims = new Map((rows.claims ?? []).map((c) => [c.id, c]));
  const sectionByRid = new Map(sections.map((s) => [String(s.rid), s]));
  // every batch entry's name and home, for the hidden-title check
  const named = [];
  let expectedClaims = 0;
  let foundClaims = 0;
  for (const c of batch.conversations) {
    const x = c.expected;
    const doc = docs.get(x.document.title);
    if (!doc) findings.lost.push(`${c.id}: no document entry "${x.document.title}"`);
    else {
      named.push({ name: doc.name, home: doc._home, kind: "document" });
      if (doc._placed_by) findings.rescues.push(`${c.id}: a person placed the document (${doc._placed_by})`);
    }
    const own = sections.filter((s) => s._doc_title === x.document.title || (doc && s._doc_id && s._doc_id === doc._doc_id));
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
      // a recorded section may be stored with its heading first ("## heading", then the body; the stored preview folds
      // the newline between them to a space), a manual's chunk is not: compare the body
      let have = fold(s.text);
      const hd = fold(x.document.sections[es.index].heading ?? "");
      if (hd && have.startsWith(`## ${hd}`)) have = have.slice(3 + hd.length).trim();
      else have = have.replace(/^##\s+\S[^\n]*?\s+(?=\S)/, (m) => (want.startsWith(fold(m)) ? m : ""));
      if (!have.startsWith(want.slice(0, Math.min(PREVIEW_CHARS, want.length)))) findings.lost.push(`${c.id} §${es.index + 1}: stored text differs ("${have.slice(0, 60)}…")`);
    }
    for (const pl of x.placements) {
      expectedClaims++;
      const cl = claims.get(pl.id);
      if (!cl) {
        findings.misplaced.push(`${c.id} claim ${pl.id}: not in the graph`);
        continue;
      }
      foundClaims++;
      const home = cl._home ?? sectionByRid.get(String(cl.out_rid))?._home ?? null;
      if (home !== pl.home) findings.misplaced.push(`${c.id} claim ${pl.id}: seen from ${home}, expected ${pl.home}`);
      const sec = sectionByRid.get(String(cl.out_rid));
      if (sec && Number(sec._section) !== pl.section) findings.misplaced.push(`${c.id} claim ${pl.id}: from §${Number(sec._section) + 1}, expected §${pl.section + 1}`);
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
  const counts = { documents: docs.size, documents_expected: batch.conversations.length, claims: foundClaims, claims_expected: expectedClaims };
  return { ok: Object.values(findings).every((l) => l.length === 0), counts, findings };
}

/** the one line: CLEAN or NOT CLEAN, with the counts */
export function verdictLine(batch, result) {
  const { counts: c, findings: f } = result;
  return `${result.ok ? "CLEAN" : "NOT CLEAN"} ${batch.batch}: ${c.documents}/${c.documents_expected} documents, ${c.claims}/${c.claims_expected} claims; rescues ${f.rescues.length}, misplaced ${f.misplaced.length}, lost ${f.lost.length}, hidden titles ${f.hidden.length}`;
}

const inList = (xs) => `[${xs.map((x) => `'${String(x).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ")}]`;

/**
 * The rows the bar reads, through a `query(sql) -> rows` that runs SQL as
 * someone with the raw capability (query_graph as the admin). A missing
 * CLAIMS type (the model's DDL not run) reads as no claims, which the bar
 * then reports as every claim missing.
 */
export async function collectRows(batch, query) {
  const titles = batch.conversations.map((c) => c.expected.document.title);
  const claimIds = batch.conversations.flatMap((c) => c.expected.placements.map((p) => p.id));
  const documents = await query(`SELECT @rid AS rid, name, _home, _origin, _placed_by, _doc_id FROM Entity WHERE _kind = 'document' AND name IN ${inList(titles)}`);
  const sections = await query(`SELECT @rid AS rid, name, _doc_title, _doc_id, _section, _home, _placed_by, text_identity AS text FROM Entity WHERE _kind = 'section' AND _doc_title IN ${inList(titles)}`);
  let claims = [];
  if (claimIds.length) {
    try {
      claims = (await query(`SELECT id, _home, @out AS out_rid, @in AS in_rid FROM CLAIMS WHERE id IN ${inList(claimIds)}`)) ?? [];
    } catch {
      claims = [];
    }
  }
  const rescues = (await query("SELECT kind, status, approved_by, payload FROM PendingWrite WHERE kind = 'rehome' AND status = 'approved'").catch(() => [])) ?? [];
  return { documents: documents ?? [], sections: sections ?? [], claims, rescues };
}
