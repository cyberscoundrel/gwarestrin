/**
 * Provision gwarestrin identities directly via the authentik API.
 *   node scripts/authentik-provision.mjs [authentik-ip]
 *
 * Per-entry serializer errors are printed verbatim — this doubles as the
 * blueprint-content diagnostic.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ip = process.argv[2] ?? execSync(
  'docker inspect gwarestrin-authentik-server-1 --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"',
).toString().trim();

const envText = readFileSync("/home/cyber/gwarestrin/.env", "utf8");
const ev = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=")).map((l) => l.split("=", 1) && [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const BASE = `http://${ip}:9000/api/v3`;
const auth = "Basic " + Buffer.from(`akadmin:${ev.AUTHENTIK_BOOTSTRAP_PASSWORD}`).toString("base64");

async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: auth, accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, j, text: text.slice(0, 300) };
}

const summary = [];
let fails = 0;

async function ensure(method, path, body, label) {
  const r = await api(method, path, body);
  if (r.status >= 400) {
    fails++;
    summary.push(`FAIL ${label}: ${r.status} ${r.text}`);
    return null;
  }
  summary.push(`OK   ${label}`);
  return r.j;
}

// ---- groups ----
await ensure("POST", "/core/groups/", { name: "gw-admin" }, "group gw-admin");
await ensure("POST", "/core/groups/", { name: "gw-user" }, "group gw-user");

// group PKs
const groupsRes = await api("GET", "/core/groups/");
const groupPk = {};
for (const g of groupsRes.j?.results ?? []) groupPk[g.name] = g.pk;

// ---- users ----
const users = [
  { username: "admin", name: "admin", email: "admin@gw.home", groups: [groupPk["gw-admin"]], password: "admin-pass-1" },
  { username: "alice", name: "Alice", email: "alice@gw.home", groups: [groupPk["gw-user"]], password: "alice-pass-1" },
  { username: "bob", name: "Bob", email: "bob@gw.home", groups: [groupPk["gw-user"]], password: "bob-pass-1" },
];
for (const u of users) {
  const existing = (await api("GET", `/core/users/?username=${u.username}`)).j?.results?.[0];
  if (existing) {
    await ensure("PATCH", `/core/users/${existing.pk}/`, { name: u.name, groups: u.groups, password: u.password }, `user ${u.username}`);
  } else {
    await ensure("POST", "/core/users/", u, `user ${u.username}`);
  }
}

// ---- proxy providers ----
const providers = [
  { name: "gw-admin-provider", external_host: "http://admin.gw.home", internal_host: "http://gwarestrin:3000" },
  { name: "gw-alice-provider", external_host: "http://alice.gw.home", internal_host: "http://gw-alice:3000" },
  { name: "gw-bob-provider", external_host: "http://bob.gw.home", internal_host: "http://gw-bob:3000" },
];
for (const p of providers) {
  const body = {
    name: p.name,
    external_host: p.external_host,
    internal_host: p.internal_host,
    mode: "forward_single",
    authorization_flow: "default-provider-authorization-implicit-consent",
    access_policy_expression: p.name === "gw-admin-provider"
      ? '"gw-admin" in request.user.group_attributes("name") or request.user.is_superuser'
      : '"gw-user" in request.user.group_attributes("name") or "gw-admin" in request.user.group_attributes("name") or request.user.is_superuser',
  };
  const existing = (await api("GET", `/providers/proxy/?name=${p.name}`)).j?.results?.[0];
  if (existing) {
    const r = await ensure("PATCH", `/providers/proxy/${existing.pk}/`, body, `provider ${p.name}`);
    void r;
  } else {
    const r = await ensure("POST", "/providers/proxy/", body, `provider ${p.name}`);
    void r;
  }
}

// ---- applications ----
const apps = [
  { name: "gw-admin", slug: "gw-admin", providerName: "gw-admin-provider", group: "gw-admin" },
  { name: "gw-alice", slug: "gw-alice", providerName: "gw-alice-provider", group: "gw-user" },
  { name: "gw-bob", slug: "gw-bob", providerName: "gw-bob-provider", group: "gw-user" },
];
for (const a of apps) {
  const providerList = (await api("GET", `/providers/proxy/?name=${a.providerName}`)).j?.results ?? [];
  const providerPk = providerList[0]?.pk;
  const appRes = await api("GET", `/core/applications/?slug=${a.slug}`);
  const existing = appRes.j?.results?.[0];
  let appPk;
  if (existing) {
    appPk = existing.pk;
    await ensure("PATCH", `/core/applications/${appPk}/`, { name: a.name, provider: providerPk }, `app ${a.name}`);
  } else {
    const created = await ensure("POST", "/core/applications/", { name: a.name, slug: a.slug, provider: providerPk }, `app ${a.name}`);
    appPk = created?.pk;
  }
  if (!appPk) { fails++; summary.push(`FAIL app ${a.name}: no pk`); continue; }
  const bind = await ensure("POST", "/policies/bindings/", { target: appPk, group: groupPk[a.group], order: 0 }, `binding ${a.name} -> ${a.group}`);
  void bind;
}

console.log(summary.join("\n"));
console.log(fails === 0 ? "ALL OK" : `${fails} failures`);
