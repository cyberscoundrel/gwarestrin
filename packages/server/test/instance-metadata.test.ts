import { describe, expect, it } from "vitest";
import type { InstanceMetadata } from "@gwarestrin/shared";
import { applyInstanceSubstitution, substituteInstanceValue } from "../src/instance/metadata.js";

const md: InstanceMetadata = {
  version: 1,
  instance: { name: "alice" },
  values: { graph: { token: "secret-1" }, sql: { token: "sql-1" } },
};

describe("substituteInstanceValue", () => {
  it("resolves ${values.*} paths", () => {
    expect(substituteInstanceValue("Bearer ${values.graph.token}", md)).toEqual({ value: "Bearer secret-1", ok: true });
  });
  it("fails closed on missing paths", () => {
    expect(substituteInstanceValue("Bearer ${values.graph.missing}", md).ok).toBe(false);
  });
  it("fails closed without metadata", () => {
    expect(substituteInstanceValue("Bearer ${values.graph.token}", undefined).ok).toBe(false);
  });
});

describe("applyInstanceSubstitution", () => {
  it("substitutes headers and env strings", () => {
    const def = {
      url: "http://graph-rag:8000/mcp",
      headers: { authorization: "Bearer ${values.graph.token}" },
      env: { TOKEN: "${values.sql.token}" },
    };
    const out = applyInstanceSubstitution(def, md);
    expect(out).toEqual({
      url: "http://graph-rag:8000/mcp",
      headers: { authorization: "Bearer secret-1" },
      env: { TOKEN: "sql-1" },
    });
  });

  it("omits the def (null) when a reference is unresolvable", () => {
    const def = { url: "http://x/mcp", headers: { authorization: "Bearer ${values.nope}" } };
    expect(applyInstanceSubstitution(def, md)).toBeNull();
  });

  it("passes through unchanged in legacy mode (no metadata)", () => {
    const def = { url: "http://x/mcp", headers: { authorization: "Bearer ${values.graph.token}" } };
    expect(applyInstanceSubstitution(def, undefined)).toEqual(def);
  });
});
