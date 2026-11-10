import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { dirsFor } from "../src/agents/scaffold.js";
import type { ServerConfig } from "../src/config.js";
import { registerFileRoutes } from "../src/http/files.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { condensedFromEvent, gatePushOf, offRecord, RECORD_FILE, recordContext, switchRecord, threadIdOf, writeRecordContext } from "../src/agents/condenser.js";
import { recordUpload, uploadText } from "../src/agents/record-gate.js";
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
    expect(text).toMatch(/stamped by the graph/);
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
    expect(text).toMatch(/graph-rag_record_document: document = the whole document/);
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

describe("where a record starts (R11.5)", () => {
  it("graph-rag is told the position the person put the thread on record under, and none while it is off", () => {
    const on = switchRecord(offRecord("t1"), { on: true, by: "bob", position: "floor", reason: "handover" }, T0);
    expect(gatePushOf("a1", on)).toEqual({ agent: "a1", thread: "t1", on: true, position: "floor" });
    expect(gatePushOf("a1", switchRecord(on, { on: false, by: "bob" }, T1))).toEqual({ agent: "a1", thread: "t1", on: false });
    expect(gatePushOf("a1", offRecord("t2"))).toEqual({ agent: "a1", thread: "t2", on: false });
  });

  it("the agent is not told to stamp who or where: the graph does", () => {
    const on = switchRecord(offRecord("t1"), { on: true, by: "bob", position: "floor", reason: "handover" }, T0);
    const text = recordContext(on);
    expect(text).not.toMatch(/recorded_by "/);
    expect(text).toMatch(/stamped by the graph/);
    expect(text).toMatch(/uploads while it is on record is put on record/);
  });
});

describe("a file uploaded on record is a record (R11.12)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const text = "# Handover\n\nJob 4471 runs on CNC 2 until Friday; Toro wants 50 more.";

  it("takes text files only", () => {
    expect(uploadText(enc(text))).toEqual({ text });
    expect(uploadText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]))).toEqual({ refused: "not a text file" });
    expect(uploadText(new Uint8Array([0xc3, 0x28, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41]))).toEqual({ refused: "not a text file (not UTF-8)" });
    expect(uploadText(enc("hi"))).toEqual({ refused: "no text to put on record" });
  });

  it("on record, sends the file's name and whole text through record_file with the agent's own client; off record, sends nothing", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return JSON.stringify({ ingesting: true, doc_id: "d1", on_record: true, sections: 1 });
      },
    };
    const off = await recordUpload(client, { file: "handover.md", bytes: enc(text), onRecord: false });
    expect(off.refused).toMatch(/off record/);
    expect(calls).toHaveLength(0);
    const on = await recordUpload(client, { file: "handover.md", bytes: enc(text), onRecord: true, reason: "shift handover" });
    expect(calls).toEqual([{ name: "record_file", args: { file: "handover.md", text, reason: "shift handover" } }]);
    expect(on.recorded).toMatchObject({ on_record: true, doc_id: "d1" });
    const pdf = await recordUpload(client, { file: "scan.pdf", bytes: new Uint8Array([0x25, 0, 1]), onRecord: true });
    expect(pdf.refused).toBe("not a text file");
    expect(calls).toHaveLength(1);
  });

  it("a refusal from the graph is returned, not taken for a record", async () => {
    const client = { callTool: async () => "this conversation is off record, so nothing from it can be written" };
    const r = await recordUpload(client, { file: "a.txt", bytes: enc(text), onRecord: true });
    expect(r.recorded).toBeUndefined();
    expect(r.refused).toMatch(/off record/);
  });
});

describe("the chat agent's record instructions", () => {
  it("name the record tools, say an upload on record is a record, and carry no class vocabulary (R5)", () => {
    expect(RECORD_INSTRUCTIONS).toMatch(/graph-rag_record_document/);
    expect(RECORD_INSTRUCTIONS).not.toMatch(/\bclaims?\b|commitment class|primitive/i);
    const all = buildStandingInstructions({ graph: true, connections: [] } as never);
    expect(all).toMatch(/graph-rag_record_file/);
    expect(all).toMatch(/uploads while this conversation is on record is a record/);
  });
});

