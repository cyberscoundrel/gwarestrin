#!/usr/bin/env bash
# Start the synthetic test SQL Server, seed it from data.mjs, and start its two DABs.
#   test-sql/up.sh                      fresh database, every run (no volume: each start is a new restore point)
#   GWSYNTH_PROJECT=gwsynth-b test-sql/up.sh    a second, independent copy
# Reach the DABs from a container on the network "<project>_api": http://dab-read:5000/mcp, http://dab-write:5000/mcp
set -euo pipefail
. "$(dirname "$0")/lib.sh"
ensure_env
node "$TEST_SQL/render-dab.mjs" "$TEST_SQL/.run/dab" ${GWSYNTH_WRITABLE:+"$GWSYNTH_WRITABLE"}
dc up -d --wait sql
if [ -z "${GWSYNTH_NO_SEED:-}" ]; then
  node "$TEST_SQL/seed.mjs" schema | sqlcmd_sa >/dev/null
  node "$TEST_SQL/seed.mjs" access "${GWSYNTH_DATABASE:-GwSynthMfg}" ${GWSYNTH_WRITABLE:+"$GWSYNTH_WRITABLE"} | sqlcmd_sa >/dev/null
  echo "seeded ${GWSYNTH_DATABASE:-GwSynthMfg}"
fi
docker image inspect gwsynth-dab:2.0.12 >/dev/null 2>&1 || docker build -q --network host -t gwsynth-dab:2.0.12 "$TEST_SQL/../dab" >/dev/null
# after a fresh seed the DABs reconnect and re-read the schema; otherwise compose recreates them only when their settings changed (GWSYNTH_DATABASE)
dc up -d --wait $([ -z "${GWSYNTH_NO_SEED:-}" ] && echo --force-recreate) dab-read dab-write
echo "up: project $GWSYNTH_PROJECT, network ${GWSYNTH_PROJECT}_api, http://dab-read:5000/mcp and http://dab-write:5000/mcp"
