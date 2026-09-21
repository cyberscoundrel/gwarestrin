import { Type, type Static } from "typebox";

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
