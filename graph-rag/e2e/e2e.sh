#!/usr/bin/env bash
# The replay harness: a throwaway ArcadeDB, graph-rag built from this
# checkout, and fake models (fake-models.mjs) on a private Docker network;
# then the scenarios (run.mjs). Nothing touches a running stack, and nothing
# calls a real model. Needs only Docker.
#
#   graph-rag/e2e/e2e.sh            run every scenario
#   KEEP=1 graph-rag/e2e/e2e.sh     leave the containers up afterwards
set -euo pipefail
cd "$(dirname "$0")/.."
NET="gr-e2e-$$"
CFG="$(mktemp -d)"
ADB_IMAGE="${ADB_IMAGE:-arcadedata/arcadedb:latest}"
NODE="node:22-alpine"

cleanup() {
  if [ "${KEEP:-}" != "1" ]; then
    docker rm -f "$NET-gr" "$NET-adb" "$NET-models" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "$CFG"
  else
    echo "kept: containers $NET-{gr,adb,models} on network $NET"
  fi
}
trap cleanup EXIT

cat >"$CFG/positions.json" <<'EOF'
{ "root": "org", "positions": {
  "org": { "name": "org", "description": "The whole organization" },
  "ops": { "name": "Operations", "parent": "org", "description": "orders, suppliers, staffing" },
  "floor": { "name": "Production floor", "parent": "ops", "description": "work orders, machines, maintenance" } } }
EOF
cat >"$CFG/tokens.json" <<'EOF'
{ "tokens": [
  { "token": "e2e-admin", "user": "admin", "caps": { "read": true, "write": "direct", "approve": true, "raw": true }, "positions": ["org"], "delegationKey": "e2e-delegation-key-0123456789abcdef" },
  { "token": "e2e-alice", "user": "alice", "caps": { "read": true, "write": "direct" }, "positions": ["ops"] },
  { "token": "e2e-bob", "user": "bob", "caps": { "read": true, "write": "direct" }, "positions": ["floor"] } ] }
EOF
chmod -R a+rX "$CFG"

docker network create "$NET" >/dev/null
docker run -d --name "$NET-adb" --network "$NET" --network-alias arcadedb \
  -e ARCADEDB_OPTS_MEMORY="-Xms256m -Xmx512m" \
  -e ARCADEDB_SETTINGS="-Darcadedb.server.rootPassword=e2e-password -Darcadedb.server.defaultDatabases=gwarestrin[root]" \
  "$ADB_IMAGE" >/dev/null
docker run -d --name "$NET-models" --network "$NET" --network-alias models -v "$PWD/e2e:/e2e:ro" "$NODE" node /e2e/fake-models.mjs >/dev/null
echo "building graph-rag from this checkout"
docker build -q -t graph-rag:e2e . >/dev/null

echo "waiting for ArcadeDB"
docker run --rm --network "$NET" "$NODE" node -e '
  const end = Date.now() + 120000;
  (async () => {
    while (Date.now() < end) {
      try { if ((await fetch("http://arcadedb:2480/api/v1/ready")).status < 500) process.exit(0); } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    process.exit(1);
  })();'

docker run -d --name "$NET-gr" --network "$NET" --network-alias graph-rag -v "$CFG:/cfg:ro" \
  -e ARCADEDB_URL=http://arcadedb:2480 -e ARCADEDB_DB=gwarestrin -e ARCADEDB_USER=root -e ARCADEDB_PASSWORD=e2e-password \
  -e LITELLM_BASE_URL=http://models:4000/v1 -e LITELLM_API_KEY=e2e \
  -e EMBED_MODEL=embed -e GRADER_MODEL=grader -e WORKER_MODEL=ds-flash \
  -e DECISION_URL=http://models:4000/decisions -e DECISION_API_KEY=e2e \
  -e TOKEN_MAP_PATH=/cfg/tokens.json -e POSITION_MAP_PATH=/cfg/positions.json \
  -e SWEEP_INTERVAL_MS=5000 -e DOC_STORE=fs:/tmp/documents \
  graph-rag:e2e >/dev/null

status=0
docker run --rm --network "$NET" -v "$PWD/e2e:/e2e:ro" "$NODE" node /e2e/run.mjs || status=$?
if [ "$status" -ne 0 ]; then
  echo "--- graph-rag log (last 60 lines) ---"
  docker logs "$NET-gr" 2>&1 | grep -v LSMVector | tail -60
fi
exit "$status"
