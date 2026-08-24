# gwarestrin

Multi-agent web console: persistent [pi](https://github.com/earendil-works/pi)
coding agents whose tools execute inside [gondolin](https://github.com/earendil-works/gondolin)
QEMU/KVM microvms, with per-agent model providers, per-agent MCP server subsets,
live session management, and workspace file transfer.

Single container: Fastify server (Node 22) + Svelte 5 SPA. One pi RPC child
process per agent; each agent gets its own gondolin microvm (workspace mounted
at `/workspace`, per-agent egress allowlist + secret injection), its own model
provider from a multi-provider registry (`providers.json`), and its own subset
of MCP servers from a shared registry (via `pi-mcp-adapter`).

## Develop

Requires Node ≥ 22.19 (Node ≥ 24.17 is **not** supported by gondolin's QEMU
bridge — upstream earendil-works/gondolin#134).

```bash
npm install
npm ci --prefix packages/pi-extensions/gondolin-vm   # gondolin dep (outside workspaces)
npm run dev:server   # fastify on :3000
npm run dev:web      # vite on :5173 (proxies /api + /ws)
npm run typecheck
npm test
```

Useful env in dev: `GWARESTRIN_STATE` (state dir), `GWARESTRIN_PROVIDERS_FILE`,
`PORT`, `GWARESTRIN_MAX_AGENTS` (default 4), `GWARESTRIN_MCP_ADAPTER_PATH`
(override pi-mcp-adapter location).

### End-to-end scripts (server package)

```bash
node scripts/e2e-m2.mjs   # REST+WS+streaming against a mock provider
node scripts/e2e-m3.mjs   # bash tool executes inside the gondolin VM (needs qemu/kvm)
node scripts/e2e-m5.mjs   # MCP registry -> per-agent subset -> mcp tool call
```

## Deploy

See [docs/RUNBOOK.md](docs/RUNBOOK.md). Short version, on a KVM-capable host:

```bash
cp .env.example .env                       # provider keys + KVM_GID
cp providers.example.json providers.json   # provider topology
docker compose up -d --build
```

Console on `http://<host>:3000`. Auth: none (LAN-trust) — bind to a trusted
interface or front it with a proxy if the network is not trusted.

## Layout

```
packages/
  shared/         wire contracts: WS envelope, REST DTOs, provider + MCP schemas
  server/         Fastify: provider registry, agent manager (pi RPC children),
                  WS bridge, files API (sandboxed), MCP registry
  web/            Svelte 5 + pi-web-ui: chat, model bar, sessions, files, MCP
  pi-extensions/  provider-bridge (registerProvider from generated catalogue),
                  gondolin-vm (tools -> microvm, egress policy, secrets)
docs/             ARCHITECTURE.md, RUNBOOK.md
```

Host state (container volume `/var/lib/gwarestrin`):

```
agents.json  mcp-registry.json
agents/<id>/{workspace,home,sessions}   # workspace <-> VM /workspace
```
