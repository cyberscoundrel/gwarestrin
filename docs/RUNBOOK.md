# gwarestrin RUNBOOK

Operator guide for deploying and running gwarestrin on a KVM-capable Linux
host (the reference host is an Ubuntu 24.04 ThinkCentre on a tailnet).

## 0. Prerequisites

- Docker with the compose plugin.
- KVM: `ls /dev/kvm` must exist. Add yourself for host-side testing:
  `sudo usermod -aG kvm $USER` (re-login).
- Node 22.x (only for host-side dev/e2e; the container brings its own).
  **Do not** use Node ≥ 24.17 — gondolin's QEMU HTTP bridge breaks
  (upstream earendil-works/gondolin#134). pi requires ≥ 22.19.
- Network: outbound HTTPS for model providers and the first gondolin
  guest-asset download (~200MB into the `gondolin-cache` volume).

## 1. From scratch

```bash
git clone <repo> ~/gwarestrin && cd ~/gwarestrin

cp .env.example .env
#   - put every provider key referenced by providers.json apiKeyEnv
#   - KVM_GID=$(getent group kvm | cut -d: -f3)

cp providers.example.json providers.json
#   - edit topology: baseUrls, apiKeyEnv names, static models, autoDiscover

docker compose build
docker compose up -d
docker compose logs -f gwarestrin     # wait for "listening on 0.0.0.0:3000"
curl -s localhost:3000/api/health
```

Open `http://<host>:3000`, create an agent, start it, send a prompt. First VM
boot per fresh `gondolin-cache` volume downloads guest assets — the first
`bash` tool call can take a minute; later boots are seconds.

## 2. Updating

```bash
cd ~/gwarestrin
git pull
# if package-lock.json fights you (npm rewrite on host): git checkout -- package-lock.json
docker compose build && docker compose up -d
```

State (`agents.json`, workspaces, sessions, `mcp-registry.json`) lives in the
`gwarestrin-state` volume and survives rebuilds. Running agents are stopped by
the recreate; restart them from the UI (sessions resume).

## 3. Day to day

- **Providers**: edit `providers.json` on the host (mounted ro) →
  `docker compose restart gwarestrin`. Keys come from `.env` only; they never
  appear in generated files or API responses.
- **MCP servers**: UI → agent → `mcp` panel → `+ add` (stdio command or http
  url + optional bearer env var). Bearer/env values are read from the pi child
  env, i.e. ultimately from `.env`. Checking a server for an agent rewrites its
  `.mcp.json` and restarts that agent.

## 3a. SQL MCP Server (Data API builder)

DAB runs as an **HTTP sidecar** (`dab` compose service, own image in `./dab/`)
serving streamable-HTTP MCP at `http://dab:5000/mcp` on a private backend
subnet — the base gwarestrin image carries no .NET. Setup on the deploy host:

```bash
mkdir -p ~/gwarestrin/dab-config
cp dab-config.example/dab-config.json dab-config/
cp dab-config.example/dab-config-mydb.json dab-config/dab-config-<dbname>.json
# one child file per database; edit connection strings (or generate from dbcreds.json)
chmod 600 dab-config/*.json   # contains credentials; bind-mounted ro
```

Register once (server registry): `PUT /api/mcp/mssql` with
`{"url":"http://dab:5000/mcp","headers":{"X-MS-API-ROLE":"anonymous"},"auth":false,"description":"Microsoft SQL MCP Server (DAB)"}`
— or `mcp` panel → `+ add` (http transport) with those values. Then tick
`mssql` per agent.

Tools are the DAB DML surface (`describe_entities`, `read_records`,
`create_record`, `update_record`, `delete_record`, `aggregate_records`,
`execute_entity`) scoped by `autoentities` patterns and role permissions in the
child configs. Restrict actions (e.g. drop `delete`) per child config. PK-less
tables/views are excluded — see `docs/dab-pkless-workaround.md` for the
designated-key read-only pattern (deferred).

Sidecar ops: `docker compose logs dab`, `docker compose restart dab` after
config edits; `dab validate --config /etc/dab/dab-config.json` inside the
container checks configs. If it exits silently, rerun with `--LogLevel Debug` —
default log level hides the real error.

## 3b. neo4j + neo4j MCP sidecar

neo4j itself runs from its own compose project in `~/neo4j-compose` (binds the
pre-existing `~/neo4j/data` store by absolute path; `NEO4J_AUTH=none`,
`NEO4J_PLUGINS=["apoc"]` — APOC core is required by the MCP schema tool).
Browser at `http://<host>:7474`, bolt at 7687.

The `neo4j-mcp` compose service (official `mcp/neo4j-cypher` image) serves
streamable-HTTP MCP at `http://neo4j-mcp:8000/mcp/` on the backend subnet —
no custom image, env-only config. Registered as:

`PUT /api/mcp/neo4j` with `{"url":"http://neo4j-mcp:8000/mcp/","auth":false,"description":"Official neo4j cypher MCP server"}`
(note the trailing slash, and `NEO4J_MCP_SERVER_ALLOWED_HOSTS` must include the
sidecar names/IPs or requests are rejected as DNS-rebinding).

Seed the homelab test graph (idempotent):

```bash
python3 - <<'EOF'
import json, urllib.request
c = open("neo4j/seed-homelab.cypher").read()
p = json.dumps({"statements": [{"statement": c}]}).encode()
r = urllib.request.Request("http://localhost:7474/db/neo4j/tx/commit", data=p,
                           headers={"content-type": "application/json"})
print(json.load(urllib.request.urlopen(r, timeout=30))["errors"])
EOF
```

Tools: `neo4j_get_neo4j_schema` (APOC), `neo4j_read_neo4j_cypher`,
`neo4j_write_neo4j_cypher` (write enabled by default; set
`NEO4J_READ_ONLY=true` on the sidecar to lock down).
- **Files**: `files` panel — upload/download/delete inside the agent workspace.
  `.pi/` is hidden and `.mcp.json` is read-only through the API (server-generated).
- **Concurrency**: max 4 running agents (`GWARESTRIN_MAX_AGENTS`). Each running
  agent = 1 pi child + 1 QEMU microvm (default 512MB).

## 4. Troubleshooting

| Symptom | Check |
|---|---|
| agent start fails, VM errors | `docker compose logs gwarestrin`; `/dev/kvm` present? `KVM_GID` matches `getent group kvm`? |
| first bash tool call hangs | guest assets still downloading; watch `du -sh` on the `gondolin-cache` volume |
| provider `degraded` in UI | autoDiscover probe failed (baseUrl reachable from the container? key valid?); static models still work |
| tools run on host, not VM | agent `gondolin.enabled=false` (dev mode); extension fails *closed* — a VM boot failure never falls back to host |
| MCP server not connecting | `mcp` panel status dot; command must exist inside the container (`npx`/`node` do); http servers must be reachable from the container (`host.docker.internal` works for host services) |
| DNS failures inside container | the compose file pins `dns: 1.1.1.1/1.0.0.1` and `build.network: host` because the host's DHCP-inherited isp resolvers refuse queries sourced from this network (wifi gateway ≠ isp). the docker bridge/WARP bypass service must also be up: `systemctl status docker-warp-bypass`; fallback: `network_mode: host` in compose (drop the ports mapping) |
| WARP nftables firewall kills host↔container TCP | Cloudflare WARP applies an nft table (`inet cloudflare-warp`) with input/output `policy drop`. ICMP passes (explicit accept) so pings lie; TCP handshakes die, docker-proxy replies never return. The `warp-nft-assert.timer` systemd unit re-asserts docker/LAN accepts every minute; check `nft list chain inet cloudflare-warp output` contains `172.16.0.0/12 accept`. Also note `/dev/tcp` tests through `sh` are false negatives — dash doesn't support it, use `bash -c` or a real client |
| sidecars can't reach other compose projects via host.docker.internal | published ports get DNAT'd to the target container, and cross-bridge FORWARD traffic is dropped by docker isolation. Fix: attach the backend network to the service's own compose project (see `neo4j-compose`'s `networks: backend: {name: gwarestrin_backend, external: true}`) and connect by container name (`bolt://neo4j:7687`). Host-networked containers (mssql-server) are reachable via `host.docker.internal` — different path, works |
| dab sidecar restart-loops | check `docker logs gwarestrin-dab-1`: "Unable to find the specified file" = cwd issue (compose sets `working_dir: /etc/dab`); SQL connect errors = mssql down (`docker ps` — mssql-server needs its `--restart unless-stopped` policy, now set) |
| container restarts loop | `docker compose logs --tail 200 gwarestrin` |

## 5. Host-side e2e (verification without the UI)

```bash
# mock provider on :8995 + server on :3100 with scratch state, then:
node packages/server/scripts/e2e-m3.mjs http://localhost:3100   # VM tool execution
node packages/server/scripts/e2e-m5.mjs http://localhost:3100   # MCP round-trip
```

## 6. Backup

`docker run --rm -v gwarestrin_gwarestrin-state:/data -v $PWD:/b alpine tar czf /b/gwarestrin-state.tgz -C /data .`
