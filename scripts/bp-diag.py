import json
import urllib.request

def bearer(tok):
    return {"authorization": f"Bearer {tok}", "accept": "application/json"}

import os
secret = os.environ["AUTHENTIK_SECRET_KEY"]
req = urllib.request.Request(
    "http://localhost:9000/api/v3/managed/blueprints/",
    headers=bearer(secret),
)
j = json.load(urllib.request.urlopen(req, timeout=15))
for b in j["results"]:
    print(b["name"], "|", b["path"], "|", b["status"])
    if "custom" in b["path"]:
        print("metadata:", json.dumps(b.get("metadata", {}))[:600])
