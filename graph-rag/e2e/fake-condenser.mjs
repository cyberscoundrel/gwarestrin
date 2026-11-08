// A stand-in for a person's chat agent as the condenser, for the replay
// harness (loaded by the harness beside fake-models.mjs; used by
// scenarios-condenser.mjs). A real condenser is the pi agent that was in
// the conversation; here each canned thread has the document that agent
// would emit, in the contract's shape (graph-rag/src/model/README.md),
// and an off-record thread yields nothing at all.
//
//   THREADS                 the canned conversations, by name
//   condense(thread)        the document the agent would put on record, or null off record
//   ingestArgs(document)    how the agent sends it: ingest_document with the document as JSON in text
//   CLASSES / seedClasses() the confirmed classes the documents name (mirrors test/fixtures/classes.json)
//   complete(body)          a chat-completions stand-in: answers a condensation prompt with the thread's document
import { randomUUID } from "node:crypto";

/** the confirmed classes (test/fixtures/classes.json, the three the canned documents use) */
export const CLASSES = [
  { name: "orders", description: "a customer order: a commitment to deliver", stages: ["quoted", "ordered", "in_production", "shipped", "invoiced", "paid"], record_table: "mssql:dbo_Order" },
  { name: "jobs", description: "a production job: a commitment of machine and people time to an order", stages: ["planned", "running", "paused", "done"], record_table: "mssql:dbo_Job" },
  { name: "hires", description: "a hire: a commitment of a position to a person; no source system records it", stages: ["opened", "interviewing", "offered", "hired", "declined"], record_table: null },
];

/** SQL that seeds the classes as confirmed (run as the admin through execute_graph); safe to repeat */
export function seedClasses(classes = CLASSES) {
  const q = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return classes.map(
    (c) =>
      `UPDATE CommitmentClass SET name = ${q(c.name)}, description = ${q(c.description)}, stages = [${c.stages.map(q).join(", ")}], record_table = ${c.record_table ? q(c.record_table) : "null"}, status = 'confirmed', proposed_by = 'e2e', confirmed_by = 'admin', confirmed_at = '2026-11-01T09:00:00.000Z' UPSERT WHERE name = ${q(c.name)}`,
  );
}

/** a word no other scenario uses, so a search for it answers "did anything of this thread reach the graph" */
export const OFF_RECORD_MARKER = "quenchmoor";

export const THREADS = {
  /** bob chats about a quality issue; the conversation is off record: nothing of it is recorded */
  "off-record quality chat": {
    on: false,
    person: "bob",
    position: "floor",
    transcript: [
      `bob: The ${OFF_RECORD_MARKER} gauge drifted again this morning, third time this month.`,
      "agent: Noted. Do you want me to look up the gauge's calibration record?",
      `bob: Not now. Also, Karl says the ${OFF_RECORD_MARKER} fixture is on its last legs.`,
    ],
    document: null,
  },
  /** alice (Operations) puts a thread on record; one section becomes one document of three sections at three sensitivities */
  "alice handover": {
    on: true,
    person: "alice",
    position: "ops",
    reason: "Thursday handover",
    transcript: [
      "alice: Toro reordered 200 brackets. Job 4471 is planned for CNC 2 next week.",
      "alice: Tomas's pay goes to 26 an hour from December, that's between us and the admins.",
      "alice: And for everyone: the shop closes at noon on Friday for the inventory count.",
      "alice: That's all for the handover, put it on record.",
    ],
    document: {
      title: "e2e-cond Thursday handover",
      description: "Alice's Thursday handover, condensed from the on-record thread",
      recorded_by: "alice",
      position: "ops",
      reason: "Thursday handover",
      sections: [
        {
          heading: "Toro reorder",
          text: "Toro reordered 200 brackets. Job 4471 is planned for CNC 2 next week.",
          claims: [
            { kind: "commitment", subject: { name: "Toro reorder of 200 brackets", class: "orders" }, attribute: "stage", value: "ordered" },
            { kind: "state", subject: "mssql:dbo_Job:4471", class: "jobs", attribute: "stage", value: "planned" },
            { kind: "state", subject: "mssql:dbo_Job:4471", class: "jobs", attribute: "machine", value: "CNC 2" },
          ],
        },
        {
          heading: "Tomas's pay",
          // the harness's grader restricts a note tagged [admins] to the top (fake-models.mjs)
          text: "Tomas's pay goes to 26 an hour from December. [admins]",
          claims: [{ kind: "state", subject: { name: "Tomas", actor: "person" }, class: "hires", attribute: "pay", value: 26, valid_from: "2026-12-01" }],
        },
        {
          heading: "Shop hours on Friday",
          text: "The shop closes at noon on Friday for the inventory count.",
          claims: [{ kind: "event", subject: { scope: "class", class: "jobs", name: "the shop" }, attribute: "shop_closure", value: "closes at noon for the inventory count", at: "2026-11-13T12:00:00Z" }],
        },
      ],
    },
  },
  /** a condenser that names a class nobody confirmed: refused with the field named, nothing stored */
  "unconfirmed class": {
    on: true,
    person: "alice",
    position: "ops",
    reason: "a quote",
    transcript: ["alice: Quote Aetrium 12 a piece for the bearing job, on record."],
    document: {
      title: "e2e-cond Aetrium quote",
      description: "A quote to Aetrium",
      recorded_by: "alice",
      position: "ops",
      reason: "a quote",
      sections: [
        {
          heading: "Aetrium quote",
          text: "Aetrium is quoted 12 a piece for the bearing job.",
          claims: [{ kind: "commitment", subject: { name: "Aetrium bearing job", class: "quotes" }, attribute: "price", value: 12 }],
        },
      ],
    },
  },
};

/** the document the agent would put on record for a thread, or null when the thread is off record */
export function condense(thread) {
  const t = typeof thread === "string" ? THREADS[thread] : thread;
  if (!t || !t.on) return null;
  return t.document ? JSON.parse(JSON.stringify(t.document)) : null;
}

/** how the agent sends a document: ingest_document, the document as JSON in text (see standing instructions, "On record") */
export function ingestArgs(document) {
  return { title: document.title, description: document.description, extract: false, text: JSON.stringify(document) };
}

/**
 * A chat-completions stand-in, in the shape fake-models.mjs serves: given a
 * condensation prompt whose messages name one of the canned threads, the
 * assistant answers with that thread's document as JSON (or "{}" when the
 * thread is off record or unknown). Lets the harness serve the condenser as
 * a model if it drives a real agent loop.
 */
export function complete(body) {
  const text = (body?.messages ?? []).map((m) => String(m.content ?? "")).join("\n");
  const name = Object.keys(THREADS).find((n) => text.includes(n));
  const doc = name ? condense(name) : null;
  return { id: `fake-condenser-${randomUUID()}`, choices: [{ message: { role: "assistant", content: doc ? JSON.stringify(doc) : "{}" } }] };
}
