#!/usr/bin/env python3
"""端到端验证 OAuth 2.1 + PKCE + DCR + /mcp 全链路（30 项检查）。

用法：
    BASE=https://你的域名 LOGIN_PASSWORD='你的登录门密码' python3 flow-test.py

环境变量：
    BASE            服务地址，默认 https://mcp.example.com
    LOGIN_PASSWORD  登录门密码，留空则跳过需要登录的用例
"""
import base64
import hashlib
import json
import os
import secrets
import sys
import urllib.parse

import requests
from oauth_browser_test import complete_selection

BASE = os.environ.get("BASE", "https://mcp.example.com")
PASSWORD = os.environ.get("LOGIN_PASSWORD", "")
REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect"

ok_count = 0
fail_count = 0


def step(name, cond, detail=""):
    global ok_count, fail_count
    if cond:
        ok_count += 1
        print(f"  [PASS] {name}" + (f" — {detail}" if detail else ""))
    else:
        fail_count += 1
        print(f"  [FAIL] {name}" + (f" — {detail}" if detail else ""))


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


s = requests.Session()
s.headers["User-Agent"] = "oauth-flow-test/1.0"
if os.environ.get("INSECURE") == "1":
    # 仅在直连源站（私有 CA 证书）等特殊场景用；常规生产验证不要开。
    # 例：直连源站时证书未被公信 CA 信任，可用 INSECURE=1 跳过校验。
    import urllib3

    urllib3.disable_warnings()
    s.verify = False
    print("!! INSECURE 模式：已跳过 TLS 证书校验（仅供临时验证）")

print("\n=== 1. Discovery (RFC 8414) ===")
r = s.get(f"{BASE}/.well-known/oauth-authorization-server", timeout=20)
md = r.json()
step("metadata 200", r.status_code == 200, str(r.status_code))
step("issuer 正确", md.get("issuer") == BASE, md.get("issuer"))
step("有 registration_endpoint", bool(md.get("registration_endpoint")))
step("支持 S256", "S256" in md.get("code_challenge_methods_supported", []))

print("\n=== 2. Protected Resource Metadata (RFC 9728) ===")
r = s.get(f"{BASE}/.well-known/oauth-protected-resource", timeout=20)
prm = r.json()
step("prm 200", r.status_code == 200)
step("resource 指向 /mcp", prm.get("resource", "").endswith("/mcp"), prm.get("resource"))

print("\n=== 3. /mcp 无 token → 401 + WWW-Authenticate ===")
r = s.post(
    f"{BASE}/mcp",
    json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
    headers={"Accept": "application/json, text/event-stream"},
    timeout=20,
)
wa = r.headers.get("WWW-Authenticate", "")
step("状态 401", r.status_code == 401, str(r.status_code))
step("WWW-Authenticate 指向 resource_metadata", "resource_metadata" in wa, wa[:90])

print("\n=== 4. Dynamic Client Registration (RFC 7591) ===")
reg_body = {
    "client_name": "flow-test",
    "redirect_uris": [REDIRECT_URI],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "none",
    "scope": "mcp:read mcp:write",
}
r = s.post(f"{BASE}/register", json=reg_body, timeout=20)
step("register 201", r.status_code == 201, str(r.status_code))
reg = r.json()
client_id = reg.get("client_id")
step("返回 client_id", bool(client_id), str(client_id)[:24])

print("\n=== 5. PKCE + /authorize ===")
verifier = b64url(secrets.token_bytes(40))
challenge = b64url(hashlib.sha256(verifier.encode()).digest())
state = secrets.token_urlsafe(16)
params = {
    "response_type": "code",
    "client_id": client_id,
    "redirect_uri": REDIRECT_URI,
    "scope": "mcp:read mcp:write",
    "state": state,
    "code_challenge": challenge,
    "code_challenge_method": "S256",
}
r = s.get(f"{BASE}/authorize", params=params, allow_redirects=False, timeout=20)
step("authorize 302", r.status_code == 302, str(r.status_code))
loc = r.headers.get("Location", "")
step("重定向到账户选择", "/connect/" in loc, loc)
cookie_names = [c.name for c in s.cookies]
step("下发 session cookie", len(cookie_names) > 0, ",".join(cookie_names))

