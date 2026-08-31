import type { McpHttpClient } from "./mcp-client.js";

export interface LexicalHints {
  matchedEntities: Array<{ label: string; name: string }>;
  summary: string;
}

let cache: { at: number; names: Array<{ label: string; name: string }> } | null = null;
const CACHE_MS = 60_000;

/** entity dictionary: label+name pairs from the graph, cached for 60s */
export async function entityDictionary(mcp: McpHttpClient): Promise<Array<{ label: string; name: string }>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.names;
  const text = await mcp.callTool("read_neo4j_cypher", {
    query: "MATCH (n) WHERE n.name IS NOT NULL RETURN labels(n)[0] AS label, n.name AS name LIMIT 500",
  });
  const names: Array<{ label: string; name: string }> = [];
  try {
    const rows = JSON.parse(text) as Array<{ label?: string; name?: string }>;
    for (const r of rows) {
      if (r.label && r.name) names.push({ label: String(r.label), name: String(r.name) });
    }
  } catch {
    // response may be pre-formatted text; fall back to line parsing
    for (const m of text.matchAll(/([A-Za-z]+)[,:\s]+([A-Za-z0-9_. -]{2,40})/g)) {
      names.push({ label: m[1]!, name: m[2]!.trim() });
    }
  }
  cache = { at: Date.now(), names };
  return names;
}

const INTENT_KEYWORDS: Record<string, string> = {
  impact: "impact failure break down outage dies dead unreachable depends dependency",
  lookup: "what is show list get describe tell me about",
  change: "create update delete modify add remove write",
  history: "when previous earlier last history log",
};

/** cheap normalized substring/keyword matching — the seed input for the LLM */
export function lexicalAnalyze(prompt: string, dictionary: Array<{ label: string; name: string }>): LexicalHints {
  const hay = prompt.toLowerCase();
  const matchedEntities = dictionary.filter(({ name }) => {
    const n = name.toLowerCase();
    return n.length >= 3 && hay.includes(n);
  });
  const intents = Object.entries(INTENT_KEYWORDS)
    .filter(([, words]) => words.split(" ").some((w) => hay.includes(w)))
    .map(([k]) => k);
  const parts: string[] = [];
  if (matchedEntities.length) {
    parts.push(`matched graph entities: ${matchedEntities.map((e) => `${e.label}:${e.name}`).join(", ")}`);
  }
  if (intents.length) parts.push(`intent hints: ${intents.join(", ")}`);
  return { matchedEntities, summary: parts.join("; ") || "no lexical matches" };
}
