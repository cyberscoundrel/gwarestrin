#!/usr/bin/env bash
# Restore a backup file under a new database name on this project's SQL Server, then give the copy the same
# access as the synthetic database: the read and write logins' users, their grants, and the identity view the
# guard reads (seed.mjs access). Nothing else in the copy changes. It refuses a name that already exists.
#   test-sql/restore.sh <file.bak> <database> [writable.json]
# Then point the DABs at it:  GWSYNTH_DATABASE=<database> GWSYNTH_NO_SEED=1 test-sql/up.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"
BAK="${1:?usage: restore.sh <file.bak> <database> [writable.json]}"
DB="${2:?usage: restore.sh <file.bak> <database> [writable.json]}"
WRITABLE="${3:-}"
[[ "$DB" =~ ^[A-Za-z][A-Za-z0-9_]{0,63}$ ]] || { echo "not a plain database name: $DB" >&2; exit 2; }
[ -f "$BAK" ] || { echo "no such file: $BAK" >&2; exit 2; }
exists=$(sqlcmd_sa -h -1 -W -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM sys.databases WHERE name = N'$DB'" | tr -d '[:space:]')
[ "$exists" = "0" ] || { echo "a database called $DB already exists here: refused (pick another name, or test-sql/down.sh first)" >&2; exit 1; }
IN="/var/opt/mssql/backup/restore-$DB.bak"
dc exec -T -u 0 sql bash -c 'mkdir -p /var/opt/mssql/backup && chown mssql /var/opt/mssql/backup' >/dev/null
docker cp "$BAK" "$(dc ps -q sql):$IN" >/dev/null
dc exec -T -u 0 sql chown mssql "$IN"
# each logical file goes to its own new physical file named for the copy
moves=$(sqlcmd_sa -h -1 -W -s '|' -Q "SET NOCOUNT ON; RESTORE FILELISTONLY FROM DISK = N'$IN'" \
  | awk -F'|' -v db="$DB" 'NF > 3 && $1 != "" { ext = ($3 == "L") ? "ldf" : "mdf"; n++; printf ", MOVE N%c%s%c TO N%c/var/opt/mssql/data/%s_%d.%s%c", 39, $1, 39, 39, db, n, ext, 39 }')
[ -n "$moves" ] || { echo "the backup lists no files: is it a SQL Server backup?" >&2; exit 1; }
sqlcmd_sa -Q "RESTORE DATABASE [$DB] FROM DISK = N'$IN' WITH RECOVERY${moves}" >/dev/null
node "$TEST_SQL/seed.mjs" access "$DB" ${WRITABLE:+"$WRITABLE"} | sqlcmd_sa >/dev/null
dc exec -T -u 0 sql rm -f "$IN"
echo "restored $DB from $(basename "$BAK"), with the read and write logins and the identity view"
