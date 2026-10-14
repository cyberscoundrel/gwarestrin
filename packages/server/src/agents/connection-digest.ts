/**
 * A short map of what a database connection holds, so agents don't spend
 * calls (and context) discovering it: for MCP servers with a
 * describe_entities tool (Data API builder), every table's name on one line,
 * plus the columns of the key tables the organization's description of the
 * connection mentions ("customers, jobs" -> dbo_Customer, dbo_Job), read
 * from one row's column names (never its values: DAB declares no fields).
 * Fetched once and cached for an hour; failures leave it out.
 */
import { scoped } from "../util/log.js";

const log = scoped("connection-digest");
const TTL_MS = 3_600_000;
const cache = new Map<string, { at: number; digest: string | null }>();

/** one MCP JSON-RPC call over streamable HTTP (handles an SSE-framed reply) */
async function rpc(url: string, headers: Record<string, string>, session: string | null, id: number, method: string, params: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers, ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return { session: res.headers.get("mcp-session-id") ?? session, body: JSON.parse(line ? line.slice(5) : text) as { result?: { content?: Array<{ text?: string }>; tools?: Array<{ name: string }> } } };
}

/** table names from a describe_entities answer */
export function entityNames(text: string): string[] {
  try {
    const j = JSON.parse(text) as { entities?: Array<{ name?: string }> };
    return (j.entities ?? []).map((e) => String(e.name ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

/** the tables a description names: "customers, jobs (work orders)" -> dbo_Customer, dbo_Job */
export function keyTables(description: string | undefined, names: string[], max = 6): string[] {
  if (!description) return [];
  const words = new Set(
    description
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2)
      .flatMap((w) => [w, w.replace(/ies$/, "y"), w.replace(/s$/, "")]),
  );
  const bare = (n: string) => n.replace(/^[a-z]+_/i, "").toLowerCase();
  return names.filter((n) => words.has(bare(n)) || words.has(n.toLowerCase())).slice(0, max);
}

/** "dbo_Customer: Customer, Name, Status, …" lines from a describe_entities answer */
export function formatEntities(text: string, max = 40): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // find the list of entities wherever the server put it
  const lists: unknown[][] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      if (v.some((x) => x && typeof x === "object" && ("name" in x || "entity" in x))) lists.push(v);
      return;
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(parsed, 0);
  const entities = lists.sort((a, b) => b.length - a.length)[0];
  if (!entities?.length) return null;
  const nameOf = (x: Record<string, unknown>) => String(x.name ?? x.entity ?? "");
  const fieldsOf = (x: Record<string, unknown>) => {
    const f = (x.fields ?? x.columns ?? x.properties) as unknown;
    if (Array.isArray(f)) return f.map((c) => (typeof c === "string" ? c : String((c as Record<string, unknown>)?.name ?? ""))).filter(Boolean);
    if (f && typeof f === "object") return Object.keys(f);
    return [];
  };
  const lines = (entities as Array<Record<string, unknown>>)
    .filter((e) => e && typeof e === "object" && nameOf(e))
    .slice(0, max)
    .map((e) => {
      const fields = fieldsOf(e);
      return `- ${nameOf(e)}${fields.length ? `: ${fields.slice(0, 10).join(", ")}${fields.length > 10 ? ", …" : ""}` : ""}`;
    });
  return lines.length ? lines.join("\n") + (entities.length > max ? `\n- … and ${entities.length - max} more` : "") : null;
}

export async function connectionDigest(name: string, def: { url?: string | undefined; headers?: Record<string, string> | undefined }, description?: string): Promise<string | null> {
  if (!def.url) return null;
  const key = `${name}|${description ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.digest;
  let digest: string | null = null;
  try {
    const headers = def.headers ?? {};
    const init = await rpc(def.url, headers, null, 1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gwarestrin", version: "1" } });
    const tools = await rpc(def.url, headers, init.session, 2, "tools/list", {});
    const toolNames = (tools.body.result?.tools ?? []).map((t) => t.name);
    if (toolNames.includes("describe_entities")) {
      const r = await rpc(def.url, headers, init.session, 3, "tools/call", { name: "describe_entities", arguments: { nameOnly: true } });
      const text = r.body.result?.content?.[0]?.text ?? "";
      const names = entityNames(text);
      const lines: string[] = [];
      // a server that does describe its fields: use that
      const described = formatEntities(text);
      if (described && /: /.test(described)) lines.push(described);
      else if (names.length) {
        const prefix = names.every((n) => n.startsWith("dbo_")) ? "dbo_" : "";
        lines.push(`Tables (${names.length}${prefix ? `, all named ${prefix}…` : ""}): ${names.map((n) => n.slice(prefix.length)).join(", ")}`);
        if (toolNames.includes("read_records")) {
          for (const [i, t] of keyTables(description, names).entries()) {
            const row = await rpc(def.url, headers, init.session, 10 + i, "tools/call", { name: "read_records", arguments: { entity: t, first: 1 } }).catch(() => null);
            const cols = Object.keys(((JSON.parse(row?.body.result?.content?.[0]?.text ?? "{}") as { result?: { value?: Array<Record<string, unknown>> } }).result?.value ?? [])[0] ?? {});
            if (cols.length) lines.push(`${t} columns: ${cols.slice(0, 25).join(", ")}${cols.length > 25 ? ", …" : ""}`);
          }
        }
      }
      digest = lines.length ? lines.join("\n") : null;
    }
  } catch (e) {
    log.warn(`no table summary for ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  cache.set(key, { at: Date.now(), digest });
  return digest;
}

/**
 * Which of a connection's tools only read. Graph worker agents get only
 * these on every connection but the graph (fail closed: none known = the
 * connection is left out). In order: the organization's own list for the
 * connection, the server's read-only hints, then tools known to only read.
 */
const KNOWN_READ = new Set(["describe_entities", "read_records"]); // Data API builder
const readCache = new Map<string, { at: number; tools: string[] }>();

export function readToolsFrom(tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } | undefined }>, configured?: string[]): string[] {
  const names = new Set(tools.map((t) => t.name));
  if (configured?.length) return configured.filter((n) => names.has(n));
  const hinted = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
  if (hinted.length) return hinted;
  return tools.map((t) => t.name).filter((n) => KNOWN_READ.has(n));
}

export async function readTools(name: string, def: { url?: string | undefined; headers?: Record<string, string> | undefined; readTools?: string[] | undefined }): Promise<string[]> {
  const key = `${name}|${(def.readTools ?? []).join(",")}`;
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tools;
  let tools: string[] = [];
  if (def.url) {
    try {
      const headers = def.headers ?? {};
      const init = await rpc(def.url, headers, null, 1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gwarestrin", version: "1" } });
      const list = await rpc(def.url, headers, init.session, 2, "tools/list", {});
      tools = readToolsFrom((list.body.result?.tools ?? []) as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>, def.readTools);
    } catch (e) {
      log.warn(`no read-only tool list for ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (tools.length) readCache.set(key, { at: Date.now(), tools });
  return tools;
}
