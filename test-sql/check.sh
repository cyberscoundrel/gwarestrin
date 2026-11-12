#!/usr/bin/env bash
# Live checks of the synthetic test SQL Server and graph-rag's source adapters against it, in a compose project of
# their own (default gwsynth-check), so they never reseed a database another session is using. Removed afterwards
# unless KEEP=1. Needs graph-rag's node_modules (npm install in graph-rag).
#   test-sql/check.sh
set -euo pipefail
export GWSYNTH_PROJECT="${GWSYNTH_PROJECT:-gwsynth-check}"
. "$(dirname "$0")/lib.sh"
REPO="$(cd "$TEST_SQL/.." && pwd)"
FAILS=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
teardown() { if [ "${KEEP:-}" != "1" ]; then "$TEST_SQL/down.sh" >/dev/null 2>&1 || true; else echo "kept: project $GWSYNTH_PROJECT"; fi; }
trap teardown EXIT
[ -d "$REPO/graph-rag/node_modules" ] || { echo "graph-rag/node_modules is missing: run npm install in graph-rag first" >&2; exit 2; }

"$TEST_SQL/up.sh" >/dev/null 2>&1
echo "up: $GWSYNTH_PROJECT"
node_check() { docker run --rm --network "${GWSYNTH_PROJECT}_api" -v "$REPO:/repo:ro" -w /repo/test-sql node:22-alpine node check.mjs "$@" || FAILS=$((FAILS + 1)); }

echo "--- the fake DAB against the real one"
node_check parity
echo "--- the adapters through the real DABs"
node_check adapters

echo "--- the logins, at the SQL level"
# sqlcmd as a login inside the SQL container; its password is read there from the container's own environment
as_login() { dc exec -T sql bash -c 'SQLCMDPASSWORD="${!1}" /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U "$2" -d "$3" -b -Q "$4" 2>&1' _ "$1" "$2" "${4:-GwSynthMfg}" "$3"; }
denied() { # what, login, password variable, statement
  local out
  if out=$(as_login "$3" "$2" "$4"); then bad "$1: it was allowed"; elif grep -qiE "permission was denied|permission denied" <<<"$out"; then ok "$1"; else bad "$1: $(head -c 200 <<<"$out")"; fi
}
allowed() {
  local out
  if out=$(as_login "$3" "$2" "$4"); then ok "$1"; else bad "$1: $(head -c 200 <<<"$out")"; fi
}
denied "the write login can't delete" gwsynth_write GWSYNTH_WRITE_PASSWORD "DELETE FROM dbo.Job WHERE Job = 4471"
allowed "the write login may delete where a table takes new rows (R19's undo; nothing matches)" gwsynth_write GWSYNTH_WRITE_PASSWORD "DELETE FROM dbo.Maintenance WHERE 1 = 0"
denied "the write login can't read a table it doesn't write" gwsynth_write GWSYNTH_WRITE_PASSWORD "SELECT TOP 1 * FROM dbo.Customer"
denied "the write login can't update a table it doesn't write" gwsynth_write GWSYNTH_WRITE_PASSWORD "UPDATE dbo.Customer SET Terms = Terms"
denied "the write login can't insert where it may only update" gwsynth_write GWSYNTH_WRITE_PASSWORD "INSERT INTO dbo.Job (Job) VALUES (1)"
denied "the write login can't change the schema" gwsynth_write GWSYNTH_WRITE_PASSWORD "CREATE TABLE dbo.X (a int)"
allowed "the write login may update a chosen table" gwsynth_write GWSYNTH_WRITE_PASSWORD "UPDATE dbo.Job SET Priority = Priority WHERE Job = 4471"
denied "the read login can't update" gwsynth_read GWSYNTH_READ_PASSWORD "UPDATE dbo.Job SET Priority = 1 WHERE Job = 4471"
denied "the read login can't delete" gwsynth_read GWSYNTH_READ_PASSWORD "DELETE FROM dbo.Maintenance"
allowed "the read login may read every table" gwsynth_read GWSYNTH_READ_PASSWORD "SELECT COUNT(*) FROM dbo.Customer; SELECT COUNT(*) FROM dbo.Employee"

echo "--- isolation"
for c in $(dc ps -q); do
  name=$(docker inspect -f '{{.Name}}' "$c")
  ports=$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostPort}} {{end}}{{end}}{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' "$c")
  [ -z "${ports// /}" ] && ok "$name publishes no port" || bad "$name publishes $ports"
done
for n in db api; do
  [ "$(docker network inspect -f '{{.Internal}}' "${GWSYNTH_PROJECT}_$n")" = "true" ] && ok "network ${GWSYNTH_PROJECT}_$n is internal" || bad "network ${GWSYNTH_PROJECT}_$n is not internal"
done
sqlnets=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(dc ps -q sql)")
[ "$sqlnets" = "${GWSYNTH_PROJECT}_db " ] && ok "SQL Server is only on the db network" || bad "SQL Server is on: $sqlnets"

echo "--- a restored copy: only its names change"
COPY=GwSynthCheckCopy
"$TEST_SQL/backup.sh" "$TEST_SQL/.run/backups/$GWSYNTH_PROJECT.bak" >/dev/null
"$TEST_SQL/restore.sh" "$TEST_SQL/.run/backups/$GWSYNTH_PROJECT.bak" "$COPY" >/dev/null && ok "restored a backup of the synthetic database as $COPY" || bad "restore"
node_check guard GwSynthMfg pass
node_check guard "$COPY" refuse
GWSYNTH_DATABASE="$COPY" GWSYNTH_NO_SEED=1 "$TEST_SQL/up.sh" >/dev/null 2>&1
node_check guard GwSynthMfg refuse
node_check guard "$COPY" pass
node_check write-copy "$COPY"
counts=$(sqlcmd_sa -h -1 -W -Q "SET NOCOUNT ON; SELECT (SELECT Priority FROM GwSynthMfg.dbo.Job WHERE Job = 4471), (SELECT Priority FROM $COPY.dbo.Job WHERE Job = 4471)" | tr -s ' \n' ' ')
[ "$counts" = "5 2 " ] && ok "the write landed in the copy, and the synthetic database is untouched" || bad "priorities (synthetic, copy): $counts"
rm -f "$TEST_SQL/.run/backups/$GWSYNTH_PROJECT.bak"

echo
[ "$FAILS" -eq 0 ] && echo "check: all passed" || echo "check: $FAILS failed"
exit $(( FAILS > 0 ))
