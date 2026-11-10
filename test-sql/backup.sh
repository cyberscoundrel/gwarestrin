#!/usr/bin/env bash
# A copy-only backup of a database on this project's SQL Server, copied out to a file on the host.
#   test-sql/backup.sh <out.bak> [database]      database: default GwSynthMfg
set -euo pipefail
. "$(dirname "$0")/lib.sh"
OUT="${1:?usage: backup.sh <out.bak> [database]}"
DB="${2:-GwSynthMfg}"
[[ "$DB" =~ ^[A-Za-z][A-Za-z0-9_]{0,63}$ ]] || { echo "not a plain database name: $DB" >&2; exit 2; }
IN="/var/opt/mssql/backup/$DB.bak"
dc exec -T -u 0 sql bash -c 'mkdir -p /var/opt/mssql/backup && chown mssql /var/opt/mssql/backup && rm -f "$1"' _ "$IN"
sqlcmd_sa -Q "BACKUP DATABASE [$DB] TO DISK = N'$IN' WITH COPY_ONLY, INIT" >/dev/null
mkdir -p "$(dirname "$OUT")"
docker cp "$(dc ps -q sql):$IN" "$OUT" >/dev/null
echo "backed up $DB to $OUT"
