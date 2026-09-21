import json
import os
import urllib.request

secret = os.environ["AUTHENTIK_SECRET_KEY"]

def api(path, body=None):
    headers = {"authorization": f"Bearer {secret}", "accept": "application/json"}
    data = None
    if body is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(f"http://localhost:9000{path}", data=data, headers=headers)
    try:
        return json.load(urllib.request.urlopen(req, timeout=20))
    except urllib.error.HTTPError as e:
        return {"HTTP_ERROR": e.code, "body": e.read().decode()[:500]}

content = open("/blueprints/custom/gw.yaml").read()
print("content bytes:", len(content))

# authentik blueprint instance validation endpoint
r = api("/api/v3/managed/blueprints/validate/", {"content": content})
print("validate:", json.dumps(r)[:600])
