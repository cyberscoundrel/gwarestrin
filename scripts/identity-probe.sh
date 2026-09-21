#!/bin/sh
# Identity bootstrap verification: users, outpost, forwardAuth endpoints.
set -e
TOK=$(grep -oP '^AUTHENTIK_BOOTSTRAP_TOKEN=\K.*' ~/gwarestrin/.env)
IP=$(docker inspect gwarestrin-authentik-server-1 --format '{{index .NetworkSettings.Networks "gwarestrin_backend" "IPAddress"}}')
H="Authorization: Bearer $TOK"
echo "== users:"
for u in admin alice bob; do
  curl -s --max-time 8 -H "$H" "http://$IP:9000/api/v3/core/users/?username__iexact=$u" \
    | grep -oP '"username":"\K[^"]*' | head -1 | sed "s/^/  $u -> /"
done
echo "== groups:"
curl -s --max-time 8 -H "$H" "http://$IP:9000/api/v3/core/groups/" | grep -oP '"name":"\K[^"]*' | head -6 | sed 's/^/  /'
echo "== outpost:"
curl -s --max-time 8 -H "$H" "http://$IP:9000/api/v3/outposts/instances/" | grep -oP '"name":"\K[^"]*' | head -3 | sed 's/^/  /'
echo "== forwardAuth (via server):"
curl -s -o /dev/null -w "  unauth: %{http_code}\n" --max-time 8 "http://$IP:9000/outpost.goauthentik.io/auth/simple"