describe("the app's half of the record (review of b076783, R-B1 and R-B2)", () => {
  /** a real manager with one agent whose current conversation is thread-1, its graph calls going to `onFetch` */
  async function setup(onFetch: (url: string, init: RequestInit) => Promise<Response>) {
    const stateDir = await mkdtemp(path.join(tmpdir(), "gw-rec-"));
    const providersFile = path.join(stateDir, "providers.json");
    await writeFile(providersFile, JSON.stringify({ providers: { mock: { type: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "dummy", models: [{ id: "m" }] } }, defaultProvider: "mock", defaultModel: "m" }));
    const registry = new ProviderRegistry();
    await registry.load(providersFile);
    const config: ServerConfig = { port: 0, host: "127.0.0.1", stateDir, providersFile, maxAgents: 2, webDistDir: path.join(stateDir, "web") };
    const store = new AgentStore(stateDir);
    await store.load();
    const manager = new AgentManager(config, registry, store);
    const internals = manager as unknown as { running: Map<string, unknown>; mcpServerUrl: () => string };
    internals.mcpServerUrl = () => "http://graph-rag:8000/mcp";
    const record = await manager.createAgent({ name: "on-record", gondolin: { enabled: false } });
    store.setSessionFile(record.id, "/sessions/thread-1.jsonl");
    internals.running.set(record.id, {});
    vi.stubGlobal("fetch", ((url: string, init: RequestInit) => onFetch(String(url), init)) as unknown as typeof fetch);
    return { manager, store, config, id: record.id };
  }

  /** graph-rag as the MCP client sees it: initialize, the notification, then record_file's answer */
  function graphRag(calls: Array<{ name: string; args: Record<string, unknown> }>, pushes: unknown[]) {
    return async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/thread-record")) {
        pushes.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      }
      const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
      const json = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
      if (body.method === "initialize") return json({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "graph-rag", version: "0" } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call" && body.params) {
        calls.push({ name: body.params.name, args: body.params.arguments });
        return json({ content: [{ type: "text", text: JSON.stringify({ ingesting: true, doc_id: "d1", on_record: true, sections: 1 }) }] });
      }
      return new Response("not here", { status: 404 });
    };
  }

  const multipart = (name: string, content: string) => {
    const b = "----e2eboundary";
    return {
      headers: { "content-type": `multipart/form-data; boundary=${b}` },
      payload: `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n--${b}--\r\n`,
    };
  };

  afterEach(() => vi.unstubAllGlobals());

  it("graph-rag is told the position the person put the thread on record under (R11.5)", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const pushes: unknown[] = [];
    const { manager, id } = await setup(graphRag(calls, pushes));
    await manager.setOnRecord(id, { on: true, by: "bob", position: "ops", reason: "handover" });
    expect(pushes.at(-1)).toEqual({ agent: id, thread: "thread-1", on: true, position: "ops" });
    await manager.setOnRecord(id, { on: false, by: "bob" });
    expect(pushes.at(-1)).toEqual({ agent: id, thread: "thread-1", on: false });
  });

  it("a file uploaded while the thread is on record goes to graph-rag's record_file as the agent; off record nothing is sent (R11.12)", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const pushes: unknown[] = [];
    const { manager, config, id } = await setup(graphRag(calls, pushes));
    const app = Fastify();
    await registerFileRoutes(app, config, manager);
    const text = "# Handover\n\nJob 4471 runs on CNC 2 until Friday; Toro wants 50 more.";
    // off record: a file in the workspace, nothing more
    const off = await app.inject({ method: "POST", url: `/api/agents/${id}/files/upload`, ...multipart("before.md", text) });
    expect(off.statusCode).toBe(201);
    expect(off.json().recorded).toEqual([]);
    expect(calls).toHaveLength(0);
    // on record: the same upload is a record
    await manager.setOnRecord(id, { on: true, by: "bob", position: "floor", reason: "the weekly plan" });
    const on = await app.inject({ method: "POST", url: `/api/agents/${id}/files/upload`, ...multipart("plan.md", text) });
    expect(on.statusCode).toBe(201);
    expect(on.json().uploaded).toEqual([{ name: "plan.md", size: Buffer.byteLength(text) }]);
    expect(calls).toEqual([{ name: "record_file", args: { file: "plan.md", text, reason: "the weekly plan" } }]);
    expect(on.json().recorded[0]).toMatchObject({ file: "plan.md", recorded: { on_record: true, doc_id: "d1" } });
    // still in the workspace, as any upload
    expect(await readFile(path.join(dirsFor(config.stateDir, manager.store.get(id)!).workspace, "plan.md"), "utf8")).toBe(text);
    // not text: refused for that file, the upload itself still lands
    const bin = await app.inject({ method: "POST", url: `/api/agents/${id}/files/upload`, ...multipart("scan.pdf", "%PDF\u0000\u0001") });
    expect(bin.statusCode).toBe(201);
    expect(bin.json().recorded[0]).toMatchObject({ file: "scan.pdf", refused: "not a text file" });
    expect(calls).toHaveLength(1);
    await app.close();
  });
});
