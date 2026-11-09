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
import { claimsOf, normalizeDocument, subjectId } from "../src/model/claims.js";
import { parsePositionMap } from "../src/positions.js";
import { sectionName } from "../src/documents.js";
import { adaptClaim, bar, checkBatch, collectRows, conversationOf, expectedClaims, failingNotes, generateBatch, POSITION, prefixed, TREE, verdictLine } from "../e2e/conversations.mjs";

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
  const wanted = expectedClaims(b);
  const documents = [];
  const sections = [];
  const claims = [];
  const things = new Map();
  let rid = 1;
  const thingOf = (subject) => {
    const id = subjectId(subject);
    if (!things.has(id)) {
      const label = subject.scope === "class" ? (subject.name ? `${subject.class} (${subject.name})` : subject.class) : (subject.name ?? subject.key);
      things.set(id, { rid: `#3:${rid++}`, name: label, label, _keys: subject.key ? [subject.key] : [] });
    }
    return things.get(id).rid;
  };
  for (const c of b.conversations) {
    const d = c.expected.document;
    documents.push({ rid: `#1:${rid++}`, name: d.title, _home: c.expected.document_home, _origin: c.position, _placed_by: null, _doc_id: c.id, _on_record: true, _recorded_by: d.recorded_by, _recorded_at: d.recorded_at, _record_position: d.position });
    d.sections.forEach((s, i) => {
      const srid = `#2:${rid++}`;
      sections.push({ rid: srid, name: sectionName(d.title, i, s.heading), _doc_title: d.title, _doc_id: c.id, _section: i, _home: c.expected.sections[i].home, _placed_by: null, text: s.text });
      for (const cl of s.claims) {
        const w = wanted.get(cl.id);
        claims.push({ id: cl.id, kind: w.kind, class: w.class, attribute: w.attribute, value: w.value, valid_from: w.valid_from, valid_until: w.valid_until, recorded_at: w.recorded_at, recorded_by: w.recorded_by, _home: c.expected.placements.find((p) => p.id === cl.id).home, out_rid: srid, in_rid: thingOf(w.subject) });
      }
    });
  }
  return { documents, sections, claims, things: [...things.values()], rescues: [] };
}

test("the bar: a batch stored as expected is clean; each of the four failures is found and counted", () => {
  const small = { ...fixture, conversations: fixture.conversations.filter((c) => ["ux-m01", "ux-al04", "ux-aa11", "ux-ak06"].includes(c.note)) };
  const rows = cleanRows(small);
  const clean = bar(small, rows);
  assert.equal(clean.ok, true, JSON.stringify(clean.findings));
  assert.equal(verdictLine(small, clean), "CLEAN oracle-sixty: 4/4 documents, 6/6 claims; rescues 0, misplaced 0, lost 0, hidden titles 0, wrong content 0");
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
  assert.match(verdictLine(small, v6), /^NOT CLEAN oracle-sixty: 4\/4 documents, 0\/6 claims; rescues 0, misplaced 6, lost 0, hidden titles 0, wrong content 0$/);
});

