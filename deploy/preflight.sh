#!/bin/bash
# 部署前置检查：把「别人踩的坑」提前变成明确的报错。
# 用法：sudo bash deploy/preflight.sh
set -uo pipefail

OK=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; OK=$((OK+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

cd "$(dirname "$0")/.." || exit 1

# 先给可能未定义的变量兜底（脚本用 set -u，.env 不存在时 grep 结果为空）
DOMAIN=""
PORT="3011"

echo "=== 1. 依赖检查 ==="
command -v docker >/dev/null && ok "docker 已安装" || bad "docker 未安装 —— https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 && ok "docker compose (v2) 可用" \
  || bad "docker compose 不可用（旧版 docker-compose 也行，但本项目用 v2 语法）"
command -v nginx >/dev/null && ok "nginx 已安装" || bad "nginx 未安装"

echo
echo "=== 2. 配置文件检查 ==="
if [ ! -f .env ]; then
  bad ".env 不存在 —— 先执行：cp .env.example .env 并填入真实值"
else
  ok ".env 存在"
  # 逐个检查必填项
  for k in DOMAIN MCP_HTTP_TOKEN LOGIN_PASSWORD SESSION_SECRET; do
    v=$(grep -E "^${k}=" .env | head -1 | cut -d= -f2-)
    if [ -z "$v" ]; then
      bad ".env 里 $k 为空"
    else
      ok "$k 已配置"
    fi
  done
  # 下划线域名检查（RFC 1123）
  d=$(grep -E '^DOMAIN=' .env | head -1 | cut -d= -f2-)
  DOMAIN="$d"
  case "$d" in
    *_*)
      bad "DOMAIN 含下划线「${d}」—— 违反 RFC 1123，严格 TLS 客户端会全部握手失败。改用连字符" ;;
    *https://*)
      bad "DOMAIN 不要带 https:// 前缀" ;;
    *)
      ok "DOMAIN 格式正常（${d}）" ;;
  esac
  # 占位符没改就等于没配
  case "$d" in
    *example.com*|your-domain*|YOUR_DOMAIN*)
      bad "DOMAIN 还是示例值「${d}」—— 换成你自己的真实域名" ;;
  esac
fi

echo
echo "=== 3. 端口占用检查 ==="
PORT=$(grep -E '^OAUTH_PROXY_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2-)
PORT=${PORT:-3011}
if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
  warn "端口 ${PORT} 已被占用 —— 改 .env 里的 OAUTH_PROXY_PORT，或停掉占用进程"
elif lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  warn "端口 ${PORT} 已被占用（lsof 检测）"
else
  ok "端口 ${PORT} 空闲"
fi

echo
echo "=== 4. 凭证持久化目录（关键）==="
if [ -d lark-keychain ]; then
  ok "lark-keychain 目录已存在"
  # node 用户 uid 1000，写不进去会导致 lark-cli 授权失败
  if [ "$(stat -c '%u' lark-keychain 2>/dev/null)" = "1000" ]; then
    ok "lark-keychain 属主正确（uid 1000 = node）"
  else
    bad "lark-keychain 属主不是 1000 —— 执行：sudo chown -R 1000:1000 lark-keychain"
  fi
else
  warn "lark-keychain 还不存在 —— 首次部署时创建并授权：sudo mkdir -p lark-keychain && sudo chown -R 1000:1000 lark-keychain"
fi

echo
echo "=== 5. TLS 证书检查 ==="
if [ -z "$DOMAIN" ]; then
  warn "跳过（DOMAIN 未配置）—— 配好 .env 后重跑本脚本"
else
  # 优先检查通配符（Cloudflare Origin CA 签发时最常见），再检查域名专用证书
  found=0
  for base in "$DOMAIN" wildcard; do
    for f in .pem .key; do
      if [ -e "/etc/nginx/ssl/${base}${f}" ]; then
        ok "找到证书文件 /etc/nginx/ssl/${base}${f}"
        found=1
      fi
    done
  done
  [ "$found" -eq 1 ] || warn "未找到 /etc/nginx/ssl/${DOMAIN}.pem|key，也未找到 wildcard.pem|key"
  # 证书有效期（只检查 pem 存在时）
  cert="/etc/nginx/ssl/${DOMAIN}.pem"
  [ -e "$cert" ] || cert="/etc/nginx/ssl/wildcard.pem"
  if [ -e "$cert" ] && command -v openssl >/dev/null; then
    end=$(openssl x509 -in "$cert" -noout -enddate 2>/dev/null | cut -d= -f2-)
    if [ -n "$end" ]; then
      if openssl x509 -in "$cert" -noout -checkend 604800 >/dev/null 2>&1; then
        ok "证书有效期至 ${end}（>7 天）"
      else
        bad "证书 ${end} 到期，7 天内会失效 —— 重新签发并 reload nginx"
      fi
    fi
  fi
fi

echo
echo "=== 6. nginx reload 方式提醒 ==="
if systemctl is-active nginx >/dev/null 2>&1; then
  ok "nginx.service 处于 active —— 用 sudo nginx -s reload"
elif pgrep -x nginx >/dev/null 2>&1; then
  ok "nginx 进程在跑但不在 systemd 下 —— 用 sudo nginx -s reload"
else
  warn "nginx 未运行（首次部署：先写好 conf 再 sudo nginx -s start）"
  warn "→ reload 必须用：sudo nginx -s reload（systemctl reload 会报 Unit cannot be reloaded）"
fi

echo
echo "=================================================="
printf '结果: %d 通过 / %d 失败\n' "$OK" "$FAIL"
[ "$FAIL" -eq 0 ] || { echo "有失败项，先修好再部署。"; exit 1; }
echo "可以部署了：sudo bash deploy/deploy.sh"
echo "=================================================="
