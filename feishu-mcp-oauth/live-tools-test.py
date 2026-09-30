#!/usr/bin/env python3
"""走完整 OAuth 流程，通过 /mcp 调用真实飞书工具，验证端到端可用。"""
import base64
import hashlib
import os
import secrets
import urllib.parse

import requests

BASE = os.environ["BASE"]
PW = os.environ["LOGIN_PASSWORD"]
RU = "https://chatgpt.com/connector_platform_oauth_redirect"


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


s = requests.Session()

md = s.get(f"{BASE}/.well-known/oauth-authorization-server").json()
reg = s.post(
    md["registration_endpoint"],
    json={
        "client_name": "live-test",
        "redirect_uris": [RU],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    },
).json()
cid = reg["client_id"]

ver = b64(secrets.token_bytes(40))
ch = b64(hashlib.sha256(ver.encode()).digest())
s.get(
    f"{BASE}/authorize",
    params={
        "response_type": "code",
        "client_id": cid,
        "redirect_uri": RU,
        "scope": "mcp:read mcp:write",
        "state": "st",
        "code_challenge": ch,
        "code_challenge_method": "S256",
    },
    allow_redirects=False,
)
loc = s.post(f"{BASE}/login/demo", data={"password": PW}, allow_redirects=False).headers["Location"]
code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)["code"][0]
tok = s.post(
    md["token_endpoint"],
    data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": RU,
        "client_id": cid,
        "code_verifier": ver,
    },
).json()
acc = tok["access_token"]

H = {
    "Authorization": f"Bearer {acc}",
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}
r = s.post(
    f"{BASE}/mcp",
    json={
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "live", "version": "1"},
        },
    },
    headers=H,
    timeout=60,
)
sid = r.headers.get("mcp-session-id")
if sid:
    H["mcp-session-id"] = sid
s.post(f"{BASE}/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=H, timeout=60)

print("session_id =", sid)
print()

calls = [
    ("check_feishu_auth", {}),
    ("search_feishu_docs", {"query": "测试"}),
]
for name, args in calls:
    resp = s.post(
        f"{BASE}/mcp",
        json={"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": name, "arguments": args}},
        headers=H,
        timeout=120,
    )
    print(f"--- {name} [{resp.status_code}]")
    print("   ", resp.text[:700].replace("\n", " "))
    print()
