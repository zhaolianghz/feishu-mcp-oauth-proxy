#!/bin/bash
# 第一步：发起 device authorization，拿授权链接（不阻塞）
# 用法：sudo bash /opt/feishu-mcp/scripts/02-start-feishu-login.sh
set -e

echo "=== 发起 device authorization ==="
OUT="$(docker exec -u node feishu-mcp lark-cli auth login --no-wait --json \
        --domain docs,drive,base,sheets,wiki 2>&1 || true)"
echo "$OUT"

URL="$(printf '%s' "$OUT" | grep -oE 'https://[^"]*(verify|cli)[^"]*' | head -1 || true)"
CODE="$(printf '%s' "$OUT" | grep -oE '"device_code"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"

if [ -z "$URL" ]; then
  echo
  echo "!! 没能拿到授权链接。通常是 App Secret 不对或未注入 ——" >&2
  echo "   先跑 01-inject-app-secret.sh 注入正确的 App Secret。" >&2
  exit 1
fi

echo
echo "=================================================="
echo "在浏览器打开下面这个链接完成授权："
echo
echo "  $URL"
echo
echo "授权完毕后执行（用这条命令里给出的 device_code）："
echo
echo "  sudo bash /opt/feishu-mcp/scripts/03-complete-feishu-login.sh $CODE"
echo "=================================================="
