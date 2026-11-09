// Conversation batches (e2e/conversations.mjs): the generator over the
// oracle, the fixture file it produced, the shape check, the clean-batch bar
// as a pure function, and the two scripts' refusal to run without an
// explicit instance URL.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { claimHome } from "../src/model/authority.js";
import { claimsOf, normalizeDocument } from "../src/model/claims.js";
import { parsePositionMap } from "../src/positions.js";
import { sectionName } from "../src/documents.js";
import { authorityMapOf, bar, checkBatch, collectRows, conversationOf, generateBatch, POSITION, prefixed, TREE, verdictLine } from "../e2e/conversations.mjs";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const oracle = read("oracle-sixty.json");
const fixture = read("conversations/oracle-sixty.batch.json");
const batch = generateBatch(oracle);
const tree = parsePositionMap(TREE);

test("the generator: one on-record conversation per oracle note, a few alternating turns each, every claim carried", () => {
  assert.equal(batch.conversations.length, oracle.length);
  assert.equal(batch.counts.conversations, 62);
  assert.equal(batch.counts.claims, 100, "the oracle's 100 claims");
  assert.ok(batch.counts.turns >= 5 * 62, `${batch.counts.turns} turns`);
  for (const [i, c] of batch.conversations.entries()) {
    const note = oracle[i];
    assert.equal(c.note, note.id);
    assert.equal(c.person, note.writer);
    assert.equal(c.position, POSITION[note.origin_position], `${note.id}: recorded under the writer's position`);
    assert.equal(c.on_record, true);
    assert.ok(c.turns.length >= 5 && c.turns.length <= 7, `${note.id}: ${c.turns.length} turns`);
    assert.equal(c.turns[0].role, "person");
    c.turns.forEach((t, k) => k > 0 && assert.notEqual(t.role, c.turns[k - 1].role, `${note.id}: turns alternate`));
    assert.ok(c.turns.some((t) => t.role === "person" && t.text === note.text), `${note.id}: the note's words come up in the person's turns`);
    assert.ok(c.turns.at(-1).role === "agent" && /^On record under /.test(c.turns.at(-1).text), `${note.id}: the agent closes with what went on record`);
    assert.equal(c.expected.placements.length, note.claims.length, `${note.id}: one placement per claim`);
  }
});

test("every expected document is what the condenser must emit: it normalizes, its claims are the oracle's, ids unique", () => {
  const seen = new Set();
  for (const [i, c] of batch.conversations.entries()) {
    const doc = normalizeDocument(c.expected.document, { now: c.recorded_at });
    assert.equal(doc.on_record, true);
    assert.equal(doc.recorded_by, c.person);
    assert.equal(doc.position, c.position);
    const claims = claimsOf(doc);
    assert.equal(claims.length, oracle[i].claims.length);
    for (const cl of claims) {
      assert.ok(!seen.has(cl.id), `claim id ${cl.id} repeats`);
      seen.add(cl.id);
      const [noteId, j] = cl.id.split("#");
      const o = oracle.find((n) => n.id === noteId).claims[Number(j)];
      assert.equal(cl.kind, o.kind);
      assert.equal(cl.class, o.class);
      assert.equal(cl.value, String(o.value));
    }
  }
  assert.equal(seen.size, 100);
});

test("placement: a claim's home is the authority rule's answer from the writer's origin; sections group one authority each, lowest first; the note's words sit in the most restricted", () => {
  for (const c of batch.conversations) {
    const note = oracle.find((n) => n.id === c.note);
    for (const pl of c.expected.placements) {
      const o = note.claims[Number(pl.id.split("#")[1])];
      assert.equal(pl.authority, o.authority);
      assert.equal(pl.home, claimHome(tree, c.position, POSITION[o.authority]), `${pl.id}: home`);
    }
    const ranks = c.expected.sections.map((s) => ["floor", "Ops", "admins-only"].indexOf(s.authority));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${c.note}: sections from lowest authority up`);
    assert.equal(new Set(ranks).size, ranks.length, `${c.note}: one section per authority`);
    const last = c.expected.document.sections.at(-1);
    assert.ok(last.text.includes(note.text), `${c.note}: the note's words are in the most restricted section`);
    for (const s of c.expected.document.sections.slice(0, -1)) assert.ok(!s.text.includes(note.text), `${c.note}: a lower section never carries the note's words`);
  }
  // al04: the order at Ops, the price for the owners (ORACLE.md, "One note, several authorities")
  const al04 = batch.conversations.find((c) => c.note === "ux-al04");
  assert.deepEqual(
    al04.expected.sections.map((s) => [s.authority, s.home]),
    [
      ["Ops", "ops"],
      ["admins-only", "org"],
    ],
  );
  assert.ok(!al04.expected.document.sections[0].text.includes("41"), "the price is not in the Operations section");
  // m01: floor-authority claims written from Ops stay at Ops (provenance sets the floor)
  const m01 = batch.conversations.find((c) => c.note === "ux-m01");
  assert.ok(m01.expected.placements.every((p) => p.home === "ops"));
  // the residue: a section with no claims, at the origin
  const aa11 = batch.conversations.find((c) => c.note === "ux-aa11");
  assert.deepEqual(aa11.expected.placements, []);
  assert.deepEqual(aa11.expected.sections, [{ index: 0, heading: oracle.find((n) => n.id === "ux-aa11").title, authority: "Ops", home: "ops" }]);
  assert.match(aa11.turns[3].text, /cannot tell what that refers to/);
});

