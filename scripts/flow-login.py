#!/usr/bin/env python3
"""Walk the authentik OAuth login flow server-side (no browser).

DNS for *.gw.home is mapped to 127.0.0.1 so real URLs (and cookies) work
against the local Traefik. Verifies admin CAN log in to admin.gw.home.
"""
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

_orig_getaddrinfo = socket.getaddrinfo


def _resolver(host, *args, **kwargs):
    if isinstance(host, str) and host.endswith("gw.home"):
        host = "127.0.0.1"
    return _orig_getaddrinfo(host, *args, **kwargs)


socket.getaddrinfo = _resolver


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def build_opener():
    jar = CookieJar()
    op = urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(jar))
    return op, jar


def req(op, url, payload=None, csrf=None, referer=None):
    headers = {"Host": urllib.parse.urlparse(url).netloc.split(":")[0]}
    if payload is not None:
        headers["content-type"] = "application/json"
        if csrf:
            headers["X-CSRFToken"] = csrf
            headers["Referer"] = referer or "http://auth.gw.home:8880/"
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, headers=headers)
    try:
        resp = op.open(r, timeout=15)
        return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def csrf_token(jar):
    for c in jar:
        if c.name == "authentik_csrf":
            return c.value
    return None


def drive_login(username, password):
    op, jar = build_opener()
    status, headers, _ = req(op, "http://admin.gw.home:8880/")
    loc = headers.get("Location", "")
    print(f"  app -> {status} {loc[:80]}")
    if status != 302 or "/authorize/" not in loc:
        return f"expected 302 authorize, got {status}"

    url = loc
    executor = None
    for _ in range(8):
        status, headers, body = req(op, url)
        if status == 302:
            url = urllib.parse.urljoin(url, headers.get("Location", ""))
            continue
        if status == 200:
            executor = "http://auth.gw.home:8880/api/v3/flows/executor/default-authentication-flow/"
            break
        return f"authorize chain stopped at {status} {url[:90]}"
    if not executor:
        return "no executor url"

    status, headers, body = req(op, executor)
    print(f"  executor GET -> {status} {body[:70]}")

    tok = csrf_token(jar)
    status, headers, body = req(op, executor, {"uid_field": username}, csrf=tok)
    print(f"  identification -> {status} {body[:90]}")
    if status != 200:
        return f"identification failed: {status}"

    tok = csrf_token(jar)
    status, headers, body = req(op, executor, {"password": password}, csrf=tok)
    print(f"  password -> {status} {body[:140]}")
    if status != 200:
        return f"password stage failed: {status}"
    data = json.loads(body or b"{}")
    if data.get("type") != "RedirectChallenge":
        return f"unexpected stage: {data.get('type')}"

    url = data.get("to", "")
    final_status, final_body = 0, b""
    for _ in range(8):
        status, headers, b = req(op, url)
        if status == 302:
            url = urllib.parse.urljoin(url, headers.get("Location", ""))
            continue
        final_status, final_body = status, b
        break
    print(f"  landed -> {final_status} {url[:80]}")
    if "admin.gw.home" in url and final_status == 200 and b"scripts" in final_body:
        return "OK"
    return f"unexpected landing: {final_status} {url[:80]}"


if __name__ == "__main__":
    print("== admin (expect OK):")
    print("  RESULT:", drive_login("admin", "admin-pass-1"))
