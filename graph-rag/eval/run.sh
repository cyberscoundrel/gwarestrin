#!/usr/bin/env bash
# One filing run of the real-model evaluation (docs/build/integrate.md), against the synthetic test database only.
#
#   graph-rag/eval/run.sh --models fake [--out DIR] [--seed N]                   the dry run: fake models in the driver
#   graph-rag/eval/run.sh --models fake --via litellm [--out DIR] [--seed N]     the plumbing proof: the same fakes
#                                                                                behind the evaluation's litellm
#   graph-rag/eval/run.sh --models real --env-file ~/gwsynth-models.env --setup A [--run 1] [--out DIR] [--seed N]
#                                                                [--via litellm (the default) | --via direct]
#
# What it starts, all its own, all removed afterwards (KEEP=1 leaves them):
#   - a fresh copy of the synthetic database, compose project gwsynth-eval (test-sql/up.sh): a new database each run;
#     the sources stream's own gwsynth project is never touched
#   - with --via litellm: the evaluation's litellm in that same project (eval/compose.yml): the image the repository's
#     litellm service names in docker-compose.yml and the committed litellm-config.example/litellm-config.yaml, no
#     published port, a master key made here for this run. The development (4100) and demo (4101) litellms are
#     never touched. With --models fake it reaches only a fake upstream on an internal network (compose.fake.yml)
#   - a throwaway ArcadeDB and graph-rag built from this checkout, on a private network joined to gwsynth-eval_api
#   - the fake model routes (e2e/fake-models.mjs): embeddings always (word-hash vectors: search quality is not what is
#     measured; NEEDS A RULING I-18), and the typed check's decision API in a dry run
#   - the driver (eval/driver/run.mjs), which plays the workspace's agent pool and writes the run's report
# The connection's home is everyone (the test configuration), set twice because two streams read it: DAB_READ_HOME
# (sources: what a read is seen from) and CONNECTION_HOMES (classes: the home of a class made from its tables).
#
# --models real: the keys come only from the env file the user made on the host (graph-rag/eval/models.env.example).
# It is passed by path (docker --env-file, compose env_file), never read into this script's output, never copied,
# never printed; the checks below grep for names only. Only the setup's model-name lines are copied, for the driver.
# The run refuses to start when the file is missing or names no key. Nothing here touches the development or demo
# instances, the gwdemo project, or the mssql-server and tcmautomation containers.
set -euo pipefail
cd "$(dirname "$0")/.."
GR="$PWD"
REPO="$(cd .. && pwd)"
MODELS="" ENV_FILE="" SETUP="" RUN=1 OUT="" SEED="" VIA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --models) MODELS="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --setup) SETUP="$2"; shift 2 ;;
    --run) RUN="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    --via) VIA="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
# names only, never values: -q prints nothing
sets() { grep -q "^$1=." "$ENV_FILE"; }
refuse() { echo "refusing to start: $1" >&2; exit 1; }
case "$MODELS" in
  fake)
    SETUP="fake"
    VIA="${VIA:-none}"
    case "$VIA" in none|litellm) ;; *) echo "--models fake takes --via litellm or nothing" >&2; exit 2 ;; esac
    ;;
  real)
    VIA="${VIA:-litellm}"
    case "$VIA" in litellm|direct) ;; *) echo "--via litellm or --via direct" >&2; exit 2 ;; esac
    [ -n "$SETUP" ] || { echo "--setup is required with --models real (A, B, ...)" >&2; exit 2; }
    [ -n "$ENV_FILE" ] || { echo "--env-file is required with --models real" >&2; exit 2; }
    [ -f "$ENV_FILE" ] || refuse "no env file at $ENV_FILE (the user creates it; see graph-rag/eval/models.env.example)"
    ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
    for name in "EVAL_SETUP_${SETUP}_ORCHESTRATOR" "EVAL_SETUP_${SETUP}_WORKER"; do sets "$name" || refuse "the env file sets no $name"; done
    if [ "$VIA" = "litellm" ]; then sets OPENROUTER_API_KEY || refuse "the env file sets no OPENROUTER_API_KEY (litellm's key)"
    else sets EVAL_AGENT_API_KEY || refuse "the env file sets no EVAL_AGENT_API_KEY (--via direct)"; fi
    # the typed check's decision model: its own key, or the OpenRouter key
    sets DECISION_API_KEY || sets OPENROUTER_API_KEY || refuse "the env file sets neither DECISION_API_KEY nor OPENROUTER_API_KEY (the typed check's key)"
    ;;
  *) echo "--models fake or --models real" >&2; exit 2 ;;
esac
OUT="${OUT:-$GR/eval/runs/$(date -u +%Y%m%dT%H%M%SZ)-$SETUP-$RUN}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

