#!/usr/bin/env bash
# One filing run of the real-model evaluation (docs/build/integrate.md), against the synthetic test database only.
#
#   graph-rag/eval/run.sh --models fake [--out DIR] [--seed N]                       the dry run: fake models
#   graph-rag/eval/run.sh --models real --env-file ~/gwsynth-models.env --setup A [--run 1] [--out DIR] [--seed N]
#
# What it starts, all its own, all removed afterwards (KEEP=1 leaves them):
#   - a fresh copy of the synthetic database, compose project gwsynth-eval (test-sql/up.sh): a new database each run;
#     the sources stream's own gwsynth project is never touched
#   - a throwaway ArcadeDB and graph-rag built from this checkout, on a private network joined to gwsynth-eval_api
#   - the fake model routes (e2e/fake-models.mjs): embeddings always (word-hash vectors: search quality is not what is
#     measured; NEEDS A RULING I-18), and the typed check's decision API in a dry run
#   - the driver (eval/driver/run.mjs), which plays the workspace's agent pool and writes the run's report
# The connection's home is everyone (the test configuration), set twice because two streams read it: DAB_READ_HOME
# (sources: what a read is seen from) and CONNECTION_HOMES (classes: the home of a class made from its tables).
#
# --models real: the models and keys come only from the env file the user made on the host. It is passed by path to
# docker (--env-file), never read into this script's output, never copied, never printed. The run refuses to start
# when the file is missing, or names no key. Nothing here touches the development or demo instances, the gwdemo
# project, or the mssql-server and tcmautomation containers.
set -euo pipefail
cd "$(dirname "$0")/.."
GR="$PWD"
REPO="$(cd .. && pwd)"
MODELS="" ENV_FILE="" SETUP="" RUN=1 OUT="" SEED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --models) MODELS="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --setup) SETUP="$2"; shift 2 ;;
    --run) RUN="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$MODELS" in
  fake) SETUP="fake" ;;
  real)
    [ -n "$SETUP" ] || { echo "--setup is required with --models real (A, B, ...)" >&2; exit 2; }
    [ -n "$ENV_FILE" ] || { echo "--env-file is required with --models real" >&2; exit 2; }
    [ -f "$ENV_FILE" ] || { echo "refusing to start: no env file at $ENV_FILE (the user creates it; see graph-rag/eval/models.env.example)" >&2; exit 1; }
    # names only, never values: -q prints nothing
    for name in EVAL_AGENT_API_KEY "EVAL_SETUP_${SETUP}_ORCHESTRATOR" "EVAL_SETUP_${SETUP}_WORKER" DECISION_API_KEY; do
      grep -q "^${name}=." "$ENV_FILE" || { echo "refusing to start: the env file sets no $name" >&2; exit 1; }
    done
    ;;
  *) echo "--models fake or --models real" >&2; exit 2 ;;
esac
OUT="${OUT:-$GR/eval/runs/$(date -u +%Y%m%dT%H%M%SZ)-$SETUP-$RUN}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

NET="gr-eval-$$"
SYNTH="gwsynth-eval"
CFG="$(mktemp -d)"
NODE="node:22-alpine"
ADB_IMAGE="${ADB_IMAGE:-arcadedata/arcadedb:latest}"
GR_IMAGE="graph-rag:eval-$$"
cleanup() {
  if [ "${KEEP:-}" != "1" ]; then
    docker rm -f "$NET-gr" "$NET-adb" "$NET-models" "$NET-driver" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    docker rmi "$GR_IMAGE" >/dev/null 2>&1 || true
    GWSYNTH_PROJECT="$SYNTH" "$REPO/test-sql/down.sh" >/dev/null 2>&1 || true
    rm -rf "$CFG"
  else
    echo "kept: containers $NET-{gr,adb,models} on $NET, and compose project $SYNTH"
  fi
}
trap cleanup EXIT

# the test positions and identities; the delegation key is made here for this run and dies with it
KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
tok() { node -e 'console.log("eval-"+require("crypto").randomBytes(12).toString("hex"))'; }
cat >"$CFG/positions.json" <<'EOF'
{ "root": "org", "positions": {
  "org": { "name": "Top of the organization", "description": "owners and admins: pay, dismissal, prices and margins" },
  "ops": { "name": "Operations", "parent": "org", "description": "orders, customers, suppliers, staffing" },
  "floor": { "name": "Production floor", "parent": "ops", "description": "jobs, machines, shifts, maintenance" } } }
EOF
cat >"$CFG/tokens.json" <<EOF
{ "tokens": [
  { "token": "$(tok)", "user": "admin", "caps": { "read": true, "write": "direct", "approve": true, "raw": true }, "positions": ["org"], "delegationKey": "$KEY" },
  { "token": "$(tok)", "user": "alice", "caps": { "read": true, "write": "direct" }, "positions": ["ops"] },
  { "token": "$(tok)", "user": "bob", "caps": { "read": true, "write": "direct" }, "positions": ["floor"] } ] }
