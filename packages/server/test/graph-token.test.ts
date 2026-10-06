import { createHmac } from "node:crypto";
import type { InstanceMetadata } from "@gwarestrin/shared";
import { describe, expect, it } from "vitest";
import { graphTokenFor } from "../src/agents/graph-token.js";
import { substituteInstanceValue } from "../src/instance/metadata.js";

const KEY = "d".repeat(96);
const md = (graph: Record<string, unknown>): InstanceMetadata => ({ version: 1, instance: { name: "alice" }, values: { graph } });

describe("graphTokenFor", () => {
  it("signs an agent token carrying the profile's positions", () => {
    const token = graphTokenFor({ id: "agent-1" }, { positions: ["pos-floor"] }, md({ token: "inst", delegationKey: KEY }), 1_000_000);
    const [prefix, body, sig] = token!.split(".");
    expect(prefix).toBe("gwa1");
    expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({ u: "alice", a: "agent-1", p: ["pos-floor"], iat: 1000 });
    expect(sig).toBe(createHmac("sha256", KEY).update(`gwa1.${body}`).digest("base64url"));
  });

  it("no positions in the profile: an agent token that stands where the user stands", () => {
    const token = graphTokenFor({ id: "agent-1" }, {}, md({ token: "inst", delegationKey: KEY }));
    expect(JSON.parse(Buffer.from(token!.split(".")[1]!, "base64url").toString()).p).toEqual([]);
  });

  it("falls back to the instance token without a delegation key", () => {
    expect(graphTokenFor({ id: "agent-1" }, { positions: ["x"] }, md({ token: "inst" }))).toBe("inst");
    expect(graphTokenFor({ id: "agent-1" }, {}, undefined)).toBeUndefined();
  });

  it("the delegation key is never substituted into agent config", () => {
    expect(substituteInstanceValue("${values.graph.delegationKey}", md({ token: "inst", delegationKey: KEY })).ok).toBe(false);
    expect(substituteInstanceValue("Bearer ${values.graph.token}", md({ token: "inst", delegationKey: KEY }))).toEqual({ value: "Bearer inst", ok: true });
  });
});
