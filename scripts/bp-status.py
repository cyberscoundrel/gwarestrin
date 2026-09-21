import json
import os
import urllib.request

token = os.environ["AUTHENTIK_BOOTSTRAP_TOKEN"]
headers = {"authorization": f"Bearer {token}", "accept": "application/json"}

def get(path):
    req = urllib.request.Request(f"http://localhost:9000{path}", headers=headers)
    return json.load(urllib.request.urlopen(req, timeout=20))

bps = get("/managed/blueprints/")
for b in bps.get("results", []):
    print("blueprint:", b["path"], "status:", b["status"])
    uuid = b["uuid"]
    detail = get(f"/managed/blueprints/{uuid}/")
    print(json.dumps(detail, indent=1, default=str)[:1500])
