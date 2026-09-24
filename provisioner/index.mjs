// gwarestrin tenant provisioner — authentik is the control plane.
//
// Polls the identity provider for users holding a gw role (tier group) and
// reconciles one gwarestrin instance per user:
//   grant   -> authentik tenant objects + graph token + instance metadata
//              + docker container + traefik route
//   revoke  -> lockout (container stopped, token denied, tenant-group
//              membership removed) while preserving state for re-grant
// The instances themselves stay identity-agnostic: they only ever see the
// instance-metadata contract (hot-reloaded files).
//
// Env:
//   AUTHENTIK_URL, AUTHENTIK_TOKEN   control-plane API
//   DOCKER_API                       write-scoped socket proxy
//   DOMAIN (gw.home)                 tenant subdomain base
//   TIER_GROUPS  "gw-admin:admin,gw-user:user"   role group -> tier
//   SEED_TENANTS "admin,alice,bob"   pre-existing tenants (no object creation)
//   KVM_GID, POLL_SECONDS            container tuning

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const AUTH_URL = (process.env.AUTHENTIK_URL ?? "http://authentik-server:9000").replace(/\/+$/, "");
const AUTH_TOKEN = process.env.AUTHENTIK_TOKEN ?? "";
const DOCKER = (process.env.DOCKER_API ?? "http://docker-proxy-write:2375").replace(/\/+$/, "");
const DOMAIN = process.env.DOMAIN ?? "gw.home";
const POLL = Number(process.env.POLL_SECONDS ?? 30);
const KVM_GID = process.env.KVM_GID ?? "993";
const SEED = new Set((process.env.SEED_TENANTS ?? "admin,alice,bob").split(",").map((s) => s.trim()).filter(Boolean));
const TIERS = Object.fromEntries(
  (process.env.TIER_GROUPS ?? "gw-admin:admin,gw-user:user")
    .split(",")
    .map((p) => p.split(":").map((s) => s.trim()))
    .filter((p) => p.length === 2),
);
const INSTANCES_DIR = "/data/instances";
// bind mounts in created containers resolve on the HOST, so the provisioner
// needs the host-side paths of the shared files
const HOST_BASE = (process.env.HOST_BASE ?? "/home/cyber/gwarestrin").replace(/\/+$/, "");
const GRAPH_CONFIG_DIR = "/data/graph-rag-config";
const TRAEFIK_DIR = "/data/traefik";

const log = (...a) => console.log(new Date().toISOString(), "[provisioner]", ...a);

