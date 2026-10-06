import { createHmac } from "node:crypto";
import type { InstanceMetadata } from "@gwarestrin/shared";
import { getInstanceMetadata } from "../instance/metadata.js";

/**
 * The knowledge-graph credential an agent uses. With a delegation key in the
 * instance metadata (values.graph.delegationKey, provisioner-issued) each
 * agent gets its own token placing it at its profile's positions:
 *
 *   gwa1.<base64url({u, a, p, iat})>.<base64url(HMAC-SHA256(key, "gwa1." + payload))>
 *
 * graph-rag drops any position outside what the instance's user reaches, and
 * never lets an agent token approve or run raw queries. Without a key the
 * agent shares the instance token (the user's own view).
 */
export function graphTokenFor(
  agent: { id: string },
  profile: { positions?: string[] | undefined },
  metadata: InstanceMetadata | undefined = getInstanceMetadata(),
  now = Date.now(),
): string | undefined {
  const graph = (metadata?.values as Record<string, { token?: unknown; delegationKey?: unknown }> | undefined)?.graph;
  const key = typeof graph?.delegationKey === "string" ? graph.delegationKey : undefined;
  const user = metadata?.instance.name;
  if (!key || !user) return typeof graph?.token === "string" ? graph.token : undefined;
  const payload = { u: user, a: agent.id, p: profile.positions ?? [], iat: Math.floor(now / 1000) };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", key).update(`gwa1.${body}`).digest("base64url");
  return `gwa1.${body}.${sig}`;
}
