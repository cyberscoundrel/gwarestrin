// A stand-in for a person's chat agent as the condenser, for the replay
// harness (loaded by the harness beside fake-models.mjs; used by
// scenarios-condenser.mjs). A real condenser is the pi agent that was in
// the conversation; here each canned thread has the document that agent
// would emit, in the contract's shape (graph-rag/src/model/record.js: text sections, no claims),
// and an off-record thread yields nothing at all.
//
//   THREADS                 the canned conversations, by name
//   documentFor(thread)     the document the agent would put on record, or null off record
//   ingestArgs(document)    how the agent sends it: ingest_document with the document as JSON in text
//   matches(body), condense(messages, body)
//                           what fake-models.mjs loads from this file (SCENARIOS.md): a chat request is
//                           ours when it names a canned thread (or says "condens"); the assistant's
//                           content is that thread's document, or "{}" when it is off record
import { randomUUID } from "node:crypto";

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
  /**
   * the admin's agent working at Operations (a delegated token positioned at ops: the person is the admin,
   * the record is made from Operations) puts a thread on record; one section becomes one document of three
   * sections at three sensitivities. A fresh agent identity keeps the derived floor out of the picture:
   * what alice or bob read earlier in a run (read marks persist per identity) would lift their writes.
   */
  "operations handover": {
    on: true,
    person: "admin",
    position: "ops",
    reason: "Thursday handover",
    transcript: [
      "admin: Toro reordered 200 brackets. Job 4471 is planned for CNC 2 next week.",
      "admin: We should stop quoting Aetrium below cost, Karl thinks we lose money on every bearing job; that's between us and the admins.",
      "admin: And for everyone: the shop closes at noon on Friday for the inventory count.",
      "admin: That's all for the handover, put it on record.",
    ],
    document: {
      title: "e2e-cond Thursday handover",
      description: "The Thursday handover, condensed from the on-record thread at Operations",
      recorded_by: "admin",
      position: "ops",
      reason: "Thursday handover",
      sections: [
        {
          heading: "Toro reorder",
          text: "Toro reordered 200 brackets. Job 4471 is planned for CNC 2 next week.",
        },
        {
          heading: "Aetrium pricing",
          // the harness's decision model reads these tags: pricing and margins, sure, and only the top (from Operations, P2) may see it
          text: "We should stop quoting Aetrium below cost; Karl thinks we lose money on every bearing job. [category: c5] [visible_from: P2]",
        },
        {
          heading: "Shop hours on Friday",
          text: "The shop closes at noon on Friday for the inventory count.",
        },
      ],
    },
  },
};

/** the document the agent would put on record for a thread, or null when the thread is off record */
export function documentFor(thread) {
  const t = typeof thread === "string" ? THREADS[thread] : thread;
  if (!t || !t.on) return null;
  return t.document ? JSON.parse(JSON.stringify(t.document)) : null;
}

/** how the agent sends a document: ingest_document, the document as JSON in text (see standing instructions, "On record") */
export function ingestArgs(document) {
  return { title: document.title, description: document.description, extract: false, text: JSON.stringify(document) };
}

const textOf = (messages) => (messages ?? []).map((m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""))).join("\n");

/** a chat request is this condenser's when it names a canned thread, or when its model or system prompt says "condens" */
export function matches(body) {
  const text = textOf(body?.messages);
  return Object.keys(THREADS).some((n) => text.includes(n)) || /condens/i.test(String(body?.model ?? "")) || /condens/i.test(textOf((body?.messages ?? []).filter((m) => m?.role === "system")));
}

/**
 * The assistant's content for a condensation request (what fake-models.mjs
 * calls): the canned document of the thread the messages name, as an object
 * (the fake JSON-encodes it), or "{}" when the thread is off record or
 * unknown. A real condenser is the agent that was in the conversation.
 */
export function condense(messages, _body) {
  const text = textOf(messages);
  const name = Object.keys(THREADS).find((n) => text.includes(n));
  const doc = name ? documentFor(name) : null;
  return doc ?? "{}";
}

/** the same, as a whole chat-completions reply */
export function complete(body) {
  const out = condense(body?.messages, body);
  return { id: `fake-condenser-${randomUUID()}`, choices: [{ message: { role: "assistant", content: typeof out === "string" ? out : JSON.stringify(out) } }] };
}
