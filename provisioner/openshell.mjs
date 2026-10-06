// OpenShell tenancy — the provisioner is the gateway's Platform Admin.
//
// The gateway isolates tenants by workspace and authorizes every call from an
// authentik-issued OIDC access token (subject + groups); its client
// certificate only gets a caller onto the wire. Per tenant on the OpenShell
// runtime this module keeps:
//   authentik  service account gw-<name>-osh (group openshell-user) + an app
//              password; the tenant grants itself tokens with client_credentials
//              (client_secret = base64(username:app_password))
//   gateway    workspace gw-<name>, with that account's subject as Workspace
//              Admin (providers, profiles, policy, sandboxes in that workspace
//              only)
// Revoke deactivates the account and removes the membership; state stays.
//
// Shared objects (created once, kept in shape every pass): the issuer
// certificate on authentik's internal HTTPS listener, groups openshell-admin /
// openshell-user, the `openshell` OAuth2 provider + application, and the
// provisioner's own account in openshell-admin.
//
// Env: OPENSHELL_GATEWAY (enables this module), OPENSHELL_PKI (ca.crt,
// client/, authentik/), OPENSHELL_ISSUER_BASE, OPENSHELL_TENANTS.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { SandboxClient, clientCredentials, errorCode, fromConnect } from "@nvidia/openshell-sdk";

