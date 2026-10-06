import http from "node:http";
import type { AddressInfo } from "node:net";
import type { InstanceMetadata } from "@gwarestrin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openShellIdentity } from "../src/runtime/openshell-identity.js";

const md = (openshell?: Record<string, unknown>): InstanceMetadata => ({
  version: 1,
  instance: { name: "alice" },
  values: { graph: { token: "g" }, ...(openshell ? { openshell } : {}) },
});

describe("openShellIdentity", () => {
  it("is mTLS-only with the configured workspace when OIDC isn't configured", () => {
    const id = openShellIdentity({ workspace: "default" }, () => md({ workspace: "gw-alice" }));
    expect(id).toEqual({ workspace: "gw-alice" });
    expect(openShellIdentity({ workspace: "default" }, () => undefined)).toEqual({ workspace: "default" });
  });

  describe("with OIDC (loopback issuer)", () => {
    let server: http.Server;
    let issuer: string;
    const grants: URLSearchParams[] = [];
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          if (req.url?.endsWith("/.well-known/openid-configuration")) {
            res.end(JSON.stringify({ issuer, token_endpoint: `${issuer}token` }));
            return;
          }
          grants.push(new URLSearchParams(body));
          res.end(JSON.stringify({ access_token: `tok-${grants.length}`, token_type: "Bearer", expires_in: 1 }));
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/application/o/openshell/`;
    });
    afterAll(() => server.close());

    it("grants with the metadata secret (re-read each grant) and the profile scope", async () => {
      let current = md({ workspace: "gw-alice", clientSecret: "s-1" });
      const id = openShellIdentity({ workspace: "default", oidc: { issuer, clientId: "openshell-gateway" } }, () => current);
      expect(id.workspace).toBe("gw-alice");
      expect(await id.tokenProvider!.getToken()).toBe("tok-1");
      expect(Object.fromEntries(grants[0]!)).toMatchObject({
        grant_type: "client_credentials",
        client_id: "openshell-gateway",
        client_secret: "s-1",
        scope: "openid profile",
      });
      // rotated secret (metadata hot reload) is used by the next grant
      current = md({ workspace: "gw-alice", clientSecret: "s-2" });
      await new Promise((r) => setTimeout(r, 1_100));
      await id.tokenProvider!.getToken();
      expect(grants.at(-1)!.get("client_secret")).toBe("s-2");
    });

    it("fails clearly without a secret", async () => {
      const id = openShellIdentity({ workspace: "default", oidc: { issuer, clientId: "c" } }, () => md(), {});
      await expect(id.tokenProvider!.getToken()).rejects.toThrow(/client secret/);
    });
  });
});