NET="gr-eval-$$"
# each setup its own compose project (its own SQL copy, DABs and litellm), so setups run side by side: A in
# gwsynth-eval-a, B in gwsynth-eval-b; nothing joins one project's networks to the other's. The copies keep the
# synthetic names the guard checks (gwsynth-sql, GwSynthMfg): each graph-rag's guard checks its own copy's
SYNTH="gwsynth-eval"
if [ "$MODELS" = "real" ]; then SYNTH="gwsynth-eval-$(echo "$SETUP" | tr '[:upper:]' '[:lower:]')"; fi
CFG="$(mktemp -d)"
NODE="node:22-alpine"
ADB_IMAGE="${ADB_IMAGE:-arcadedata/arcadedb:latest}"
GR_IMAGE="graph-rag:eval-$$"
# the repository's litellm image, read from the checkout's docker-compose.yml (never from a running container)
LITELLM_IMAGE="$(awk '/^  litellm:/{f=1;next} f&&/^  [a-z]/{exit} f&&/^    image:/{print $2;exit}' "$REPO/docker-compose.yml")"
[ -n "$LITELLM_IMAGE" ] || { echo "no litellm image in $REPO/docker-compose.yml" >&2; exit 1; }
LITELLM_KEY="sk-eval-$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
OVERLAY="$([ "$MODELS" = "real" ] && echo real || echo fake)"
ec() {
  GWSYNTH_PROJECT="$SYNTH" EVAL_LITELLM_IMAGE="$LITELLM_IMAGE" EVAL_LITELLM_KEY="$LITELLM_KEY" EVAL_MODELS_ENV="${ENV_FILE:-/dev/null}" \
    docker compose -p "$SYNTH" -f "$GR/eval/compose.yml" -f "$GR/eval/compose.$OVERLAY.yml" "$@"
}
cleanup() {
  if [ "${KEEP:-}" != "1" ]; then
    docker rm -f "$NET-gr" "$NET-adb" "$NET-models" "$NET-driver" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    docker rmi "$GR_IMAGE" >/dev/null 2>&1 || true
    [ "$VIA" = "litellm" ] && { ec down -v >/dev/null 2>&1 || true; }
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
# the driver's model names through litellm: only the setup's two name lines of the env file, never a key line
if [ "$MODELS" = "real" ] && [ "$VIA" = "litellm" ]; then
  grep -E "^EVAL_SETUP_${SETUP}_(ORCHESTRATOR|WORKER)=" "$ENV_FILE" >"$CFG/models.env"
fi
chmod -R a+rX "$CFG"

echo "the synthetic database: a fresh copy, project $SYNTH"
GWSYNTH_PROJECT="$SYNTH" "$REPO/test-sql/down.sh" >/dev/null 2>&1 || true
GWSYNTH_PROJECT="$SYNTH" "$REPO/test-sql/up.sh"
if [ "$VIA" = "litellm" ]; then
  echo "the evaluation's litellm: $LITELLM_IMAGE, the committed configuration, project $SYNTH ($OVERLAY upstream)"
  ec up -d --wait >/dev/null
  # the repository's tag moves (main-stable): the run records which image it was
  docker image inspect --format '{{.Id}} {{json .RepoDigests}}' "$LITELLM_IMAGE" >"$OUT/litellm-image.txt" 2>/dev/null || true
fi

# an explicit /24 of 172.31.100-249: once docker's 172.x pool is used up it hands out 192.168.0.0/20, which
# doesn't route between containers on this host (setup B's first starts)
for try in $(seq 1 20); do
  if docker network create --subnet "172.31.$(( 100 + RANDOM % 150 )).0/24" "$NET" >/dev/null 2>&1; then break; fi
  [ "$try" = 20 ] && { echo "no free subnet for $NET" >&2; exit 1; }
done
docker run -d --name "$NET-adb" --network "$NET" --network-alias arcadedb \
  -e ARCADEDB_OPTS_MEMORY="-Xms256m -Xmx1g" \
  -e ARCADEDB_SETTINGS="-Darcadedb.server.rootPassword=eval-throwaway -Darcadedb.server.defaultDatabases=gwarestrin[root]" \
  "$ADB_IMAGE" >/dev/null
docker run -d --name "$NET-models" --network "$NET" --network-alias models -v "$GR/e2e:/e2e:ro" "$NODE" node /e2e/fake-models.mjs >/dev/null
echo "building graph-rag from this checkout"
docker build -q -t "$GR_IMAGE" "$GR" >/dev/null
docker run --rm --network "$NET" "$NODE" node -e '
  const end = Date.now() + 300000; // five minutes: two setups starting side by side load the host
  (async () => { while (Date.now() < end) { try { if ((await fetch("http://arcadedb:2480/api/v1/ready")).status < 500) process.exit(0); } catch {} await new Promise((r) => setTimeout(r, 2000)); } process.exit(1); })();'

CHECK_ENV=(-e DECISION_URL=http://models:4000/decisions -e DECISION_API_KEY=fake)
GR_RUN=()
GR_CMD=()
if [ "$MODELS" = "real" ]; then
  # the typed check's decision model, read by graph-rag from the env file: DECISION_API_KEY, or else the OpenRouter
  # key (as the repository's compose does), and DECISION_URL / DECISION_MODEL if set; resolved inside the container
  CHECK_ENV=()
  GR_RUN=(--env-file "$ENV_FILE" --dns 1.1.1.1 --dns 1.0.0.1 --entrypoint sh)
  GR_CMD=(-c 'export DECISION_API_KEY="${DECISION_API_KEY:-${OPENROUTER_API_KEY:-}}"; exec node src/server.js')
fi
docker create --name "$NET-gr" --network "$NET" --network-alias graph-rag -v "$CFG:/cfg:ro" "${GR_RUN[@]}" \
  -e ARCADEDB_URL=http://arcadedb:2480 -e ARCADEDB_DB=gwarestrin -e ARCADEDB_USER=root -e ARCADEDB_PASSWORD=eval-throwaway \
  -e LITELLM_BASE_URL=http://models:4000/v1 -e LITELLM_API_KEY=fake -e EMBED_MODEL=embed "${CHECK_ENV[@]}" \
  -e TOKEN_MAP_PATH=/cfg/tokens.json -e POSITION_MAP_PATH=/cfg/positions.json \
  -e SWEEP_INTERVAL_MS=5000 -e DOC_STORE=fs:/tmp/documents \
  -e DAB_SYSTEM=mssql -e DAB_READ_URL=http://dab-read:5000/mcp -e DAB_WRITE_URL=http://dab-write:5000/mcp -e DAB_READ_HOME=everyone \
  -e 'CONNECTION_HOMES={"mssql":"everyone"}' \
  -e DAB_WRITE_TABLES=dbo_Job,dbo_Job_Operation,dbo_Work_Center,dbo_Sales_Order,dbo_Purchase_Order,dbo_Maintenance \
  -e DAB_GUARD_SERVER=gwsynth-sql -e DAB_GUARD_DATABASE=GwSynthMfg \
  "$GR_IMAGE" "${GR_CMD[@]}" >/dev/null
docker network connect "${SYNTH}_api" "$NET-gr"
docker start "$NET-gr" >/dev/null

# the driver's models: in-process fakes, the evaluation's litellm, or a direct endpoint from the env file
DRIVER_ENV=()
case "$MODELS/$VIA" in
  fake/litellm) DRIVER_ENV=(-e EVAL_VIA=litellm -e EVAL_LITELLM_URL=http://litellm:4000/v1 -e "EVAL_LITELLM_KEY=$LITELLM_KEY" \
                            -e EVAL_SETUP_fake_ORCHESTRATOR=deepseek-v4-flash -e EVAL_SETUP_fake_WORKER=deepseek-v4-flash) ;;
  real/litellm) DRIVER_ENV=(--env-file "$CFG/models.env" -e EVAL_VIA=litellm -e EVAL_LITELLM_URL=http://litellm:4000/v1 -e "EVAL_LITELLM_KEY=$LITELLM_KEY") ;;
  real/direct)  DRIVER_ENV=(--env-file "$ENV_FILE" -e EVAL_VIA=direct --dns 1.1.1.1 --dns 1.0.0.1) ;;
