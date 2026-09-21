import json
import os
import urllib.request

secret = os.environ["AUTHENTIK_SECRET_KEY"]
bootstrap_pw = os.environ["AUTHENTIK_BOOTSTRAP_PASSWORD"]

def api(path, body=None):
    import base64
    headers = {"authorization": "Basic " + base64.b64encode(f"akadmin:{bootstrap_pw}".encode()).decode(),
               "accept": "application/json"}
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
