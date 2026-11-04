#!/usr/bin/env bash
# Snapshot the running instance's state for the demo: run on the host from the checkout.
#   scripts/demo-snapshot.sh [project] [out.tgz]
# Stops the stateful services for the copy (a minute or two), then starts them again.
set -euo pipefail
P=${1:-gwarestrin}
OUT=${2:-$HOME/demo-snapshot-$(date +%Y%m%d).tgz}
VOLS=(arcadedb-data graph-rag-documents gwarestrin-state gwarestrin-state-alice gwarestrin-state-bob authentik-pg)
W=$(mktemp -d)
docker compose -p "$P" stop graph-rag arcadedb gwarestrin gw-alice gw-bob authentik-server authentik-worker authentik-postgres
trap 'docker compose -p "$P" start authentik-postgres authentik-server authentik-worker arcadedb graph-rag gwarestrin gw-alice gw-bob' EXIT
mkdir -p "$W/volumes" "$W/config"
for v in "${VOLS[@]}"; do
  docker run --rm -v "${P}_${v}:/v:ro" -v "$W/volumes:/out" alpine tar czf "/out/$v.tgz" -C /v .
done
# config the stack reads (secrets stay out: root-pw, the root-only instances/.* files, .env values, provider keys)
tar czf "$W/config/config.tgz" --exclude=arcadedb-config/root-pw --exclude="instances/.*" graph-rag-config dab-config litellm-config arcadedb-config instances authentik/blueprints traefik/dynamic
sed -E 's/^([A-Z0-9_]+)=.*/\1=<set me>/' .env > "$W/config/env.redacted"
[ -f providers.json ] && sed -E 's/("(apiKey|key|token)"\s*:\s*)"[^"]*"/\1"<set me>"/g' providers.json > "$W/config/providers.redacted.json"
git rev-parse HEAD > "$W/COMMIT"
tar czf "$OUT" -C "$W" .
rm -rf "$W"
echo "snapshot: $OUT ($(du -h "$OUT" | cut -f1))"