async function ak(method, path, body) {
  const res = await fetch(`${AUTH_URL}/api/v3${path}`, {
    method,
    headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html error pages */ }
  if (!res.ok) throw new Error(`authentik ${method} ${path} -> ${res.status}: ${text.slice(0, 140)}`);
  return json;
}

async function docker(method, path, body) {
  const res = await fetch(`${DOCKER}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok && res.status !== 304 && res.status !== 404) {
    throw new Error(`docker ${method} ${path} -> ${res.status}: ${text.slice(0, 140)}`);
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, json };
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
// many authentik list endpoints silently ignore unknown query params — fetch
// the full list and match exactly client-side
async function akFind(path, match) {
  const res = await ak("GET", path);
  return (res.results ?? []).find(match);
}
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeIfChanged = (p, content) => {
  if (existsSync(p) && readFileSync(p, "utf8") === content) return false;
  writeFileSync(p, content);
  return true;
};
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------- desired tenants from tier-group membership ----------

async function desiredTenants() {
  const wanted = new Map(); // username -> tier
  for (const [group, tier] of Object.entries(TIERS)) {
    const res = await ak("GET", `/core/groups/?name=${encodeURIComponent(group)}`);
    for (const g of res.results ?? []) {
      const members = g.users_obj ?? [];
      for (const u of members) {
        const name = slug(u.username);
        if (!name) continue;
        // admin tier wins when a user holds both roles
        if (!wanted.has(name) || tier === "admin") wanted.set(name, tier);
      }
    }
  }
  return wanted;
}

// ---------- authentik tenant objects (non-seed tenants) ----------

async function ensureFlowPks() {
  const authz = await akFind("/flows/instances/", (f) => f.slug === "default-provider-authorization-implicit-consent");
  const inval = await akFind("/flows/instances/", (f) => f.slug === "default-invalidation-flow");
  return { authorization: authz?.pk, invalidation: inval?.pk };
}

async function ensureTenantObjects(name, tier, flows, userId) {
  // tenant group (owner-only membership drives the access policy)
  let group = (await ak("GET", `/core/groups/?name=gw-${name}`)).results?.find((g) => g.name === `gw-${name}`);
  if (!group) {
    group = await ak("POST", "/core/groups/", { name: `gw-${name}`, attributes: { gw_tenant: name, gw_tier: tier } });
    log(`authentik: group gw-${name} created`);
  }
  const memberIds = (group.users_obj ?? []).map((u) => u.pk);
  const wantedMembers = userId ? [userId] : [];
  if (JSON.stringify([...memberIds].sort()) !== JSON.stringify([...wantedMembers].sort())) {
    await ak("PATCH", `/core/groups/${group.pk}/`, { users: wantedMembers });
    log(`authentik: group gw-${name} membership -> [${wantedMembers.join(",")}]`);
  }

  // expression policy: tenant-group membership (superusers always pass)
  let policy = await akFind("/policies/expression/", (p) => p.name === `gw-${name}-access`);
  const expr = `return request.user.is_superuser or request.user.ak_groups.filter(name="gw-${name}").exists()`;
  if (!policy) {
    policy = await ak("POST", "/policies/expression/", { name: `gw-${name}-access`, expression: expr });
    log(`authentik: policy gw-${name}-access created`);
  }

  // proxy provider
  let provider = await akFind("/providers/proxy/", (p) => p.name === `gw-${name}-provider`);
  if (!provider) {
    provider = await ak("POST", "/providers/proxy/", {
      name: `gw-${name}-provider`,
      external_host: `http://${name}.${DOMAIN}`,
      internal_host: `http://gw-${name}:3000`,
      mode: "forward_single",
      authorization_flow: flows.authorization,
      invalidation_flow: flows.invalidation,
    });
    log(`authentik: provider gw-${name}-provider created`);
  }

  // application
  let app = await akFind("/core/applications/", (a) => a.slug === `gw-${name}`);
  if (!app) {
    app = await ak("POST", "/core/applications/", {
      name: `gw-${name}`,
      slug: `gw-${name}`,
      provider: provider.pk,
      policy_engine_mode: "any",
    });
    log(`authentik: application gw-${name} created`);
  }

  // policy binding (target = the application's binding-model uuid)
  const bindings = (await ak("GET", `/policies/bindings/?target=${app.pbm_uuid}`)).results ?? [];
  if (!bindings.some((b) => b.policy === policy.pk)) {
    await ak("POST", "/policies/bindings/", { policy: policy.pk, target: app.pbm_uuid, order: 0, enabled: true });
    log(`authentik: binding gw-${name}-access -> application created`);
  }

  // attach the provider to the embedded outpost
  const outposts = (await ak("GET", "/outposts/instances/")).results ?? [];
  const outpost = outposts[0];
  if (outpost && !outpost.providers.includes(provider.pk)) {
    await ak("PATCH", `/outposts/instances/${outpost.pk}/`, { providers: [...outpost.providers, provider.pk] });
    log(`authentik: provider gw-${name}-provider bound to outpost`);
  }

  return { groupPk: group.pk };
}

// ---------- tokens + metadata + routes ----------

function tierCaps(tier) {
  if (tier === "admin") return { read: true, write: "direct", approve: true };
  return { read: true, write: "queued" };
}

function ensureToken(name, tier) {
  const p = `${GRAPH_CONFIG_DIR}/token-map.json`;
  const map = readJson(p, { tokens: [] });
  let entry = map.tokens.find((t) => t.user === name);
  let changed = false;
  if (!entry) {
    entry = { token: randomToken(), user: name, caps: tierCaps(tier) };
    map.tokens.push(entry);
    changed = true;
    log(`token: created for ${name} (${tier})`);
  } else {
    const caps = tierCaps(tier);
    if (JSON.stringify(entry.caps) !== JSON.stringify(caps)) {
      entry.caps = caps;
      changed = true;
      log(`token: caps restored for ${name} (${tier})`);
    }
  }
  if (changed) writeIfChanged(p, JSON.stringify(map, null, 1));
  return entry.token;
}

