import { clientCredentials, type OidcTokenProvider } from "@nvidia/openshell-sdk";
import type { OpenShellRuntimeConfig } from "../config.js";
import type { InstanceMetadata } from "@gwarestrin/shared";
import { getInstanceMetadata } from "../instance/metadata.js";

/**
 * Who this instance is at the OpenShell gateway. The gateway isolates tenants
 * by workspace and authorizes each call from an OIDC access token (subject +
 * groups); the client certificate only gets a caller onto the wire. The
 * provisioner issues both halves per tenant into instance metadata:
 *
 *   values.openshell = { workspace: "gw-<tenant>", clientSecret: "<grant secret>" }
 *
 * Env fallbacks (GWARESTRIN_OPENSHELL_WORKSPACE / _OIDC_SECRET) cover
 * instances that aren't provisioned.
 */
export interface OpenShellIdentity {
  workspace: string;
  /** absent when the gateway isn't configured for OIDC (local single-user gateways) */
  tokenProvider?: OidcTokenProvider;
}

interface OpenShellValues {
  workspace?: unknown;
  clientSecret?: unknown;
}

function values(metadata: InstanceMetadata | undefined): OpenShellValues {
  const v = (metadata?.values as Record<string, unknown> | undefined)?.openshell;
  return v && typeof v === "object" ? (v as OpenShellValues) : {};
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function openShellIdentity(
  cfg: Pick<OpenShellRuntimeConfig, "workspace" | "oidc">,
  metadata: () => InstanceMetadata | undefined = getInstanceMetadata,
  env: NodeJS.ProcessEnv = process.env,
): OpenShellIdentity {
  const workspace = str(values(metadata()).workspace) ?? cfg.workspace;
  if (!cfg.oidc) return { workspace };
  const { issuer, clientId } = cfg.oidc;
  return {
    workspace,
    tokenProvider: clientCredentials({
      issuer,
      clientId,
      // read on every grant, so a rotated secret (metadata hot reload) takes effect
      clientSecret: () => {
        const secret = str(values(metadata()).clientSecret) ?? str(env.GWARESTRIN_OPENSHELL_OIDC_SECRET);
        if (!secret) throw new Error("no OpenShell client secret (instance metadata values.openshell.clientSecret)");
        return secret;
      },
      // profile carries the groups claim the gateway reads roles from
      scopes: ["openid", "profile"],
    }),
  };
}
