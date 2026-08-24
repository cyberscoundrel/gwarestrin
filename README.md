# gwarestrin

Multi-agent web console: persistent [pi](https://github.com/earendil-works/pi)
coding agents whose tools execute inside [gondolin](https://github.com/cyberscoundrel/gondolin)
QEMU/KVM microvms, with per-agent model providers, MCP server subsets, and
workspace file transfer.

Status: M0 scaffold. See `docs/` as milestones land.

## Develop

```bash
npm install
npm run dev:server   # fastify on :3000
npm run dev:web      # vite on :5173 (proxies /api + /ws)
npm run typecheck
npm test
```

## Deploy

```bash
cp .env.example .env           # populate provider keys
cp providers.example.json providers.json   # edit topology
docker compose up -d --build
```

Requires `/dev/kvm` on the host.
