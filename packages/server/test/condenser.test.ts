import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { condensedFromEvent, offRecord, RECORD_FILE, recordContext, switchRecord, threadIdOf, writeRecordContext } from "../src/agents/condenser.js";
import { buildStandingInstructions, RECORD_INSTRUCTIONS } from "../src/agents/standing-instructions.js";
import { AgentStore } from "../src/agents/store.js";

const T0 = new Date("2026-11-08T09:00:00.000Z");
const T1 = new Date("2026-11-08T10:30:00.000Z");
const T2 = new Date("2026-11-08T11:00:00.000Z");

describe("a thread's record state", () => {
  it("is off by default, keyed by the conversation's session file", () => {
    expect(threadIdOf("/state/agents/a1/sessions/2026-11-08T09-00-00-abc.jsonl")).toBe("2026-11-08T09-00-00-abc");
    expect(threadIdOf(null)).toBeNull();
    const off = offRecord("t1");
    expect(off).toMatchObject({ thread: "t1", on: false, ever: false, documents: 0, since: null });
  });

  it("switches on from now under the person's position and reason, off again without unrecording, on again afresh", () => {
    const on = switchRecord(offRecord("t1"), { on: true, by: "bob", position: "floor", reason: "shift handover" }, T0);
    expect(on).toMatchObject({ on: true, ever: true, since: T0.toISOString(), until: null, by: "bob", position: "floor", reason: "shift handover" });
    // on while on: only a restated reason changes anything
    expect(switchRecord(on, { on: true, by: "bob" }, T1)).toBe(on);
    expect(switchRecord(on, { on: true, by: "bob", reason: "the Toro job" }, T1).reason).toBe("the Toro job");
    const counted = { ...on, documents: 2, condensed_at: T1.toISOString() };
    const off = switchRecord(counted, { on: false, by: "bob" }, T1);
    expect(off).toMatchObject({ on: false, ever: true, since: T0.toISOString(), until: T1.toISOString(), documents: 2, by: "bob", reason: "shift handover" });
    expect(switchRecord(off, { on: false, by: "bob" }, T2)).toBe(off);
    const again = switchRecord(off, { on: true, by: "alice", position: "ops" }, T2);
    expect(again).toMatchObject({ on: true, since: T2.toISOString(), until: null, by: "alice", position: "ops", reason: "put on record by alice", documents: 2 });
  });

  it("the store keeps it per agent and thread, and reports off for a thread it never saw", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "gw-record-"));
    const store = new AgentStore(stateDir);
    await store.load();
    const a = store.create({ name: "x", gondolin: { allowedHosts: [], secrets: {} } });
    const on = switchRecord(offRecord("t1"), { on: true, by: "bob", reason: "r" }, T0);
    store.setThreadRecord(a.id, on);
    expect(store.threadRecord(a.id, "t1")).toEqual(on);
    expect(store.threadRecord(a.id, "t2").on).toBe(false);
    expect(store.threadRecord(a.id, null).on).toBe(false);
    // a state without a thread is not stored
    store.setThreadRecord(a.id, offRecord(null));
    expect(Object.keys(store.get(a.id)!.threads ?? {})).toEqual(["t1"]);
    // persisted
    await new Promise((r) => setTimeout(r, 50));
    const again = new AgentStore(stateDir);
    await again.load();
    expect(again.threadRecord(a.id, "t1").since).toBe(T0.toISOString());
  });
});

describe("what the agent reads at every turn", () => {
  it("nothing for a conversation never on record; the record while on, with no class vocabulary (R5); the switch-off and what is left to condense after", () => {
    expect(recordContext(offRecord("t1"))).toBe("");
    const on = switchRecord(offRecord("t1"), { on: true, by: "bob", position: "floor", reason: "shift handover" }, T0);
    const text = recordContext(on);
    expect(text).toMatch(/ON RECORD since 2026-11-08 09:00 UTC: bob put it on record under the position floor, reason: "shift handover"/);
    expect(text).toMatch(/recorded_by "bob", position "floor"/);
    expect(text).toMatch(/Nothing has been recorded from this conversation yet/);
    expect(text).not.toMatch(/claim|class/i);
    const off = switchRecord({ ...on, documents: 1, condensed_at: T1.toISOString() }, { on: false, by: "bob" }, T2);
    const after = recordContext(off);
    expect(after).toMatch(/went OFF RECORD at 2026-11-08 11:00 UTC/);
    expect(after).toMatch(/not yet condensed stays unrecorded/);
    expect(after).toMatch(/Documents recorded from this conversation so far: 1 \(the last at 2026-11-08 10:30 UTC\)/);
  });

  it("is written beside the standing instructions and removed when there is nothing to say", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "gw-home-"));
    await writeRecordContext(home, "On record\n\nsomething");
    expect(await readFile(path.join(home, RECORD_FILE), "utf8")).toBe("On record\n\nsomething\n");
    await writeRecordContext(home, "");
    await expect(stat(path.join(home, RECORD_FILE))).rejects.toThrow();
  });
});

describe("a document the agent recorded, seen in its tool events", () => {
  it("is the end of an ingest call whose result says on_record; anything else is not", () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ ingesting: true, doc_id: "0f8fad5b-d9cb-469f-a165-70867728950e", on_record: true, sections: 3 }) }] };
    expect(condensedFromEvent({ type: "tool_execution_end", toolName: "mcp", result })).toEqual({ doc_id: "0f8fad5b-d9cb-469f-a165-70867728950e", sections: 3 });
    // pi may hand the text straight
    expect(condensedFromEvent({ type: "tool_execution_end", toolName: "mcp", result: JSON.stringify({ doc_id: "x", on_record: true }) })).toEqual({ doc_id: "x", sections: null });
    expect(condensedFromEvent({ type: "tool_execution_end", toolName: "mcp", result, isError: true })).toBeNull();
    expect(condensedFromEvent({ type: "tool_execution_end", toolName: "mcp", result: JSON.stringify({ ingesting: true, doc_id: "manual" }) })).toBeNull();
    expect(condensedFromEvent({ type: "tool_execution_start", toolName: "mcp" })).toBeNull();
  });
});

describe("the chat agent's standing instructions", () => {
  it("no longer say to save pasted text first; they describe on/off record and the condensation step", () => {
    const text = buildStandingInstructions({ graph: true, connections: [] });
    expect(text).not.toMatch(/save it first/);
    expect(text).not.toMatch(/pasted into this chat\), save/);
    expect(text).toMatch(/only through the record/);
    expect(text).toContain(RECORD_INSTRUCTIONS);
    expect(text).toMatch(/Every conversation is off record until the person switches it on record/);
    expect(text).toMatch(/graph-rag_ingest_document: title and description as in the document, and text = the\nwhole document as JSON/);
    expect(text).not.toMatch(/claim|extract/);
    expect(text).toMatch(/Switching off again stops recording and unrecords\nnothing/);
    // everything else stands as it was
    expect(text).toMatch(/graph-rag_find_shareable/);
    expect(text).toMatch(/Saving things that end/);
    expect(text).toMatch(/Asking for what the person can't see/);
    // a graph role's instructions are untouched by this
    expect(buildStandingInstructions({ graph: true, connections: [], graphRole: "worker" })).not.toMatch(/On record: what reaches/);
    // and without the graph there is no record to speak of
    expect(buildStandingInstructions({ graph: false, connections: [{ name: "mssql" }] })).not.toMatch(/On record/);
  });
});
