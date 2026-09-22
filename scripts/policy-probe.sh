#!/bin/sh
# Access-policy diagnostic: alice's groups, provider policies, bindings.
set -e
TOK=$(grep -oP '^AUTHENTIK_BOOTSTRAP_TOKEN=\K.*' ~/gwarestrin/.env)
IP=$(docker inspect gwarestrin-authentik-server-1 --format '{{index .NetworkSettings.Networks "gwarestrin_backend" "IPAddress"}}')
H="Authorization: Bearer $TOK"
echo "== alice groups:"
curl -s --max-time 8 -H "$H" "http://$IP:9000/api/v3/core/users/?username=alice" | python3 -c "
import json, sys
for u in json.load(sys.stdin)['results']:
    print('  groups:', u.get('groups'))
    print('  pk:', u['pk'])
"
echo "== provider policies (expression):"
curl -s --max-time 8 -H "$H" "http://$IP:9000/api/v3/policies/expression/" | python3 -c "
import json, sys
for p in json.load(sys.stdin)['results']:
    print(' ', p['pk'][:8], '|', p['name'], '|', p['expression'][:90])
"
echo "== policy bindings:"
curl -s --max-time 8 -H "$H" "http://$IP:9000/api/v3/policies/bindings/?target_pk=$(curl -s --max-time 8 -H "$H" 'http://$IP:9000/api/v3/providers/proxy/?name=gw-admin-provider' | python3 -c 'import json,sys; print(json.load(sys.stdin)["results"][0]["pk"])')" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('  count:', d['pagination']['count'])
for b in d['results']:
    print(' ', b['pk'][:8], '| enabled:', b['enabled'], '| policy:', b.get('policy'))
"