function lockToken(name) {
  const p = `${GRAPH_CONFIG_DIR}/token-map.json`;
  const map = readJson(p, { tokens: [] });
  const entry = map.tokens.find((t) => t.user === name);
  if (!entry) return;
  const denied = { read: false, write: "deny" };
  if (JSON.stringify(entry.caps) !== JSON.stringify(denied)) {
    entry.caps = denied;
    writeIfChanged(p, JSON.stringify(map, null, 1));
    log(`token: denied for ${name} (locked)`);
  }
}

function ensureMetadata(name, tier, token) {
  const doc = {
    version: 1,
    instance: { name, displayName: `${name} instance` },
    owner: { id: name, displayName: name },
    values: { graph: { token } },
  };
  if (tier === "admin") {
    doc.presentation = { queue: { label: "Graph review", url: "http://graph-rag:8000/api/queue", tokenRef: "values.graph.token" } };
  }
  writeIfChanged(`${INSTANCES_DIR}/${name}.json`, JSON.stringify(doc, null, 1) + "\n");
}

// ---------- docker containers ----------

async function tenantContainers() {
  const { json } = await docker("GET", `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: ["gwarestrin.tenant"] }))}`);
  const map = new Map(); // tenant -> {id, state, compose}
  for (const c of json ?? []) {
    const tenant = c.Labels?.["gwarestrin.tenant"];
    if (tenant) map.set(tenant, { id: c.Id, state: c.State, names: c.Names?.[0] ?? "" });
  }
  return map;
}

