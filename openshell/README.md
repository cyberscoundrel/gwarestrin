# OpenShell runtime

Agents run as [OpenShell](https://github.com/NVIDIA/OpenShell) microVM
sandboxes; the gwarestrin server talks to them through the OpenShell gateway
(`GWARESTRIN_RUNTIME=openshell`). This directory deploys that gateway as its own
compose project on the main stack's `gwarestrin_backend` network.

```
tenant server ──TLS client cert + OIDC token──▶ openshell-gateway (container, /dev/kvm)
   │ token: client_credentials                   ├─ workspace gw-<tenant> per tenant
   ▼                                             ├─ VM driver ── libkrun microVM per agent (pi + extensions)
authentik (:9443, deployment-CA cert)            └─ host supervisor: policy (L4+L7), credential swap, OCSF audit
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

## Tenancy

The gateway isolates tenants by **workspace** and authorizes every call from an
**OIDC access token** issued by authentik; the shared client certificate only
gets a caller onto the wire (mTLS user auth is off: with it on, any certificate
holder is a Platform Admin).

| Identity | authentik | Gateway role | Can |
|---|---|---|---|
| provisioner | `gw-provisioner-osh` in `openshell-admin` | Platform Admin | create workspaces, assign their admins |
| tenant server | `gw-<tenant>-osh` in `openshell-user` | Workspace Admin of `gw-<tenant>` only | providers, profiles, policy, sandboxes, exec — in its own workspace |

Tokens come from `client_credentials` grants on the `openshell` OAuth2 provider
(`client_id` = gateway audience `openshell-gateway`; `client_secret` =
base64(`account:app password`); `groups` claim = roles). The provisioner
creates and reconciles all of it, writes each tenant's secret + workspace into
its instance metadata (`values.openshell`, never substituted into agent
config) and revokes by deactivating the account and removing the membership.
authentik serves the issuer on its internal HTTPS listener with the
deployment-CA certificate (`pki/authentik`, brand `authentik-server`), which
the gateway and servers trust through the deployment CA.

Verified 2026-10-06 from bob's container with bob's identity: own workspace
allowed; alice's sandboxes/providers/members, the `default` workspace,
all-workspace lists and workspace creation denied (`permission_denied`, or
`not_found` for alice's sandbox by name); certificate without a token
`unauthenticated`.

## Set up

On the docker host, from the repo root (needs `/dev/kvm`, the main stack's
`gwarestrin_backend` network, and Docker's containerd image store):

```sh
docker compose -f openshell/compose.yml build openshell-gateway
openshell/scripts/pki.sh                      # deployment CA + gateway/client/registry certs -> openshell/pki/
docker compose -f openshell/compose.yml up -d openshell-gateway openshell-registry
openshell/scripts/publish-agent.sh dev        # -> registry:5443/gwarestrin-agent:dev
docker compose up -d provisioner              # identities + workspaces for OPENSHELL_TENANTS
docker compose up -d gw-alice gw-bob          # tenants on this runtime (x-openshell-tenant-env)
```

`openshell/pki/` holds private keys and is gitignored. Only `ca.crt`,
`server/`, `client/` and `jwt/` are mounted into the gateway; tenant servers
get `ca.crt` and `client/`; the registry gets `registry/`; the provisioner gets
`ca.crt`, `client/` and `authentik/` (which it loads into authentik). The CA
private key stays on the host. `pki.sh` keeps an existing CA and only issues
missing leaf certificates.

## Server settings (runtime=openshell)

| Variable | Value here |
|---|---|
| `GWARESTRIN_RUNTIME` | `openshell` |
| `GWARESTRIN_OPENSHELL_GATEWAY` | `https://openshell-gateway:17670` |
| `GWARESTRIN_OPENSHELL_PKI` | dir with `ca.crt`, `client/tls.crt`, `client/tls.key` |
| `GWARESTRIN_OPENSHELL_IMAGE` | `registry:5443/gwarestrin-agent:<tag>` |
| `GWARESTRIN_OPENSHELL_RESOLVE` | `names` (gateway on the compose network) |
| `GWARESTRIN_OPENSHELL_OIDC_ISSUER` | `https://authentik-server:9443/application/o/openshell/` |
| `GWARESTRIN_OPENSHELL_OIDC_CLIENT_ID` | default `openshell-gateway` |
| `NODE_EXTRA_CA_CERTS` | the deployment `ca.crt` (to trust the issuer) |
| workspace + client secret | instance metadata `values.openshell` (env fallbacks `GWARESTRIN_OPENSHELL_WORKSPACE`, `GWARESTRIN_OPENSHELL_OIDC_SECRET`) |

## Notes

- Images must come from a registry: the VM driver only exports *local* images
  through the Docker API (it creates a container to do so), and registries must
  be HTTPS; the gateway trusts the deployment CA via `SSL_CERT_FILE`
  (`gateway/entrypoint.sh`).
- `mem_mib` in `gateway/gateway.toml` is a per-VM ceiling, not a reservation.
- Ops access (sandbox lists, OCSF logs) needs an authentik token too; use
  the provisioner's Platform Admin identity, see the RUNBOOK.
