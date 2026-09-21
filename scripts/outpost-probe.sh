#!/bin/sh
# Outpost endpoint variants + outpost health via API.
set -e
TOK=$(grep -oP '^AUTHENTIK_BOOTSTRAP_TOKEN=\K.*' ~/gwarestrin/.env)
IP=$(docker inspect gwarestrin-authentik-server-1 --format '{{index .NetworkSettings.Networks "gwarestrin_backend" "IPAddress"}}')
H="Authorization: Bearer $TOK"
echo "== outpost endpoint variants:"
for p in ping auth/simple; do
  curl -s -o /dev/null -w "  /outpost.goauthentik.io/$p -> %{http_code}\n" --max-time 8 "http://$IP:9000/outpost.goauthentik.io/$p"
done
echo "== outpost state:"
curl -s --max-time 8 -H "$H" "http://$IP:9000/api/v3/outposts/instances/" | head -c 600
echo
echo "== outpost health:"
curl -s --max-time 8 -H "$H" "http://$IP:9000/api/v3/outposts/outpost_health/" | head -c 400
echo
echo "== outpost containers:"
curl -s --max-time 8 -H "$H" "http://$IP:9000/api/v3/outposts/service_connections/all/" | head -c 300
