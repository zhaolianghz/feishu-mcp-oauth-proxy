#!/bin/bash
# 一键部署：构建镜像 → 起服务 → 验证
# 用法：sudo bash deploy/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

echo "=== 0. 前置检查 ==="
bash deploy/preflight.sh || { echo "前置检查未通过，终止。"; exit 1; }

echo
echo "=== 1. 准备凭证持久化目录 ==="
# 必须 bind mount，且属主必须是 uid 1000（node 用户），否则 lark-cli 写不进去
if [ ! -d lark-keychain ]; then
  mkdir -p lark-keychain
  chown -R 1000:1000 lark-keychain
  chmod 700 lark-keychain
  echo "  已创建 lark-keychain（uid 1000）"
else
  echo "  lark-keychain 已存在"
  chown -R 1000:1000 lark-keychain
fi

echo
echo "=== 2. 获取 feishu-mcp 上游代码 ==="
# 上游本体不进本仓库（体积大、与中间件无关），首次部署时拉取。
# 注意：只覆盖构建必需的文件，绝不碰本仓库修正过的 Dockerfile。
UPSTREAM="https://github.com/feifan2024/feishu_mcp.git"
if [ -f feishu-mcp/package.json ]; then
  echo "  上游代码已存在，跳过（如需更新：rm -rf feishu-mcp/src feishu-mcp/package*.json 后重跑）"
else
  echo "  正在浅克隆 ${UPSTREAM} ..."
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  git clone --depth 1 "$UPSTREAM" "$tmp/feishu_mcp"

  need_ok=1
  for f in src package.json tsconfig.json; do
    if [ -e "$tmp/feishu_mcp/$f" ]; then
      cp -r "$tmp/feishu_mcp/$f" feishu-mcp/
    else
      echo "  ❌ 上游缺少 ${f}，仓库结构可能已变，请查看 ${UPSTREAM}" >&2
      need_ok=0
    fi
  done
  # package-lock.json 可选（上游可能没有）
  [ -e "$tmp/feishu_mcp/package-lock.json" ] && cp "$tmp/feishu_mcp/package-lock.json" feishu-mcp/
  rm -rf "$tmp"; trap - EXIT

  [ "$need_ok" -eq 1 ] || exit 1
  echo "  ✅ 上游代码就绪（Dockerfile 保持用本仓库修正版）"
fi

echo
echo "=== 3. 构建并启动 ==="
# ⚠️ 必须 --build：build cache 会命中旧层，up -d 不重建就跑旧代码
docker compose up -d --build

echo
echo "=== 4. 等待健康检查 ==="
for i in $(seq 1 30); do
  s1=$(docker inspect -f '{{.State.Health.Status}}' oauth-proxy 2>/dev/null || echo none)
  s2=$(docker inspect -f '{{.State.Health.Status}}' feishu-mcp 2>/dev/null || echo none)
  if [ "$s1" = "healthy" ] && [ "$s2" = "healthy" ]; then
    echo "  ✅ 两个容器均 healthy（第 ${i} 次探测）"
    break
  fi
  [ "$i" = "30" ] && { echo "  ❌ 超时未健康，当前状态：oauth-proxy=$s1 feishu-mcp=$s2"; docker compose logs --tail 30; exit 1; }
  sleep 2
done

echo
echo "=== 5. 端到端验证（走本机回环，绕开外部 DNS）==="
DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)
PORT=$(grep -E '^OAUTH_PROXY_PORT=' .env | cut -d= -f2- || true); PORT=${PORT:-3011}
BASE="https://127.0.0.1"

# 发现端点：全部必须是 200 + JSON，缺一个 ChatGPT 就整体失败
for p in /.well-known/oauth-protected-resource \
         /.well-known/oauth-authorization-server \
         /.well-known/openid-configuration; do
  code=$(curl -sk -o /dev/null -w '%{http_code}' "$BASE$p" -H "Host: $DOMAIN")
  if [ "$code" = "200" ]; then
    echo "  ✅ $p → 200"
  else
    echo "  ❌ $p → ${code}（ChatGPT 会因此判定发现流程失败）"
    exit 1
  fi
done

# /mcp 无 token 必须 401
code=$(curl -sk -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" \
  -H "Host: $DOMAIN" -H 'Content-Type: application/json' -d '{}')
[ "$code" = "401" ] && echo "  ✅ /mcp 无 token → 401（正确）" \
                    || { echo "  ❌ /mcp 无 token → ${code}（应为 401）"; exit 1; }

echo
echo "=== 6. nginx ==="
if [ -f "/etc/nginx/conf.d/feishu-mcp.conf" ]; then
  echo "  发现 nginx 配置，执行 reload"
  nginx -t && nginx -s reload && echo "  ✅ 已 reload"
else
  echo "  ⚠️  未找到 /etc/nginx/conf.d/feishu-mcp.conf"
  echo "     请手动把 feishu-mcp-oauth/nginx-feishu-mcp.conf 复制过去并改 server_name"
fi

echo
echo "=================================================="
echo "✅ 部署完成"
echo
echo "接下来："
echo "  1. 飞书授权（必做，否则工具调用会失败）"
echo "     sudo bash feishu-mcp-oauth/scripts/01-inject-app-secret.sh"
echo "     sudo bash feishu-mcp-oauth/scripts/02-start-feishu-login.sh"
echo "     # 浏览器授权后："
echo "     sudo bash feishu-mcp-oauth/scripts/03-complete-feishu-login.sh <device_code>"
echo
echo "  2. ChatGPT 里添加连接器"
echo "     URL:      https://${DOMAIN}/mcp"
echo "     认证:     OAuth"
echo "     密码:     .env 里的 LOGIN_PASSWORD"
echo
echo "  3. 体检"
echo "     sudo bash feishu-mcp-oauth/scripts/04-check-feishu-auth.sh"
echo "=================================================="