test("collectRows asks for the batch's titles and claim ids and survives a missing CLAIMS type", async () => {
  const small = { ...fixture, conversations: fixture.conversations.slice(0, 2) };
  const asked = [];
  const rows = await collectRows(small, async (sql) => {
    asked.push(sql);
    if (/FROM CLAIMS/.test(sql)) throw new Error("Type 'CLAIMS' was not found");
    return [];
  });
  assert.deepEqual(rows, { documents: [], sections: [], claims: [], things: [], rescues: [] });
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

test("the batch's expected claims are the oracle's, field by field, and every date is the contract's reading of the oracle's", () => {
  for (const c of fixture.conversations) {
    const note = oracle.find((n) => n.id === c.note);
    const claims = c.expected.document.sections.flatMap((s) => s.claims);
    assert.equal(claims.length, note.claims.length, c.note);
    for (const cl of claims) {
      const j = Number(cl.id.split("#")[1]);
      assert.deepEqual(cl, adaptClaim(note.claims[j], cl.id), cl.id);
    }
  }
  const wanted = expectedClaims(fixture);
  assert.equal(wanted.size, 100);
  const m01 = fixture.conversations.find((c) => c.note === "ux-m01");
  assert.equal(wanted.get("ux-m01#0").valid_from, m01.recorded_at, "recorded_at resolves against the recording");
  assert.equal(wanted.get("ux-m01#2").valid_until, m01.recorded_at, "so does the end");
});

test("expectedClaims applies decision 3: a later claim on the same attribute of the same subject closes the open one", () => {
  const one = structuredClone(fixture.conversations.find((c) => c.note === "ux-t03"));
  const two = structuredClone(one);
  two.id = "conv-later";
  two.recorded_at = "2026-11-07T09:00:00.000Z";
  two.expected.document.recorded_at = two.recorded_at;
  two.expected.document.title = "later";
  two.expected.document.sections[0].claims[0].id = "later#0";
  two.expected.placements[0].id = "later#0";
  const wanted = expectedClaims({ ...fixture, conversations: [one, two] });
  assert.equal(wanted.get("ux-t03#0").valid_until, two.recorded_at);
  assert.equal(wanted.get("later#0").valid_until, null);
});

const small = () => ({ ...fixture, conversations: fixture.conversations.filter((c) => ["ux-m01", "ux-al04", "ux-aa11", "ux-ak06"].includes(c.note)) });

test("the bar reads what a landed claim says: one wrong field on one row fails it, and the finding names the field", () => {
  const b = small();
  const rows = cleanRows(b);
  assert.equal(bar(b, rows).ok, true);
  for (const [field, bad] of [
    ["kind", "event"],
    ["class", "not the class"],
    ["attribute", "not_the_attribute"],
    ["value", "not the value"],
    ["valid_from", "2001-01-01T00:00:00.000Z"],
    ["valid_until", "2001-01-02T00:00:00.000Z"],
    ["recorded_at", "2001-01-01T00:00:00.000Z"],
    ["recorded_by", "mallory"],
  ]) {
    const r = structuredClone(rows);
    r.claims[0][field] = bad;
    const v = bar(b, r);
    assert.equal(v.ok, false, `${field} wrong and still clean`);
    assert.ok(v.findings.content.some((f) => f.includes(rows.claims[0].id) && f.includes(`: ${field} `)), `${field}: ${JSON.stringify(v.findings.content)}`);
    assert.match(verdictLine(b, v), /^NOT CLEAN/);
    assert.match(verdictLine(b, v), /wrong content [1-9]/);
  }
});

test("the bar compares the subject by its row's key or its name, and two rows on one thing is wrong", () => {
  const b = small();
  const rows = cleanRows(b);
  const m01 = rows.claims.find((c) => c.id === "ux-m01#0");
  const named = rows.claims.find((c) => c.id === "ux-m01#1");
  const edit = (id, fn) => {
    const r = structuredClone(rows);
    fn(r, r.things.find((t) => t.rid === rows.claims.find((c) => c.id === id).in_rid));
    return bar(b, r).findings.content.filter((f) => f.includes(": subject: "));
  };
  assert.match(edit("ux-m01#0", (_, t) => (t._keys = ["mssql:dbo_Work_Center:OTHER"]))[0], /expected the row mssql:dbo_Work_Center:INSPECT-2/);
  assert.match(edit("ux-m01#0", (_, t) => t._keys.push("mssql:dbo_Customer:BSE"))[0] ?? "", /^$/, "another key nobody in the batch claims is no finding");
  const otherBatchKey = [...expectedClaims(b).values()].map((c) => c.subject.key).find((k) => k && k !== "mssql:dbo_Work_Center:INSPECT-2");
  assert.match(edit("ux-m01#0", (_, t) => t._keys.push(otherBatchKey))[0], /two rows on one thing/);
  assert.match(edit("ux-m01#1", (_, t) => (t.label = "something else"))[0], /expected "Exatron EPP-D98 parts \(job not named\)"/);
  // a subject thing that is not there, and a claim pointed at another thing
  const r = structuredClone(rows);
  r.things = r.things.filter((t) => t.rid !== m01.in_rid);
  assert.ok(bar(b, r).findings.content.some((f) => f.includes("ux-m01#0") && /not in the graph/.test(f)));
  const r2 = structuredClone(rows);
  r2.claims.find((c) => c.id === "ux-m01#0").in_rid = named.in_rid;
  assert.ok(bar(b, r2).findings.content.some((f) => f.includes("ux-m01#0") && f.includes(": subject: ")));
});

test("the bar compares the section and document a claim landed in, and both homes", () => {
  const b = small();
  const rows = cleanRows(b);
  // the document's home, generated as expected and compared now
  const r1 = structuredClone(rows);
  r1.documents.find((d) => d.name === b.conversations[0].expected.document.title)._home = "org";
  assert.match(bar(b, r1).findings.misplaced.join("\n"), /the document seen from org, expected ops/);
  // the document's on-record marker, recorder, position and time
  for (const [field, bad, re] of [
    ["_on_record", null, /not marked on record/],
    ["_recorded_by", "mallory", /recorded by "mallory"/],
    ["_record_position", "org", /recorded under "org"/],
    ["_recorded_at", "2001-01-01T00:00:00.000Z", /recorded at "2001/],
  ]) {
    const r = structuredClone(rows);
    r.documents[0][field] = bad;
    assert.match(bar(b, r).findings.content.join("\n"), re, field);
  }
  // a claim from no section of the batch, from another document's section, from the wrong section of its own
  const r2 = structuredClone(rows);
  r2.claims[0].out_rid = "#9:9";
  assert.match(bar(b, r2).findings.content.join("\n"), /ux-m01#0: not from a section of this batch/);
  const al04 = b.conversations.find((c) => c.note === "ux-al04");
  const r3 = structuredClone(rows);
  r3.claims[0].out_rid = rows.sections.find((s) => s._doc_title === al04.expected.document.title).rid;
  assert.match(bar(b, r3).findings.content.join("\n"), /ux-m01#0: from a section of ".*brightline/);
  const r4 = structuredClone(rows);
  r4.claims.find((c) => c.id === "ux-al04#0").out_rid = rows.sections.find((s) => s._doc_title === al04.expected.document.title && s._section === 1).rid;
  assert.match(bar(b, r4).findings.misplaced.join("\n"), /ux-al04#0: from §2, expected §1/);
  // a claim on a batch section the oracle does not have
  const r5 = structuredClone(rows);
  r5.claims.push({ ...rows.claims[0], id: "not-in-the-oracle" });
  assert.match(bar(b, r5).findings.content.join("\n"), /an unexpected claim not-in-the-oracle/);
});

test("the review's case: all sixty-two with every subject, class, value and date wrong and every document at the root is not clean", () => {
  const rows = cleanRows(fixture);
  assert.equal(bar(fixture, rows).ok, true, JSON.stringify(bar(fixture, rows).findings));
  assert.equal(verdictLine(fixture, bar(fixture, rows)), "CLEAN oracle-sixty: 62/62 documents, 100/100 claims; rescues 0, misplaced 0, lost 0, hidden titles 0, wrong content 0");
  for (const c of rows.claims) Object.assign(c, { class: "x", value: "x", valid_from: "2001-01-01T00:00:00.000Z", valid_until: "2001-01-02T00:00:00.000Z" });
  for (const t of rows.things) Object.assign(t, { label: "x", _keys: ["mssql:x:y"] });
  for (const d of rows.documents) d._home = "org";
  const v = bar(fixture, rows);
  assert.equal(v.ok, false);
  assert.equal(v.counts.claims, 100, "the rows are all there: this is about what they say");
  assert.ok(v.findings.content.length >= 400, `${v.findings.content.length} findings`);
  assert.ok(v.findings.misplaced.length >= 40, "every document not expected at the root");
  assert.equal(failingNotes(fixture, v).size, 62);
});

test("failingNotes groups findings by note", () => {
  const b = small();
  const rows = cleanRows(b);
  rows.claims.find((c) => c.id === "ux-al04#1").value = "wrong";
  const notes = failingNotes(b, bar(b, rows));
  assert.deepEqual([...notes.keys()], ["ux-al04"]);
  assert.match(notes.get("ux-al04")[0], /^content: conv-ux-al04 claim ux-al04#1: value "wrong"/);
});