print("\n=== 6. 登录 (密码门) ===")
loc = complete_selection(s, BASE, loc, PASSWORD)
step("重定向回 redirect_uri", loc.startswith(REDIRECT_URI), loc[:100])
qs = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
code = (qs.get("code") or [""])[0]
step("拿到 authorization code", bool(code), (code[:20] + "...") if code else "NONE")
step("state 回传一致", (qs.get("state") or [""])[0] == state)

if not code:
    print("\n!! 没有拿到 code，后续步骤无法继续")
    sys.exit(1)

print("\n=== 7. /token 换 access_token ===")
r = s.post(
    f"{BASE}/token",
    data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": client_id,
        "code_verifier": verifier,
    },
    timeout=20,
)
step("token 200", r.status_code == 200, str(r.status_code))
tok = r.json()
access = tok.get("access_token", "")
refresh = tok.get("refresh_token", "")
step("有 access_token", bool(access))
step("有 refresh_token", bool(refresh))
step("token_type=Bearer", tok.get("token_type") == "Bearer")

print("\n=== 8. PKCE 负向测试（错误 verifier 必须被拒） ===")
params2 = dict(params)
params2["code_challenge"] = challenge
r2 = s.get(f"{BASE}/authorize", params=params2, allow_redirects=False, timeout=20)
loc2 = complete_selection(s, BASE, r2.headers.get("Location", ""), PASSWORD)
code2 = (urllib.parse.parse_qs(urllib.parse.urlparse(loc2).query).get("code") or [""])[0]
r2 = s.post(
    f"{BASE}/token",
    data={
        "grant_type": "authorization_code",
        "code": code2,
        "redirect_uri": REDIRECT_URI,
        "client_id": client_id,
        "code_verifier": "WRONG_VERIFIER",
    },
    timeout=20,
)
step("错误 code_verifier 被拒 (400)", r2.status_code == 400, f"{r2.status_code} {r2.text[:80]}")

print("\n=== 9. /mcp 带 access_token → initialize ===")
init_body = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "flow-test", "version": "1.0"},
    },
}
r = s.post(
    f"{BASE}/mcp",
    json=init_body,
    headers={
        "Authorization": f"Bearer {access}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    },
    timeout=60,
)
step("initialize 200", r.status_code == 200, str(r.status_code))
body_text = r.text
step("返回非空 body", len(body_text) > 0, f"{len(body_text)} bytes")
step("body 含 serverInfo/result（证明上游真的收到请求）", ("serverInfo" in body_text) or ("result" in body_text), body_text[:200].replace("\n", " "))
session_id = r.headers.get("mcp-session-id", "")

print("\n=== 10. /mcp tools/list ===")
hdr = {
    "Authorization": f"Bearer {access}",
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}
if session_id:
    hdr["mcp-session-id"] = session_id
r = s.post(
    f"{BASE}/mcp",
    json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    headers=hdr,
    timeout=60,
)
step("tools/list 200", r.status_code == 200, str(r.status_code))
has_tools = "read_feishu_doc" in r.text or "tools" in r.text
step("返回 tools 列表", has_tools, r.text[:260].replace("\n", " "))

print("\n=== 11. /mcp 伪造 token → 401 ===")
r = s.post(
    f"{BASE}/mcp",
    json={"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
    headers={"Authorization": "Bearer totally-fake-token", "Accept": "application/json, text/event-stream"},
    timeout=20,
)
step("伪造 token 401", r.status_code == 401, str(r.status_code))

print("\n=== 12. refresh_token 换新 token ===")
r = s.post(
    f"{BASE}/token",
    data={"grant_type": "refresh_token", "refresh_token": refresh, "client_id": client_id},
    timeout=20,
)
step("refresh 200", r.status_code == 200, str(r.status_code))
step("拿到新 access_token", bool(r.json().get("access_token")))

print(f"\n{'=' * 56}")
print(f"结果: {ok_count} 通过 / {fail_count} 失败")
print(f"client_id:    {client_id}")
print("=" * 56)
sys.exit(0 if fail_count == 0 else 1)
