# pi-extensions

Extensions loaded by each pi agent process (via `--extension` flags added by
the server's agent scaffold):

- `provider-bridge/` — registers providers from the generated
  `providers.gen.json` (multi-provider support; M1)
- `gondolin-vm/` — routes read/write/edit/bash into the agent's gondolin
  microvm with per-agent egress policy + secrets (M3)
- `agent-runtime/` — status glue: VM/MCP snapshots surfaced to the server (M3+)

Each will be a jiti-loadable TS extension with its own package.json (the
gondolin one depends on the packed fork tarball).
