#!/bin/sh
# Full embedded-outpost JSON + provider binding check.
set -e
TOK=$(grep -oP '^AUTHENTIK_BOOTSTRAP_TOKEN=\K.*' ~/gwarestrin/.env)
IP=$(docker inspect gwarestrin-authentik-server-1 --format '{{index .NetworkSettings.Networks "gwarestrin_backend" "IPAddress"}}')
H="Authorization: Bearer $TOK"
echo "== outpost instance JSON:"
curl -s --max-time 8 -H "$H" "http://$IP:9000/api/v3/outposts/instances/" | python3 -m json.tool | head -30
echo "== proxy providers (name + pk):"
curl -s --max-time 8 -H "$H" "http://$IP:9000/api/v3/providers/proxy/" | python3 -c "
import json, sys
for p in json.load(sys.stdin)['results']:
    print(' ', p['pk'], p['name'], p.get('mode'))
"
echo "== outpost health:"
curl -s --max-time 8 -H "$H" "http://$IP:9000/api/v3/outposts/outpost_health/" | python3 -m json.tool | head -20
