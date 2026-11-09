// The agent's real MCP client (pi-mcp-adapter, the pinned version: McpServerManager and executeCall, nothing
// stubbed) against the real graph-rag of an e2e stack, over one connection that lists its tools while the thread is
// off record. What it proves is what tools/list can't: that client keeps the list it fetched at connect.
//   AFTER='../node_modules/.bin/tsx e2e/adapter-check.mts' ONLY=zz-none graph-rag/e2e/e2e.sh
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { signAgentToken } from "../src/delegation.js";

const GR = process.env.GR_URL ?? "http://localhost:8000";
const ADMIN = "e2e-admin";
const ADAPTER = join(import.meta.dirname, "../../packages/server/node_modules/pi-mcp-adapter");
// the adapter's peer pi-ai is the one pi itself runs on (pi's loader supplies it); the checkout's hoisted copy is an older one
const PI_AI_COMPAT = pathToFileURL(join(import.meta.dirname, "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js")).href;
registerHooks({ resolve: (spec, ctx, next) => next(spec === "@earendil-works/pi-ai/compat" ? PI_AI_COMPAT : spec, ctx) });
const { McpServerManager } = await import(join(ADAPTER, "server-manager.ts"));
const { updateServerMetadata } = await import(join(ADAPTER, "init.ts"));
const { executeCall } = await import(join(ADAPTER, "proxy-modes.ts"));

const fails: string[] = [];
const check = (ok: unknown, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };
const agent = randomUUID();
const token = signAgentToken("e2e-delegation-key-0123456789abcdef", { u: "alice", a: agent, p: ["ops"], iat: Math.floor(Date.now() / 1000) });
const put = (on: boolean) => fetch(`${GR}/api/thread-record`, { method: "PUT", headers: { authorization: "Bearer e2e-alice", "content-type": "application/json" }, body: JSON.stringify({ agent, thread: "adapter-check", on }) });

const definition = { url: `${GR}/mcp`, headers: { Authorization: `Bearer ${token}` } };
const manager = new McpServerManager();
await manager.connect("graph-rag", definition);
const conn = manager.getConnection("graph-rag");
check(conn?.status === "connected", `the real client connected: ${conn?.status}`);
const state: any = { config: { mcpServers: { "graph-rag": definition }, settings: {} }, toolMetadata: new Map(), manager, lifecycle: { markKeepAlive() {} }, failureTracker: new Map(), ui: undefined };
updateServerMetadata(state, "graph-rag");
const names = (state.toolMetadata.get("graph-rag") ?? []).map((t: any) => t.originalName ?? t.name);
console.log(`listed off record: ${names.length} tools`);
const text = (r: any) => (r.content ?? []).map((c: any) => c.text).join(" ");
const doc = (title: string) => ({ document: { title, reason: "adapter check", sections: [{ heading: "note", text: `A note for ${title}, from the real client.` }] } });

const before = text(await executeCall(state, "graph-rag_record_document", doc("adapter off")));
check(/off record/.test(before), `off record the handler refuses: ${before.slice(0, 160)}`);

check((await put(true)).ok, "the person switches the thread on");
const on = text(await executeCall(state, "graph-rag_record_document", doc("adapter on")));
check(/"doc_id"/.test(on) && !/not found/.test(on), `on record, on the same connection and list, the write reaches graph-rag: ${on.slice(0, 200)}`);
check((await put(false)).ok, "the person switches it off");
const after = text(await executeCall(state, "graph-rag_record_document", doc("adapter off again")));
check(/off record/.test(after), `off again, same connection: refused: ${after.slice(0, 160)}`);
const asked = text(await executeCall(state, "graph-rag_request_access", { question: "adapter check what is the margin" }));
check(/off record/.test(asked), `off record a question is refused too: ${asked.slice(0, 160)}`);

await manager.closeAll?.();
console.log(fails.length ? `${fails.length} FAILED` : "adapter check: all passed");
process.exit(fails.length ? 1 : 0);
