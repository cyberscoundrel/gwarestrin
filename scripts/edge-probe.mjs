/**
 * Edge + authentik diagnostics (run on the deploy host):
 *   node scripts/edge-probe.mjs
 *
 * Checks: traefik routing per subdomain (with Host header via localhost),
 * forwardAuth redirect behavior, outpost auth endpoint, authentik blueprint
 * statuses, users/groups/providers via API (bootstrap token).
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const EDGE = process.env.EDGE ?? "http://localhost:8880";
const envText = readFileSync("/home/cyber/gwarestrin/.env", "utf8");
const ev = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const ipOf = (name) =>
  execSync(`docker inspect ${name} --format "{{index .NetworkSettings.Networks \\"gwarestrin_backend\\" \\"IPAddress\\"}}"`)
    .toString()
    .trim();

const authIp = ipOf("gwarestrin-authentik-server-1");
console.log("[edge] traefik on :8880 | authentik IP:", authIp);

// 1) outpost auth endpoint per subdomain (on the authentik server directly)
for (const host of ["admin.gw.home", "alice.gw.home", "bob.gw.home"]) {
  const r = await fetch(`http://${authIp}:9000/outpost.goauthentik.io/auth/simple`, {
    headers: { "X-Forwarded-Host": host, "X-Forwarded-Proto": "http" },
    signal: AbortSignal.timeout(8000),
  }).catch((e) => ({ status: 0, text: () => e.message }));
  const body = r.text ? (await r.text()).slice(0, 80) : "";
  console.log(`[outpost] ${host}: ${r.status} ${body}`);
}

// 2) traefik routing per subdomain (unauthenticated — expect 302 to login)
for (const host of ["admin.gw.home", "alice.gw.home", "bob.gw.home"]) {
  const r = await fetch(`http://localhost:8880/`, {
    headers: { host },
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  }).catch((e) => ({ status: 0 }));
  console.log(`[traefik] ${host}: ${r.status} -> ${r.headers.get("location") ?? "-"}`);
}

// 3) authentik API via bootstrap token (through the authentik container IP)
const api = async (path) => {
  const r = await fetch(`http://${authIp}:9000/api/v3${path}`, {
    headers: { authorization: `Bearer ${ev.AUTHENTIK_BOOTSTRAP_TOKEN}`, accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  return { status: r.status, j: await r.json().catch(() => null) };
};

const bp = await api("/managed/blueprints/");
for (const b of bp.j?.results ?? []) {
  if (b.path?.includes("gw")) {
    console.log(`[blueprint] ${b.path}: ${b.status}`);
    const detail = await api(`/managed/blueprints/${b.uuid}/`);
    console.log("[blueprint meta]", JSON.stringify(detail.j?.metadata ?? {}).slice(0, 500));
  }
}

const users = await api("/core/users/");
console.log("[users]", (users.j?.results ?? []).map((u) => u.username).join(",") || "none");
const groups = await api("/core/groups/");
console.log("[groups]", (groups.j?.results ?? []).map((g) => g.name).join(",") || "none");
const providers = await api("/providers/proxy/");
console.log("[providers]", (providers.j?.results ?? []).map((p) => `${p.name}(${p.external_host})`).join(",") || "none");
const apps = await api("/core/applications/");
console.log("[apps]", (apps.j?.results ?? []).map((a) => a.slug).join(",") || "none");