EOF
chmod -R a+rX "$CFG"

echo "the synthetic database: a fresh copy, project $SYNTH"
GWSYNTH_PROJECT="$SYNTH" "$REPO/test-sql/down.sh" >/dev/null 2>&1 || true
GWSYNTH_PROJECT="$SYNTH" "$REPO/test-sql/up.sh"

docker network create "$NET" >/dev/null
docker run -d --name "$NET-adb" --network "$NET" --network-alias arcadedb \
  -e ARCADEDB_OPTS_MEMORY="-Xms256m -Xmx1g" \
  -e ARCADEDB_SETTINGS="-Darcadedb.server.rootPassword=eval-throwaway -Darcadedb.server.defaultDatabases=gwarestrin[root]" \
  "$ADB_IMAGE" >/dev/null
docker run -d --name "$NET-models" --network "$NET" --network-alias models -v "$GR/e2e:/e2e:ro" "$NODE" node /e2e/fake-models.mjs >/dev/null
echo "building graph-rag from this checkout"
docker build -q -t "$GR_IMAGE" "$GR" >/dev/null
docker run --rm --network "$NET" "$NODE" node -e '
  const end = Date.now() + 120000;
  (async () => { while (Date.now() < end) { try { if ((await fetch("http://arcadedb:2480/api/v1/ready")).status < 500) process.exit(0); } catch {} await new Promise((r) => setTimeout(r, 2000)); } process.exit(1); })();'

CHECK_ENV=(-e DECISION_URL=http://models:4000/decisions -e DECISION_API_KEY=fake)
ENV_ARGS=()
if [ "$MODELS" = "real" ]; then
  # the typed check's decision model, from the env file (DECISION_API_KEY, and DECISION_URL / DECISION_MODEL if set)
  CHECK_ENV=()
  ENV_ARGS=(--env-file "$ENV_FILE")
fi
docker create --name "$NET-gr" --network "$NET" --network-alias graph-rag -v "$CFG:/cfg:ro" "${ENV_ARGS[@]}" \
  -e ARCADEDB_URL=http://arcadedb:2480 -e ARCADEDB_DB=gwarestrin -e ARCADEDB_USER=root -e ARCADEDB_PASSWORD=eval-throwaway \
  -e LITELLM_BASE_URL=http://models:4000/v1 -e LITELLM_API_KEY=fake -e EMBED_MODEL=embed "${CHECK_ENV[@]}" \
  -e TOKEN_MAP_PATH=/cfg/tokens.json -e POSITION_MAP_PATH=/cfg/positions.json \
  -e SWEEP_INTERVAL_MS=5000 -e DOC_STORE=fs:/tmp/documents \
  -e DAB_SYSTEM=mssql -e DAB_READ_URL=http://dab-read:5000/mcp -e DAB_WRITE_URL=http://dab-write:5000/mcp -e DAB_READ_HOME=everyone \
  -e 'CONNECTION_HOMES={"mssql":"everyone"}' \
  -e DAB_WRITE_TABLES=dbo_Job,dbo_Job_Operation,dbo_Work_Center,dbo_Sales_Order,dbo_Purchase_Order,dbo_Maintenance \
  -e DAB_GUARD_SERVER=gwsynth-sql -e DAB_GUARD_DATABASE=GwSynthMfg \
  "$GR_IMAGE" >/dev/null
docker network connect "${SYNTH}_api" "$NET-gr"
docker start "$NET-gr" >/dev/null

echo "the run: $MODELS models, setup $SETUP, run $RUN -> $OUT"
docker create --name "$NET-driver" --network "$NET" -v "$REPO:/repo:ro" -v "$CFG:/cfg:ro" -v "$OUT:/out" --user "$(id -u):$(id -g)" "${ENV_ARGS[@]}" \
  "$NODE" node /repo/graph-rag/eval/driver/run.mjs --graph http://graph-rag:8000 --tokens /cfg/tokens.json \
  --dab-read http://dab-read:5000/mcp --dab-write http://dab-write:5000/mcp --run-dir /out \
  --models "$MODELS" ${SETUP:+--setup "$SETUP"} --run "$RUN" ${SEED:+--seed "$SEED"} >/dev/null
docker network connect "${SYNTH}_api" "$NET-driver"
status=0
docker start -a "$NET-driver" || status=$?
docker logs "$NET-gr" > "$OUT/graph-rag.log" 2>&1 || true
echo "report: $OUT/report.md (exit $status)"
exit "$status"
