# OpenShell runtime

Agents run as [OpenShell](https://github.com/NVIDIA/OpenShell) microVM
sandboxes; the gwarestrin server talks to them through the OpenShell gateway
(`GWARESTRIN_RUNTIME=openshell`). This directory deploys that gateway as its own
compose project on the main stack's `gwarestrin_backend` network.

```
gwarestrin server ──mTLS──▶ openshell-gateway (container, /dev/kvm)
                              ├─ VM driver ── libkrun microVM per agent (pi + extensions)
                              └─ host supervisor: policy (L4+L7), credential swap, OCSF audit
                                     │ egress leaves from this container's network
                                     ▼
                     backend network: graph-rag, dab, litellm… (by service name)
openshell-registry (HTTPS, deployment CA) ◀── agent image, single-platform OCI manifest
```

Why the gateway lives in compose: with the VM driver the per-sandbox supervisor
runs inside the gateway container, so sandbox traffic resolves compose service
names through Docker DNS (no stale IPs) and can only reach the networks this
container joins. (OpenShell's Docker driver always runs the supervisor with host
networking, which is why the server rewrites names to IPs in that mode:
`GWARESTRIN_OPENSHELL_RESOLVE=ips`.)

## Set up

On the docker host, from the repo root (needs `/dev/kvm`, the main stack's
`gwarestrin_backend` network, and Docker's containerd image store):

```sh
docker compose -f openshell/compose.yml build openshell-gateway
openshell/scripts/pki.sh                      # deployment CA + gateway/client/registry certs -> openshell/pki/
docker compose -f openshell/compose.yml up -d openshell-gateway openshell-registry
openshell/scripts/publish-agent.sh dev        # -> registry:5443/gwarestrin-agent:dev
docker build --network host -t gwarestrin:openshell-dev .
docker volume create gw-osh-state             # first time only
docker compose -f openshell/compose.yml --profile trial up -d gw-osh   # trial instance on :3200
```

`openshell/pki/` holds private keys and is gitignored. Only `ca.crt`,
`server/`, `client/` and `jwt/` are mounted into the gateway; clients (the
gwarestrin server) get `ca.crt` and `client/`; the registry gets `registry/`.
The CA private key stays on the host.

## Server settings (runtime=openshell)

| Variable | Value here |
|---|---|
| `GWARESTRIN_RUNTIME` | `openshell` |
| `GWARESTRIN_OPENSHELL_GATEWAY` | `https://openshell-gateway:17670` |
| `GWARESTRIN_OPENSHELL_PKI` | dir with `ca.crt`, `client/tls.crt`, `client/tls.key` |
| `GWARESTRIN_OPENSHELL_IMAGE` | `registry:5443/gwarestrin-agent:<tag>` |
| `GWARESTRIN_OPENSHELL_RESOLVE` | `names` (gateway on the compose network) |
| `GWARESTRIN_OPENSHELL_WORKSPACE` | OpenShell workspace, default `default` |

## Notes

- Images must come from a registry: the VM driver only exports *local* images
  through the Docker API (it creates a container to do so), and registries must
  be HTTPS; the gateway trusts the deployment CA via `SSL_CERT_FILE`
  (`gateway/entrypoint.sh`).
- `mem_mib` in `gateway/gateway.toml` is a per-VM ceiling, not a reservation.
- Inspect a sandbox from inside the network:
  `docker compose -f openshell/compose.yml exec openshell-gateway openshell --gateway-endpoint https://127.0.0.1:17670 sandbox list`
  (the CLI needs the client bundle under `~/.config/openshell/gateways/`; see the RUNBOOK).
