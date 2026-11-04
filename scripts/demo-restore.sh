#!/usr/bin/env bash
# Restore a demo snapshot into its own compose project, in a checkout of the demo tag:
#   git worktree add ~/gwarestrin-demo demo-2026-11 && cd ~/gwarestrin-demo
#   cp <your .env> .env; cp <your providers.json> providers.json; mkdir -p arcadedb-config; echo <pw> > arcadedb-config/root-pw
#   scripts/demo-restore.sh <snapshot.tgz> [project]
set -euo pipefail
SNAP=$1
P=${2:-gwdemo}
W=$(mktemp -d)
tar xzf "$SNAP" -C "$W"
tar xzf "$W/config/config.tgz" --exclude=arcadedb-config/root-pw
for f in .env providers.json arcadedb-config/root-pw; do [ -s "$f" ] || { echo "missing $f (the .env keys: config/env.redacted in the snapshot)"; rm -rf "$W"; exit 1; }; done
for t in "$W"/volumes/*.tgz; do
  v=$(basename "$t" .tgz)
  docker volume create "${P}_${v}" >/dev/null
  docker run --rm -v "${P}_${v}:/v" -v "$W/volumes:/in:ro" alpine sh -c "rm -rf /v/* /v/..?* /v/.[!.]* 2>/dev/null; tar xzf /in/$v.tgz -C /v"
done
rm -rf "$W"
echo "restored into project $P: docker compose -p $P -f docker-compose.yml -f docker-compose.demo.yml up -d --build"