test("the fixture file is what the generator produces today (regenerate with scripts/make-conversation-batch.mjs generate)", () => {
  assert.deepEqual(fixture, batch);
});

test("checkBatch: the fixture is sound; a broken one names the problem", () => {
  assert.deepEqual(checkBatch(fixture), []);
  const bad = structuredClone(fixture);
  bad.conversations[0].turns[1].role = "person";
  bad.conversations[1].expected.document.sections[0].claims[0].kind = "wish";
  bad.conversations[2].expected.placements[0].home = "nowhere";
  bad.conversations[3].on_record = false;
  const problems = checkBatch(bad);
  assert.ok(problems.some((p) => /conversations\[0\]\.turns\[1\]: turns alternate/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /conversations\[1\]\.expected\.document: sections\[0\]\.claims\[0\]\.kind/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /conversations\[2\]\.expected\.placements\[ux-t01#0\]: home nowhere/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /conversations\[3\]: a batch conversation is on record/.test(p)), problems.join("\n"));
  assert.deepEqual(checkBatch({ shape: 1 }), ["conversations: needs a non-empty list"]);
  assert.deepEqual(checkBatch(null), ["batch: not an object"]);
});

test("conversationOf is deterministic for a note and a time", () => {
  const a = conversationOf(oracle[0], "2026-11-06T09:00:00.000Z");
  const b = conversationOf(oracle[0], "2026-11-06T09:00:00.000Z");
  assert.deepEqual(a, b);
  assert.notEqual(conversationOf(oracle[0], "2026-11-07T09:00:00.000Z").recorded_at, a.recorded_at);
});

/** rows as an instance that stored the batch exactly as expected would answer */
function cleanRows(b) {
  const documents = [];
  const sections = [];
  const claims = [];
  let rid = 1;
  for (const c of b.conversations) {
    const d = c.expected.document;
    documents.push({ rid: `#1:${rid++}`, name: d.title, _home: c.position, _origin: c.position, _placed_by: null, _doc_id: c.id });
    d.sections.forEach((s, i) => {
      const srid = `#2:${rid++}`;
      sections.push({ rid: srid, name: sectionName(d.title, i, s.heading), _doc_title: d.title, _doc_id: c.id, _section: i, _home: c.expected.sections[i].home, _placed_by: null, text: s.text });
      for (const cl of s.claims) claims.push({ id: cl.id, _home: c.expected.placements.find((p) => p.id === cl.id).home, out_rid: srid, in_rid: "#3:1" });
    });
  }
  return { documents, sections, claims, rescues: [] };
}

test("the bar: a batch stored as expected is clean; each of the four failures is found and counted", () => {
  const small = { ...fixture, conversations: fixture.conversations.filter((c) => ["ux-m01", "ux-al04", "ux-aa11", "ux-ak06"].includes(c.note)) };
  const rows = cleanRows(small);
  const clean = bar(small, rows);
  assert.equal(clean.ok, true, JSON.stringify(clean.findings));
  assert.equal(verdictLine(small, clean), "CLEAN oracle-sixty: 4/4 documents, 6/6 claims; rescues 0, misplaced 0, lost 0, hidden titles 0");
  // a rescue: a person placed a section, and an approved rehome names a document
  const r1 = structuredClone(rows);
  r1.sections[0]._placed_by = "admin";
  r1.rescues.push({ kind: "rehome", status: "approved", approved_by: "admin", payload: JSON.stringify({ name: r1.documents[1].name, to: "floor" }) });
  const f1 = bar(small, r1).findings;
  assert.equal(f1.rescues.length, 2, JSON.stringify(f1.rescues));
  // a misplacement: a claim seen from the wrong position, and a claim missing from the graph
  const r2 = structuredClone(rows);
  r2.claims[0]._home = "org";
  r2.claims.pop();
  const f2 = bar(small, r2).findings;
  assert.equal(f2.misplaced.length, 2, JSON.stringify(f2.misplaced));
  assert.match(f2.misplaced[0], /seen from org, expected ops/);
  assert.match(f2.misplaced[1], /not in the graph/);
  // a claim with no home of its own takes its section's
  const r2b = structuredClone(rows);
  r2b.claims[0]._home = null;
  assert.equal(bar(small, r2b).ok, true);
  // lost text: a section missing, a section's text replaced (the field dump of 2026-10-30), a document gone
  const r3 = structuredClone(rows);
  r3.sections.splice(1, 1);
  r3.sections[0].text = "name: x\n_home: ops\n(a field dump)";
  r3.documents.pop();
  const f3 = bar(small, r3).findings;
  assert.equal(f3.lost.length, 3, JSON.stringify(f3.lost));
  // a hidden title: the Operations section of al04 names the owners' section's heading
  const r4 = structuredClone(rows);
  const al04 = small.conversations.find((c) => c.note === "ux-al04");
  const lower = r4.sections.find((s) => s._doc_title === al04.expected.document.title && s._section === 0);
  lower.text += ` (see ${al04.expected.document.sections[1].heading})`;
  const f4 = bar(small, r4).findings;
  assert.equal(f4.hidden.length, 1, JSON.stringify(f4.hidden));
  assert.match(f4.hidden[0], /seen from ops\) names ".*the owners part" \(seen from org\)/);
  // naming something at or below its own home is not hidden
  const r5 = structuredClone(rows);
  const upper = r5.sections.find((s) => s._doc_title === al04.expected.document.title && s._section === 1);
  upper.text += ` (see ${al04.expected.document.sections[0].heading})`;
  assert.equal(bar(small, r5).findings.hidden.length, 0);
  // no CLAIMS type in the graph at all: every claim missing
  const r6 = { ...rows, claims: [] };
  const v6 = bar(small, r6);
  assert.equal(v6.ok, false);
  assert.equal(v6.counts.claims, 0);
  assert.match(verdictLine(small, v6), /^NOT CLEAN oracle-sixty: 4\/4 documents, 0\/6 claims; rescues 0, misplaced 6, lost 0, hidden titles 0$/);
});

test("collectRows asks for the batch's titles and claim ids and survives a missing CLAIMS type", async () => {
  const small = { ...fixture, conversations: fixture.conversations.slice(0, 2) };
  const asked = [];
  const rows = await collectRows(small, async (sql) => {
    asked.push(sql);
    if (/FROM CLAIMS/.test(sql)) throw new Error("Type 'CLAIMS' was not found");
    return [];
  });
  assert.deepEqual(rows, { documents: [], sections: [], claims: [], rescues: [] });
  assert.ok(asked[0].includes(`'${small.conversations[0].expected.document.title}'`));
  assert.ok(asked.some((s) => /FROM CLAIMS WHERE id IN \['ux-m01#0'/.test(s)));
  assert.ok(asked.some((s) => /FROM PendingWrite WHERE kind = 'rehome' AND status = 'approved'/.test(s)));
});

const script = (name) => fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));
const batchFile = fileURLToPath(new URL("./fixtures/conversations/oracle-sixty.batch.json", import.meta.url));

test("the seeder refuses to run without an explicit --url, and never defaults to an instance", () => {
  const noUrl = spawnSync(process.execPath, [script("make-conversation-batch.mjs"), "seed", batchFile, "--tokens", "/dev/null"], { encoding: "utf8" });
  assert.equal(noUrl.status, 2);
  assert.match(noUrl.stderr, /--url http:\/\/host:port is required; there is no default instance/);
  const badUrl = spawnSync(process.execPath, [script("make-conversation-batch.mjs"), "seed", batchFile, "--url", "graph-rag:8000", "--tokens", "/dev/null"], { encoding: "utf8" });
  assert.equal(badUrl.status, 2, "a bare host is not an explicit URL");
  const dry = spawnSync(process.execPath, [script("make-conversation-batch.mjs"), "seed", batchFile, "--url", "http://127.0.0.1:9", "--tokens", fileURLToPath(new URL("./fixtures/positions.json", import.meta.url)), "--only", "conv-ux-m01", "--dry-run"], { encoding: "utf8" });
  assert.equal(dry.status, 2, "no token for alice in a file that is not a token map");
  assert.match(dry.stderr, /no token for alice/);
});

test("the bar script refuses to run without an explicit --url and a token", () => {
  const noUrl = spawnSync(process.execPath, [script("batch-bar.mjs"), batchFile], { encoding: "utf8" });
  assert.equal(noUrl.status, 2);
  assert.match(noUrl.stderr, /--url http:\/\/host:port is required; there is no default instance/);
  const noToken = spawnSync(process.execPath, [script("batch-bar.mjs"), batchFile, "--url", "http://127.0.0.1:9"], { encoding: "utf8" });
  assert.equal(noToken.status, 2);
  assert.match(noToken.stderr, /--token or --tokens is required/);
});

test("generate --check agrees with the fixture on disk", () => {
  const r = spawnSync(process.execPath, [script("make-conversation-batch.mjs"), "generate", "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /up to date/);
  assert.match(r.stdout, /62 conversations, 372 turns, 68 sections, 100 claims/);
});

test("prefixed: titles, headings, conversation ids and claim ids carry the prefix; placements still match the claims; the result is still sound", () => {
  const small = { ...fixture, conversations: fixture.conversations.filter((c) => ["ux-m01", "ux-al04", "ux-aa11"].includes(c.note)) };
  const p = prefixed(small, "e2e-bar-1234");
  assert.deepEqual(checkBatch(p), []);
  const al04 = p.conversations.find((c) => c.note === "ux-al04");
  assert.equal(al04.id, "e2e-bar-1234-conv-ux-al04");
  assert.equal(al04.expected.document.title, "e2e-bar-1234 ux-al04 brightline po received");
  assert.ok(al04.expected.document.sections.every((s) => s.heading.startsWith("e2e-bar-1234 ")));
  assert.deepEqual(al04.expected.document.sections.flatMap((s) => s.claims.map((cl) => cl.id)), ["e2e-bar-1234:ux-al04#0", "e2e-bar-1234:ux-al04#1"]);
  assert.deepEqual(al04.expected.placements.map((pl) => [pl.id, pl.home]), [
    ["e2e-bar-1234:ux-al04#0", "ops"],
    ["e2e-bar-1234:ux-al04#1", "org"],
  ]);
  assert.deepEqual(small.conversations.find((c) => c.note === "ux-al04").expected.placements[0].id, "ux-al04#0", "the original is untouched");
  // the bar on prefixed rows is the same bar
  assert.equal(bar(p, cleanRows(p)).ok, true);
});

test("authorityMapOf: each claim's class and attribute take its authority's position; a class whose claims agree gets one authority; disagreement goes to the ancestor", () => {
  const small = { ...fixture, conversations: fixture.conversations.filter((c) => ["ux-m01", "ux-al04", "ux-aa11", "ux-aq01", "ux-ak06"].includes(c.note)) };
  const map = authorityMapOf(small);
  assert.deepEqual(map.attributes, {});
  assert.deepEqual(map.classes["customer order"], { attributes: { status: "floor", placed: "ops", unit_price: "org" } }, JSON.stringify(map.classes["customer order"]));
  assert.deepEqual(map.classes["work center"], { authority: "floor" });
  assert.ok(Object.values(map.classes).every((c) => (c.authority ? ["floor", "ops", "org"].includes(c.authority) : Object.values(c.attributes).every((v) => ["floor", "ops", "org"].includes(v)))));
  // the whole batch: every claim's position is the rule's answer or a stricter one (never a looser one)
  const all = authorityMapOf(fixture);
  for (const c of fixture.conversations)
    for (const pl of c.expected.placements) {
      const cl = c.expected.document.sections.flatMap((s) => s.claims).find((x) => x.id === pl.id);
      const rule = all.classes[cl.class];
      const got = rule.authority ?? rule.attributes[cl.attribute];
      const rank = { floor: 0, ops: 1, org: 2 };
      assert.ok(rank[got] >= rank[POSITION[pl.authority]], `${pl.id}: ${got} is at least ${POSITION[pl.authority]}`);
    }
  // a disagreement: two notes, one attribute, floor and org -> org
  const a = structuredClone(small.conversations.find((c) => c.note === "ux-aq01"));
  const b = structuredClone(a);
  b.id = "x";
  b.expected.placements[0].authority = "admins-only";
  b.expected.placements[0].home = "org";
  const m = authorityMapOf({ ...small, conversations: [a, b] });
  const cls = a.expected.document.sections[0].claims[0].class;
  assert.deepEqual(m.classes[cls], { authority: "org" });
});

test("the bar tolerates a stored section whose text starts with its heading line", () => {
  const small = { ...fixture, conversations: fixture.conversations.filter((c) => ["ux-m01"].includes(c.note)) };
  const rows = cleanRows(small);
  const body = rows.sections[0].text;
  rows.sections[0].text = `## ${small.conversations[0].expected.document.sections[0].heading}\n\n${body}`;
  assert.equal(bar(small, rows).ok, true, JSON.stringify(bar(small, rows).findings));
  // as the stored preview has it: the newline folded to a space
  rows.sections[0].text = `## ${small.conversations[0].expected.document.sections[0].heading} ${body}`;
  assert.equal(bar(small, rows).ok, true, JSON.stringify(bar(small, rows).findings));
  rows.sections[0].text = `## something else\n\nnot the text`;
  assert.equal(bar(small, rows).findings.lost.length, 1);
});