function tenantContainerSpec(name, tier) {
  const env = [
    "GWARESTRIN_MAX_AGENTS=2",
    "GWARESTRIN_STATE=/var/lib/gwarestrin",
    "GWARESTRIN_PROVIDERS_FILE=/etc/gwarestrin/providers.json",
    "GWARESTRIN_INSTANCE_METADATA=/etc/gwarestrin/instance.json",
  ];
  // provider api keys from the host .env, same as compose env_file
  if (existsSync("/data/.env")) {
    for (const line of readFileSync("/data/.env", "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !env.some((e) => e.startsWith(`${m[1]}=`))) env.push(`${m[1]}=${m[2]}`);
    }
  }
  return {
    Image: "gwarestrin:local",
    Labels: { "gwarestrin.tenant": name },
    Env: env,
    HostConfig: {
      Mounts: [
        { Type: "volume", Source: `gw-${name}-state`, Target: "/var/lib/gwarestrin" },
        { Type: "volume", Source: `gw-${name}-gondolin`, Target: "/home/node/.cache/gondolin" },
        { Type: "bind", Source: `${HOST_BASE}/providers.json`, Target: "/etc/gwarestrin/providers.json", ReadOnly: true },
        { Type: "bind", Source: `${HOST_BASE}/instances/${name}.json`, Target: "/etc/gwarestrin/instance.json", ReadOnly: true },
      ],
      Devices: [{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rwm" }],
      GroupAdd: [KVM_GID],
      Dns: ["1.1.1.1", "1.0.0.1"],
      ExtraHosts: ["host.docker.internal:host-gateway"],
      RestartPolicy: { Name: "unless-stopped" },
    },
    NetworkingConfig: {
      EndpointsConfig: { [`${process.env.COMPOSE_PROJECT ?? "gwarestrin"}_backend`]: {} },
    },
  };
}

async function ensureContainer(name, tier, containers) {
  const existing = containers.get(name);
  if (existing) {
    if (existing.state !== "running") {
      await docker("POST", `/containers/${existing.id}/start`);
      log(`docker: container for ${name} started`);
    }
    return;
  }
  if (existsSync("/data/providers.json") === false) throw new Error("providers.json missing — cannot provision container");
  const spec = tenantContainerSpec(name, tier);
  const created = await docker("POST", `/containers/create?name=gw-${name}`, spec);
  const id = created.json?.Id;
  if (!id) throw new Error(`container create for ${name} failed: ${JSON.stringify(created.json).slice(0, 140)}`);
  // attach to the default (outbound) network too
  const nets = await docker("GET", "/networks?filters=" + encodeURIComponent(JSON.stringify({ name: [`${process.env.COMPOSE_PROJECT ?? "gwarestrin"}_default`] })));
  const netId = nets.json?.[0]?.Id;
  if (netId) await docker("POST", `/networks/${netId}/connect`, { Container: id });
  await docker("POST", `/containers/${id}/start`);
  log(`docker: tenant container gw-${name} created + started (${tier})`);
}

async function lockContainer(name, containers) {
  const existing = containers.get(name);
  if (existing && existing.state === "running") {
    await docker("POST", `/containers/${existing.id}/stop`);
    log(`docker: container for ${name} stopped (locked)`);
  }
}

// ---------- traefik tenant routes ----------

function ensureRoutes(known, containers) {
  const routers = [];
  const services = [];
  for (const name of [...known].sort()) {
    const backend = containers.get(name)?.names
      ? containers.get(name).names.replace(/^\//, "")
      : `gw-${name}`;
    const host = `${name}.${DOMAIN}`;
    routers.push(
      "    gw-" + name + ":\n" +
      "      rule: \"Host(`" + host + "`)\"\n" +
      "      service: gw-" + name + "\n" +
      "      middlewares: [gw-forward-auth]",
    );
    services.push(
      "    gw-" + name + ":\n" +
      "      loadBalancer:\n" +
      "        servers: [{url: \"http://" + backend + ":3000\"}]",
    );
  }
  const content = `# Tenant routers — MANAGED by the provisioner. Edits are overwritten.\nhttp:\n  routers:\n${routers.join("\n")}\n  services:\n${services.join("\n")}\n`;
  writeIfChanged(`${TRAEFIK_DIR}/tenants.yml`, content);
}

// ---------- reconcile loop ----------

async function reconcile() {
  const desired = await desiredTenants();
  const containers = await tenantContainers();

  // union of tenants we know about (desired + previously provisioned)
  const state = readJson(`${INSTANCES_DIR}/.provisioner-state.json`, { tenants: {} });
  const known = new Set([...desired.keys(), ...Object.keys(state.tenants), ...SEED]);

  // seed tenants that were never recorded
  for (const name of known) {
    if (!state.tenants[name] && (desired.has(name) || SEED.has(name))) {
      state.tenants[name] = { tier: desired.get(name) ?? "user", status: "active" };
    }
  }

  const flows = await ensureFlowPks();

  for (const name of known) {
    const tier = desired.get(name);
    const rec = state.tenants[name];
    try {
      if (tier) {
        // grant (or re-grant / steady state)
        if (!SEED.has(name)) {
          const user = (await ak("GET", `/core/users/?username=${encodeURIComponent(name)}`)).results?.find((u) => u.username === name);
          await ensureTenantObjects(name, tier, flows, user?.pk);
        }
        const token = ensureToken(name, tier);
        ensureMetadata(name, tier, token);
        await ensureContainer(name, tier, containers);
        if (rec.status === "locked") log(`tenant ${name}: unlocked (${tier})`);
        rec.tier = tier;
        rec.status = "active";
      } else {
        // revoke: preserve everything, deny access
        await lockContainer(name, containers);
        lockToken(name);
        if (!SEED.has(name)) {
          // drop tenant-group membership (access policy then denies)
          const group = (await ak("GET", `/core/groups/?name=gw-${name}`)).results?.find((g) => g.name === `gw-${name}`);
          if (group && (group.users_obj ?? []).length > 0) {
            await ak("PATCH", `/core/groups/${group.pk}/`, { users: [] });
            log(`authentik: tenant group gw-${name} emptied (locked)`);
          }
        }
        if (rec.status !== "locked") log(`tenant ${name}: locked (role lost, state preserved)`);
        rec.status = "locked";
      }
    } catch (err) {
      log(`tenant ${name}: reconcile error: ${err.message}`);
    }
  }

  ensureRoutes(known, containers);
  writeIfChanged(`${INSTANCES_DIR}/.provisioner-state.json`, JSON.stringify(state, null, 1));
}

log(`provisioner up — tiers ${JSON.stringify(TIERS)}, seed [${[...SEED].join(",")}]`);
const tick = async () => {
  try {
    await reconcile();
  } catch (err) {
    log(`reconcile failed: ${err.message}`);
  }
};
await tick();
setInterval(tick, POLL * 1000);