const GATEWAY = process.env.OPENSHELL_GATEWAY ?? "";
const PKI = (process.env.OPENSHELL_PKI ?? "/data/openshell-pki").replace(/\/+$/, "");
const ISSUER_BASE = (process.env.OPENSHELL_ISSUER_BASE ?? "https://authentik-server:9443").replace(/\/+$/, "");
export const ISSUER = `${ISSUER_BASE}/application/o/openshell/`;
export const CLIENT_ID = "openshell-gateway";
export const TENANTS = new Set((process.env.OPENSHELL_TENANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
// the issuer host: authentik serves a brand's web certificate on SNI match
const ISSUER_HOST = new URL(ISSUER_BASE).hostname;
const PLATFORM_ACCOUNT = "gw-provisioner-osh";
const PLATFORM_CRED = "/data/instances/.openshell-platform.json";
const WORKSPACE_ROLE_ADMIN = 2; // openshell.v1.WorkspaceRole.ADMIN

export const enabled = () => GATEWAY !== "";
export const accountFor = (name) => `gw-${name}-osh`;
export const workspaceFor = (name) => `gw-${name}`;

const codeOf = (err) => errorCode(err) ?? errorCode(fromConnect(err));
const scope = (workspace) => ({ workspaceScope: { selection: { case: "workspace", value: workspace } } });

/** sub claim of a token we just received from the issuer over TLS (no signature check needed) */
const subjectOf = (accessToken) => JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString()).sub;

export function createOpenShell({ ak, akFind, log }) {
  let platform; // { client } once the shared objects + platform login are in place

  // ---------- authentik helpers ----------

  async function ensureGroup(name) {
    return (await akFind("/core/groups/?page_size=200", (g) => g.name === name)) ?? ak("POST", "/core/groups/", { name });
  }

  async function ensureServiceAccount(username, group) {
    let user = (await ak("GET", `/core/users/?username=${encodeURIComponent(username)}`)).results?.find((u) => u.username === username);
    if (!user) {
      user = await ak("POST", "/core/users/", { username, name: username, type: "service_account", path: "gwarestrin/openshell", is_active: true });
      log(`authentik: service account ${username} created`);
    } else if (!user.is_active) {
      user = await ak("PATCH", `/core/users/${user.pk}/`, { is_active: true });
      log(`authentik: service account ${username} reactivated`);
    }
    if (!(user.groups ?? []).includes(group.pk)) {
      await ak("POST", `/core/groups/${group.pk}/add_user/`, { pk: user.pk });
    }
    return user;
  }

  /** replace the account's app password; returns the client_credentials secret */
  async function rotateSecret(user) {
    const identifier = `${user.username}-client-credentials`;
    await ak("DELETE", `/core/tokens/${identifier}/`).catch((err) => {
      if (!/-> 404/.test(err.message)) throw err;
    });
    await ak("POST", "/core/tokens/", {
      identifier,
      intent: "app_password",
      user: user.pk,
      expiring: false,
      description: "OpenShell gateway identity (managed by the provisioner)",
    });
    const { key } = await ak("GET", `/core/tokens/${identifier}/view_key/`);
    log(`authentik: credentials rotated for ${user.username}`);
    return Buffer.from(`${user.username}:${key}`).toString("base64");
  }

  /** one client_credentials grant; null when the issuer refuses the secret */
  async function grant(secret) {
    const res = await fetch(`${ISSUER_BASE}/application/o/token/`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: secret, scope: "openid profile" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 400 || res.status === 401) return null;
    if (!res.ok) throw new Error(`token grant -> ${res.status}`);
    return (await res.json()).access_token;
  }

  /** a working secret for the account (kept if it still grants, rotated otherwise) and its subject */
  async function credentialFor(user, current) {
    let secret = current;
    let token = secret ? await grant(secret) : null;
    if (!token) {
      secret = await rotateSecret(user);
      token = await grant(secret);
      if (!token) throw new Error(`fresh credentials for ${user.username} are refused by the issuer`);
    }
    return { secret, subject: subjectOf(token) };
  }

  // ---------- shared objects ----------

  async function ensureIssuerCertificate() {
    const certificate_data = readFileSync(`${PKI}/authentik/tls.crt`, "utf8");
    const key_data = readFileSync(`${PKI}/authentik/tls.key`, "utf8");
    let kp = await akFind("/crypto/certificatekeypairs/?page_size=200", (k) => k.name === "gw-authentik-server");
    if (!kp) {
      kp = await ak("POST", "/crypto/certificatekeypairs/", { name: "gw-authentik-server", certificate_data, key_data });
      log("authentik: issuer certificate imported");
    } else {
      const { data } = await ak("GET", `/crypto/certificatekeypairs/${kp.pk}/view_certificate/`);
      if (data.trim() !== certificate_data.trim()) {
        await ak("PATCH", `/crypto/certificatekeypairs/${kp.pk}/`, { certificate_data, key_data });
        log("authentik: issuer certificate replaced");
      }
    }
    const brands = (await ak("GET", "/core/brands/?page_size=100")).results ?? [];
    const brand = brands.find((b) => b.domain === ISSUER_HOST);
    if (!brand) {
      const def = brands.find((b) => b.default);
      await ak("POST", "/core/brands/", {
        domain: ISSUER_HOST,
        default: false,
        branding_title: "authentik (internal)",
        web_certificate: kp.pk,
        flow_authentication: def?.flow_authentication ?? null,
        flow_invalidation: def?.flow_invalidation ?? null,
      });
      log(`authentik: brand ${ISSUER_HOST} serves the issuer certificate`);
    } else if (brand.web_certificate !== kp.pk) {
      await ak("PATCH", `/core/brands/${brand.brand_uuid}/`, { web_certificate: kp.pk });
    }
  }

  async function ensureProvider(groups) {
    const flows = (await ak("GET", "/flows/instances/?page_size=200")).results ?? [];
    const flow = (s) => flows.find((f) => f.slug === s)?.pk;
    const mappings = (await ak("GET", "/propertymappings/provider/scope/?page_size=200")).results ?? [];
    const mapping = (m) => mappings.find((s) => s.managed === `goauthentik.io/providers/oauth2/scope-${m}`)?.pk;
    const signing = await akFind("/crypto/certificatekeypairs/?page_size=200", (k) => k.name === "authentik Self-signed Certificate");
    const want = {
      name: "openshell",
      client_type: "confidential",
      client_id: CLIENT_ID,
      // 2026.8: every grant must be listed, an empty list refuses all
      grant_types: ["client_credentials"],
      authorization_flow: flow("default-provider-authorization-implicit-consent"),
      invalidation_flow: flow("default-invalidation-flow"),
      signing_key: signing?.pk,
      property_mappings: [mapping("openid"), mapping("profile")],
      redirect_uris: [],
      sub_mode: "hashed_user_id",
      issuer_mode: "per_provider",
      access_token_validity: "minutes=10",
    };
    let provider = await akFind("/providers/oauth2/?page_size=200", (p) => p.name === "openshell");
    if (!provider) {
      provider = await ak("POST", "/providers/oauth2/", want);
      log("authentik: oauth2 provider openshell created");
    } else if (
      JSON.stringify(provider.grant_types) !== JSON.stringify(want.grant_types) ||
      provider.client_id !== want.client_id ||
      [...provider.property_mappings].sort().join() !== [...want.property_mappings].sort().join()
    ) {
      provider = await ak("PATCH", `/providers/oauth2/${provider.pk}/`, want);
      log("authentik: oauth2 provider openshell reconciled");
    }

    // the plain list only shows apps the caller may use; the access policy excludes us
    let app = await akFind("/core/applications/?superuser_full_list=true&page_size=200", (a) => a.slug === "openshell");
    if (!app) {
      app = await ak("POST", "/core/applications/", { name: "openshell", slug: "openshell", provider: provider.pk, policy_engine_mode: "any" });
      log("authentik: application openshell created");
    }
    // only OpenShell identities may get tokens (a human's app password can't)
    const expression = `return request.user.ak_groups.filter(name__in=["${groups.admin.name}", "${groups.user.name}"]).exists()`;
    let policy = await akFind("/policies/expression/?page_size=200", (p) => p.name === "openshell-access");
    if (!policy) policy = await ak("POST", "/policies/expression/", { name: "openshell-access", expression });
    else if (policy.expression !== expression) await ak("PATCH", `/policies/expression/${policy.pk}/`, { expression });
    const bindings = (await ak("GET", `/policies/bindings/?target=${app.pbm_uuid}`)).results ?? [];
    if (!bindings.some((b) => b.policy === policy.pk)) {
      await ak("POST", "/policies/bindings/", { policy: policy.pk, target: app.pbm_uuid, order: 0, enabled: true });
    }
  }

  async function connectPlatform(groups) {
    const user = await ensureServiceAccount(PLATFORM_ACCOUNT, groups.admin);
    const stored = existsSync(PLATFORM_CRED) ? JSON.parse(readFileSync(PLATFORM_CRED, "utf8")).secret : undefined;
    const { secret } = await credentialFor(user, stored);
    if (secret !== stored) {
      writeFileSync(PLATFORM_CRED, JSON.stringify({ username: PLATFORM_ACCOUNT, secret }) + "\n", { mode: 0o600 });
      chmodSync(PLATFORM_CRED, 0o600);
    }
    return SandboxClient.connect({
      gateway: GATEWAY,
      caCert: readFileSync(`${PKI}/ca.crt`),
      clientCert: readFileSync(`${PKI}/client/tls.crt`),
      clientKey: readFileSync(`${PKI}/client/tls.key`),
      oidcTokenProvider: clientCredentials({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: () => secret, scopes: ["openid", "profile"] }),
    });
  }

  async function ensurePlatform() {
    if (platform) return platform;
    await ensureIssuerCertificate();
    const groups = { admin: await ensureGroup("openshell-admin"), user: await ensureGroup("openshell-user") };
    await ensureProvider(groups);
    const client = await connectPlatform(groups);
    platform = { client, groups };
    log(`openshell: platform admin connected to ${GATEWAY}`);
    return platform;
  }

  // ---------- per tenant ----------

  async function ensureWorkspace(raw, workspace, name) {
    try {
      await raw.getWorkspace({ name: workspace });
    } catch (err) {
      if (codeOf(err) !== "not_found") throw err;
      await raw.createWorkspace({ name: workspace, labels: { "gwarestrin.tenant": name } });
      log(`openshell: workspace ${workspace} created`);
    }
  }

  async function ensureAdminMember(raw, workspace, subject) {
    const { members } = await raw.listWorkspaceMembers({ ...scope(workspace), pageSize: 200 });
    const existing = members.find((m) => m.principalSubject === subject);
    if (existing?.role === WORKSPACE_ROLE_ADMIN) return;
    if (existing) await raw.removeWorkspaceMember({ ...scope(workspace), principalSubject: subject, allowMissing: true });
    await raw.addWorkspaceMember({ ...scope(workspace), principalSubject: subject, role: WORKSPACE_ROLE_ADMIN });
    log(`openshell: ${workspace} admin membership granted`);
  }

  /**
   * Grant/steady state for a tenant on the OpenShell runtime. `current` is the
   * secret already in its instance metadata (kept while it still works).
   * Returns what goes into values.openshell, plus the subject for revocation.
   */
  async function ensureTenant(name, current) {
    const { client, groups } = await ensurePlatform();
    const user = await ensureServiceAccount(accountFor(name), groups.user);
    const { secret, subject } = await credentialFor(user, current);
    const workspace = workspaceFor(name);
    await ensureWorkspace(client.raw, workspace, name);
    await ensureAdminMember(client.raw, workspace, subject);
    return { workspace, clientSecret: secret, subject };
  }

  /** Revoke: no new tokens, no membership (tokens already issued expire within minutes) */
  async function lockTenant(name, subject) {
    const { client } = await ensurePlatform();
    const username = accountFor(name);
    const user = (await ak("GET", `/core/users/?username=${encodeURIComponent(username)}`)).results?.find((u) => u.username === username);
    if (user?.is_active) {
      await ak("PATCH", `/core/users/${user.pk}/`, { is_active: false });
      log(`authentik: service account ${username} deactivated (locked)`);
    }
    if (subject) {
      await client.raw.removeWorkspaceMember({ ...scope(workspaceFor(name)), principalSubject: subject, allowMissing: true });
    }
  }

  return { ensureTenant, lockTenant };
}
