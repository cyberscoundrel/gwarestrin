# Shared by the test-sql scripts: the compose command for this project, and the env file it needs.
# GWSYNTH_PROJECT picks the compose project (default gwsynth), so two can run side by side.
TEST_SQL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$TEST_SQL/.env.gwsynth"
export GWSYNTH_PROJECT="${GWSYNTH_PROJECT:-gwsynth}"
dc() { docker compose --env-file "$ENV_FILE" -f "$TEST_SQL/compose.yml" -p "$GWSYNTH_PROJECT" "$@"; }
# sqlcmd as sa inside the SQL container; its password comes from the container's own environment
sqlcmd_sa() { dc exec -T sql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -b "$@"; }
# the passwords stay in the env file: make one if there is none, never print it
ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    (umask 077; node -e '
      const pw = () => require("node:crypto").randomBytes(24).toString("base64url") + "Aa1";
      process.stdout.write(`GWSYNTH_SA_PASSWORD=${pw()}\nGWSYNTH_READ_PASSWORD=${pw()}\nGWSYNTH_WRITE_PASSWORD=${pw()}\n`);
    ' >"$ENV_FILE")
    echo "made $ENV_FILE (untracked; passwords not shown)"
  fi
}
