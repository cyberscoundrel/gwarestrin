import { type Static, Type } from "typebox";

/** pi-ai provider APIs we support bridging. */
export type ProviderApi = "openai-completions" | "anthropic-messages" | "google-generative-ai";

export const providerApiSchema = Type.Union([
  Type.Literal("openai-completions"),
  Type.Literal("anthropic-messages"),
  Type.Literal("google-generative-ai"),
]);

/** Cost fields are per-million-token USD; zeros when unknown/unbilled. */
export const modelCostSchema = Type.Object({
  input: Type.Number({ default: 0 }),
  output: Type.Number({ default: 0 }),
  cacheRead: Type.Number({ default: 0 }),
  cacheWrite: Type.Number({ default: 0 }),
});

export const staticModelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String()),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.String())),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1024 })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  cost: Type.Optional(modelCostSchema),
});

export const autoDiscoverSchema = Type.Object({
  enabled: Type.Boolean({ default: false }),
  path: Type.String({ default: "/models" }),
});

/**
 * One entry in providers.json. Either `apiKeyEnv` (name of an env var the
 * server resolves and injects into the pi child) or `apiKey` (literal).
 * Never serialized into generated files or API responses.
 */
export const providerDefSchema = Type.Object(
  {
    type: providerApiSchema,
    baseUrl: Type.String({ minLength: 1 }),
    apiKeyEnv: Type.Optional(Type.String()),
    apiKey: Type.Optional(Type.String()),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    models: Type.Optional(Type.Array(staticModelSchema)),
    autoDiscover: Type.Optional(autoDiscoverSchema),
    description: Type.Optional(Type.String()),
    isDefault: Type.Optional(Type.Boolean()),
    /** presentation grouping: "local" (self-hosted) vs "cloud" (hosted api); default cloud */
    tier: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("cloud")])),
  },
  { additionalProperties: false },
);

export const providersFileSchema = Type.Object(
  {
    providers: Type.Record(Type.String(), providerDefSchema),
    defaultProvider: Type.Optional(Type.String()),
    defaultModel: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type StaticModel = Static<typeof staticModelSchema>;
export type ProviderDef = Static<typeof providerDefSchema>;
export type ProvidersFile = Static<typeof providersFileSchema>;

/** Sanitized provider + resolved model catalogue (what the API serves). */
export interface ProviderView {
  id: string;
  type: ProviderApi;
  baseUrl: string;
  description?: string | undefined;
  hasKey: boolean;
  degraded: boolean;
  degradedReason?: string | undefined;
  autoDiscover: boolean;
  firstParty: boolean;
  /** "local" (self-hosted) vs "cloud" (hosted api); defaults to cloud */
  tier: "local" | "cloud";
  models: ModelView[];
}

export interface ModelView {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** "static" = declared in providers.json; "discovered" = probed from /models */
  source: "static" | "discovered" | "first-party";
}

export const DEFAULT_CONTEXT_WINDOW = 32_768;
export const DEFAULT_MAX_TOKENS = 8_192;
