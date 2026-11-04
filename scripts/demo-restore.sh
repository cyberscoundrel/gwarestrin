#!/usr/bin/env bash
# Restore a demo snapshot into its own compose project, in a checkout of the demo tag:
#   git worktree add ~/gwarestrin-demo demo-2026-11 && cd ~/gwarestrin-demo
#   cp <your .env> .env; cp <your providers.json> providers.json; echo <pw> > arcadedb-config/root-pw
#   scripts/demo-restore.sh <snapshot.tgz> [project]
set -euo pipefail
SNAP=$1
P=${2:-gwdemo}
W=$(mktemp -d)
tar xzf "$SNAP" -C "$W"
for f in .env providers.json arcadedb-config/root-pw; do [ -s "$f" ] || { echo "missing $f (see $W/config/env.redacted for the keys)"; exit 1; }; done
tar xzf "$W/config/config.tgz" --exclude=arcadedb-config/root-pw
for t in "$W"/volumes/*.tgz; do
  v=$(basename "$t" .tgz)
  docker volume create "${P}_${v}" >/dev/null
  docker run --rm -v "${P}_${v}:/v" -v "$W/volumes:/in:ro" alpine sh -c "rm -rf /v/* /v/..?* /v/.[!.]* 2>/dev/null; tar xzf /in/$v.tgz -C /v"
done
rm -rf "$W"
echo "restored into project $P: docker compose -p $P -f docker-compose.yml -f docker-compose.demo.yml up -d --build"
