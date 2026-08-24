import { Type, type Static } from "typebox";

/**
 * MCP server definition — mirrors pi-mcp-adapter's `ServerEntry` (mcpServers
 * map values in .mcp.json) plus gwarestrin metadata (`description`).
 * Exactly one transport must be set: `command` (stdio) or `url` (http).
 */
export const mcpServerDefSchema = Type.Object(
  {
    // stdio transport
    command: Type.Optional(Type.String({ minLength: 1 })),
    args: Type.Optional(Type.Array(Type.String())),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    cwd: Type.Optional(Type.String()),
    // http transport
    url: Type.Optional(Type.String({ minLength: 1 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    auth: Type.Optional(Type.Union([Type.Literal("oauth"), Type.Literal("bearer"), Type.Literal(false)])),
    /** env var name holding the bearer token (resolved in the pi child env) */
    bearerTokenEnv: Type.Optional(Type.String()),
    // gwarestrin metadata (stripped when generating .mcp.json)
    description: Type.Optional(Type.String()),
    /** adapter-native per-server kill switch */
    disabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type McpServerDef = Static<typeof mcpServerDefSchema>;

export type McpRegistry = Record<string, McpServerDef>;

export function validateMcpServerDef(def: McpServerDef): string | null {
  const hasCommand = typeof def.command === "string" && def.command.length > 0;
  const hasUrl = typeof def.url === "string" && def.url.length > 0;
  if (hasCommand === hasUrl) return "exactly one of command (stdio) or url (http) is required";
  if (hasCommand && def.headers) return "headers only apply to url transport";
  if (hasUrl && (def.args || def.env || def.cwd)) return "args/env/cwd only apply to command transport";
  return null;
}

/** subset of the registry for one agent, with gwarestrin-only keys stripped */
export function mcpSubset(registry: McpRegistry, names: string[]): Record<string, Omit<McpServerDef, "description">> {
  const out: Record<string, Omit<McpServerDef, "description">> = {};
  for (const name of names) {
    const def = registry[name];
    if (!def) continue; // unknown names ignored (e.g. after registry delete)
    const { description: _meta, ...adapterDef } = def;
    out[name] = adapterDef;
  }
  return out;
}
