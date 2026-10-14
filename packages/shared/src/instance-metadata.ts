import { Type, type Static } from "typebox";

export const MODEL_TIERS = ["basic", "standard", "frontier"] as const;
export const MODEL_HOSTING = ["on-prem", "private-cloud", "public-api"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export type ModelHosting = (typeof MODEL_HOSTING)[number];

/** what the organization's admin says a model is (see provisioner/model-labels.mjs) */
export const modelLabelSchema = Type.Object({
  tier: Type.Union([Type.Literal("basic"), Type.Literal("standard"), Type.Literal("frontier")]),
  hosting: Type.Union([Type.Literal("on-prem"), Type.Literal("private-cloud"), Type.Literal("public-api")]),
  notes: Type.Optional(Type.String({ maxLength: 500 })),
  by: Type.Optional(Type.String()),
  at: Type.Optional(Type.String()),
});
export type ModelLabel = Static<typeof modelLabelSchema>;

/** a model's label key */
export const modelKey = (provider: string, modelId: string): string => `${provider}/${modelId}`;

/**
 * Instance metadata v1 — the deployment contract between the surrounding
 * infrastructure (IdP, reverse proxy, provisioner) and a gwarestrin
 * instance. Infrastructure authors this document (and may alter it at any
 * time; the server hot-reloads). Its absence means the instance runs in
 * legacy open mode. gwarestrin never interprets identity-provider specifics:
 * `values` is an opaque substitution bag referenced by MCP server defs via
 * `${values.*}` placeholders, and `presentation` optionally enables
 * infrastructure-provided UI surfaces (e.g. a write-approval queue).
 */
export const instanceMetadataSchema = Type.Object(
  {
    version: Type.Literal(1),
    instance: Type.Object({
      name: Type.String({ minLength: 1 }),
      displayName: Type.Optional(Type.String()),
    }),
    owner: Type.Optional(
      Type.Object({
        id: Type.Optional(Type.String()),
        displayName: Type.Optional(Type.String()),
      }),
    ),
    /**
     * per-instance settings the organization's admin sets (provisioner-issued,
     * enforced live by the server): concurrency cap, allowed tool connections,
     * allowed model providers. Absent = no restriction beyond the server's own.
     */
    settings: Type.Optional(
      Type.Object({
        maxAgents: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
        mcp: Type.Optional(Type.Union([Type.Literal("all"), Type.Array(Type.String())])),
        providers: Type.Optional(Type.Union([Type.Literal("all"), Type.Array(Type.String())])),
      }),
    ),
    /**
     * what each tool connection is for, in the organization's words (the
     * admin writes them in Workspaces); agents get them with their tools
     */
    connections: Type.Optional(Type.Record(Type.String(), Type.String())),
    /**
     * the organization's model labels ("<provider>/<model id>" -> label).
     * Present = only labeled models may run agents here; absent (legacy) =
     * no label restriction.
     */
    models: Type.Optional(Type.Record(Type.String(), modelLabelSchema)),
    /** substitution bag: MCP defs reference values via ${values.a.b} paths */
    values: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /** optional UI surfaces (all enforcement happens in the backing service) */
    presentation: Type.Optional(
      Type.Object({
        queue: Type.Optional(
          Type.Object({
            label: Type.Optional(Type.String()),
            url: Type.String({ minLength: 1 }),
            /** path (within this document) resolving to the bearer token */
            tokenRef: Type.String({ minLength: 1 }),
          }),
        ),
      }),
    ),
  },
  { additionalProperties: false },
);

export type InstanceMetadata = Static<typeof instanceMetadataSchema>;

/** resolve a dot path ("values.graph.token") against the metadata document */
export function resolveMetadataPath(metadata: InstanceMetadata, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, key) => {
      if (acc != null && typeof acc === "object") return (acc as Record<string, unknown>)[key];
      return undefined;
    }, metadata as unknown);
}
