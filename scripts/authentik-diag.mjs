/**
 * Authentik diagnostics (run on the deploy host):
 *   node scripts/authentik-diag.mjs
 *
 * - basic auth sanity (valid + invalid password)
 * - blueprint list + per-blueprint apply errors (metadata)
 * - users / groups / providers / applications inventory
 * - outpost auth endpoint status per subdomain
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const envText = readFileSync("/home/cyber/gwarestrin/.env", "utf8");
const ev = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const ip = execSync('docker inspect gwarestrin-authentik-server-1 --format "{{index .NetworkSettings.Networks \\"gwarestrin_backend\\" \\"IPAddress\\"}}"')
  .toString()
  .trim();
const base = `http://${ip}:9000`;
const basic = "Basic " + Buffer.from(`akadmin:${ev.AUTHENTIK_BOOTSTRAP_PASSWORD}`).toString("base64");

async function api(path, method = "GET", body) {
  const r = await fetch(`${base}/api/v3${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: basic, accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, j, text };
}

console.log("== basic auth sanity ==");
const sanity = await api("GET", "/core/groups/");
console.log("groups GET:", sanity.status, (sanity.j?.results ?? []).length, "groups");

console.log("== blueprints ==");
const bps = await api("GET", "/managed/blueprints/");
for (const b of bps.j?.results ?? []) {
  console.log(`- ${b.path}: ${b.status}`);
  if (b.status === "error") {
    console.log("  metadata:", JSON.stringify(b.metadata ?? {}).slice(0, 800));
    const raw = await api("GET", `/managed/blueprints/${b.uuid}/raw/`).catch((e) => ({ text: e.message }));
    void raw;
  }
}

console.log("== users ==");
const users = await api("GET", "/core/users/");
console.log((users.j?.results ?? []).map((u) => u.username).join(",") || "none");

console.log("== groups ==");
const groups = await api("GET", "/core/groups/");
console.log((groups.j?.results ?? []).map((g) => g.name).join(",") || "none");

console.log("== providers ==");
const providers = await api("GET", "/providers/proxy/");
console.log((providers.j?.results ?? []).map((p) => `${p.name} -> ${p.external_host}`).join(",") || "none");

console.log("== applications ==");
const apps = await api("GET", "/core/applications/");
console.log((apps.j?.results ?? []).map((a) => a.slug).join(",") || "none");

// outpost auth endpoints per subdomain (direct at authentik, bypassing traefik)
console.log("== outpost auth (unauthenticated) ==");
for (const host of ["admin.gw.home", "alice.gw.home", "bob.gw.home"]) {
  const r = await fetch(`http://${authIp}:9000/outpost.goauthentik.io/auth/simple`, {
    headers: { "X-Forwarded-Host": host, "X-Forwarded-Proto": "http" },
    signal: AbortSignal.timeout(8000),
  }).catch((e) => ({ status: 0, text: () => e.message }));
  console.log(`${host}: ${r.status}`);
}

if (ev.AUTHENTIK_BOOTSTRAP_TOKEN) {
  console.log("== outpost auth with bootstrap token ==");
  for (const host of ["admin.gw.home", "alice.gw.home", "bob.gw.home"]) {
    const r = await fetch(`http://${authIp}:9000/outpost.goauthentik.io/auth/simple`, {
      headers: { "X-Forwarded-Host": host, "X-Forwarded-Proto": "http", authorization: `Bearer ${ev.AUTHENTIK_BOOTSTRAP_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    }).catch((e) => ({ status: 0, text: () => e.message }));
    console.log(`${host}: ${r.status}`);
  }
}