esac
echo "the run: $MODELS models via $VIA, setup $SETUP, run $RUN -> $OUT"
docker create --name "$NET-driver" --label "eval-setup=$SETUP" --label "eval-run=$RUN" --network "$NET" -v "$REPO:/repo:ro" -v "$CFG:/cfg:ro" -v "$OUT:/out" --user "$(id -u):$(id -g)" "${DRIVER_ENV[@]}" \
  "$NODE" node /repo/graph-rag/eval/driver/run.mjs --graph http://graph-rag:8000 --tokens /cfg/tokens.json \
  --dab-read http://dab-read:5000/mcp --dab-write http://dab-write:5000/mcp --run-dir /out \
  --models "$MODELS" ${SETUP:+--setup "$SETUP"} --run "$RUN" ${SEED:+--seed "$SEED"} >/dev/null
docker network connect "${SYNTH}_api" "$NET-driver"
[ "$VIA" = "litellm" ] && docker network connect "${SYNTH}_models" "$NET-driver"
status=0
docker start -a "$NET-driver" || status=$?
docker logs "$NET-gr" > "$OUT/graph-rag.log" 2>&1 || true
[ "$VIA" = "litellm" ] && { ec logs --no-color > "$OUT/litellm.log" 2>&1 || true; }
echo "report: $OUT/report.md (exit $status)"
exit "$status"
