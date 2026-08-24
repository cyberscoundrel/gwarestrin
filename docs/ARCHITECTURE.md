# gwarestrin ARCHITECTURE

## Processes

```
browser (Svelte 5 SPA, pi-web-ui Lit components)
   │  REST /api/*            WS /ws (per-tab, multiplexed over agents)
   ▼
gwarestrin server (Fastify, Node 22, single container)
   ├─ ProviderRegistry  providers.json → validate → discover → per-agent catalogue
   ├─ McpRegistryStore  mcp-registry.json (shared MCP server defs)
   ├─ AgentManager      spawn/stop/restart, cap GWARESTRIN_MAX_AGENTS (4)
   │     └─ pi --mode rpc (child per agent, LF-only JSONL stdio, id-correlated)
   │           ├─ -e provider-bridge   registerProvider() per generated catalogue entry
   │           ├─ -e gondolin-vm       read/write/edit/bash → QEMU microvm (if enabled)
   │           └─ -e pi-mcp-adapter    if agent.mcpServers non-empty (reads .mcp.json)
   ├─ WS bridge         whitelisted RPC passthrough (bash blocked), event fan-out,
   │                    extension_ui_request ↔ ui_response relay
   └─ files API         workspace CRUD, path-sandboxed (realpath, .pi/ denied,
                        .mcp.json read-only)
```

## Traffic separation

- **LLM**: pi child → provider endpoint directly. Keys enter the child only as
  env vars injected at spawn (from server env); never written to disk, never in
  the VM, never in API responses.
- **Tools**: inside the agent's gondolin microvm. `/workspace` is a RealFS
  mount of `agents/<id>/workspace` — the same directory the files API serves,
  so no sync step exists. Egress via gondolin HTTP hooks: per-agent
  `allowedHosts` + `secrets` (header injection by host, values invisible to
  the guest). VM boot failure ⇒ agent fails closed (no host fallback).
- **MCP**: `pi-mcp-adapter` inside the pi process (host-side), lazy-connects
  stdio/http servers from the generated `workspace/.mcp.json` subset.

## Per-agent on-disk layout (state volume)

```
agents/<id>/
  workspace/   pi cwd; VM /workspace mount; generated .mcp.json
  home/        PI_CODING_AGENT_DIR: settings.json (defaults, no ambient
               discovery), providers.gen.json (keyless catalogue),
               agent-config.json (gondolin policy, env-indirected secrets)
  sessions/    pi --session-dir (jsonl; resume via --session)
```

## Key contracts

- pi RPC: JSONL stdio, **LF-only** framing (readline splits U+2028/29 — custom
  reader). Events forwarded verbatim over WS; `extension_ui_request` answered
  by browser dialogs (select/confirm/input/editor + notify/status).
- pi-web-ui `AgentInterface` consumes a pi-agent-core `Agent`; the web adapter
  implements it over the WS bridge (snapshot from get_state/get_messages,
  delta assembly per contentIndex, authoritative message_end).
- gondolin on Node 22 only (≥24.17 broken, upstream #134); image pinned to
  node:22-bookworm-slim.
- pi-mcp-adapter: `.mcp.json` in cwd, `mcpServers` map; tools exposed to the
  model prefixed (`<server>_<tool>`) through the `mcp` proxy tool;
  hostConfigDiscovery defaults off. Loaded by directory path (`-e
  node_modules/pi-mcp-adapter`) so no npm fetch happens at runtime
  (PI_OFFLINE=1).

## Failure handling

- pi child crash → status `error`, auto-restart ≤ 3 with backoff, session
  resumed from `sessionFile`.
- Patch of spawn-affecting config (mcpServers/gondolin/providers/enabledModels)
  restarts a running agent; model/thinking changes apply live via RPC.
- Files API rejects `..`/absolute paths and symlink escapes (realpath check),
  denies `.pi/`, treats generated `.mcp.json` as read-only.
