#!/bin/sh
# Check the gw-admin-provider's policy bindings properly.
set -e
TOK=$(grep -oP '^AUTHENTIK_BOOTSTRAP_TOKEN=\K.*' ~/gwarestrin/.env)
IP=$(docker inspect gwarestrin-authentik-server-1 --format '{{index .NetworkSettings.Networks "gwarestrin_backend" "IPAddress"}}')
H="Authorization: Bearer $TOK"
BASE="http://$IP:9000/api/v3"

PPK=$(curl -s --max-time 8 -H "$H" "$BASE/providers/proxy/?name=gw-admin-provider" | python3 -c 'import json,sys; print(json.load(sys.stdin)["results"][0]["pk"])')
echo "provider pk: $PPK"
echo "== bindings on provider:"
curl -s --max-time 8 -H "$H" "$BASE/policies/bindings/?target_pk=$PPK" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('  count:', d['pagination']['count'])
for b in d['results']:
    print('  ', b['pk'][:8], '| enabled:', b['enabled'], '| policy:', (b.get('policy') or '')[:8], '| order:', b.get('order'))
"
echo "== my expression policies:"
curl -s --max-time 8 -H "$H" "$BASE/policies/expression/" | python3 -c "
import json, sys
for p in json.load(sys.stdin)['results']:
    if 'gw-' in p['name']:
        print('  ', p['pk'][:8], '|', p['name'], '|', p['expression'][:100])
"
