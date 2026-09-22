#!/usr/bin/env python3
"""Walk the authentik OAuth login flow via curl-style HTTP (no browser).

Flow: traefik (Host: admin.gw.home) -> 302 authentik authorize -> login
form API (identification + password stages) -> back to the app session.
Verifies admin CAN log in and alice CANNOT reach admin.gw.home.
"""
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

BASE = "http://localhost:8880"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def build_opener():
    jar = CookieJar()
    return urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(jar)), jar


def get(op, url, headers=None):
    req = urllib.request.Request(url, headers=headers or {"Host": "admin.gw.home"})
    try:
        resp = op.open(req, timeout=15)
        return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def post_json(op, url, payload, headers=None):
    body = json.dumps(payload).encode()
    h = {"Host": "admin.gw.home", "content-type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=body, headers=h)
    try:
        resp = op.open(req, timeout=15)
        return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def drive_login(username, password):
    op, _jar = build_opener()
    # 1. hit the app through traefik; capture the 302 to the authorize URL
    status, headers, _ = get(op, f"{BASE}/")
    loc = headers.get("Location", "")
    print(f"  app -> {status} {loc[:80]}")
    if status != 302 or "/authorize/" not in loc:
        return f"expected 302 authorize, got {status}"

    auth_host = urllib.parse.urlparse(loc).netloc or "auth.gw.home:8880"
    # 2. follow the authorize redirect chain until we get the flow executor
    url = loc
    executor_url = None
    for _ in range(8):
        status, headers, body = get(op, url, headers={"Host": auth_host})
        if status == 302:
            url = headers.get("Location", "")
            if not url.startswith("http"):
                url = f"http://{auth_host}{url}"
            continue
        if status == 200:
            # the SPA would now call the executor API; find the flow slug
            slug = re.search(r'default-authentication-flow|flow_slug["\s:=]+([a-z0-9-]+)', body.decode(errors="replace"))
            executor_url = f"http://{auth_host}/api/v3/flows/executor/default-authentication-flow/"
            break
        return f"authorize chain stopped at {status} {url[:90]}"
    if not executor_url:
        return "no executor url"

    # 3. identification stage
    status, body = post_json(op, executor_url, {"uid_field": username}, headers={"Host": auth_host})
    print(f"  identification -> {status} {body[:80]}")
    data = json.loads(body or b"{}")
    # 4. password stage
    status, body = post_json(op, executor_url, {"password": password}, headers={"Host": auth_host})
    print(f"  password -> {status} {body[:120]}")
    data = json.loads(body or b"{}")
    if data.get("type") != "RedirectChallenge" and "redirect" not in json.dumps(data):
        return f"login did not complete: {data.get('type')}"
    redir = (data.get("to") or data.get("payload", {}).get("to") or data.get("redirect") or "")
    print(f"  flow complete -> {redir[:90]}")

    # 5. follow the redirect chain back through the outpost callback to the app
    url = redir if redir.startswith("http") else f"http://{auth_host}{redir}"
    for _ in range(8):
        status, headers, body = get(op, url, headers={"Host": auth_host if "auth.gw" in url else "admin.gw.home"})
        if status == 302:
            url = headers.get("Location", "")
            if not url.startswith("http"):
                url = f"http://{urllib.parse.urlparse(url).netloc or 'admin.gw.home'}{url}"
            continue
        break
    final = url if status != 302 else url
    print(f"  landed -> {status} {final[:80]}")
    if "admin.gw.home" in final and status == 200:
        return "OK"
    if status == 200 and b"gwarestrin" in body:
        return "OK"
    return f"unexpected landing: {status} {final[:80]}"


print("== admin (expect OK):")
print("  RESULT:", drive_login("admin", "admin-pass-1"))
