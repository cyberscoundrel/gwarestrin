#!/bin/sh
# Blueprint instance state + per-entry apply result, run inside the postgres container.
psql -U authentik -c "SELECT path, status, last_applied, length(content) AS clen FROM authentik_blueprints_blueprintinstance ORDER BY path;"
echo "--- users:"
psql -U authentik -c "SELECT username, type FROM authentik_core_user ORDER BY username;"
echo "--- groups:"
psql -U authentik -c "SELECT name FROM authentik_core_group ORDER BY name;"
echo "--- providers:"
psql -U authentik -c "SELECT name FROM authentik_providers_proxy_proxyprovider;"
echo "--- apps:"
psql -U authentik -c "SELECT slug FROM authentik_core_application;"
